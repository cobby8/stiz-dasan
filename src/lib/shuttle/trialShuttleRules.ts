// 체험 셔틀(2026-11-19 원장 결정)의 순수 규칙 — 상태 이름·상태 전이·배정 요청 검증·알림/문자 문구.
// ─────────────────────────────────────────────────────────────────────────────
// 왜 순수 모듈인가?
//   체험 신청서(공개 화면)·관리자 체험 화면·배정 패널·서버가 **같은 상태 이름과 같은 전이 규칙**을 써야 한다.
//   화면마다 따로 쓰면 한쪽만 고쳐져 «배정됨인데 운행표에 없음» 같은 어긋남이 생긴다.
//   DB·React 의존이 없어 테스트가 그대로 실행한다. import 는 날짜 공용 모듈(kst) 하나뿐이다
//   (공개 신청서가 이 파일을 가져가도 다른 셔틀 로직이 따라가지 않게 가볍게 둔다 — 끼울 자리 추천은 trialShuttlePlacement.ts).
//
// 정책(원장):
//   - 체험 셔틀은 무료 · 체험 날 하루만. 정규 명단(RegularShuttleStop)·청구와 이어지지 않는다.
//   - 운행 지역은 사이트가 막지 않는다. 관리자가 보고 «셔틀 어려움»으로 표시할 수 있다.
//   - 학부모 문자는 관리자가 미리보기 뒤 직접 눌러야 나간다(자동 발송 없음).

import { kstDow } from "@/lib/datetime/kst";

// ── 상태 ─────────────────────────────────────────────────────────

/** TrialLead.shuttleStatus — DB CHECK 와 같은 집합(테스트가 마이그레이션 SQL 과 비교한다). */
export const TRIAL_SHUTTLE_STATUSES = ["NONE", "REQUESTED", "ASSIGNED", "UNAVAILABLE"] as const;
export type TrialShuttleStatus = (typeof TRIAL_SHUTTLE_STATUSES)[number];

/** TrialLead.shuttleDirection — DB CHECK 와 같은 집합. */
export const TRIAL_SHUTTLE_DIRECTIONS = ["BOTH", "PICKUP", "DROPOFF"] as const;
export type TrialShuttleDirection = (typeof TRIAL_SHUTTLE_DIRECTIONS)[number];

/** 하루 탑승 한 줄의 방향 — 정규 명단(RegularShuttleStop.direction)과 같은 값. */
export type TrialRideDirection = "BOARD" | "ALIGHT";

export function isTrialShuttleStatus(value: unknown): value is TrialShuttleStatus {
  return typeof value === "string" && (TRIAL_SHUTTLE_STATUSES as readonly string[]).includes(value);
}

/** 모르는 값·빈 값은 «요청 없음»으로 본다(칸이 아직 없는 옛 행 포함). */
export function normalizeTrialShuttleStatus(value: unknown): TrialShuttleStatus {
  return isTrialShuttleStatus(value) ? value : "NONE";
}

/** 화면에 보일 상태 글자. */
export function trialShuttleStatusLabel(status: unknown): string {
  switch (normalizeTrialShuttleStatus(status)) {
    case "REQUESTED": return "셔틀 배정 대기";
    case "ASSIGNED": return "셔틀 배정됨";
    case "UNAVAILABLE": return "셔틀 어려움";
    default: return "셔틀 요청 없음";
  }
}

/** 상태색 종류(색 하나에 뜻 하나) — 대기=주의, 배정됨=완료, 어려움=보류, 없음=보류. */
export function trialShuttleStatusTone(status: unknown): "warning" | "success" | "neutral" {
  const s = normalizeTrialShuttleStatus(status);
  return s === "REQUESTED" ? "warning" : s === "ASSIGNED" ? "success" : "neutral";
}

export function trialShuttleDirectionLabel(direction: unknown): string {
  return direction === "PICKUP" ? "등원만" : direction === "DROPOFF" ? "하원만" : direction === "BOTH" ? "등원·하원" : "방향 미정";
}

export function trialRideDirectionLabel(direction: TrialRideDirection): string {
  return direction === "BOARD" ? "등원" : "하원";
}

/** 요청 방향 → 배정할 탑승 방향 목록. 방향을 모르면 등·하원 둘 다 보여 준다(관리자가 고른다). */
export function requestedRideDirections(direction: unknown): TrialRideDirection[] {
  if (direction === "PICKUP") return ["BOARD"];
  if (direction === "DROPOFF") return ["ALIGHT"];
  return ["BOARD", "ALIGHT"];
}

// ── 상태 전이 ─────────────────────────────────────────────────────

/**
 * 셔틀 «요청»이 저장·수정될 때의 다음 상태(신청서·관리자 입력 — B 의 저장 코드가 쓴다).
 *   - 요청을 끄면 NONE.
 *   - 요청이 켜져 있으면: 이미 배정됐고 요청 내용(방향·위치)이 그대로면 ASSIGNED 유지,
 *     내용이 바뀌었으면 REQUESTED(«다시 배정 필요»). 그 밖(없음·대기·어려움)은 REQUESTED.
 *   - «셔틀 어려움»으로 표시된 건은 요청 내용이 바뀌지 않았으면 그대로 둔다(같은 요청을 다시 대기로 올리지 않는다).
 * ⚠️ 결과가 ASSIGNED 가 아닌데 지금이 ASSIGNED 였다면 호출부가 releaseTrialShuttleOnLeadChange 로 하루 탑승도 풀어야 한다.
 */
export function nextShuttleStatusOnRequestChange(input: {
  current: unknown;
  needed: boolean;
  /** 방향·위치가 이전 저장값과 달라졌는가(처음 요청이면 true) */
  requestChanged: boolean;
}): TrialShuttleStatus {
  if (!input.needed) return "NONE";
  const current = normalizeTrialShuttleStatus(input.current);
  if (!input.requestChanged && (current === "ASSIGNED" || current === "UNAVAILABLE")) return current;
  return "REQUESTED";
}

/** 하루 탑승이 풀린 이유. */
export const TRIAL_SHUTTLE_RELEASE_REASONS = [
  "RESCHEDULED",     // 체험 일정(날짜·시간·반) 변경
  "CANCELLED",       // 체험 취소
  "LOST",            // 이탈
  "REQUEST_CHANGED", // 셔틀 요청 내용 변경·요청 취소
  "ADMIN_RELEASE",   // 관리자가 «배정 풀기»
  "UNAVAILABLE",     // 관리자가 «셔틀 어려움»으로 표시
] as const;
export type TrialShuttleReleaseReason = (typeof TRIAL_SHUTTLE_RELEASE_REASONS)[number];

export function isTrialShuttleReleaseReason(value: unknown): value is TrialShuttleReleaseReason {
  return typeof value === "string" && (TRIAL_SHUTTLE_RELEASE_REASONS as readonly string[]).includes(value);
}

/**
 * 하루 탑승을 푼 뒤의 상태 — 배정됐던 건은 «배정 대기»(= 셔틀 다시 배정 필요)로 돌아간다.
 * «셔틀 어려움»으로 푸는 경우만 UNAVAILABLE. 요청이 없던 건(NONE)·대기·어려움은 그대로.
 */
export function shuttleStatusAfterRelease(current: unknown, reason: TrialShuttleReleaseReason): TrialShuttleStatus {
  const status = normalizeTrialShuttleStatus(current);
  if (reason === "UNAVAILABLE") return status === "NONE" ? "NONE" : "UNAVAILABLE";
  return status === "ASSIGNED" ? "REQUESTED" : status;
}

/** 체험 신청(TrialLead.status) 중 셔틀을 더 다루지 않는 상태 — 취소·이탈·등록 전환. */
const CLOSED_LEAD_STATUSES = ["CANCELLED", "LOST", "CONVERTED"];

/** 취소·이탈·등록 전환된 신청인가 — 배정 패널이 행동 버튼(배정·셔틀 어려움 등)을 숨기는 기준. */
export function isTrialLeadClosedForShuttle(leadStatus: string | null | undefined): boolean {
  return CLOSED_LEAD_STATUSES.includes(String(leadStatus ?? ""));
}

/**
 * 닫힌 신청인데도 «배정 풀기» 하나만 남길 경우 — 등록 전환(CONVERTED)된 신청에 살아 있는 배정 줄이 있고
 * 그 날짜가 오늘(KST) 이후(오늘 포함)일 때. 전환 당일 «등록하고 부모 차로 간다»면 하원 셔틀을 뺄 길이 있어야 한다.
 * 취소·이탈(CANCELLED·LOST)은 해당 없다(그 줄은 운행표에 이미 안 나온다). 지난 날짜 줄만 있으면 풀 것이 없다.
 * 문자·배정 수정·셔틀 어려움·다시 대기는 이 경우에도 숨긴다 — 풀면 다시 배정할 수 없다(배정 게이트가 막는다).
 */
export function canReleaseConvertedTrialShuttle(input: {
  leadStatus: string | null | undefined;
  /** 살아 있는(ACTIVE) 배정 줄들의 날짜 'YYYY-MM-DD' */
  activeRideDates: readonly string[];
  todayYmd: string;
}): boolean {
  if (String(input.leadStatus ?? "") !== "CONVERTED") return false;
  // 'YYYY-MM-DD' 는 사전순 = 날짜순
  return input.activeRideDates.some((date) => /^\d{4}-\d{2}-\d{2}$/.test(date) && date >= input.todayYmd);
}

/** 등록 전환된 신청의 «배정 풀기» 확인 문구. */
export const CONVERTED_RELEASE_CONFIRM_TEXT = "셔틀 배정을 풀까요? 기사님 운행표에서 빠집니다. 등록 전환된 학생이라 풀면 다시 배정할 수 없습니다.";

/**
 * 알림·문자·운행표에 들어갈 한 줄 글자 다듬기 — 줄바꿈·탭·제어문자를 공백으로 바꾸고 이어진 공백을 하나로.
 * 위치명에 줄바꿈이 섞이면 기사님 푸시·학부모 문자 초안의 줄 모양이 깨지고 다른 줄처럼 보이는 글을 끼울 수 있다.
 */
export function cleanTrialLine(value: unknown): string {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * 하루 탑승 줄을 «그날 운행표»에 내보낼지(기사님 화면·탑승 체크 공통).
 *   - 체험이 취소·이탈되면 내보내지 않는다. **등록 전환(CONVERTED)은 내보낸다** — 체험 당일 수업 뒤 바로 등록하면
 *     아직 돌지 않은 하원 줄이 사라져 아이를 못 태운다(날짜 일치 조건이 «그날 하루»로 묶어 다음 날부터는 안 나온다).
 *   - 배정 상태가 ASSIGNED 일 때만(요청이 고쳐져 «다시 배정 필요»가 된 건은 살아 있는 줄이 남아 있어도 안 나온다).
 *   - 체험 날짜가 바뀌었으면 옛 날짜 줄은 내보내지 않는다(배정 풀기 호출이 빠져도).
 *   - 지난 날짜는 내보내지 않는다 — 체험은 «하루만»이고, 등록하지 않은 아이의 이름·보호자 전화가
 *     운행 링크로 과거 날짜를 넘겨 볼 때 계속 보이면 안 된다.
 */
export function trialRideOnRunSheet(input: {
  leadStatus: string | null | undefined;
  shuttleStatus: unknown;
  /** 하루 탑승의 날짜 'YYYY-MM-DD' */
  serviceDate: string;
  /** 지금 체험 날짜 'YYYY-MM-DD'(KST) */
  scheduledYmd: string | null | undefined;
  todayYmd: string;
}): boolean {
  const leadStatus = String(input.leadStatus ?? "");
  if (leadStatus === "CANCELLED" || leadStatus === "LOST") return false;
  if (normalizeTrialShuttleStatus(input.shuttleStatus) !== "ASSIGNED") return false;
  if (!input.scheduledYmd || input.scheduledYmd !== input.serviceDate) return false;
  // 'YYYY-MM-DD' 는 사전순 = 날짜순
  return input.serviceDate >= input.todayYmd;
}

/**
 * 지금 배정할 수 있는가 — 체험 날짜가 확정돼 있고(지난 날 아님) 신청이 살아 있어야 한다.
 * 안 되면 화면에 그대로 보일 이유를 돌려준다.
 */
export function trialShuttleAssignGate(input: {
  leadStatus: string | null | undefined;
  /** 체험 날짜 'YYYY-MM-DD'(KST). 미정이면 null */
  scheduledYmd: string | null | undefined;
  todayYmd: string;
}): { ok: true } | { ok: false; reason: string } {
  if (CLOSED_LEAD_STATUSES.includes(String(input.leadStatus ?? ""))) {
    return { ok: false, reason: "취소·이탈·등록 전환된 체험 신청은 셔틀을 배정하지 않습니다." };
  }
  if (!input.scheduledYmd || !/^\d{4}-\d{2}-\d{2}$/.test(input.scheduledYmd)) {
    return { ok: false, reason: "일정 확정 뒤 배정할 수 있습니다." };
  }
  // 'YYYY-MM-DD' 는 사전순 = 날짜순
  if (input.scheduledYmd < input.todayYmd) return { ok: false, reason: "체험 날짜가 지나 배정할 수 없습니다." };
  return { ok: true };
}

/**
 * «배정 대기»로 셀 건인가 — 요청이 대기 상태이고 신청이 살아 있을 때. 체험을 이미 다녀간 건(ATTENDED)도 뺀다.
 * 서버 건수(countTrialShuttleWaiting)와 같은 조건이다(서버는 여기에 «체험 날짜가 지나지 않음»을 SQL 로 더 본다).
 */
export function isTrialShuttleWaiting(lead: { shuttleStatus?: unknown; status?: string | null }): boolean {
  const leadStatus = String(lead.status ?? "");
  return normalizeTrialShuttleStatus(lead.shuttleStatus) === "REQUESTED" && !CLOSED_LEAD_STATUSES.includes(leadStatus) && leadStatus !== "ATTENDED";
}

/** «체험 셔틀 배정 대기 N건» — 0건이면 null(아무것도 그리지 않는다). */
export function trialShuttleWaitingLabel(count: number): string | null {
  const n = Math.max(0, Math.floor(Number(count) || 0));
  return n > 0 ? `체험 셔틀 배정 대기 ${n}건` : null;
}

// ── 요청 위치 ─────────────────────────────────────────────────────

export type TrialShuttlePlace = { name: string; address: string; lat: number | null; lng: number | null };

/**
 * 셔틀 «요청 내용»의 도장(방향 + 등·하원 위치 8칸) — 배정 화면이 열 때 받은 도장을 배정 확정 때 돌려보내고,
 * 서버가 지금 값과 다르면 거절한다(화면을 연 뒤 다른 사람이 요청을 고쳤는데 옛 위치로 배정되는 일을 막는다).
 * 비밀 값이 아니라 «같은가»만 보는 글자라 암호 해시를 쓰지 않는다(브라우저·서버·테스트가 같은 함수).
 */
export function trialShuttleRequestStamp(lead: LeadPlaceFields & { shuttleNeeded?: unknown; shuttleDirection?: unknown }): string {
  const parts = [
    lead.shuttleNeeded === true ? "1" : "0", String(lead.shuttleDirection ?? ""),
    lead.shuttlePickupName, lead.shuttlePickupAddress, lead.shuttlePickupLat, lead.shuttlePickupLng,
    lead.shuttleDropoffName, lead.shuttleDropoffAddress, lead.shuttleDropoffLat, lead.shuttleDropoffLng,
  ].map((value) => (value == null ? "" : String(value).trim()));
  // 짧은 지문(FNV-1a 32비트) + 길이 — 위치 글자가 응답에 한 번 더 실리지 않게
  const text = parts.join("\u0001");
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) { hash ^= text.charCodeAt(i); hash = Math.imul(hash, 0x01000193) >>> 0; }
  return `${hash.toString(16).padStart(8, "0")}-${text.length}`;
}

type LeadPlaceFields = {
  shuttlePickupName?: string | null; shuttlePickupAddress?: string | null; shuttlePickupLat?: number | null; shuttlePickupLng?: number | null;
  shuttleDropoffName?: string | null; shuttleDropoffAddress?: string | null; shuttleDropoffLat?: number | null; shuttleDropoffLng?: number | null;
};

function numOrNull(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * 방향별 요청 위치 — 하원 위치 4칸이 전부 비어 있으면 «등원과 같은 곳».
 * 위치명이 없으면 주소를 이름 자리에 미리 채운다(관리자가 배정 때 고친다 — 위치명은 필수).
 */
export function requestedTrialPlace(lead: LeadPlaceFields, direction: TrialRideDirection): TrialShuttlePlace {
  const pickup: TrialShuttlePlace = {
    name: String(lead.shuttlePickupName ?? "").trim(),
    address: String(lead.shuttlePickupAddress ?? "").trim(),
    lat: numOrNull(lead.shuttlePickupLat),
    lng: numOrNull(lead.shuttlePickupLng),
  };
  const dropoff: TrialShuttlePlace = {
    name: String(lead.shuttleDropoffName ?? "").trim(),
    address: String(lead.shuttleDropoffAddress ?? "").trim(),
    lat: numOrNull(lead.shuttleDropoffLat),
    lng: numOrNull(lead.shuttleDropoffLng),
  };
  const dropoffEmpty = !dropoff.name && !dropoff.address && dropoff.lat == null && dropoff.lng == null;
  const place = direction === "ALIGHT" && !dropoffEmpty ? dropoff : pickup;
  // 좌표는 둘 다 있을 때만 쓴다(한쪽만 있으면 지도에 엉뚱한 점이 찍힌다)
  const hasPoint = place.lat != null && place.lng != null;
  return { name: place.name || place.address, address: place.address, lat: hasPoint ? place.lat : null, lng: hasPoint ? place.lng : null };
}

// ── 배정 요청 검증 ─────────────────────────────────────────────────

export const TRIAL_STOP_NAME_MAX = 150;

export type TrialAssignLeg = {
  direction: TrialRideDirection;
  classTime: string;
  afterStopName: string | null;
  stopName: string;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  arriveTime: string;
};

/** 'H:MM'·'HH:MM' → 'HH:MM'. 형식이 아니면 null. */
export function normalizeHhmm(value: unknown): string | null {
  const m = String(value ?? "").trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
  return `${m[1].padStart(2, "0")}:${m[2]}`;
}

/**
 * 화면이 보낸 배정 내용(방향별 한 줄씩)을 검사한다. 통과하면 다듬은 값, 아니면 화면에 그대로 보일 안내.
 * 위치명·예상 시각·운행 묶음은 필수다(원장: «위치명도 적어야 한다»).
 */
export function parseTrialAssignLegs(raw: unknown): { ok: true; legs: TrialAssignLeg[] } | { ok: false; error: string } {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 2) return { ok: false, error: "배정할 방향을 하나 이상 골라 주세요." };
  const legs: TrialAssignLeg[] = [];
  for (const item of raw) {
    const leg = (item ?? {}) as Record<string, unknown>;
    const direction = leg.direction === "BOARD" || leg.direction === "ALIGHT" ? leg.direction : null;
    if (!direction) return { ok: false, error: "등원·하원 방향을 확인해 주세요." };
    const word = trialRideDirectionLabel(direction);
    if (legs.some((x) => x.direction === direction)) return { ok: false, error: `${word}이 두 번 들어 있습니다.` };
    const classTime = cleanTrialLine(leg.classTime);
    if (!classTime || classTime.length > 40) return { ok: false, error: `${word}: 끼울 운행(수업 시간)을 골라 주세요.` };
    // 줄바꿈·제어문자는 공백으로(기사님 푸시·학부모 문자 초안에 그대로 들어가는 글자다)
    const stopName = cleanTrialLine(leg.stopName);
    if (!stopName) return { ok: false, error: `${word}: 위치명을 적어 주세요(예: 롯데캐슬 정문).` };
    if (stopName.length > TRIAL_STOP_NAME_MAX) return { ok: false, error: `${word}: 위치명은 ${TRIAL_STOP_NAME_MAX}자까지 적을 수 있습니다.` };
    const arriveTime = normalizeHhmm(leg.arriveTime);
    if (!arriveTime) return { ok: false, error: `${word}: 예상 시각을 16:40 처럼 적어 주세요.` };
    const latitude = numOrNull(leg.latitude), longitude = numOrNull(leg.longitude);
    if ((latitude == null) !== (longitude == null)) return { ok: false, error: `${word}: 위치 좌표를 다시 지정해 주세요.` };
    // 대한민국 범위 밖 좌표는 잘못 찍힌 값으로 본다
    if (latitude != null && longitude != null && (latitude < 33 || latitude > 39 || longitude < 124 || longitude > 132)) {
      return { ok: false, error: `${word}: 위치 좌표가 올바르지 않습니다. 지도에서 다시 지정해 주세요.` };
    }
    const after = leg.afterStopName == null ? "" : cleanTrialLine(leg.afterStopName);
    if (after.length > TRIAL_STOP_NAME_MAX) return { ok: false, error: `${word}: 끼울 자리를 다시 골라 주세요.` };
    const address = cleanTrialLine(leg.address).slice(0, 300);
    legs.push({ direction, classTime, afterStopName: after || null, stopName, address: address || null, latitude, longitude, arriveTime });
  }
  // 등원이 먼저 오게 정리한다(알림·문자 문구 순서)
  legs.sort((a, b) => (a.direction === "BOARD" ? 0 : 1) - (b.direction === "BOARD" ? 0 : 1));
  return { ok: true, legs };
}

// ── 문구 ─────────────────────────────────────────────────────────

const WEEKDAY = ["일", "월", "화", "수", "목", "금", "토"];

/** 'YYYY-MM-DD' → '11/20(금)'. 요일은 공용 모듈(kstDow)로 계산한다 — 시간대가 끼어들지 않는다. */
export function trialShuttleDateLabel(ymd: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd ?? ""));
  if (!m) return "";
  return `${Number(m[2])}/${Number(m[3])}(${WEEKDAY[kstDow(ymd)] ?? ""})`;
}

type NoticeLeg = { direction: TrialRideDirection; stopName: string; arriveTime: string | null };

function sortedLegs<T extends { direction: TrialRideDirection }>(legs: readonly T[]): T[] {
  return [...legs].sort((a, b) => (a.direction === "BOARD" ? 0 : 1) - (b.direction === "BOARD" ? 0 : 1));
}

function childLabel(childName: string, grade?: string | null): string {
  const g = cleanTrialLine(grade);
  return `${cleanTrialLine(childName)}${g ? `(${g})` : ""}`;
}

/** 기사님이 알림을 눌렀을 때 열 화면 — 그 날짜 셔틀 명단. */
export function trialShuttleDriverLink(serviceDate: string): string {
  return `/staff/shuttle?date=${serviceDate}`;
}

export const TRIAL_SHUTTLE_ASSIGNED_TYPE = "TRIAL_SHUTTLE_ASSIGNED";
export const TRIAL_SHUTTLE_CANCELLED_TYPE = "TRIAL_SHUTTLE_CANCELLED";

/**
 * 기사님 알림(배정 확정) — «체험 셔틀 배정: ○○(초2) 11/20(금) 등원 — 위치명 · 예상 16:40».
 * 전화·주소는 넣지 않는다(알림은 잠금 화면에도 뜬다). 연락처는 운행표에서 본다.
 */
export function buildTrialShuttleDriverNotice(input: {
  childName: string; grade?: string | null; serviceDate: string; legs: readonly NoticeLeg[];
}): { title: string; message: string; linkUrl: string } {
  const parts = sortedLegs(input.legs).map((leg) =>
    `${trialRideDirectionLabel(leg.direction)} — ${cleanTrialLine(leg.stopName)}${leg.arriveTime ? ` · 예상 ${cleanTrialLine(leg.arriveTime)}` : ""}`);
  return {
    title: "체험 셔틀 배정",
    message: `체험 셔틀 배정: ${childLabel(input.childName, input.grade)} ${trialShuttleDateLabel(input.serviceDate)} ${parts.join(" / ")}`,
    linkUrl: trialShuttleDriverLink(input.serviceDate),
  };
}

/** 기사님 알림(배정이 풀림) — «체험 셔틀 취소: ○○(초2) 11/20(금) 등원·하원 — 태우지 않습니다». */
export function buildTrialShuttleCancelNotice(input: {
  childName: string; grade?: string | null; serviceDate: string; directions: readonly TrialRideDirection[];
}): { title: string; message: string; linkUrl: string } {
  const words = sortedLegs(input.directions.map((direction) => ({ direction }))).map((x) => trialRideDirectionLabel(x.direction));
  return {
    title: "체험 셔틀 취소",
    message: `체험 셔틀 취소: ${childLabel(input.childName, input.grade)} ${trialShuttleDateLabel(input.serviceDate)} ${[...new Set(words)].join("·")} — 태우지 않습니다`,
    linkUrl: trialShuttleDriverLink(input.serviceDate),
  };
}

/**
 * 학부모 문자 «미리 채운» 문구 — 관리자가 미리보기에서 고친 뒤 직접 보내기를 눌러야 나간다.
 * 머리말([스티즈농구교실])은 발송 함수가 붙이므로 여기엔 넣지 않는다.
 */
export function buildTrialShuttleParentSms(input: {
  childName: string; serviceDate: string; legs: readonly NoticeLeg[];
}): string {
  const lines = [`${cleanTrialLine(input.childName)} 체험 수업 셔틀 안내드립니다.`, `날짜: ${trialShuttleDateLabel(input.serviceDate)}`];
  for (const leg of sortedLegs(input.legs)) {
    lines.push(leg.direction === "BOARD"
      ? `등원: ${cleanTrialLine(leg.stopName)}${leg.arriveTime ? ` ${cleanTrialLine(leg.arriveTime)} 탑승 예정` : ""}`
      : `하원: ${cleanTrialLine(leg.stopName)}${leg.arriveTime ? ` ${cleanTrialLine(leg.arriveTime)} 도착 예정` : ""}`);
  }
  lines.push("도로 사정에 따라 몇 분 달라질 수 있어 5분 전에 나와 주시면 좋습니다. 체험 셔틀은 무료입니다.");
  return lines.join("\n");
}
