// 보강 판정에 쓰는 «학생 학년» 한 곳 — 순수 함수(DB·시계 없음).
// 실행 테스트: tests/makeup-grade-by-birth.test.mjs
//
// 왜 따로 두나(2026-11-14 원장 결정):
//   예전에는 Student.grade 글자 칸만 읽어, 그 칸이 빈 학생과 «성인»은 «학년 정보가 없어 수업을 고를 수 없습니다»로 막혔다.
//   아이 정보 화면은 생년월일로 학년을 계산한다(statsRules.schoolGradeNumber — KST 3월 학년도).
//   같은 학생이 화면마다 다른 학년이 되지 않게, 보강도 같은 계산 함수를 쓴다.
//
// 순서: ① 생년월일로 계산 → ② 계산할 수 없으면(빈 값·오입력·임시 생일) Student.grade 글자.
import { schoolGradeNumber } from "@/lib/stats/statsRules";
import { MAKEUP_ADULT_GRADE, makeupGradeFromText } from "./credit-rules";

/**
 * 생년월일을 모를 때 넣어 둔 임시값. birthDate 가 NOT NULL 칸이라 일괄 등록이 이 날짜를 채운다
 * (actions/admin.ts «생년월일이 없으면 기본값(2000-01-01)»). 진짜 생일이 아니므로 학년 계산에서 뺀다.
 */
export const PLACEHOLDER_BIRTH_YMD = "2000-01-01";

/**
 * 보강 판정용 학생 학년(숫자): 5세=-2 · 6세=-1 · 7세=0 · 초1=1 … 고3=12 · 성인=13. 알 수 없으면 null.
 *
 * @param birthYmd  생년월일 "YYYY-MM-DD"(KST 달력 날짜)
 * @param gradeText Student.grade 글자("초5"·"성인"·빈 값)
 * @param todayYmd  오늘 "YYYY-MM-DD"(KST) — 학년도는 3월 1일에 바뀐다
 */
export function studentMakeupGrade(
  birthYmd: string | null | undefined,
  gradeText: string | null | undefined,
  todayYmd: string,
): number | null {
  if (birthYmd && birthYmd !== PLACEHOLDER_BIRTH_YMD) {
    const n = schoolGradeNumber(birthYmd, todayYmd);
    // 13 이상(고등학교를 마친 나이)은 모두 성인 하나로 모은다
    if (n != null) return n >= MAKEUP_ADULT_GRADE ? MAKEUP_ADULT_GRADE : n;
  }
  return makeupGradeFromText(gradeText);
}
