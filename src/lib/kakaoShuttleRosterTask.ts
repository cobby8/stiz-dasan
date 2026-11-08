// 카카오 «정규 셔틀 신청» → 원장 할 일 «셔틀 명단에 넣어 주세요» — 판정·문구 순수 함수(DB 접근 없음).
// ─────────────────────────────────────────────────────────────────────────────
// 왜 필요한가?
//   카카오 대화로 들어온 정규 셔틀 신청은 접수함(KakaoParentIntake)에만 쌓이고, 실제 운행표인
//   셔틀 명단(RegularShuttleStop)까지 이어지는 길이 없었다. 이 모듈은
//     ① 어떤 접수가 «명단에 넣어야 할 일»인지
//     ② 할 일 한 줄 요약 문구와 명단 화면으로 가는 주소
//     ③ «처리 완료»를 누르면 접수 상태를 무엇으로 바꾸는지
//   를 한곳에서 정한다. 새 표 없이 기존 KakaoParentIntake 의 status + structuredJson.rosterTask 로 표시한다.
// ⚠️ node 타입 제거 실행으로 테스트하므로 '@/' 경로 import·enum 을 쓰지 않는다.

/** 할 일로 보이는 접수 상태 — 원장이 아직 끝내지 않은 상태들(운영 원장 이관 APPROVED 도 명단은 따로 넣어야 해서 포함). */
export const SHUTTLE_ROSTER_TASK_OPEN_STATUSES = ["SUBMITTED", "HELD", "FAILED", "NEEDS_DETAILS", "CONSULTATION", "APPROVED"] as const;

/**
 * «처리 완료» 뒤 상태.
 * - 접수함에서 아직 결정 전인 상태(신규·보류·실패·추가 확인·상담) → APPLIED(접수 종결).
 * - 운영 원장 이관(APPROVED) → 그대로 둔다(운영 원장 후속 흐름을 깨지 않게). 명단 반영 표시만 남긴다.
 * - 그 외(PROCESSING = 자동 분류 중, 이미 종결 등) → null = 지금은 완료 처리하지 않는다.
 */
export function shuttleRosterTaskNextStatus(status: string): string | null {
  if (["SUBMITTED", "HELD", "FAILED", "NEEDS_DETAILS", "CONSULTATION"].includes(status)) return "APPLIED";
  if (status === "APPROVED") return "APPROVED";
  return null;
}

type Json = Record<string, unknown>;

function obj(v: unknown): Json {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {};
}
function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/** 정규 셔틀 «신청(START)» 접수인가 — 대화 접수(regularShuttle.action) 또는 검토값(shuttleIntent) 어느 쪽이든. */
export function isRegularShuttleStartIntake(kind: string, structuredJson: unknown): boolean {
  if (kind !== "SHUTTLE_START_STOP") return false;
  const s = obj(structuredJson);
  return str(obj(s.regularShuttle).action) === "START" || str(s.shuttleIntent) === "START";
}

/** 명단 반영 완료 기록(structuredJson.rosterTask.doneAt). 없으면 null. */
export function shuttleRosterTaskDoneAt(structuredJson: unknown): string | null {
  return str(obj(obj(structuredJson).rosterTask).doneAt) || null;
}

/** 원장 할 일 «셔틀 명단에 넣어 주세요» 대상인가. 학생 연결이 없으면 명단에 넣을 수 없어 대상이 아니다(접수함에서 먼저 확인). */
export function isShuttleRosterTask(row: { kind: string; status: string; studentId: string | null; structuredJson: unknown }): boolean {
  return !!row.studentId
    && (SHUTTLE_ROSTER_TASK_OPEN_STATUSES as readonly string[]).includes(row.status)
    && isRegularShuttleStartIntake(row.kind, row.structuredJson)
    && !shuttleRosterTaskDoneAt(row.structuredJson);
}

const DIRECTION_LABEL: Record<string, string> = { PICKUP: "등원", DROPOFF: "하원", BOTH: "등원·하원" };

/** 'YYYY-MM-DD' → '11/10'. 형식이 아니면 빈 문자열(Date 를 쓰지 않는다 — 시간대 무관). */
function shortDate(ymd: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  return m ? `${Number(m[2])}/${Number(m[3])}` : "";
}

/** 할 일 한 줄 요약 — «월·수 · 등원·하원 · 장소 다산자이 정문 · 11/10부터». 빈 항목은 뺀다. */
export function shuttleRosterTaskSummary(structuredJson: unknown): string {
  const s = obj(structuredJson);
  const r = obj(s.regularShuttle);
  const days = Array.isArray(r.days) ? r.days.filter((d): d is string => typeof d === "string" && d.trim() !== "") : [];
  const dayText = days[0] === "전체" ? "다니는 요일 전체" : days.join("·");
  const direction = DIRECTION_LABEL[str(r.direction)] ?? "";
  const place = str(r.place);
  const start = shortDate(str(r.effectiveDate) || str(s.effectiveDate));
  return [dayText, direction, place ? `장소 ${place}` : "", start ? `${start}부터` : ""].filter(Boolean).join(" · ");
}

/**
 * 셔틀 명단 화면으로 가는 주소 — 시작일이 있으면 그 달 명단을 연다.
 * 명단 화면은 ?studentId= 가 명단에 없으면 «신청 학생 선택해 명단 추가» 버튼을 띄운다(기존 기능 재사용).
 */
export function shuttleRosterTaskHref(studentId: string, structuredJson: unknown): string {
  const s = obj(structuredJson);
  const date = str(obj(s.regularShuttle).effectiveDate) || str(s.effectiveDate);
  const month = /^\d{4}-(0[1-9]|1[0-2])-\d{2}$/.test(date) ? date.slice(0, 7) : "";
  const params = new URLSearchParams();
  if (month) params.set("month", month);
  params.set("studentId", studentId);
  return `/admin/shuttle/regular?${params.toString()}`;
}
