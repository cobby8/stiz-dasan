/**
 * 방학특강 수강 자동 종료 — 순수 판정 규칙.
 *
 * 왜 따로 두는가: DB 없이 날짜 비교만 실행 테스트로 못박으려고 import 를 하나도 두지 않는다.
 * (tests/seasonal-auto-end.test.mjs 가 이 파일을 그대로 변환해 실행한다)
 *
 * 날짜는 모두 KST 달력 날짜 "YYYY-MM-DD" 문자열이다. 같은 형식끼리는 글자 비교가 곧 날짜 비교다.
 */

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

export type SeasonalClassEndDecision = {
  /** true 면 이 반의 ACTIVE·PAUSED 수강을 퇴원(WITHDRAWN) 처리해도 된다. */
  ended: boolean;
  /** 연결된 모든 특강 중 가장 늦은 마지막 회차 날짜(KST). 판정 불가면 null. */
  lastYmd: string | null;
};

/**
 * 한 특강 전용 반이 "완전히 끝났는지" 판정한다.
 *
 * @param offeringLastYmds 이 반에 연결된(linkedClassId) 특강마다의 마지막 날짜(KST).
 *   마지막 회차 endsAt 의 최대값, 회차가 없으면 시즌 endsAt 이다.
 * @param todayYmd 오늘(KST).
 *
 * 규칙
 *  - 연결된 특강이 하나도 없으면 끝났다고 보지 않는다(정보가 없으면 건드리지 않는다).
 *  - 날짜를 읽을 수 없는 특강이 하나라도 있으면 끝났다고 보지 않는다(안전 쪽).
 *  - 모든 특강의 마지막 날짜가 오늘보다 **이전**이어야 끝난 것이다.
 *    마지막 날 당일은 아직 수업이 있으므로 다음 날 처리된다.
 *    같은 반을 다음 시즌이 재사용해 미래 회차가 있으면 하나라도 걸려 보호된다.
 */
export function decideSeasonalClassEnd(
  offeringLastYmds: ReadonlyArray<string | null | undefined>,
  todayYmd: string,
): SeasonalClassEndDecision {
  if (!YMD_RE.test(String(todayYmd ?? ""))) return { ended: false, lastYmd: null };
  if (offeringLastYmds.length === 0) return { ended: false, lastYmd: null };

  let lastYmd: string | null = null;
  for (const ymd of offeringLastYmds) {
    // 한 특강이라도 날짜를 모르면 판정하지 않는다.
    if (!ymd || !YMD_RE.test(ymd)) return { ended: false, lastYmd: null };
    if (lastYmd === null || ymd > lastYmd) lastYmd = ymd;
  }
  return { ended: lastYmd !== null && lastYmd < todayYmd, lastYmd };
}
