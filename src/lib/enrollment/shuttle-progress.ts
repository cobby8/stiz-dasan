import { createHash } from "node:crypto";

// ASSIGNED = 월별 셔틀 명단(=기사님 화면)에 정상 반영됨(6단계부터 저장 노선은 보지 않는다). PAUSED = 휴원 중이라 배정 불필요.
export type ShuttleProgressStatus = "NOT_REQUESTED" | "REQUESTED" | "LOCATION_REQUIRED" | "ROSTER_PENDING" | "DISPATCH_PENDING" | "RECONFIRM_REQUIRED" | "NOTICE_PENDING" | "NOTICE_ACCEPTED" | "COMPLETE" | "ASSIGNED" | "PAUSED" | "UNKNOWN";
export type ShuttleDirection = "PICKUP" | "DROPOFF";
export type ShuttleProgressLeg = { dayOfWeek: string; direction: ShuttleDirection; status: ShuttleProgressStatus; label: string; detail: string; timeLabel: string | null };
export type EnrollmentShuttleProgress = { status: ShuttleProgressStatus; label: string; detail: string; serviceMonth: string; confirmedCount: number; totalCount: number; legs: ShuttleProgressLeg[]; rosterHref: string; dispatchHref: string };
export type ShuttleApplication = { id: string; status?: string; convertedStudentId: string | null; assignedClassId: string | null; shuttleNeeded: boolean; requestedStartOn?: Date | string | null };
export function requestedShuttleMonth(value: ShuttleApplication["requestedStartOn"]): string | null { const text = value instanceof Date ? (Number.isFinite(value.getTime()) ? new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(value) : "") : String(value ?? ""); return /^\d{4}-(?:0[1-9]|1[012])-\d{2}(?:T|$)/.test(text) ? text.slice(0,7) : null; }
export type ShuttleRosterRow = { id: string; serviceMonth: string; weekday: number; direction: string; studentId: string | null; classTime?: string | null; arriveTime?: string | null; stopName: string; latitude?: number | null; longitude?: number | null; sortOrder?: number };
export type ShuttleRoute = { serviceMonth: string; dayOfWeek: string; direction: string; payload: unknown; classStart?: string | null; classEnd?: string | null };
// active = 수강 상태 ACTIVE. status 는 Enrollment.status 원문(휴원 PAUSED 구분용).
export type ShuttleClass = { id: string; dayOfWeek: string; active: boolean; status?: string; startTime?: string; endTime?: string };
export type ShuttleLocation = { studentId: string; kind: string; latitude: number; longitude: number; consentVersion: string; confirmedAt: unknown };
export type ShuttleNotice = { studentId: string; serviceMonth: string; stableEventKey: string; payloadHash: string; status: string; messageBody: string; recipientPhone: string; sentAt?: unknown; createdAt?: Date | string };
export type ShuttleDelivery = { stableEventKey: string | null; status: string; providerStatus: string | null; bodyHash: string | null; recipientPhoneHash: string | null; providerMessageId?: string | null; sentAt?: unknown };
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DAY_LABELS = ["일", "월", "화", "수", "목", "금", "토"];
export const SHUTTLE_PROGRESS_LABELS: Record<ShuttleProgressStatus, string> = { NOT_REQUESTED: "미신청", REQUESTED: "신청 접수", LOCATION_REQUIRED: "위치 확인 필요", ROSTER_PENDING: "배차 대기", DISPATCH_PENDING: "노선 확정 대기", RECONFIRM_REQUIRED: "배차 재확인 필요", NOTICE_PENDING: "안내 발송 대기", NOTICE_ACCEPTED: "발송 접수·전달 미확인", COMPLETE: "안내 완료", ASSIGNED: "배차 완료", PAUSED: "휴원 중", UNKNOWN: "확인 불가" };
// 배차가 끝난 칸(더 할 일이 배차가 아니라 안내뿐이거나, 기사님 화면 반영으로 끝난 칸)
const SETTLED: ShuttleProgressStatus[] = ["ASSIGNED", "NOTICE_PENDING", "NOTICE_ACCEPTED", "COMPLETE"];
// 명단의 수업 칸("16:00~17:00", 60·80분 단위)은 실제 수업("16:00~16:55")과 끝 시각이 다르다 → 시작 시각만 비교한다.
const rosterStartTime = (classTime: string | null | undefined) => (classTime ?? "").replace(/\s/g, "").split("~")[0];
const obj = (v: unknown): Record<string, unknown> => v != null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
// 키 순서는 비교 결과에 영향을 주지 않는다. 배열 순서(운행 순서)는 그대로 보존한다.
function canonical(v: unknown): unknown { if (Array.isArray(v)) return v.map(canonical); if (v != null && typeof v === "object") return Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, value]) => [k, canonical(value)])); return v; }
export function shuttleFingerprint(value: unknown): string { return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex"); }
export function rosterFingerprint(rows: ShuttleRosterRow[]): string { return shuttleFingerprint(rows.map(r => ({ id: r.id, serviceMonth: r.serviceMonth, weekday: r.weekday, direction: r.direction, studentId: r.studentId, classTime: r.classTime ?? null, arriveTime: r.arriveTime ?? null, stopName: r.stopName, latitude: r.latitude ?? null, longitude: r.longitude ?? null, sortOrder: r.sortOrder ?? 0 })).sort((a,b) => a.id.localeCompare(b.id))); }
export function routeFingerprint(route: ShuttleRoute): string { return shuttleFingerprint({ serviceMonth: route.serviceMonth, dayOfWeek: route.dayOfWeek, direction: route.direction, classStart: route.classStart ?? null, classEnd: route.classEnd ?? null, vehicles: obj(route.payload).vehicles }); }
export function routeConfirmation(route: ShuttleRoute, rows: ShuttleRosterRow[]) { return { version: 1, rosterHash: rosterFingerprint(rows), routeHash: routeFingerprint(route) }; }
export function hasCurrentRouteConfirmation(route: ShuttleRoute, rows: ShuttleRosterRow[]): boolean { const saved = obj(obj(route.payload).confirmation); const current = routeConfirmation(route, rows); return saved.version === 1 && saved.rosterHash === current.rosterHash && saved.routeHash === current.routeHash; }
export function shuttleNoticeEventKey(month: string, studentId: string, fingerprint: string): string { return `regular-shuttle-v2:${month}:${studentId}:${fingerprint}`; }
export function shuttleDeliveryEventKey(payloadHash: string): string { return `REGULAR_SHUTTLE_CHANGE:REGULAR_SHUTTLE_CHANGE:${payloadHash}`; }
// ── 6단계(2026-11-09): 안내·진행 상태의 정본 = 셔틀 명단(RegularShuttleStop) ──
// 기사님 화면·관리자 운행표가 명단만 읽으므로, 학부모 안내 문자와 배차 진행도 명단에서 만든다.
// 저장 노선(RegularDispatchRoute)은 더 읽지 않는다(위 route* 함수는 저장 노선 저장 API 가 아직 쓰므로 남겨 둔다).
const HHMM = /\b(?:[01]\d|2[0-3]):[0-5]\d\b/;
// 명단 시각 «8:05»도 «08:05»로 맞춘다. 형식이 아니면 null.
function rosterTime(value: string | null | undefined): string | null { const m = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(value ?? ""); if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return (value ?? "").match(HHMM)?.[0] ?? null; return `${m[1].padStart(2, "0")}:${m[2]}`; }
// 그 학생의 그 달 등원·하원 명단 행(운영 정차 PIVOT/RETURN 제외).
function studentRows(studentId: string, serviceMonth: string, roster: ShuttleRosterRow[]) { return roster.filter(r => r.studentId === studentId && r.serviceMonth === serviceMonth && (r.direction === "BOARD" || r.direction === "ALIGHT")); }
// 안내는 이름/전화가 같은 기록이 아니라, 그 학생의 현재 명단 칸(요일·방향·수업·시각·정류장)에만 연결한다.
// 다른 학생 행이나 정렬 번호(sortOrder)만 바뀐 것은 이 학생의 안내 내용이 아니므로 지문에 넣지 않는다.
export function studentRosterFingerprint(studentId: string, serviceMonth: string, roster: ShuttleRosterRow[]): string { return shuttleFingerprint({ studentId, serviceMonth, rows: studentRows(studentId, serviceMonth, roster).map(r => ({ weekday: r.weekday, direction: r.direction, classTime: r.classTime ?? null, arriveTime: rosterTime(r.arriveTime), stopName: r.stopName })).sort((a, b) => `${a.weekday}:${a.direction}:${a.classTime}`.localeCompare(`${b.weekday}:${b.direction}:${b.classTime}`)) }); }
function delivered(delivery: ShuttleDelivery) { return delivery.status === "SENT" && delivery.sentAt != null && Boolean(delivery.providerMessageId) && ["DELIVERED", "DELIVERY_SUCCESS", "4000"].includes(delivery.providerStatus ?? ""); }
/** 등원시간 안내 문자 본문 — 명단의 요일·방향마다 «월 등원 16:40 정류장» 한 줄. 칸이 겹치거나 시각이 비면 막는다. */
export function buildStudentRouteNotice(studentId: string, serviceMonth: string, roster: ShuttleRosterRow[]) {
  const mine = studentRows(studentId, serviceMonth, roster);
  if (!mine.length) throw new Error("해당 학생의 월별 셔틀 명단을 확인해 주세요.");
  const labels: string[] = [];
  // 요일(일→토) · 등원 먼저 순서. 예전 저장 노선 판본과 같은 «요일 등원/하원 시각 정류장» 모양이다(차량명은 명단에 없어 뺐다).
  const keys = [...new Set(mine.map(r => `${r.weekday}:${r.direction === "BOARD" ? 0 : 1}`))].sort((a, b) => a.localeCompare(b));
  for (const key of keys) {
    const [weekday, dir] = key.split(":").map(Number);
    const rows = mine.filter(r => r.weekday === weekday && (r.direction === "BOARD" ? 0 : 1) === dir);
    if (rows.length !== 1) throw new Error("같은 요일·방향에 이 학생 명단이 여러 줄입니다. 셔틀 명단을 확인해 주세요.");
    const time = rosterTime(rows[0].arriveTime);
    if (!time) throw new Error("셔틀 명단의 도착 시각을 먼저 입력해 주세요.");
    labels.push(`${DAY_LABELS[weekday] ?? ""} ${dir === 0 ? "등원" : "하원"} ${time} ${rows[0].stopName}`);
  }
  const fingerprint = studentRosterFingerprint(studentId, serviceMonth, roster);
  return { fingerprint, eventKey: shuttleNoticeEventKey(serviceMonth, studentId, fingerprint), text: labels.join(" / ") };
}
export function enrollmentShuttleProgress(input: { application: ShuttleApplication; serviceMonth: string; classes: ShuttleClass[]; locations: ShuttleLocation[]; roster: ShuttleRosterRow[]; notices?: ShuttleNotice[]; deliveries?: ShuttleDelivery[]; recipientPhone?: string | null; recipientHash?: (phone: string) => string; readFailed?: boolean }): EnrollmentShuttleProgress {
  const { application: app, serviceMonth, roster } = input;
  const legs: ShuttleProgressLeg[] = [];
  const studentQuery = app.convertedStudentId ? `&studentId=${encodeURIComponent(app.convertedStudentId)}` : "";
  const result = (status: ShuttleProgressStatus, detail: string): EnrollmentShuttleProgress => ({ status, label: SHUTTLE_PROGRESS_LABELS[status], detail, serviceMonth, confirmedCount: legs.filter(l => SETTLED.includes(l.status)).length, totalCount: legs.length, legs, rosterHref: `/admin/shuttle/regular?month=${serviceMonth}${studentQuery}`, dispatchHref: `/admin/shuttle/regular-dispatch?month=${serviceMonth}${studentQuery}` });
  if (!app.shuttleNeeded) return result("NOT_REQUESTED", "셔틀을 신청하지 않았습니다.");
  if (input.readFailed) return result("UNKNOWN", "셔틀 자료를 불러오지 못했습니다. 다시 확인해 주세요.");
  const startMonth = requestedShuttleMonth(app.requestedStartOn);
  if (startMonth && serviceMonth < startMonth) return { ...result("REQUESTED", `${startMonth} 수강 시작 예정입니다. 시작 월의 배차를 확인해 주세요.`), label: "수강 시작 전" };
  if (app.status !== "APPROVED" || !app.convertedStudentId) return result("REQUESTED", "수강 승인과 원생 연결 후 배차를 진행합니다.");
  // 반은 신청서의 assignedClassId 가 아니라 학생의 «현재 수강»으로 본다(조회부가 ACTIVE·PAUSED 만 넘긴다).
  // 반 이동(옛 반 WITHDRAWN → 새 반 ACTIVE)·휴원이 있어도 옛 반 기록 때문에 재확인으로 빠지지 않게 한다.
  const activeClasses = input.classes.filter(c => c.active);
  if (!activeClasses.length && input.classes.some(c => c.status === "PAUSED")) return result("PAUSED", "휴원 중이라 셔틀 배정이 필요 없습니다.");
  if (!activeClasses.length || activeClasses.some(c => !DOW.includes(c.dayOfWeek))) return result("RECONFIRM_REQUIRED", "배정 반의 현재 수강 상태와 요일을 확인해 주세요.");
  const studentId = app.convertedStudentId;
  const days = [...new Set(activeClasses.map(c => c.dayOfWeek))].sort((a,b) => DOW.indexOf(a) - DOW.indexOf(b));
  const rowsOf = (dayOfWeek: string, direction: ShuttleDirection) => roster.filter(r => r.serviceMonth === serviceMonth && DOW[r.weekday] === dayOfWeek && r.direction === (direction === "PICKUP" ? "BOARD" : "ALIGHT"));
  // 위치는 «아직 명단에 없는 칸»을 새로 배정할 때만 필요하다. 모든 칸이 이미 명단에 있으면 막지 않는다.
  const rosterMissing = days.some(dayOfWeek => (["PICKUP", "DROPOFF"] as const).some(direction => !rowsOf(dayOfWeek, direction).some(r => r.studentId === studentId)));
  if (rosterMissing && !["PICKUP", "DROPOFF"].every(kind => input.locations.some(l => l.studentId === studentId && l.kind === kind && l.consentVersion === "2026-07-21" && l.confirmedAt != null && Number.isFinite(new Date(String(l.confirmedAt)).getTime()) && Number.isFinite(l.latitude) && Math.abs(l.latitude) <= 90 && Number.isFinite(l.longitude) && Math.abs(l.longitude) <= 180))) return result("LOCATION_REQUIRED", "학생 상세에서 동의가 확인된 승차·하차 위치를 확인해 주세요.");
  for (const dayOfWeek of days) for (const direction of ["PICKUP", "DROPOFF"] as const) {
    const mine = rowsOf(dayOfWeek, direction).filter(r => r.studentId === studentId);
    const startTimes = activeClasses.filter(c => c.dayOfWeek === dayOfWeek).map(c => (c.startTime ?? "").trim()).filter(Boolean);
    const rosterStart = rosterStartTime(mine[0]?.classTime);
    let status: ShuttleProgressStatus, detail: string, eta: string | null = null;
    if (mine.length === 0) { status = "ROSTER_PENDING"; detail = "해당 월·요일의 셔틀 명단에 추가해 주세요."; }
    else if (mine.length !== 1 || mine.some(r => !Number.isFinite(r.latitude) || !Number.isFinite(r.longitude))) { status = "RECONFIRM_REQUIRED"; detail = "중복 명단 또는 정류장 좌표를 확인해 주세요."; }
    // 학부모 위치와 명단 정류장 좌표 차이는 더 이상 보지 않는다 — 기사님은 공용 정류장(아파트 정문 등)을 쓰므로 원래 다르다.
    else if (!rosterStart || !startTimes.includes(rosterStart)) { status = "RECONFIRM_REQUIRED"; detail = "배정 반의 현재 수업시간과 셔틀 명단을 대조해 주세요."; }
    else if (!rosterTime(mine[0].arriveTime)) { status = "DISPATCH_PENDING"; detail = "셔틀 명단에 등록됐습니다. 운행표에서 등·하원 시각을 입력해 주세요."; }
    else { status = "ASSIGNED"; detail = "기사님 운행표에 반영됐습니다."; eta = rosterTime(mine[0].arriveTime); }
    legs.push({ dayOfWeek, direction, status, label: `${DAY_LABELS[DOW.indexOf(dayOfWeek)]} ${direction === "PICKUP" ? "등원" : "하원"} · ${SHUTTLE_PROGRESS_LABELS[status]}`, detail, timeLabel: eta });
  }
  const pending = legs.find(l => !SETTLED.includes(l.status));
  if (pending) return result(pending.status, `${serviceMonth} · ${legs.filter(l => SETTLED.includes(l.status)).length}/${legs.length}개 배차 확정. ${pending.detail}`);
  // 모든 칸이 명단에 반영됨 = 배차 완료(기본). 그 위에, 현재 명단과 같은 지문의 안내 문자가 실제 전달됐으면
  // «발송 접수·전달 미확인»/«안내 완료»로 올린다. 안내를 안 보냈거나 명단이 바뀐 뒤면 배차 완료 그대로.
  const eventKey = shuttleNoticeEventKey(serviceMonth, studentId, studentRosterFingerprint(studentId, serviceMonth, roster));
  const sent = (input.notices ?? []).filter(n => n.studentId === studentId && n.serviceMonth === serviceMonth && n.status === "SENT").sort((a,b) => new Date(b.createdAt ?? 0).getTime() - new Date(a.createdAt ?? 0).getTime());
  // 변경 안내 이후 오래된 명단으로 되돌아와도 옛 발송 성공을 자동으로 재사용하지 않는다(가장 최근 발송만 본다).
  const notices = sent.length && sent[0].stableEventKey === eventKey ? [sent[0]] : [];
  let state: ShuttleProgressStatus = "ASSIGNED";
  for (const notice of notices) {
    const bodyHash = createHash("sha256").update(notice.messageBody).digest("hex");
    const sameRecipient = Boolean(input.recipientPhone) && input.recipientPhone!.replace(/\D/g, "") === notice.recipientPhone.replace(/\D/g, "");
    const evidence = sameRecipient ? (input.deliveries ?? []).filter(d => d.stableEventKey === shuttleDeliveryEventKey(notice.payloadHash) && d.bodyHash === bodyHash && input.recipientHash && d.recipientPhoneHash === input.recipientHash(notice.recipientPhone)) : [];
    if (evidence.some(delivered)) { state = "COMPLETE"; break; }
    if (evidence.some(d => ["SENT", "SENDING"].includes(d.status) && d.providerStatus === "ACCEPTED")) state = "NOTICE_ACCEPTED";
  }
  for (const leg of legs) { leg.status = state; leg.label = `${DAY_LABELS[DOW.indexOf(leg.dayOfWeek)]} ${leg.direction === "PICKUP" ? "등원" : "하원"} · ${SHUTTLE_PROGRESS_LABELS[state]}`; }
  if (state === "COMPLETE") return result(state, `${serviceMonth} · 모든 배차와 현재 노선 안내의 전달 성공을 확인했습니다.`);
  if (state === "NOTICE_ACCEPTED") return result(state, `${serviceMonth} · 발송은 접수됐으며 최종 전달 결과는 아직 확인되지 않았습니다.`);
  return result("ASSIGNED", sent.length ? `${serviceMonth} · 기사님 운행표에 반영됐습니다. 안내 뒤 명단이 바뀌어 변경 안내가 필요합니다.` : `${serviceMonth} · 기사님 운행표에 반영됐습니다.`);
}
