// 결석·당일 셔틀 변경 알림의 «기사님 수신자» 판정 — 순수 모듈(외부 import 금지: 테스트가 data URL 로 불러온다).
//
// 6단계(2026-11-09): 저장 노선(RegularDispatchRoute)의 차량 driverUserId 로 기사를 찾던 방식을 없앴다.
//   저장 노선이 거의 없어 대부분 요일이 «담당 기사 확인 필요»(보류)였고, 명단을 고쳐도 반영되지 않았다.
//   이제 기준 = «그날 셔틀 명단에 그 학생이 있으면 현재 기사 역할 전원» — 명단 변경 기사님 알림
//   (regularRosterNotify.notifyDriversOfRosterChange)과 같은 기사 조건(주 역할 DRIVER 또는 승인된 추가 역할, 탈퇴 제외).

export type RosterDriverResolution = {
  driverIds: string[];
  needsConfirmation: boolean;
};

const DAY_OF_WEEK = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
// 알림 방향 → 명단 방향(등원 BOARD / 하원 ALIGHT).
const ROSTER_DIRECTION = { PICKUP: "BOARD", DROPOFF: "ALIGHT" } as const;

export function buildDriverLookupContext(serviceDate: string, direction?: "PICKUP" | "DROPOFF" | "BOTH") {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(serviceDate);
  if (!m) return null;
  // 요일은 시간대를 개입시키지 않는 Date.UTC 로 계산한다(KST 규칙 — kst.ts kstDow 와 같은 방식).
  const date = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  // 2026-02-30 처럼 넘친 날짜는 거른다.
  if (Number.isNaN(date.getTime()) || date.getUTCDate() !== Number(m[3]) || date.getUTCMonth() !== Number(m[2]) - 1) return null;
  const directions: Array<"PICKUP" | "DROPOFF"> = direction && direction !== "BOTH" ? [direction] : ["PICKUP", "DROPOFF"];
  const weekday = date.getUTCDay();
  return {
    serviceMonth: serviceDate.slice(0, 7),
    dayOfWeek: DAY_OF_WEEK[weekday],
    weekday,
    directions,
    rosterDirections: directions.map((d) => ROSTER_DIRECTION[d]),
  };
}

/**
 * 조회 결과(그날 명단에 학생이 있을 때만 채워진 현재 기사 id 목록)로 수신자를 정한다.
 * 비어 있으면(명단에 없음·기사 계정 없음) 아무에게도 보내지 않고 원장 알림에 «담당 기사 확인 필요»를 붙인다.
 */
export function selectRosterDriverIds(driverIds: readonly (string | null | undefined)[]): RosterDriverResolution {
  const ids = [...new Set(driverIds.filter((id): id is string => typeof id === "string" && id.trim() !== ""))];
  return ids.length ? { driverIds: ids, needsConfirmation: false } : { driverIds: [], needsConfirmation: true };
}
