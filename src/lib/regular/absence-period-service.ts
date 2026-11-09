// 관리자 «기간 결석» DB 연결부 — 기간 행과 날짜별 RegularAbsence 를 함께 만들고·늘리고·지운다.
//
// 규칙(2026-11-09 원장 결정):
//   · 만들 때: 기간 안 수업일마다 RegularAbsence(CONFIRMED, 관리자 확정, reportedByUserId NULL, periodId) 를 만든다.
//       - 이미 살아 있는 행(학부모 신고·출석부 표시·다른 기간)은 그대로 둔다 → «이미 있음»
//       - 취소된 행은 되살려 이 기간에 묶는다(정산된 행은 제외)
//       - 그날 출석·지각 기록이 있으면 만들지 않는다 → «출석 기록 있음» (지난 날짜 소급 등록 허용)
//   · 복귀 처리·등록 취소: 이 기간 행만 CANCELLED. 청구 정산(BillingAbsenceResolution)·보강 예약에 묶였거나
//       그 뒤 학부모가 직접 신고해 학부모 행이 된 것은 건드리지 않고 개수로 알린다(이중 보상·학부모 기록 훼손 방지).
//   · 학부모·코치·기사 알림은 보내지 않는다(원장이 직접 등록하는 기록). 결석 행 note 머리말로 알림 재조정도 거른다.
//
// DB 접근은 인자로 받은 db(트랜잭션)로만 한다 — 실제 Postgres 로 실행 검증할 수 있게(출석부 결석 사유 모듈과 같은 방식).
// 모든 쓰기는 청구 정산·출석부와 같은 전역 잠금(lockCompensation) 안에서 한다.
import { lockCompensation } from "@/lib/billing/absence-compensation-guard";
import { addDaysKst, isKstYmd } from "@/lib/datetime/kst";
import { isValidReason } from "@/lib/regular/regularAbsenceRules";
import {
  DEFAULT_PERIOD_REASON,
  PERIOD_ABSENCE_NOTE_PREFIX,
  cancelResultMessage,
  createResultMessage,
  decideCancel,
  decideCreate,
  periodAbsenceNote,
  periodTargetEnd,
  periodsOverlap,
  planAbsencePeriodDates,
  validatePeriodDates,
  type CancelCounts,
  type ClassDatesForMonth,
  type CreateCounts,
  type PeriodClass,
} from "@/lib/regular/absence-period-plan";

export type AbsencePeriodDb = {
  $queryRawUnsafe<T = unknown>(sql: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(sql: string, ...values: unknown[]): Promise<number>;
};

/** 오늘·수업일 계산 재료 — 호출부(서버 액션·크론)가 만든다. */
export type PeriodContext = {
  todayYmd: string;
  classDatesForMonth: ClassDatesForMonth;
  actorUserId: string;
};

type PeriodRow = {
  id: string;
  studentId: string;
  reason: string;
  startDate: string;
  returnDate: string | null;
  status: string;
  coveredUntil: string;
  classIds: string[];
  createdByUserId: string;
};

/** 기간 결석이 만든 행의 note 모양(LIKE) — 알림 재조정 제외 조건과 같은 머리말 */
const PERIOD_NOTE_LIKE = `${PERIOD_ABSENCE_NOTE_PREFIX} · %`;

const PERIOD_COLUMNS = `p.id, p."studentId", p.reason, to_char(p."startDate",'YYYY-MM-DD') AS "startDate",
  to_char(p."returnDate",'YYYY-MM-DD') AS "returnDate", p.status,
  to_char(p."coveredUntil",'YYYY-MM-DD') AS "coveredUntil", p."classIds", p."createdByUserId"`;

async function tableExists(db: AbsencePeriodDb, name: string): Promise<boolean> {
  const rows = await db.$queryRawUnsafe<Array<{ found: string | null }>>(
    `SELECT to_regclass($1)::text AS found`, `public."${name}"`,
  );
  return Boolean(rows[0]?.found);
}

/** 그 학생의 수강 중(ACTIVE) 반 — 요일·개시일·이름 */
async function activeClassesOf(db: AbsencePeriodDb, studentId: string) {
  return db.$queryRawUnsafe<Array<PeriodClass & { className: string }>>(
    `SELECT e."classId" AS "classId", c."dayOfWeek" AS "dayOfWeek", c.name AS "className",
            to_char(e."startsOn",'YYYY-MM-DD') AS "startsOn"
       FROM "Enrollment" e JOIN "Class" c ON c.id = e."classId"
      WHERE e."studentId" = $1 AND e.status = 'ACTIVE'
      ORDER BY c."dayOfWeek", c."startTime"`,
    studentId,
  );
}

/** 기간의 대상 반: classIds 빈 배열 = 수강 중 반 전부(나중에 생긴 반 포함), 아니면 그중 아직 수강 중인 반만. */
function targetClasses(all: PeriodClass[], classIds: string[]): PeriodClass[] {
  if (!classIds.length) return all;
  const wanted = new Set(classIds);
  return all.filter((c) => wanted.has(c.classId));
}

/**
 * 기간 시작일부터 목표 끝(복귀일 전날·복귀 미정이면 다음 달 말일)까지 «반마다» 수업일을 다시 보고 빠진 결석 행을 만든다.
 * (등록·복귀 처리·크론 연장이 모두 이 함수 하나를 쓴다)
 *
 * 왜 coveredUntil 다음 날부터가 아니라 시작일부터인가: 기간 도중 새로 수강 시작한 반은 이미 덮은 구간에도
 * 수업일이 있을 수 있다(개시일 이후). 반의 개시일(startsOn) 전 날짜는 계획에서 빠진다.
 * 이미 한 번 본 날은 이렇게 걸러 중복을 만들지 않는다:
 *   · 이 기간에 이미 묶인 행(살아 있든 취소됐든) → 손대지 않고 세지도 않는다
 *     (원장이 결석 관리에서 하루씩 취소한 날을 크론이 되살리지 않게)
 *   · 다른 살아 있는 행 → EXISTS, 동시에 생긴 행 → ON CONFLICT DO NOTHING
 *   · 이 기간과 무관한 취소 행(학부모·원장·출석부가 일부러 취소한 날) → 처음 등록(mode="CREATE")에서만 되살린다.
 *     크론 연장·복귀 처리(mode="EXTEND")에서는 건너뛰고 세지도 않는다 — 등록 뒤에 누가 일부러 취소한 날을 다시 결석으로 만들지 않게.
 * coveredUntil 은 «여기까지는 계산을 끝냈다»는 표시로, 연간 일정에 없는 달에서 멈추면 거기까지만 올린다(크론이 다음 날 다시 본다).
 */
async function fillPeriodRows(db: AbsencePeriodDb, period: PeriodRow, ctx: PeriodContext, mode: "CREATE" | "EXTEND") {
  const counts: CreateCounts = { created: 0, existing: 0, attended: 0, protectedCount: 0 };
  const targetEnd = periodTargetEnd({ returnDate: period.returnDate, todayYmd: ctx.todayYmd });
  const fromDate = period.startDate;
  if (fromDate > targetEnd) return { counts, missingMonth: null as string | null };

  const classes = targetClasses(await activeClassesOf(db, period.studentId), period.classIds);
  const plan = planAbsencePeriodDates({ classes, fromDate, targetEnd, classDatesForMonth: ctx.classDatesForMonth });

  if (plan.items.length) {
    const lastDate = plan.items[plan.items.length - 1].date;
    const resolvedSql = (await tableExists(db, "BillingAbsenceResolution"))
      ? `EXISTS (SELECT 1 FROM "BillingAbsenceResolution" r WHERE r."absenceId" = ra.id)`
      : `false`;
    // 그 범위의 기존 결석 행(잠금) — 학부모 신고와 동시에 들어와도 한쪽만 이기게
    const existingRows = await db.$queryRawUnsafe<Array<{ id: string; classId: string; date: string; status: string; resolved: boolean; periodId: string | null }>>(
      `SELECT ra.id, ra."classId" AS "classId", to_char(ra.date,'YYYY-MM-DD') AS date, ra.status, ${resolvedSql} AS resolved,
              ra."periodId" AS "periodId"
         FROM "RegularAbsence" ra
        WHERE ra."studentId" = $1 AND ra.date BETWEEN $2::date AND $3::date
        FOR UPDATE OF ra`,
      period.studentId, fromDate, lastDate,
    );
    const existing = new Map(existingRows.map((r) => [`${r.classId}|${r.date}`, r]));
    // 그날 출석·지각 기록(청구 작업대와 같은 비교: se.date::date)
    const attendedRows = await db.$queryRawUnsafe<Array<{ classId: string; date: string }>>(
      `SELECT DISTINCT se."classId" AS "classId", to_char(se.date::date,'YYYY-MM-DD') AS date
         FROM "Attendance" t JOIN "Session" se ON se.id = t."sessionId"
        WHERE t."studentId" = $1 AND se.date::date BETWEEN $2::date AND $3::date
          AND t.status IN ('PRESENT','LATE')`,
      period.studentId, fromDate, lastDate,
    );
    const attended = new Set(attendedRows.map((r) => `${r.classId}|${r.date}`));
    const note = periodAbsenceNote(period.reason, period.startDate);

    for (const item of plan.items) {
      const key = `${item.classId}|${item.date}`;
      const row = existing.get(key) ?? null;
      if (row && row.periodId === period.id) continue; // 이미 이 기간이 다룬 날(개별 취소 포함) — 다시 보지 않는다
      if (row && row.status === "CANCELLED" && mode !== "CREATE") continue; // 연장·복귀 처리에선 일부러 취소한 날을 되살리지 않는다
      const decision = decideCreate({ existing: row, attended: attended.has(key) });
      if (decision === "ATTENDED") counts.attended++;
      else if (decision === "EXISTS") counts.existing++;
      else if (decision === "PROTECTED") counts.protectedCount++;
      else if (decision === "INSERT") {
        const inserted = await db.$queryRawUnsafe<Array<{ id: string }>>(
          `INSERT INTO "RegularAbsence" ("studentId","classId",date,reason,status,note,"reportedByUserId","resolvedByUserId","periodId")
           VALUES ($1,$2,$3::date,$4,'CONFIRMED',$5,NULL,$6,$7)
           ON CONFLICT ("studentId","classId","date") DO NOTHING
           RETURNING id`,
          period.studentId, item.classId, item.date, period.reason, note, ctx.actorUserId, period.id,
        );
        if (inserted[0]) counts.created++;
        else counts.existing++; // 잠금 사이에 다른 경로가 먼저 만들었다
      } else if (decision === "REACTIVATE" && row) {
        // 학부모가 취소했던 행 등 — 이 기간 행으로 되살린다(학부모 표시를 지워 알림 재조정·학부모 취소 대상에서 빠지게)
        const n = await db.$executeRawUnsafe(
          `UPDATE "RegularAbsence"
              SET reason = $2, status = 'CONFIRMED', note = $3, "reportedByUserId" = NULL,
                  "resolvedByUserId" = $4, "periodId" = $5, "updatedAt" = now()
            WHERE id = $1 AND status = 'CANCELLED'`,
          row.id, period.reason, note, ctx.actorUserId, period.id,
        );
        if (Number(n) > 0) counts.created++;
        else counts.existing++;
      }
    }
  }

  await db.$executeRawUnsafe(
    `UPDATE "RegularAbsencePeriod" SET "coveredUntil" = GREATEST("coveredUntil", $2::date), "updatedAt" = now() WHERE id = $1`,
    period.id, plan.coveredUntil,
  );
  return { counts, missingMonth: plan.missingMonth };
}

/** 이 기간 행 중 fromDate(포함) 이후를 취소한다(fromDate 없으면 전부). 보호 대상은 개수만 센다. */
async function cancelPeriodRows(db: AbsencePeriodDb, periodId: string, actorUserId: string, fromDate: string | null) {
  const counts: CancelCounts = { cancelled: 0, billing: 0, makeup: 0, parent: 0 };
  const resolvedSql = (await tableExists(db, "BillingAbsenceResolution"))
    ? `EXISTS (SELECT 1 FROM "BillingAbsenceResolution" r WHERE r."absenceId" = ra.id)`
    : `false`;
  // 보강 예약(MakeupSession)은 결석과 자연키(학생·원래 반·결석일)로 묶인다 — absence-compensation-guard 와 같은 비교
  const makeupSql = (await tableExists(db, "MakeupSession"))
    ? `EXISTS (SELECT 1 FROM "MakeupSession" m WHERE m."studentId" = ra."studentId" AND m."originalClassId" = ra."classId"
         AND to_char(m."originalDate" AT TIME ZONE 'Asia/Seoul','YYYY-MM-DD') = to_char(ra.date,'YYYY-MM-DD')
         AND m.status <> 'CANCELLED')`
    : `false`;
  const rows = await db.$queryRawUnsafe<Array<{ id: string; status: string; reportedByUserId: string | null; resolved: boolean; makeupBooked: boolean }>>(
    `SELECT ra.id, ra.status, ra."reportedByUserId" AS "reportedByUserId", ${resolvedSql} AS resolved, ${makeupSql} AS "makeupBooked"
       FROM "RegularAbsence" ra
      WHERE ra."periodId" = $1 AND ($2::date IS NULL OR ra.date >= $2::date)
        -- 출석부가 되살려 note 가 출석부 문구로 바뀐 행 등은 더 이상 이 기간 행이 아니다 — 보지도 세지도 않는다
        AND COALESCE(ra.note,'') LIKE $3
      FOR UPDATE OF ra`,
    periodId, fromDate, PERIOD_NOTE_LIKE,
  );
  const toCancel: string[] = [];
  for (const row of rows) {
    const d = decideCancel(row);
    if (d === "CANCEL") toCancel.push(row.id);
    else if (d === "PROTECTED_BILLING") counts.billing++;
    else if (d === "PROTECTED_MAKEUP") counts.makeup++;
    else if (d === "PROTECTED_PARENT_REPORT") counts.parent++;
  }
  if (toCancel.length) {
    // UPDATE 에도 «이 기간·관리자 행» 조건을 다시 건다(학부모 행을 실수로 지우지 않게)
    counts.cancelled = Number(await db.$executeRawUnsafe(
      `UPDATE "RegularAbsence"
          SET status = 'CANCELLED', "resolvedByUserId" = $2, "updatedAt" = now()
        WHERE id = ANY($1::text[]) AND "periodId" = $3 AND status <> 'CANCELLED' AND "reportedByUserId" IS NULL
          AND COALESCE(note,'') LIKE $4`,
      toCancel, actorUserId, periodId, PERIOD_NOTE_LIKE,
    ));
  }
  return counts;
}

async function readPeriodForUpdate(db: AbsencePeriodDb, periodId: string): Promise<PeriodRow> {
  const rows = await db.$queryRawUnsafe<PeriodRow[]>(
    `SELECT ${PERIOD_COLUMNS} FROM "RegularAbsencePeriod" p WHERE p.id = $1 FOR UPDATE`, periodId,
  );
  if (!rows[0]) throw new Error("기간 결석을 찾을 수 없습니다.");
  return { ...rows[0], classIds: rows[0].classIds ?? [] };
}

// ── 1) 등록 ──
export async function createAbsencePeriodInTx(db: AbsencePeriodDb, input: {
  studentId: string;
  startDate: string;
  returnDate?: string | null;
  reason?: string | null;
  note?: string | null;
  classIds?: string[] | null;
}, ctx: PeriodContext) {
  const studentId = String(input.studentId ?? "").trim();
  const startDate = String(input.startDate ?? "").trim();
  const returnDate = input.returnDate ? String(input.returnDate).trim() : null;
  const reason = input.reason ? String(input.reason) : DEFAULT_PERIOD_REASON;
  const note = input.note ? String(input.note).trim().slice(0, 500) || null : null;
  if (!studentId) throw new Error("학생을 찾을 수 없습니다.");
  const dateError = validatePeriodDates(startDate, returnDate);
  if (dateError) throw new Error(dateError);
  if (!isValidReason(reason)) throw new Error("결석 사유를 확인해 주세요.");

  await lockCompensation(db);

  // 학생 확인(병합으로 흡수된 학생 제외). 같은 학생 동시 등록은 위 전역 잠금이 줄 세운다
  const student = await db.$queryRawUnsafe<Array<{ id: string }>>(
    `SELECT s.id FROM "Student" s WHERE s.id = $1 AND s."mergedIntoStudentId" IS NULL`, studentId,
  );
  if (!student[0]) throw new Error("학생을 찾을 수 없습니다.");

  // 대상 반: 화면이 보낸 반은 반드시 그 학생의 수강 중 반이어야 한다(다른 학생 반 id 를 섞어 보내는 것 차단)
  const active = await activeClassesOf(db, studentId);
  if (!active.length) throw new Error("수강 중인 반이 없어 기간 결석을 만들 수 없습니다.");
  const requested = Array.from(new Set((input.classIds ?? []).map((id) => String(id).trim()).filter(Boolean)));
  const activeIds = new Set(active.map((c) => c.classId));
  if (requested.some((id) => !activeIds.has(id))) throw new Error("수강 중인 반만 고를 수 있습니다.");
  // 전부 골랐으면 빈 배열로 저장 → 나중에 새로 들어간 반도 자동 포함
  const storedClassIds = requested.length && requested.length < activeIds.size ? requested : [];

  // 같은 학생의 살아 있는 기간(진행 중·복귀 처리됨)과 날짜가 겹치면 막는다
  const others = await db.$queryRawUnsafe<Array<{ startDate: string; returnDate: string | null }>>(
    `SELECT to_char("startDate",'YYYY-MM-DD') AS "startDate", to_char("returnDate",'YYYY-MM-DD') AS "returnDate"
       FROM "RegularAbsencePeriod" WHERE "studentId" = $1 AND status IN ('ACTIVE','ENDED')`,
    studentId,
  );
  const mine = { startDate, returnDate };
  const clash = others.find((o) => periodsOverlap(mine, o));
  if (clash) {
    throw new Error(`이미 등록된 기간 결석(${clash.startDate}~${clash.returnDate ?? "복귀 미정"})과 날짜가 겹칩니다. 그 기간을 복귀 처리하거나 등록 취소한 뒤 다시 해 주세요.`);
  }

  const created = await db.$queryRawUnsafe<PeriodRow[]>(
    `INSERT INTO "RegularAbsencePeriod" ("studentId",reason,"startDate","returnDate",note,status,"coveredUntil","classIds","createdByUserId")
     VALUES ($1,$2,$3::date,$4::date,$5,'ACTIVE',$3::date - 1,$6::text[],$7)
     RETURNING ${PERIOD_COLUMNS.replaceAll("p.", "")}`,
    studentId, reason, startDate, returnDate, note, storedClassIds, ctx.actorUserId,
  );
  const period = { ...created[0], classIds: created[0].classIds ?? [] };
  const { counts, missingMonth } = await fillPeriodRows(db, period, ctx, "CREATE");
  return { periodId: period.id, studentId, counts, missingMonth, message: createResultMessage(counts, { missingMonth }) };
}

// ── 2) 복귀 처리 ──
export async function endAbsencePeriodInTx(db: AbsencePeriodDb, input: { periodId: string; returnDate: string }, ctx: PeriodContext) {
  const periodId = String(input.periodId ?? "").trim();
  const returnDate = String(input.returnDate ?? "").trim();
  if (!periodId) throw new Error("기간 결석을 찾을 수 없습니다.");
  if (!isKstYmd(returnDate)) throw new Error("복귀일을 확인해 주세요.");

  await lockCompensation(db);
  const period = await readPeriodForUpdate(db, periodId);
  if (period.status !== "ACTIVE") throw new Error("진행 중인 기간 결석만 복귀 처리할 수 있습니다.");
  const dateError = validatePeriodDates(period.startDate, returnDate);
  if (dateError) throw new Error(dateError);

  // 복귀일이 지금까지 만든 범위보다 뒤면, 그 사이 수업일을 먼저 채운다(복귀일 전날까지)
  const ended: PeriodRow = { ...period, returnDate };
  let fill: { counts: CreateCounts; missingMonth: string | null } | null = null;
  if (addDaysKst(returnDate, -1) > period.coveredUntil) fill = await fillPeriodRows(db, ended, ctx, "EXTEND");

  const counts = await cancelPeriodRows(db, periodId, ctx.actorUserId, returnDate);
  await db.$executeRawUnsafe(
    `UPDATE "RegularAbsencePeriod"
        SET status = 'ENDED', "returnDate" = $2::date, "endedByUserId" = $3,
            "coveredUntil" = LEAST("coveredUntil", $2::date - 1), "updatedAt" = now()
      WHERE id = $1`,
    periodId, returnDate, ctx.actorUserId,
  );
  const message = [
    `복귀일 ${returnDate} 저장`,
    cancelResultMessage(counts),
    fill && fill.counts.created ? `복귀 전 결석 ${fill.counts.created}회 추가` : "",
  ].filter(Boolean).join(" · ");
  return { periodId, studentId: period.studentId, counts, message };
}

// ── 3) 등록 취소(잘못 등록) ──
export async function cancelAbsencePeriodInTx(db: AbsencePeriodDb, input: { periodId: string }, ctx: Pick<PeriodContext, "actorUserId">) {
  const periodId = String(input.periodId ?? "").trim();
  if (!periodId) throw new Error("기간 결석을 찾을 수 없습니다.");
  await lockCompensation(db);
  const period = await readPeriodForUpdate(db, periodId);
  if (period.status === "CANCELLED") throw new Error("이미 등록 취소된 기간 결석입니다.");
  const counts = await cancelPeriodRows(db, periodId, ctx.actorUserId, null);
  await db.$executeRawUnsafe(
    `UPDATE "RegularAbsencePeriod" SET status = 'CANCELLED', "endedByUserId" = $2, "updatedAt" = now() WHERE id = $1`,
    periodId, ctx.actorUserId,
  );
  return { periodId, studentId: period.studentId, counts, message: `등록 취소 · ${cancelResultMessage(counts)}` };
}

// ── 4) 매일 연장(크론) ──
/**
 * 크론이 다시 볼 기간 id — 진행 중(ACTIVE) 중 (1) coveredUntil 이 목표 끝보다 앞서거나
 * (2) 아직 복귀 전(복귀 미정 또는 복귀일이 오늘 이후)인 것. (2)는 기간 도중 새로 수강 시작한 반을 채우기 위해서다.
 */
export async function listPeriodsToExtend(db: AbsencePeriodDb, todayYmd: string): Promise<string[]> {
  if (!(await tableExists(db, "RegularAbsencePeriod"))) return [];
  const rows = await db.$queryRawUnsafe<Array<{ id: string; returnDate: string | null; coveredUntil: string }>>(
    `SELECT id, to_char("returnDate",'YYYY-MM-DD') AS "returnDate", to_char("coveredUntil",'YYYY-MM-DD') AS "coveredUntil"
       FROM "RegularAbsencePeriod" WHERE status = 'ACTIVE' ORDER BY "createdAt"`,
  );
  return rows
    .filter((r) => r.coveredUntil < periodTargetEnd({ returnDate: r.returnDate, todayYmd }) || !r.returnDate || r.returnDate > todayYmd)
    .map((r) => r.id);
}

/** 기간 하나를 목표 끝까지 늘린다(크론이 기간마다 트랜잭션 하나로 부른다). 새로 수강 시작한 반도 포함된다. */
export async function extendAbsencePeriodInTx(db: AbsencePeriodDb, periodId: string, ctx: PeriodContext) {
  await lockCompensation(db);
  const period = await readPeriodForUpdate(db, periodId);
  if (period.status !== "ACTIVE") return { periodId, studentId: period.studentId, created: 0 };
  // 크론이 만든 행도 «그 기간을 등록한 관리자»가 확정한 것으로 남긴다
  const { counts } = await fillPeriodRows(db, period, { ...ctx, actorUserId: period.createdByUserId }, "EXTEND");
  return { periodId, studentId: period.studentId, created: counts.created };
}

// ── 5) 목록 ──
export type AbsencePeriodView = {
  id: string;
  createdByUserId: string;
  reason: string;
  startDate: string;
  returnDate: string | null;
  note: string | null;
  status: string;
  coveredUntil: string;
  classIds: string[];
  createdAt: string;
  /** 이 기간이 만든 결석 날짜(취소된 것 포함 — 화면에서 구분) */
  absences: { id: string; classId: string; className: string; date: string; status: string }[];
};

export async function listAbsencePeriodsInDb(db: AbsencePeriodDb, studentId: string): Promise<{ available: boolean; periods: AbsencePeriodView[] }> {
  // 마이그레이션 전이면 화면이 깨지지 않게 «아직 사용 불가»로 돌려준다
  if (!(await tableExists(db, "RegularAbsencePeriod"))) return { available: false, periods: [] };
  const periods = await db.$queryRawUnsafe<Array<Omit<AbsencePeriodView, "absences">>>(
    `SELECT ${PERIOD_COLUMNS}, p.note, to_char(p."createdAt" AT TIME ZONE 'Asia/Seoul','YYYY-MM-DD') AS "createdAt"
       FROM "RegularAbsencePeriod" p
      WHERE p."studentId" = $1
      ORDER BY p."startDate" DESC, p."createdAt" DESC
      LIMIT 30`,
    studentId,
  );
  if (!periods.length) return { available: true, periods: [] };
  const rows = await db.$queryRawUnsafe<Array<{ id: string; periodId: string; classId: string; className: string; date: string; status: string }>>(
    `SELECT ra.id, ra."periodId" AS "periodId", ra."classId" AS "classId", c.name AS "className",
            to_char(ra.date,'YYYY-MM-DD') AS date, ra.status
       FROM "RegularAbsence" ra JOIN "Class" c ON c.id = ra."classId"
      WHERE ra."studentId" = $1 AND ra."periodId" = ANY($2::text[])
      ORDER BY ra.date, c.name`,
    studentId, periods.map((p) => p.id),
  );
  return {
    available: true,
    periods: periods.map((p) => ({
      ...p,
      classIds: p.classIds ?? [],
      absences: rows.filter((r) => r.periodId === p.id).map(({ periodId: _omit, ...rest }) => rest),
    })),
  };
}
