// 중복 학생 병합 "판단 규칙"만 모은 순수 모듈.
// 왜 따로 떼는가: 여기서 한 번 잘못 판단하면 8월 청구 금액이 통째로 날아간다.
// DB나 `@/` 별칭에 의존하지 않게 만들어야 node 내장 테스트 러너로 직접 돌려볼 수 있다.
// (프로젝트 관례: 돈이 걸린 계산 규칙은 순수 모듈로 분리해 회귀 테스트한다.)

// 타입만 가져온다 — 실행 시에는 지워지므로 node 테스트 러너에서도 그대로 돈다.
import type { StudentRefTable } from "./tables";

/** 수강 상태 우선순위. 숫자가 클수록 "더 살아있는" 상태다. */
export const ENROLLMENT_STATUS_PRIORITY: Record<string, number> = {
  ACTIVE: 3,
  PAUSED: 2,
  WITHDRAWN: 1,
};

/** 충돌해서 밀려난 수강 행에 찍을 상태. 지우지 않고 상태만 낮춘다. */
export const SOFT_SKIP_STATUS = "WITHDRAWN";

/**
 * 청구 동결 기준월. 이 달(포함) 이후의 Payment/PaymentInvoice는 절대 이동시키지 않는다.
 * 8월 청구는 이미 사람이 확정한 결과라, 병합이 건드리는 순간 금액이 흔들린다.
 */
export const BILLING_FREEZE_FROM = { year: 2026, month: 8 } as const;

export type EnrollmentRow = {
  id: string;
  classId: string;
  status: string;
};

export type MergeCandidate = {
  id: string;
  /** 동결 기준월 이후에 살아있는(취소 아님) 청구 건수 */
  liveBillingCountFromFreeze: number;
  /** 살아있는 자식 기록 수 (원장/시트원본/셔틀/로스터 등 합계) */
  liveChildRowCount: number;
  /** 생성 시각 (ISO 문자열). 동률일 때만 쓰는 최후 기준 */
  createdAt: string;
  enrollments: EnrollmentRow[];
};

export type RepresentativeRule = "FROZEN_BILLING" | "CHILD_ROWS" | "CREATED_FIRST";

export type RepresentativeChoice = {
  winnerId: string;
  loserId: string;
  rule: RepresentativeRule;
  reason: string;
};

/** 알 수 없는 상태값은 가장 낮게 본다(모르면 함부로 살리지 않는다). */
export function statusPriority(status: string): number {
  return ENROLLMENT_STATUS_PRIORITY[status] ?? 0;
}

/**
 * 대표 레코드 선정.
 * 1순위: 동결 기준월(2026-08) 이후 확정 청구가 붙어 있는 쪽 → 청구를 한 건도 옮기지 않아도 된다.
 * 2순위: 살아있는 자식 기록이 많은 쪽 → 옮길 행이 적어 사고 여지가 작다.
 * 3순위: 먼저 만들어진 쪽.
 *
 * 양쪽 모두 동결월 청구를 갖고 있으면 자동 판단이 불가능하다(둘 다 청구가 확정된 상태).
 * 이때는 조용히 하나를 고르지 않고 예외를 던져 사람이 보게 한다.
 */
export function chooseRepresentative(a: MergeCandidate, b: MergeCandidate): RepresentativeChoice {
  if (a.liveBillingCountFromFreeze > 0 && b.liveBillingCountFromFreeze > 0) {
    throw new Error(
      `동결월 청구가 양쪽에 모두 있어 자동 대표 선정 불가: ${a.id} / ${b.id}`,
    );
  }

  if (a.liveBillingCountFromFreeze !== b.liveBillingCountFromFreeze) {
    const [win, lose] =
      a.liveBillingCountFromFreeze > b.liveBillingCountFromFreeze ? [a, b] : [b, a];
    return {
      winnerId: win.id,
      loserId: lose.id,
      rule: "FROZEN_BILLING",
      reason: `${BILLING_FREEZE_FROM.year}-${BILLING_FREEZE_FROM.month} 확정 청구 ${win.liveBillingCountFromFreeze}건이 붙어 있어 청구를 옮기지 않아도 된다`,
    };
  }

  if (a.liveChildRowCount !== b.liveChildRowCount) {
    const [win, lose] = a.liveChildRowCount > b.liveChildRowCount ? [a, b] : [b, a];
    return {
      winnerId: win.id,
      loserId: lose.id,
      rule: "CHILD_ROWS",
      reason: `살아있는 기록이 더 많다 (${win.liveChildRowCount}행 vs ${lose.liveChildRowCount}행)`,
    };
  }

  const [win, lose] = a.createdAt <= b.createdAt ? [a, b] : [b, a];
  return {
    winnerId: win.id,
    loserId: lose.id,
    rule: "CREATED_FIRST",
    reason: `청구·기록이 동률이라 먼저 만들어진 행을 대표로 둔다 (${win.createdAt})`,
  };
}

export type EnrollmentPromotion = {
  enrollmentId: string;
  classId: string;
  fromStatus: string;
  toStatus: string;
};

export type EnrollmentMove = {
  enrollmentId: string;
  classId: string;
  status: string;
};

export type EnrollmentSoftSkip = {
  enrollmentId: string;
  classId: string;
  fromStatus: string;
  toStatus: string;
  /** 같은 반에서 살아남은 대표 쪽 행 */
  supersededBy: string;
};

export type EnrollmentPlan = {
  /** 대표 쪽 행의 상태를 올린다 (흡수 쪽이 더 살아있는 상태였을 때) */
  promote: EnrollmentPromotion[];
  /** 대표에게 같은 반이 없어서 그대로 옮기는 행 */
  move: EnrollmentMove[];
  /** UNIQUE(studentId, classId) 때문에 못 옮기는 행. 흡수 쪽에 남기고 상태만 낮춘다 */
  softSkip: EnrollmentSoftSkip[];
};

/**
 * Enrollment 병합 계획.
 *
 * `Enrollment_studentId_classId_key` UNIQUE 때문에 같은 반이 양쪽에 있으면 그냥 옮길 수 없다.
 * 그래서 반(classId)마다 한 행만 남기되, 하드 DELETE는 하지 않는다.
 * - 대표 쪽이 더 살아있으면: 흡수 쪽 행을 흡수 학생에 남긴 채 상태만 낮춘다(softSkip).
 * - 흡수 쪽이 더 살아있으면: 대표 쪽 행의 상태를 그 값으로 올리고(promote), 흡수 쪽은 softSkip.
 *   → 행을 옮기는 대신 "상태만 승계"하므로 UNIQUE를 건드리지 않는다.
 */
export function planEnrollmentMerge(
  winnerRows: readonly EnrollmentRow[],
  loserRows: readonly EnrollmentRow[],
): EnrollmentPlan {
  const winnerByClass = new Map<string, EnrollmentRow>();
  for (const row of winnerRows) winnerByClass.set(row.classId, row);

  const plan: EnrollmentPlan = { promote: [], move: [], softSkip: [] };

  for (const loser of loserRows) {
    const rival = winnerByClass.get(loser.classId);

    if (!rival) {
      // 대표에게 없는 반 → 충돌 없음. 그대로 옮긴다.
      plan.move.push({ enrollmentId: loser.id, classId: loser.classId, status: loser.status });
      continue;
    }

    if (statusPriority(loser.status) > statusPriority(rival.status)) {
      plan.promote.push({
        enrollmentId: rival.id,
        classId: rival.classId,
        fromStatus: rival.status,
        toStatus: loser.status,
      });
    }

    plan.softSkip.push({
      enrollmentId: loser.id,
      classId: loser.classId,
      fromStatus: loser.status,
      toStatus: SOFT_SKIP_STATUS,
      supersededBy: rival.id,
    });
  }

  return plan;
}

/**
 * 병합이 끝난 뒤 대표 학생이 갖게 될 반별 최종 상태.
 * "박하준은 3개 반 ACTIVE여야 한다" 같은 원장님 확인 사항을 시뮬레이션에서 검산할 때 쓴다.
 */
export function finalEnrollmentStatuses(
  winnerRows: readonly EnrollmentRow[],
  plan: EnrollmentPlan,
): Map<string, string> {
  const result = new Map<string, string>();
  for (const row of winnerRows) result.set(row.classId, row.status);
  for (const p of plan.promote) result.set(p.classId, p.toStatus);
  for (const m of plan.move) result.set(m.classId, m.status);
  return result;
}

/** 최종 ACTIVE 반 개수 */
export function countActive(statuses: Map<string, string>): number {
  let n = 0;
  for (const status of statuses.values()) if (status === "ACTIVE") n += 1;
  return n;
}

/**
 * 청구 행(Payment / PaymentInvoice)을 옮겨도 되는 달인지.
 * 2026-08 이상이면 무조건 false. 미래 달(9월 이후)도 함께 막는다.
 */
export function isBillingRowMovable(year: number, month: number): boolean {
  if (year > BILLING_FREEZE_FROM.year) return false;
  if (year < BILLING_FREEZE_FROM.year) return true;
  return month < BILLING_FREEZE_FROM.month;
}

/**
 * 흡수 학생의 행(별칭 src) 중 "대표에게 옮겨도 되는 행"만 남기는 WHERE 조각.
 * `SELECT src.id FROM "T" src WHERE src."col" = <흡수> ${moveGuardSql(...)}` 형태로 붙인다.
 * winnerLiteral 은 이미 이스케이프된 SQL 문자열 리터럴이어야 한다.
 *
 * - UNIQUE 충돌: 대표 쪽에 같은 조합이 있으면 옮기지 않는다(부분 UNIQUE면 양쪽이 조건을 만족할 때만).
 * - 남기기 고정: keepOnLoser 가 있으면 한 행도 옮기지 않는다.
 * - 부모 따라가기: 부모 행이 대표 소유일 때만 옮긴다. 부모 연결이 비어 있으면 옮긴다.
 */
export function moveGuardSql(t: StudentRefTable, winnerLiteral: string): string {
  if (t.keepOnLoser) return " AND false";
  let guard = "";

  if (t.conflictKeys?.length) {
    const on = t.conflictKeys
      .map((k) => `(rival."${k}" IS NOT DISTINCT FROM src."${k}")`)
      .join(" AND ");
    const rivalWhere = t.conflictWhere ? ` AND ${t.conflictWhere("rival")}` : "";
    const rivalExists = `EXISTS (
      SELECT 1 FROM "${t.table}" rival
      WHERE rival."${t.column}" = ${winnerLiteral} AND ${on}${rivalWhere}
    )`;
    guard += t.conflictWhere
      ? ` AND NOT (${t.conflictWhere("src")} AND ${rivalExists})`
      : ` AND NOT ${rivalExists}`;
  }

  for (const p of t.followsParents ?? []) {
    guard += ` AND (src."${p.column}" IS NULL OR EXISTS (
      SELECT 1 FROM "${p.parentTable}" parent
      WHERE parent.id = src."${p.column}" AND parent."studentId" = ${winnerLiteral}
    ))`;
  }

  return guard;
}

/**
 * 충돌한 두 행 중 흡수 쪽 상태가 더 살아있어 대표 쪽이 승계해야 하는지.
 * 모르는 상태(우선순위 표에 없음)는 0 — 흡수 쪽이 모르는 값이면 승계하지 않는다.
 */
export function shouldPromoteOnConflict(
  priority: Record<string, number>,
  winnerStatus: string | null,
  loserStatus: string | null,
): boolean {
  const w = priority[winnerStatus ?? ""] ?? 0;
  const l = priority[loserStatus ?? ""] ?? 0;
  return l > w;
}

/**
 * UNIQUE 충돌 쌍(대표 행 w, 흡수 행 l)과 승계할 컬럼 값을 함께 읽는 SELECT.
 * 결과 컬럼: "winnerRowId", "loserRowId", 그리고 승계 컬럼마다 "w:<컬럼>", "l:<컬럼>" (text).
 */
export function conflictPairsSql(
  t: StudentRefTable,
  winnerLiteral: string,
  loserLiteral: string,
): string {
  const promo = t.promoteOnConflict;
  if (!promo || !t.conflictKeys?.length) {
    throw new Error(`${t.table}: promoteOnConflict 에는 conflictKeys 가 필요하다`);
  }
  const on = t.conflictKeys
    .map((k) => `(w."${k}" IS NOT DISTINCT FROM l."${k}")`)
    .join(" AND ");
  const cols = promo.copyColumns
    .map((c) => `w."${c}"::text AS "w:${c}", l."${c}"::text AS "l:${c}"`)
    .join(", ");
  return `SELECT w.id AS "winnerRowId", l.id AS "loserRowId", ${cols}
     FROM "${t.table}" l
     JOIN "${t.table}" w ON w."${t.column}" = ${winnerLiteral} AND ${on}
    WHERE l."${t.column}" = ${loserLiteral}
    ORDER BY l.id`;
}

/** 대표 행이 흡수 행의 값을 승계하는 UPDATE (updatedAt 은 그대로 둔다) */
export function promoteRowSql(
  t: StudentRefTable,
  winnerRowLiteral: string,
  loserRowLiteral: string,
): string {
  const promo = t.promoteOnConflict;
  if (!promo) throw new Error(`${t.table}: promoteOnConflict 설정이 없다`);
  const sets = promo.copyColumns.map((c) => `"${c}" = l."${c}"`).join(", ");
  return `UPDATE "${t.table}" w SET ${sets}
     FROM "${t.table}" l
    WHERE w.id = ${winnerRowLiteral} AND l.id = ${loserRowLiteral}`;
}

/** 옮기지 못하고 흡수 쪽에 남긴 행의 로그 사유 */
export function moveSkipNote(t: StudentRefTable): string {
  if (t.keepOnLoser) return t.keepOnLoser;
  const reasons: string[] = [];
  if (t.conflictKeys?.length) reasons.push(`UNIQUE(${t.conflictKeys.join(",")}) 충돌`);
  if (t.followsParents?.length) {
    reasons.push(
      `부모 행(${t.followsParents.map((p) => p.parentTable).join("/")})이 흡수 쪽에 남음`,
    );
  }
  return `${reasons.join(" 또는 ") || "이동 조건 불충족"}으로 이동하지 않음`;
}
