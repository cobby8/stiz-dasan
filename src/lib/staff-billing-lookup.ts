/**
 * 선생님 «청구» 탭 조회 규칙 — 순수 함수만 둔다(DB·화면 없이 테스트로 실행할 수 있게).
 *
 * 왜 따로 빼는가: 달 값은 주소창(?month=)으로 들어오는 «바깥 입력»이라 그대로 믿으면 안 되고,
 * 달 이동(12월 → 1월)은 눈으로 읽어서는 틀린 곳을 못 찾는다. 그래서 실행 테스트가 붙는 한 곳에 모은다.
 * 달력 계산은 공용 모듈(datetime/kst)의 addMonthsYm 만 쓴다(여기서 새로 만들지 않는다).
 */
// ⚠️ node 타입 제거 실행으로 테스트하므로 '@/' 경로를 쓰지 않는다(런타임 import 는 .ts 확장자).
// @ts-expect-error -- Node 타입 제거 기반 단위 테스트는 런타임 확장자를 요구한다.
import { addMonthsYm } from "./datetime/kst.ts";

// "YYYY-MM" 만 통과(01~12월). 숫자·하이픈 외 글자가 섞이면 전부 거른다.
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/** 조회할 수 있는 가장 이른 달(사이트 운영 이전 달은 볼 것이 없다) */
export const STAFF_BILLING_MIN_MONTH = "2024-01";
/** 이번 달 기준 몇 달 뒤까지 볼 수 있는가(다음 달 청구를 미리 발행하는 경우까지) */
export const STAFF_BILLING_FUTURE_MONTHS = 2;

export function isBillingMonth(value: unknown): value is string {
  return typeof value === "string" && MONTH_RE.test(value);
}

/**
 * 주소창에서 받은 달 값을 검사한다. 형식이 틀리거나 범위를 벗어나면 이번 달로 돌린다.
 * - currentMonth: 이번 달(KST) "YYYY-MM" — 부르는 쪽이 todayKst() 로 만들어 넘긴다.
 * - 배열(?month=a&month=b)·빈 값·SQL 조각 같은 이상한 값은 전부 이번 달.
 */
export function resolveBillingMonth(raw: unknown, currentMonth: string): string {
  if (!isBillingMonth(raw)) return currentMonth;
  // "YYYY-MM" 은 자릿수가 같아 글자 비교가 곧 날짜 순서다
  const max = addMonthsYm(currentMonth, STAFF_BILLING_FUTURE_MONTHS);
  if (raw < STAFF_BILLING_MIN_MONTH || (max && raw > max)) return currentMonth;
  return raw;
}

/** 이전·다음 달로 옮긴다. 볼 수 있는 범위를 벗어나면 null(버튼을 잠근다). */
export function shiftBillingMonth(month: string, delta: number, currentMonth: string): string | null {
  const next = addMonthsYm(month, delta);
  if (!next) return null;
  return resolveBillingMonth(next, currentMonth) === next ? next : null;
}

/** SQL 에 넘길 숫자(연·월). 검사를 통과한 달만 넣는다. */
export function splitBillingMonth(month: string): { year: number; month: number } {
  const [year, mon] = month.split("-").map(Number);
  return { year, month: mon };
}

/** "2026-11" → "2026년 11월" */
export function billingMonthLabel(month: string): string {
  if (!isBillingMonth(month)) return "";
  const { year, month: mon } = splitBillingMonth(month);
  return `${year}년 ${mon}월`;
}

/**
 * 반 정보(classId)가 없는 옛 월 수강료를 이 직원에게 보여도 되는가.
 *
 * 예전 규칙은 «학생이 내 반을 하나라도 들으면 보인다»여서, 두 선생님 반을 같이 듣는 학생의
 * 청구가 양쪽 선생님에게 모두 보였다. 어느 반 청구인지 알 수 없는 돈은
 * «그 학생이 듣는 활성 반이 전부 내 담당»일 때만 내 것으로 본다
 * (한 선생님이 그 학생의 두 반을 모두 맡으면 보이고, 남의 반이 하나라도 섞이면 원장·부원장만).
 * 원장·부원장(모든 반)은 지금처럼 전부 본다.
 *
 * 아래 unlinkedMonthlyBillScopeSql 과 같은 규칙이다 — 한쪽을 고치면 양쪽을 같이 고친다.
 */
export function canSeeUnlinkedMonthlyBill(input: {
  canAccessAllClasses: boolean;
  /** 그 학생의 활성 수강 반 id 전부 */
  studentActiveClassIds: readonly string[];
  /** 이 직원의 담당 반 id */
  accessibleClassIds: readonly string[];
}): boolean {
  const active = input.studentActiveClassIds;
  // 활성 수강이 없으면 이을 반이 없어 누구에게도 안 보인다
  if (active.length === 0) return false;
  if (input.canAccessAllClasses) return true;
  return active.every((classId) => input.accessibleClassIds.includes(classId));
}

/**
 * 위 판정의 SQL 조각. 청구 탭(getStaffBilling)과 반별 청구 시트(getStaffClassBilling)가 같이 쓴다.
 * 두 쿼리 모두 «내 담당 반의 활성 수강» JOIN 을 이미 걸고 있어 «활성 수강 0개»는 여기 오기 전에 걸러진다.
 * - classIdsParam: 내 담당 반 id 배열 자리("$1" 같은 자리 표시만 — 값을 직접 넣지 않는다)
 * - allClassesParam: 원장·부원장 여부 자리
 */
export function unlinkedMonthlyBillScopeSql(classIdsParam: string, allClassesParam: string): string {
  // 자리 표시("$숫자")만 받는다 — 실수로 값이 문자열에 섞여 들어가는 것을 막는다
  if (!/^\$\d+$/.test(classIdsParam) || !/^\$\d+$/.test(allClassesParam)) {
    throw new Error("SQL 자리 표시($1 형식)만 넘길 수 있습니다.");
  }
  return `(p."classId" IS NOT NULL OR ${allClassesParam}::boolean
               OR NOT EXISTS (SELECT 1 FROM "Enrollment" e2 WHERE e2."studentId"=p."studentId" AND e2.status='ACTIVE' AND NOT (e2."classId"=ANY(${classIdsParam}::text[]))))`;
}

export type BillingLookupFilter = { classId: string; name: string };

/** 받은 목록을 화면에서 거르는 조건(반·학생 이름). 빈 값은 «전체». */
export function matchesBillingLookup(
  bill: { classId: string; studentName: string },
  filter: BillingLookupFilter,
): boolean {
  if (filter.classId && bill.classId !== filter.classId) return false;
  const keyword = filter.name.trim().toLowerCase();
  if (keyword && !bill.studentName.toLowerCase().includes(keyword)) return false;
  return true;
}

/** «조회 2» 처럼 버튼에 붙일 적용 개수(달을 바꿨는가 + 반 + 이름) */
export function countBillingLookup(month: string, currentMonth: string, filter: BillingLookupFilter): number {
  return (month !== currentMonth ? 1 : 0) + (filter.classId ? 1 : 0) + (filter.name.trim() ? 1 : 0);
}
