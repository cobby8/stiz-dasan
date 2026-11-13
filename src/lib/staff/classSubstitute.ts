// 대타 선생님 지정(f4, 2026-11-13) — 순수 판정 규칙.
//
// 원장·부원장이 «날짜 · 반 · 대타 선생님»을 지정하면 **그 날짜에만** 그 선생님이 그 반 출석부를 열고 출석을 찍는다.
// 원래 담당 선생님 권한은 그대로 둔다(빼지 않는다).
//
// 왜 한 파일에 모으는가: «이 날짜에 대타 권한이 있나»는 홈 목록·출석부 열기·출석 저장·사진 보기가 모두 같은 답을 내야 한다.
//   한쪽만 다르면 «화면은 보이는데 저장이 막히는» 갈림이 생긴다 → 여기서 정하고 tests/class-substitute.test.mjs 로 실행 검증한다.
//
// ⚠️ prisma·next import 금지(테스트가 이 파일을 그대로 실행한다). 날짜는 @/lib/datetime/kst 만 쓴다.
import { isKstYmd, kstDow, todayKst } from "@/lib/datetime/kst";

/** Class.dayOfWeek 값 형식(시간표와 같은 영문 세 글자). 인덱스 = 0(일)…6(토). */
export const CLASS_DAY_KEYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/**
 * 대타 지정 날짜(substituteDate)가 확인하려는 날짜(onDate)에 권한을 주는가.
 * - 둘 다 실재하는 "YYYY-MM-DD" 이고 **같은 날**일 때만 true.
 * - 다른 날(어제·내일)은 false — 대타 권한은 그날 하루뿐이다.
 */
export function substituteGrantsAccess(substituteDate: unknown, onDate: unknown): boolean {
  if (!isKstYmd(substituteDate) || !isKstYmd(onDate)) return false;
  return substituteDate === onDate;
}

/**
 * 지금 시각 기준 «오늘(KST)»에 대타 권한이 있는가.
 * 서버 시계는 UTC 라서 반드시 todayKst 로 바꿔 비교한다(KST 00:00~09:00 에 어제가 나오는 사고 방지).
 */
export function substituteActiveNow(substituteDate: unknown, nowMs: number = Date.now()): boolean {
  return substituteGrantsAccess(substituteDate, todayKst(nowMs));
}

/**
 * 출석부 권한 판정에 쓰는 최종 규칙(보안 검수 HIGH 1).
 * 대타 행 날짜 == 판정 날짜(수업 기록·요청 날짜) == **오늘(KST)** 일 때만 true.
 * 그날 기록 ID 를 들고 다음 날 다시 와도 «오늘»이 바뀌어 닫힌다 — 유예 없음(KST 자정에 닫힘).
 */
export function substituteAllowedNow(substituteDate: unknown, onDate: unknown, nowMs: number = Date.now()): boolean {
  return substituteGrantsAccess(substituteDate, onDate) && substituteActiveNow(onDate, nowMs);
}

/**
 * 대타가 될 수 있는 계정 조건(SQL 조각, 별칭 u = "User").
 * 주 역할 선생님(INSTRUCTOR) 또는 선생님 추가 역할 승인(ACTIVE), 탈퇴 제외.
 * 관리자 지정(서버 액션)과 **판정 시점**(staff-class-access) 양쪽이 같은 조건을 쓴다 —
 * 지정 뒤에 선생님 역할이 회수되면 그 즉시 대타 권한도 사라진다(보안 검수 HIGH 2).
 */
export const SUBSTITUTE_TEACHER_SQL = `
    u."withdrawnAt" IS NULL
    AND (
      u.role = 'INSTRUCTOR'
      OR EXISTS (
        SELECT 1 FROM "UserRoleGrant" g
         WHERE g."userId" = u.id AND g.role = 'INSTRUCTOR' AND g.status = 'ACTIVE'
      )
    )`;

/** 그날 특강 회차가 연결된 반에 대타를 지정하려 할 때의 안내(검수 M1). */
export const SEASONAL_SUBSTITUTE_MESSAGE = "그날 특강 회차가 있는 반은 대타 대신 특강 담당 강사를 바꿔 주세요.";

/**
 * 관리자가 대타를 지정할 때 입력 확인. 문제가 없으면 null, 있으면 화면에 보일 안내 문장.
 * - 날짜 형식·실재 여부
 * - 지난 날짜 금지(오늘은 가능)
 * - 그 반이 수업하는 요일과 같은 날이어야 한다 — 다른 요일이면 홈 «오늘 수업»에 반이 안 떠서 지정이 헛돈다.
 */
export function validateSubstituteInput(input: {
  date: string;
  classDayOfWeek: string | null | undefined;
  today: string;
}): string | null {
  if (!isKstYmd(input.date)) return "날짜를 다시 골라 주세요.";
  if (input.date < input.today) return "지난 날짜에는 대타를 지정할 수 없습니다.";
  const dayKey = CLASS_DAY_KEYS[kstDow(input.date)];
  if (!input.classDayOfWeek || input.classDayOfWeek !== dayKey) {
    return "그 반의 수업 요일과 날짜의 요일이 다릅니다.";
  }
  return null;
}
