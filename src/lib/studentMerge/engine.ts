// 중복 학생 병합 실행 엔진.
//
// 핵심 원칙 (하나라도 어기면 실행하지 않는다):
//  1. DELETE 를 한 줄도 쓰지 않는다. 흡수된 행은 지우지 않고 표시만 한다.
//  2. 2026-08 이후 청구(Payment / PaymentInvoice / PaymentTransaction)는 WHERE 절에서 명시적으로 제외한다.
//  3. 전체가 하나의 트랜잭션이다. 단계별 영향 행 수가 예상과 다르면 전부 ROLLBACK 한다.
//  4. 모든 변경을 StudentMergeLog에 남긴다. 이 로그만으로 되돌릴 수 있어야 한다.
//
// DRY-RUN 과 실제 적용이 "같은 SQL"을 쓰도록, 실행기(SqlRunner)만 갈아끼우는 구조로 만든다.
// DRY-RUN 은 BEGIN → 전부 실행 → ROLLBACK 이라 실제 결과를 보면서도 DB는 그대로 남는다.

import {
  BILLING_FREEZE_FROM,
  chooseRepresentative,
  countActive,
  finalEnrollmentStatuses,
  conflictPairsSql,
  moveGuardSql,
  moveSkipNote,
  promoteRowSql,
  shouldPromoteOnConflict,
  planEnrollmentMerge,
  SOFT_SKIP_STATUS,
  type EnrollmentPlan,
  type EnrollmentRow,
  type MergeCandidate,
  type RepresentativeChoice,
} from "./plan";
import {
  autoMovableTables,
  followsParentRows,
  STUDENT_REF_TABLES,
  type StudentRefTable,
} from "./tables";

export type SqlRunner = {
  /** SELECT 등 결과가 필요한 쿼리 */
  query: <T = Record<string, unknown>>(sql: string) => Promise<T[]>;
  /** UPDATE/INSERT 등. 영향 받은 행 수를 돌려준다 */
  execute: (sql: string) => Promise<number>;
};

/** SQL 문자열 리터럴 이스케이프. 값은 전부 이 함수를 통해서만 넣는다. */
export function sqlText(value: string | null | undefined): string {
  if (value === null || value === undefined) return "NULL";
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * 운영 DB에 실제로 있는 테이블만 남긴다.
 * mayBeMissing 표시가 없는 테이블은 그대로 둔다 — 오타·누락이면 쿼리가 실패해 바로 드러나야 한다.
 */
export async function presentTables(
  runner: SqlRunner,
  tables: StudentRefTable[],
): Promise<StudentRefTable[]> {
  const optional = [...new Set(tables.filter((t) => t.mayBeMissing).map((t) => t.table))];
  if (optional.length === 0) return tables;
  const rows = await runner.query<{ name: string }>(
    `SELECT name FROM unnest(ARRAY[${optional.map((n) => sqlText(n)).join(",")}]::text[]) AS name
     WHERE to_regclass('public.' || quote_ident(name)) IS NOT NULL`,
  );
  const present = new Set(rows.map((r) => r.name));
  return tables.filter((t) => !t.mayBeMissing || present.has(t.table));
}

/** 청구 계열 테이블에 붙일 "동결월 이후 제외" 하드 가드 */
export function billingFreezeGuard(paymentAlias: string): string {
  const { year, month } = BILLING_FREEZE_FROM;
  return `(${paymentAlias}.year < ${year} OR (${paymentAlias}.year = ${year} AND ${paymentAlias}.month < ${month}))`;
}

export type PairDirective = {
  label: string;
  /** 실측으로 확인한 두 Student.id */
  studentIds: [string, string];
  /** 대표의 보호자를 이 User.id로 갈아끼운다 (User.phone은 절대 UPDATE 하지 않는다) */
  relinkParentUserId?: string;
  /** 임시 보호자 계정 이름을 원장(Ledger) 실명으로 채운다 */
  fillParentName?: string;
  /** 생년월일 통일 (YYYY-MM-DD). 대표·흡수 양쪽 모두에 적용 */
  unifyBirthDate?: string;
  /** 병합 뒤 대표의 모든 수강 상태를 이 값으로 정리 (예: 퇴원 확정) */
  forceAllEnrollmentStatus?: string;
  /** 검산용 기대값. 다르면 전체 ROLLBACK */
  expectFinalActiveClasses?: number;
};

export type TableMoveResult = {
  table: string;
  column: string;
  moved: number;
  softSkipped: number;
  /** 충돌한 대표 행이 흡수 행의 상태를 승계한 수 (promoteOnConflict) */
  promoted: number;
};

export type PairResult = {
  label: string;
  choice: RepresentativeChoice;
  winner: MergeCandidate;
  loser: MergeCandidate;
  enrollmentPlan: EnrollmentPlan;
  finalActiveClasses: number;
  tableMoves: TableMoveResult[];
  billingMoved: { payments: number; invoices: number; transactions: number };
  billingFrozenLeftBehind: number;
  parentAction: string;
  logRows: number;
};

/** 학생 한 명의 병합 판단 재료를 DB에서 읽어온다 (읽기 전용) */
export async function loadCandidate(runner: SqlRunner, studentId: string): Promise<MergeCandidate> {
  const { year, month } = BILLING_FREEZE_FROM;

  const [meta] = await runner.query<{ createdAt: string }>(
    `SELECT "createdAt"::text AS "createdAt" FROM "Student" WHERE id = ${sqlText(studentId)}`,
  );
  if (!meta) throw new Error(`학생을 찾을 수 없다: ${studentId}`);

  // 동결월 이후 "살아있는(취소 아님)" 청구 건수 — 대표 선정 1순위 근거
  const [billing] = await runner.query<{ n: string }>(
    `SELECT COUNT(*)::int AS n FROM "Payment"
     WHERE "studentId" = ${sqlText(studentId)}
       AND (year > ${year} OR (year = ${year} AND month >= ${month}))
       AND status <> 'CANCELED'`,
  );

  const enrollments = await runner.query<EnrollmentRow>(
    `SELECT id, "classId", status FROM "Enrollment"
     WHERE "studentId" = ${sqlText(studentId)} ORDER BY "classId"`,
  );

  // 살아있는 자식 기록 수 — 대표 선정 2순위 근거
  const countSql = (await presentTables(runner, autoMovableTables()))
    .map(
      (t) =>
        `SELECT COUNT(*)::int AS n FROM "${t.table}" WHERE "${t.column}" = ${sqlText(studentId)}`,
    )
    .join(" UNION ALL ");
  const counts = await runner.query<{ n: string }>(
    `SELECT COALESCE(SUM(n), 0)::int AS n FROM (${countSql}) x`,
  );

  return {
    id: studentId,
    liveBillingCountFromFreeze: Number(billing?.n ?? 0),
    liveChildRowCount: Number(counts[0]?.n ?? 0) + enrollments.length,
    createdAt: meta.createdAt,
    enrollments,
  };
}

/** StudentMergeLog INSERT 한 줄 만들기 */
function logInsert(args: {
  mergeId: string;
  winnerId: string;
  loserId: string;
  table: string;
  rowId: string;
  column: string;
  oldValue: string | null;
  newValue: string | null;
  action: "MOVE" | "UPDATE" | "SOFT_SKIP" | "MARK";
  note?: string;
}): string {
  return `INSERT INTO "StudentMergeLog"
    ("mergeId","winnerStudentId","loserStudentId","tableName","rowId","column","oldValue","newValue",action,note)
    VALUES (${sqlText(args.mergeId)}, ${sqlText(args.winnerId)}, ${sqlText(args.loserId)},
            ${sqlText(args.table)}, ${sqlText(args.rowId)}, ${sqlText(args.column)},
            ${sqlText(args.oldValue)}, ${sqlText(args.newValue)}, ${sqlText(args.action)},
            ${sqlText(args.note ?? null)})`;
}

/**
 * 무충돌 테이블 이동.
 * UNIQUE 제약이 걸린 테이블은 "대표 쪽에 같은 조합이 없을 때만" 옮기고,
 * 청구월 동결·부모 행 조건에 걸린 행도 옮기지 않은 채(SOFT_SKIP) 흡수 학생에 그대로 둔다.
 */
async function moveTable(
  runner: SqlRunner,
  t: StudentRefTable,
  mergeId: string,
  winnerId: string,
  loserId: string,
): Promise<TableMoveResult> {
  const w = sqlText(winnerId);
  const l = sqlText(loserId);

  // UNIQUE 충돌·청구월 동결·부모 따라가기 조건 (plan.ts 의 순수 함수 — 테스트로 고정)
  const guard = moveGuardSql(t, w);

  // 충돌로 못 옮기는 행 중 흡수 쪽이 더 살아있으면 대표 행이 먼저 승계한다(그 뒤 흡수 행은 SOFT_SKIP).
  let promoted = 0;
  if (t.promoteOnConflict) {
    const promo = t.promoteOnConflict;
    const pairs = await runner.query<Record<string, string | null>>(conflictPairsSql(t, w, l));
    for (const pair of pairs) {
      const winnerRowId = String(pair.winnerRowId);
      const loserRowId = String(pair.loserRowId);
      const ws = pair[`w:${promo.statusColumn}`] ?? null;
      const ls = pair[`l:${promo.statusColumn}`] ?? null;
      if (!shouldPromoteOnConflict(promo.priority, ws, ls)) continue;

      for (const c of promo.copyColumns) {
        const oldValue = pair[`w:${c}`] ?? null;
        const newValue = pair[`l:${c}`] ?? null;
        if (oldValue === newValue) continue;
        await runner.execute(
          logInsert({
            mergeId,
            winnerId,
            loserId,
            table: t.table,
            rowId: winnerRowId,
            column: c,
            oldValue,
            newValue,
            action: "UPDATE",
            note: `흡수 쪽(${loserRowId})이 더 살아있는 상태(${ls})라 대표 행이 승계`,
          }),
        );
      }
      const n = await runner.execute(promoteRowSql(t, sqlText(winnerRowId), sqlText(loserRowId)));
      if (n !== 1) throw new Error(`${t.table} 상태 승계 영향 행이 ${n}건 (기대 1건) — 전체 중단`);
      promoted += 1;
    }
  }

  // 옮기기 전에 대상 행 ID를 먼저 확보해야 로그에 남길 수 있다.
  const targets = await runner.query<{ id: string }>(
    `SELECT src.id FROM "${t.table}" src WHERE src."${t.column}" = ${l}${guard}`,
  );
  const skipped = await runner.query<{ id: string }>(
    `SELECT src.id FROM "${t.table}" src WHERE src."${t.column}" = ${l}
     EXCEPT SELECT src.id FROM "${t.table}" src WHERE src."${t.column}" = ${l}${guard}`,
  );

  let moved = 0;
  if (targets.length > 0) {
    const ids = targets.map((r) => sqlText(r.id)).join(",");
    moved = await runner.execute(
      `UPDATE "${t.table}" SET "${t.column}" = ${w} WHERE id IN (${ids})`,
    );
    // 로그는 한 번에 몰아 넣는다(행 수가 수백 건이라 개별 INSERT는 느리다).
    await runner.execute(
      `INSERT INTO "StudentMergeLog"
       ("mergeId","winnerStudentId","loserStudentId","tableName","rowId","column","oldValue","newValue",action)
       SELECT ${sqlText(mergeId)}, ${w}, ${l}, ${sqlText(t.table)}, id, ${sqlText(t.column)}, ${l}, ${w}, 'MOVE'
       FROM "${t.table}" WHERE id IN (${ids})`,
    );
  }

  for (const row of skipped) {
    await runner.execute(
      logInsert({
        mergeId,
        winnerId,
        loserId,
        table: t.table,
        rowId: row.id,
        column: t.column,
        oldValue: loserId,
        newValue: loserId,
        action: "SOFT_SKIP",
        note: moveSkipNote(t),
      }),
    );
  }

  return { table: t.table, column: t.column, moved, softSkipped: skipped.length, promoted };
}

/** 한 쌍 병합 */
export async function mergePair(
  runner: SqlRunner,
  mergeId: string,
  directive: PairDirective,
): Promise<PairResult> {
  const [idA, idB] = directive.studentIds;
  const a = await loadCandidate(runner, idA);
  const b = await loadCandidate(runner, idB);
  const choice = chooseRepresentative(a, b);
  const winner = choice.winnerId === a.id ? a : b;
  const loser = choice.loserId === a.id ? a : b;

  const w = sqlText(winner.id);
  const l = sqlText(loser.id);

  // --- 1) 무충돌 테이블 이동 (부모 행을 따라가는 테이블은 3-1에서) ---
  const movable = await presentTables(runner, autoMovableTables());
  const tableMoves: TableMoveResult[] = [];
  for (const t of movable.filter((x) => !followsParentRows(x))) {
    tableMoves.push(await moveTable(runner, t, mergeId, winner.id, loser.id));
  }

  // --- 2) Enrollment 충돌 처리 (하드 DELETE 금지) ---
  const enrollmentPlan = planEnrollmentMerge(winner.enrollments, loser.enrollments);

  for (const p of enrollmentPlan.promote) {
    await runner.execute(
      `UPDATE "Enrollment" SET status = ${sqlText(p.toStatus)}, "updatedAt" = NOW()
       WHERE id = ${sqlText(p.enrollmentId)}`,
    );
    await runner.execute(
      logInsert({
        mergeId,
        winnerId: winner.id,
        loserId: loser.id,
        table: "Enrollment",
        rowId: p.enrollmentId,
        column: "status",
        oldValue: p.fromStatus,
        newValue: p.toStatus,
        action: "UPDATE",
        note: "흡수 쪽이 더 살아있는 상태라 대표 행 상태를 승계",
      }),
    );
  }

  for (const m of enrollmentPlan.move) {
    await runner.execute(
      `UPDATE "Enrollment" SET "studentId" = ${w}, "updatedAt" = NOW()
       WHERE id = ${sqlText(m.enrollmentId)}`,
    );
    await runner.execute(
      logInsert({
        mergeId,
        winnerId: winner.id,
        loserId: loser.id,
        table: "Enrollment",
        rowId: m.enrollmentId,
        column: "studentId",
        oldValue: loser.id,
        newValue: winner.id,
        action: "MOVE",
      }),
    );
  }

  for (const s of enrollmentPlan.softSkip) {
    await runner.execute(
      `UPDATE "Enrollment" SET status = ${sqlText(SOFT_SKIP_STATUS)}, "updatedAt" = NOW()
       WHERE id = ${sqlText(s.enrollmentId)}`,
    );
    await runner.execute(
      logInsert({
        mergeId,
        winnerId: winner.id,
        loserId: loser.id,
        table: "Enrollment",
        rowId: s.enrollmentId,
        column: "status",
        oldValue: s.fromStatus,
        newValue: SOFT_SKIP_STATUS,
        action: "SOFT_SKIP",
        note: `같은 반이 대표(${s.supersededBy})에 이미 있어 이동 불가. 흡수 쪽에 남긴다`,
      }),
    );
  }

  // --- 3) 청구 이동: 동결월 이전만. 8월 이후는 WHERE에서 하드 제외 ---
  const payTargets = await runner.query<{ id: string }>(
    `SELECT id FROM "Payment" p WHERE p."studentId" = ${l} AND ${billingFreezeGuard("p")}`,
  );
  let movedPayments = 0;
  if (payTargets.length > 0) {
    const ids = payTargets.map((r) => sqlText(r.id)).join(",");
    await runner.execute(
      `INSERT INTO "StudentMergeLog"
       ("mergeId","winnerStudentId","loserStudentId","tableName","rowId","column","oldValue","newValue",action,note)
       SELECT ${sqlText(mergeId)}, ${w}, ${l}, 'Payment', id, 'studentId', ${l}, ${w}, 'MOVE',
              year || '-' || month
       FROM "Payment" WHERE id IN (${ids})`,
    );
    movedPayments = await runner.execute(
      `UPDATE "Payment" SET "studentId" = ${w}, "updatedAt" = NOW() WHERE id IN (${ids})`,
    );
  }

  const invTargets = await runner.query<{ id: string }>(
    `SELECT i.id FROM "PaymentInvoice" i
     JOIN "Payment" p ON p.id = i."paymentId"
     WHERE i."studentId" = ${l} AND ${billingFreezeGuard("p")}`,
  );
  let movedInvoices = 0;
  if (invTargets.length > 0) {
    const ids = invTargets.map((r) => sqlText(r.id)).join(",");
    await runner.execute(
      `INSERT INTO "StudentMergeLog"
       ("mergeId","winnerStudentId","loserStudentId","tableName","rowId","column","oldValue","newValue",action)
       SELECT ${sqlText(mergeId)}, ${w}, ${l}, 'PaymentInvoice', id, 'studentId', ${l}, ${w}, 'MOVE'
       FROM "PaymentInvoice" WHERE id IN (${ids})`,
    );
    movedInvoices = await runner.execute(
      `UPDATE "PaymentInvoice" SET "studentId" = ${w}, "updatedAt" = NOW() WHERE id IN (${ids})`,
    );
  }

  const txTargets = await runner.query<{ id: string }>(
    `SELECT t.id FROM "PaymentTransaction" t
     JOIN "Payment" p ON p.id = t."paymentId"
     WHERE t."studentId" = ${l} AND ${billingFreezeGuard("p")}`,
  );
  let movedTx = 0;
  if (txTargets.length > 0) {
    const ids = txTargets.map((r) => sqlText(r.id)).join(",");
    await runner.execute(
      `INSERT INTO "StudentMergeLog"
       ("mergeId","winnerStudentId","loserStudentId","tableName","rowId","column","oldValue","newValue",action)
       SELECT ${sqlText(mergeId)}, ${w}, ${l}, 'PaymentTransaction', id, 'studentId', ${l}, ${w}, 'MOVE'
       FROM "PaymentTransaction" WHERE id IN (${ids})`,
    );
    movedTx = await runner.execute(
      `UPDATE "PaymentTransaction" SET "studentId" = ${w} WHERE id IN (${ids})`,
    );
  }

  // --- 3-1) 부모 행 따라가기: 수강·청구가 어디로 갔는지 확정된 뒤에 옮긴다 ---
  //     (동결돼 흡수 쪽에 남은 Payment의 납부요청 등은 함께 남는다)
  for (const t of movable.filter(followsParentRows)) {
    tableMoves.push(await moveTable(runner, t, mergeId, winner.id, loser.id));
  }

  const [frozenLeft] = await runner.query<{ n: string }>(
    `SELECT COUNT(*)::int AS n FROM "Payment" p
     WHERE p."studentId" = ${l} AND NOT ${billingFreezeGuard("p")}`,
  );

  // --- 4) 보호자 교정: User.phone은 절대 건드리지 않고 Student.parentId만 옮긴다 ---
  //     (오기 번호 계정에 다른 자녀나 로그인이 매달려 있을 수 있어서, 계정 자체를 수정하면 위험하다)
  let parentAction = "변경 없음";
  if (directive.relinkParentUserId) {
    const [before] = await runner.query<{ parentId: string }>(
      `SELECT "parentId" FROM "Student" WHERE id = ${w}`,
    );
    await runner.execute(
      `UPDATE "Student" SET "parentId" = ${sqlText(directive.relinkParentUserId)}, "updatedAt" = NOW()
       WHERE id = ${w}`,
    );
    await runner.execute(
      logInsert({
        mergeId,
        winnerId: winner.id,
        loserId: loser.id,
        table: "Student",
        rowId: winner.id,
        column: "parentId",
        oldValue: before?.parentId ?? null,
        newValue: directive.relinkParentUserId,
        action: "UPDATE",
        note: "정답 전화번호를 가진 기존 계정으로 재연결 (User.phone 미변경)",
      }),
    );
    parentAction = `parentId 재연결 → ${directive.relinkParentUserId}`;
  }

  if (directive.fillParentName) {
    const [cur] = await runner.query<{ id: string; name: string }>(
      `SELECT u.id, u.name FROM "User" u JOIN "Student" s ON s."parentId" = u.id WHERE s.id = ${w}`,
    );
    if (cur && cur.name !== directive.fillParentName) {
      await runner.execute(
        `UPDATE "User" SET name = ${sqlText(directive.fillParentName)}, "updatedAt" = NOW()
         WHERE id = ${sqlText(cur.id)}`,
      );
      await runner.execute(
        logInsert({
          mergeId,
          winnerId: winner.id,
          loserId: loser.id,
          table: "User",
          rowId: cur.id,
          column: "name",
          oldValue: cur.name,
          newValue: directive.fillParentName,
          action: "UPDATE",
          note: "임시 보호자 이름을 원장(Ledger) 실명으로 채움",
        }),
      );
      parentAction += ` / 이름 "${cur.name}" → "${directive.fillParentName}"`;
    }
  }

  // --- 5) 생년월일 통일 ---
  if (directive.unifyBirthDate) {
    for (const target of [winner.id, loser.id]) {
      const [cur] = await runner.query<{ birth: string }>(
        `SELECT "birthDate"::text AS birth FROM "Student" WHERE id = ${sqlText(target)}`,
      );
      await runner.execute(
        `UPDATE "Student" SET "birthDate" = ${sqlText(`${directive.unifyBirthDate} 00:00:00`)}::timestamp,
         "updatedAt" = NOW() WHERE id = ${sqlText(target)}`,
      );
      await runner.execute(
        logInsert({
          mergeId,
          winnerId: winner.id,
          loserId: loser.id,
          table: "Student",
          rowId: target,
          column: "birthDate",
          oldValue: cur?.birth ?? null,
          newValue: `${directive.unifyBirthDate} 00:00:00`,
          action: "UPDATE",
          note: "원장 확인: 생일 오기 → 동일인으로 통일",
        }),
      );
    }
  }

  // --- 6) 수강 상태 일괄 정리 (예: 퇴원 확정) ---
  if (directive.forceAllEnrollmentStatus) {
    const rows = await runner.query<{ id: string; status: string }>(
      `SELECT id, status FROM "Enrollment"
       WHERE "studentId" = ${w} AND status <> ${sqlText(directive.forceAllEnrollmentStatus)}`,
    );
    for (const row of rows) {
      await runner.execute(
        `UPDATE "Enrollment" SET status = ${sqlText(directive.forceAllEnrollmentStatus)}, "updatedAt" = NOW()
         WHERE id = ${sqlText(row.id)}`,
      );
      await runner.execute(
        logInsert({
          mergeId,
          winnerId: winner.id,
          loserId: loser.id,
          table: "Enrollment",
          rowId: row.id,
          column: "status",
          oldValue: row.status,
          newValue: directive.forceAllEnrollmentStatus,
          action: "UPDATE",
          note: "원장 확인 사항 반영",
        }),
      );
    }
  }

  // --- 7) 흡수 레코드 표시 (삭제하지 않는다) ---
  await runner.execute(
    `UPDATE "Student" SET "mergedIntoStudentId" = ${w}, "mergedAt" = NOW(), "updatedAt" = NOW()
     WHERE id = ${l}`,
  );
  await runner.execute(
    logInsert({
      mergeId,
      winnerId: winner.id,
      loserId: loser.id,
      table: "Student",
      rowId: loser.id,
      column: "mergedIntoStudentId",
      oldValue: null,
      newValue: winner.id,
      action: "MARK",
      note: directive.label,
    }),
  );

  // --- 8) 최종 상태 검산 ---
  const finalRows = await runner.query<{ status: string }>(
    `SELECT status FROM "Enrollment" WHERE "studentId" = ${w}`,
  );
  const finalActiveClasses = finalRows.filter((r) => r.status === "ACTIVE").length;

  if (
    directive.expectFinalActiveClasses !== undefined &&
    finalActiveClasses !== directive.expectFinalActiveClasses
  ) {
    throw new Error(
      `${directive.label}: 병합 후 ACTIVE 반이 ${finalActiveClasses}개 (기대 ${directive.expectFinalActiveClasses}개) — 전체 중단`,
    );
  }

  const [logCount] = await runner.query<{ n: string }>(
    `SELECT COUNT(*)::int AS n FROM "StudentMergeLog"
     WHERE "mergeId" = ${sqlText(mergeId)} AND "loserStudentId" = ${l}`,
  );

  return {
    label: directive.label,
    choice,
    winner,
    loser,
    enrollmentPlan,
    finalActiveClasses,
    tableMoves: tableMoves.filter((t) => t.moved > 0 || t.softSkipped > 0 || t.promoted > 0),
    billingMoved: { payments: movedPayments, invoices: movedInvoices, transactions: movedTx },
    billingFrozenLeftBehind: Number(frozenLeft?.n ?? 0),
    parentAction,
    logRows: Number(logCount?.n ?? 0),
  };
}

export type BillingSnapshot = {
  pendingCount: number;
  pendingTotal: number;
  issuedInvoiceCount: number;
  issuedInvoiceTotal: number;
  /** 동결월 청구 행 전체의 지문. 한 글자라도 바뀌면 값이 달라진다 */
  frozenRowFingerprint: string;
};

/** 8월 청구 기준선. 병합 전/후가 완전히 같아야 한다. */
export async function readFrozenBillingSnapshot(runner: SqlRunner): Promise<BillingSnapshot> {
  const { year, month } = BILLING_FREEZE_FROM;
  const [p] = await runner.query<{ n: string; t: string }>(
    `SELECT COUNT(*)::int AS n, COALESCE(SUM(amount), 0)::bigint AS t
     FROM "Payment" WHERE year = ${year} AND month = ${month} AND status = 'PENDING'`,
  );
  const [i] = await runner.query<{ n: string; t: string }>(
    `SELECT COUNT(*)::int AS n, COALESCE(SUM(i.amount), 0)::bigint AS t
     FROM "PaymentInvoice" i JOIN "Payment" p ON p.id = i."paymentId"
     WHERE p.year = ${year} AND p.month = ${month} AND i.status = 'ISSUED'`,
  );
  // 건수·합계만 보면 "한 건 늘고 한 건 줄어" 같은 상쇄를 놓친다.
  // 그래서 동결월 청구 행을 통째로 문자열로 이어 붙여 지문(md5)을 남긴다.
  const [fp] = await runner.query<{ h: string | null }>(
    `SELECT md5(COALESCE(string_agg(
       p.id || '|' || p."studentId" || '|' || p.status || '|' || p.amount || '|' ||
       COALESCE(i.id, '-') || '|' || COALESCE(i.status, '-') || '|' || COALESCE(i.amount::text, '-'),
       ',' ORDER BY p.id), '')) AS h
     FROM "Payment" p LEFT JOIN "PaymentInvoice" i ON i."paymentId" = p.id
     WHERE p.year >= ${year} AND (p.year > ${year} OR p.month >= ${month})`,
  );

  return {
    pendingCount: Number(p?.n ?? 0),
    pendingTotal: Number(p?.t ?? 0),
    issuedInvoiceCount: Number(i?.n ?? 0),
    issuedInvoiceTotal: Number(i?.t ?? 0),
    frozenRowFingerprint: fp?.h ?? "",
  };
}

export function assertBillingUnchanged(before: BillingSnapshot, after: BillingSnapshot): void {
  const keys = Object.keys(before) as (keyof BillingSnapshot)[];
  for (const key of keys) {
    if (before[key] !== after[key]) {
      throw new Error(
        `8월 청구가 변했다 (${key}: ${before[key]} → ${after[key]}) — 전체 ROLLBACK`,
      );
    }
  }
}

/** 유령 ID 잔존 검사: 병합 뒤에도 흡수 학생을 가리키는 행이 남아 있는지 훑는다 */
export async function findRemainingReferences(
  runner: SqlRunner,
  loserIds: string[],
): Promise<{ table: string; column: string; n: number }[]> {
  if (loserIds.length === 0) return [];
  const list = loserIds.map((id) => sqlText(id)).join(",");
  const tables = await presentTables(
    runner,
    STUDENT_REF_TABLES.filter((t) => !t.cascadesFromPayment),
  );
  const sql = tables
    .map(
      (t) =>
        `SELECT ${sqlText(t.table)} AS table_name, ${sqlText(t.column)} AS column_name, COUNT(*)::int AS n
         FROM "${t.table}" WHERE "${t.column}" IN (${list})`,
    )
    .join(" UNION ALL ");
  const rows = await runner.query<{ table_name: string; column_name: string; n: string }>(
    `SELECT * FROM (${sql}) x WHERE n > 0 ORDER BY n DESC`,
  );
  return rows.map((r) => ({ table: r.table_name, column: r.column_name, n: Number(r.n) }));
}

export { countActive, finalEnrollmentStatuses };
