"use client";

import { useEffect, useRef, useState } from "react";
import AdminModal from "@/components/admin/AdminModal";
import type { RoutePlanDraft, PlanRun } from "@/lib/shuttle/routePlanningTypes";
import type { ShuttleIntakeItem } from "@/lib/enrollment/shuttle-review-types";
import styles from "./RoutePlanning.module.css";

type Mode = "driver" | "admin";
type Dashboard = { items: RoutePlanDraft[]; reviews: ShuttleIntakeItem[]; vehicles: { id: string; name: string }[] };
const DAYS: Record<string, string> = { Mon: "월", Tue: "화", Wed: "수", Thu: "목", Fri: "금", Sat: "토", Sun: "일" };
const DELIVERY: Record<string, string> = { PENDING: "미발송 대기", SENDING: "전송 중", ACCEPTED: "접수 · 전달 미확인", DELIVERED: "전달 완료", FAILED: "발송 보류", UNKNOWN: "결과 확인 필요" };
const STATUS = { DRAFT: "조정 중 · 미확정", SUBMITTED: "원장님 확인 대기", CONFIRMED: "배차 확정", STALE: "기존 노선 변경 · 다시 확인" };
function clock(value: number | null | undefined) { return value == null ? "미확인" : `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`; }
function direction(value: string) { return value === "PICKUP" ? "등원" : "하원"; }
function todayKorea() { return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()); }
function bounds(month: string) { const [year, number] = month.split("-").map(Number); return { min: `${month}-01`, max: `${month}-${new Date(year, number, 0).getDate()}` }; }
function Icon({ children }: { children: string }) { return <span aria-hidden="true" className="material-symbols-outlined">{children}</span>; }

/** 공용 운행 링크에는 이 진입점을 넣지 않는다. API도 별도로 로그인·담당자를 검증한다. */
export function DriverRoutePlanningEntry({ date }: { date: string }) {
  const [open, setOpen] = useState(false);
  return <><button type="button" className={styles.button} onClick={() => setOpen(true)}><Icon>person_add</Icon>신규 요청 보기</button>
    {open && <AdminModal titleId="route-plan-title" panelClassName="max-w-5xl" onClose={() => setOpen(false)} closeOnBackdrop={false}>
      <div className={styles.modalHeader}><h2 id="route-plan-title">신규 학생 배차 조정</h2><button className={styles.button} onClick={() => setOpen(false)}>닫기</button></div>
      <RoutePlanningClient mode="driver" initialMonth={date.slice(0, 7)} initialDate={date} />
    </AdminModal>}</>;
}

export default function RoutePlanningClient({ mode, initialMonth, initialDate }: { mode: Mode; initialMonth: string; initialDate?: string }) {
  const endpoint = `/api/${mode === "admin" ? "admin" : "staff"}/shuttle/route-plans`;
  const [month, setMonth] = useState(initialMonth);
  const [data, setData] = useState<Dashboard | null>(null);
  const [draft, setDraft] = useState<RoutePlanDraft | null>(null);
  const [effectiveFrom, setEffectiveFrom] = useState(() => initialDate ?? (todayKorea().startsWith(initialMonth) ? todayKorea() : `${initialMonth}-01`));
  const [vehicleId, setVehicleId] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [dirty, setDirty] = useState(false);
  const [runId, setRunId] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [discardChecked, setDiscardChecked] = useState(false);
  const [baselineChecked, setBaselineChecked] = useState(false);
  const sequence = useRef(0);
  const writeLock = useRef(false);
  const [draggingStop, setDraggingStop] = useState("");
  const [dropTarget, setDropTarget] = useState("");
  const drag = useRef<{ runId: string; stopId: string } | null>(null);
  const dateBounds = bounds(month);

  useEffect(() => {
    const current = ++sequence.current;
    const controller = new AbortController();
    setLoading(true); setData(null); setDraft(null); setError(""); setNotice(""); setDirty(false); setBaselineChecked(false); setDiscardChecked(false);
    fetch(`${endpoint}?month=${encodeURIComponent(month)}`, { cache: "no-store", signal: controller.signal })
      .then(async response => { const value = await response.json(); if (!response.ok) throw new Error(value.error || "배차안을 불러오지 못했습니다."); return value; })
      .then(value => { if (sequence.current === current) setData(value); })
      .catch(cause => { if (sequence.current === current && cause.name !== "AbortError") setError(cause.message); })
      .finally(() => { if (sequence.current === current) setLoading(false); });
    return () => controller.abort();
  }, [endpoint, month]);

  function selectDraft(value: RoutePlanDraft) { setDraft(value); setVehicleId(value.runs[0]?.vehicleId ?? ""); setEffectiveFrom(value.effectiveFrom < todayKorea() ? todayKorea() : value.effectiveFrom); setDiscardChecked(false); setRunId(value.runs[0]?.id ?? ""); setDirty(false); setError(""); setNotice(""); setBaselineChecked(false); }
  async function write(action: string, fields: Record<string, unknown>, optimistic?: RoutePlanDraft) {
    if (writeLock.current) return;
    writeLock.current = true; setBusy(true); setError(""); setNotice(""); setConfirmOpen(false);
    const current = sequence.current;
    if (optimistic) { setDraft(optimistic); setDirty(true); }
    try {
      const response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, ...fields }) });
      const value = await response.json();
      if (!response.ok || value.ok !== true || !value.draft) throw new Error(response.status === 409 ? (value.error || "다른 변경이 반영됐습니다. 최신 배차안을 확인해 주세요.") : (value.error || "처리를 완료하지 못했습니다."));
      if (sequence.current !== current) return;
      const result = value.draft as RoutePlanDraft;
      setDraft(result); setRunId(id => result.runs.some(run => run.id === id) ? id : result.runs[0]?.id ?? ""); setDirty(false); setBaselineChecked(false); setDiscardChecked(false);
      setData(previous => previous ? { ...previous, items: [result, ...previous.items.filter(item => item.id !== result.id)] } : previous);
      setNotice(action === "REBUILD" ? "최신 명단으로 새 추천 배차안을 만들었습니다. 기사님 조정과 원장님 재확인이 필요하며 아직 확정되지 않았습니다." : action === "RETURN_TO_DRIVER" ? "기사님이 다시 조정할 수 있도록 돌려보냈습니다. 실제 배차와 학부모 안내는 변경하지 않았습니다." : action === "SUBMIT" ? "원장님 확인 대기입니다. 실제 배차와 학부모 안내는 아직 확정되지 않았습니다." : action === "CONFIRM" ? result.noticeDelivery?.enabled === false ? "문자 자동 발송이 꺼져 있습니다. 배차만 확정했습니다." : value.dispatch?.status === "BLOCKED" ? "배차만 확정했습니다. 문자 발송이 차단되어 안내는 접수되지 않았습니다." : value.dispatch?.status === "PENDING_REVIEW" ? "배차는 확정됐지만 문자 발송 결과를 확인하지 못했습니다. 발송 결과를 새로 읽어 확인해 주세요." : "배차를 확정했습니다. 안내 접수와 전달은 다르므로 발송 결과를 확인해 주세요." : "배차안을 저장했습니다. 아직 실제 운행에는 반영되지 않았습니다.");
    } catch (cause) { if (sequence.current === current) setError(cause instanceof Error ? cause.message : "처리하지 못했습니다. 입력은 유지됩니다."); }
    finally { writeLock.current = false; setBusy(false); }
  }
  function update(next: RoutePlanDraft) {
    void write("UPDATE", { id: next.id, revision: next.revision, orders: next.runs.map(run => ({ runId: run.id, stopIds: run.stops.map(stop => stop.id), manualTimes: Object.fromEntries(run.stops.filter(stop => stop.manualMin != null).map(stop => [stop.id, stop.manualMin])) })) }, next);
  }
  function move(run: PlanRun, fromId: string, toId: string) {
    if (!draft || busy || draft.status !== "DRAFT") return;
    const from = run.stops.findIndex(stop => stop.id === fromId), to = run.stops.findIndex(stop => stop.id === toId);
    if (from < 0 || to < 0 || from === to || run.stops.slice(Math.min(from, to), Math.max(from, to) + 1).some(stop => stop.locked)) return;
    const stops = [...run.stops]; stops.splice(to, 0, stops.splice(from, 1)[0]);
    update({ ...draft, runs: draft.runs.map(item => item.id === run.id ? { ...item, stops } : item) });
  }
  async function reloadDraft(openConfirmation = false) {
    if (!draft || busy) return;
    setBusy(true); setError("");
    try { const response = await fetch(`${endpoint}?id=${encodeURIComponent(draft.id)}&month=${encodeURIComponent(draft.serviceMonth)}`, { cache: "no-store" }); const value = await response.json(); if (!response.ok || !value.draft) throw new Error(value.error || "최신 배차안을 읽지 못했습니다."); selectDraft(value.draft); if (openConfirmation) setConfirmOpen(true); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "다시 확인해 주세요."); }
    finally { setBusy(false); }
  }
  const run = draft?.runs.find(item => item.id === runId) ?? draft?.runs[0];
  const editable = mode === "driver" && draft?.status === "DRAFT" && !busy;
  const baselineIds = draft?.impacts.filter(item => item.baselineRequired).map(item => item.studentId) ?? [];

  return <div className={styles.workspace} aria-busy={busy || loading}>
    <div className={styles.toolbar}><label>운행 월 <input aria-label="운행 월" type="month" value={month} disabled={busy || dirty} onChange={event => { if (/^\d{4}-\d{2}$/.test(event.target.value)) { setMonth(event.target.value); setEffectiveFrom(event.target.value === todayKorea().slice(0, 7) ? todayKorea() : `${event.target.value}-01`); } }} /></label><span className={styles.muted}>추천·조정 → 원장님 확인 → 배차 확정 → 안내 결과 확인</span></div>
    {loading && <p role="status">담당 요청과 실제 운행 구간을 확인하고 있습니다.</p>}
    {error && <div role="alert" className={styles.alert}>{error}<p>확정 여부가 불분명하면 다시 누르기 전에 최신 배차안을 확인해 주세요. 조정 내용은 화면에 유지됩니다.</p>{draft && <button className={styles.button} disabled={busy} onClick={() => void reloadDraft()}>최신 배차안 다시 읽기</button>}</div>}
    {notice && <p role="status" className={styles.notice}>{notice}</p>}
    {data && !draft && <>
      <div className={styles.toolbar}><label>적용 시작일 <input aria-label="적용 시작일" type="date" disabled={busy} min={dateBounds.min} max={dateBounds.max} value={effectiveFrom} onChange={event => setEffectiveFrom(event.target.value)} /></label>
        {mode === "admin" && <label>담당 차량 <select aria-label="담당 차량" disabled={busy} value={vehicleId} onChange={event => setVehicleId(event.target.value)}><option value="">차량 선택</option>{data.vehicles.map(vehicle => <option value={vehicle.id} key={vehicle.id}>{vehicle.name}</option>)}</select></label>}</div>
      <h2 className={styles.sectionTitle}>신규 요청</h2>
      {data.reviews.length === 0 && <p>이 달에 검토할 담당 요청이 없습니다.</p>}
      {data.reviews.map(item => <div className={styles.request} key={item.applicationId}><div><strong>{item.studentName}</strong> <span className={styles.muted}>{item.grade}</span><p>{item.classes.map(lesson => `${DAYS[lesson.dayOfWeek] ?? lesson.dayOfWeek} ${lesson.startTime}~${lesson.endTime}`).join(" · ")}</p>{item.requestedStartOn && <p>수강 개시 {item.requestedStartOn}</p>}</div><button className={styles.primary} disabled={busy || !item.review || effectiveFrom < dateBounds.min || effectiveFrom > dateBounds.max || (!!item.requestedStartOn && effectiveFrom < item.requestedStartOn) || (mode === "admin" && !vehicleId)} onClick={() => void write("CREATE", { reviewId: item.review?.id, effectiveFrom, ...(mode === "admin" ? { vehicleId } : {}) })}>추천 넣기</button></div>)}
      <h2 className={styles.sectionTitle}>배차안</h2>{data.items.length === 0 && <p className={styles.muted}>아직 작성한 배차안이 없습니다.</p>}
      {data.items.map(item => <button className={styles.request} key={item.id} disabled={busy} onClick={() => selectDraft(item)}><strong>{item.impacts.find(impact => impact.studentId === item.studentId)?.studentName ?? "신규 학생"}</strong><span>{item.effectiveFrom}부터 · {STATUS[item.status]}</span><Icon>chevron_right</Icon></button>)}
    </>}
    {draft && <>
      <div className={styles.toolbar}><button className={styles.button} disabled={busy || dirty} onClick={() => setDraft(null)}>요청 목록</button><strong>{STATUS[draft.status]}</strong><span>{draft.effectiveFrom}부터 · 수정 {draft.revision}</span></div>
      {mode === "admin" && draft.status !== "CONFIRMED" && (draft.status === "STALE" || draft.effectiveFrom < todayKorea()) && <section aria-label="오래된 배차안 다시 만들기" className={styles.alert}>
        <h2 className={styles.sectionTitle}>최신 명단으로 다시 검토</h2>{bounds(draft.serviceMonth).max < todayKorea() && <p role="status">이 적용 월은 종료됐습니다. 새 월의 신규 요청에서 검토해 주세요.</p>}<p>기존 명단이 바뀌었거나 적용일이 지났습니다. 이전 초안은 보존하고, 기존 조정을 이어받지 않는 새 추천 배차안을 만듭니다.</p>
        <label>새 적용 시작일 <input aria-label="새 적용 시작일" type="date" disabled={busy} min={bounds(draft.serviceMonth).min > todayKorea() ? bounds(draft.serviceMonth).min : todayKorea()} max={bounds(draft.serviceMonth).max} value={effectiveFrom} onChange={event => setEffectiveFrom(event.target.value)} /></label>
        <p><label><input type="checkbox" checked={discardChecked} disabled={busy} onChange={event => setDiscardChecked(event.target.checked)} /> 기존 조정 내용을 사용하지 않고 최신 명단으로 새 추천을 만들겠습니다.</label></p>
        <button className={styles.button} disabled={busy || !discardChecked || effectiveFrom < todayKorea() || effectiveFrom < bounds(draft.serviceMonth).min || effectiveFrom > bounds(draft.serviceMonth).max} onClick={() => void write("REBUILD", { id: draft.id, revision: draft.revision, effectiveFrom, discardChanges: true })}>최신 명단으로 다시 만들기</button>
      </section>}
      <div role="tablist" aria-label="운행 구간" className={styles.tabs}>{draft.runs.map(item => <button role="tab" aria-selected={item.id === run?.id} className={item.id === run?.id ? styles.activeTab : styles.button} key={item.id} onClick={() => setRunId(item.id)}>{DAYS[item.dayOfWeek] ?? item.dayOfWeek} {direction(item.direction)}</button>)}</div>
      {run && <section aria-label="배차 조정 운행표"><div className={styles.toolbar}><strong>{run.vehicleName}</strong><span>{clock(run.departMin)} 출발 → {clock(run.arriveMin)} 도착</span></div>
        <p className={styles.muted}>{mode === "driver" ? "손잡이를 끌거나 위·아래 버튼으로 조정하세요. 잠긴 정류장은 순서와 시각을 바꿀 수 없습니다." : "기사님이 제출한 순서와 시각을 확인해 주세요."}</p>
        <ol className={styles.stops}>{run.stops.map((stop, index) => <li key={stop.id} data-plan-stop={stop.id} data-plan-run={run.id} data-dragging={draggingStop === stop.id || undefined} data-drop-target={dropTarget === stop.id || undefined} className={`${styles.stop} ${stop.recommended && draft.status !== "CONFIRMED" ? styles.recommended : ""}`}>
          {/* 브라우저 기본 끌기와 포인터 캡처의 충돌을 피하고 마우스·터치를 같은 방식으로 처리한다. */}
          <button aria-label={`${stop.label} 순서 끌기`} className={styles.handle} disabled={!editable || stop.locked} style={{ touchAction: "none" }}
            onPointerDown={event => { if (!editable || stop.locked || event.button !== 0) return; event.preventDefault(); drag.current = { runId: run.id, stopId: stop.id }; setDraggingStop(stop.id); setDropTarget(""); event.currentTarget.setPointerCapture(event.pointerId); }}
            onPointerMove={event => { if (!drag.current) return; event.preventDefault(); const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-plan-stop]"); const targetId = target?.dataset.planRun === run.id ? target.dataset.planStop ?? "" : ""; const candidate = run.stops.find(node => node.id === targetId); setDropTarget(candidate && !candidate.locked && candidate.id !== drag.current.stopId ? candidate.id : ""); }}
            onPointerUp={event => { if (!drag.current) return; event.preventDefault(); const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-plan-stop]"); const source = drag.current; drag.current = null; setDraggingStop(""); setDropTarget(""); event.currentTarget.releasePointerCapture(event.pointerId); if (target?.dataset.planRun === run.id && source.runId === run.id) move(run, source.stopId, target.dataset.planStop ?? ""); }}
            onPointerCancel={() => { drag.current = null; setDraggingStop(""); setDropTarget(""); }}><Icon>{stop.locked ? "lock" : "drag_indicator"}</Icon></button>
          <div className={styles.stopBody}><div className={styles.stopTitle}><strong>{index + 1}. {stop.label}</strong><strong>{clock(stop.etaMin)}</strong></div><p>{stop.students.map(student => student.name).join(" · ")}</p>{stop.recommended && <span className={styles.badge}>{draft.status === "CONFIRMED" ? "신규 정류장 · 확정" : "추천 · 미확정"}</span>}{stop.locked && <span className={styles.badge}>변경 불가</span>}</div>
          {mode === "driver" && <div className={styles.moves}><label className={styles.timeLabel}>시각<input aria-label={`${stop.label} 조정 시각`} type="time" disabled={!editable || stop.locked} value={clock(stop.manualMin ?? stop.etaMin) === "미확인" ? "" : clock(stop.manualMin ?? stop.etaMin)} onChange={event => { if (!/^\d{2}:\d{2}$/.test(event.target.value)) return; const [hour, minute] = event.target.value.split(":").map(Number); update({ ...draft, runs: draft.runs.map(item => item.id === run.id ? { ...item, stops: item.stops.map(node => node.id === stop.id ? { ...node, manualMin: hour * 60 + minute } : node) } : item) }); }} /></label><button className={styles.button} aria-label={`${stop.label} 위로`} disabled={!editable || index === 0 || stop.locked || run.stops[index - 1]?.locked} onClick={() => move(run, stop.id, run.stops[index - 1].id)}><Icon>arrow_upward</Icon></button><button className={styles.button} aria-label={`${stop.label} 아래로`} disabled={!editable || index === run.stops.length - 1 || stop.locked || run.stops[index + 1]?.locked} onClick={() => move(run, stop.id, run.stops[index + 1].id)}><Icon>arrow_downward</Icon></button></div>}
        </li>)}</ol>
      </section>}
      {dirty && <div className={styles.alert}>조정 내용의 시각을 아직 확인하지 못했습니다.<button className={styles.button} disabled={busy} onClick={() => update(draft)}>현재 순서로 다시 계산</button></div>}
      <h2 className={styles.sectionTitle}>다른 학생 영향</h2><div className={styles.impacts}>{draft.impacts.map(impact => <div className={styles.impact} key={impact.studentId}><strong>{impact.studentName}</strong><span className={impact.notify || impact.baselineRequired ? styles.badge : styles.muted}>{impact.baselineRequired ? "기존 안내 시각 확인 필요" : impact.notify ? "학부모 안내 대상" : "추가 안내 없음"}</span>{impact.legs.map(leg => <p key={`${leg.dayOfWeek}-${leg.direction}`}>{DAYS[leg.dayOfWeek] ?? leg.dayOfWeek} {direction(leg.direction)}　{impact.reasons.includes("FIRST_NOTICE") ? "첫 안내" : clock(leg.beforeMin)} → {leg.afterMin == null ? "이용 종료" : clock(leg.afterMin)}　<strong>{impact.reasons.includes("FIRST_NOTICE") ? "신규 이용" : leg.deltaMin == null ? impact.baselineRequired ? "기존 안내 확인 필요" : "시간 비교 없음" : leg.deltaMin === 0 ? "시간 동일" : `${leg.deltaMin > 0 ? "+" : ""}${leg.deltaMin}분`}</strong>{leg.beforeLocation != null && leg.afterLocation != null && leg.beforeLocation !== leg.afterLocation && <span> · 장소 변경</span>}</p>)}</div>)}</div>
      {draft.issues.length > 0 && <div role="alert" className={styles.alert}><strong>확정 전 확인할 내용</strong><ul>{draft.issues.map((issue, index) => <li key={`${issue.code}-${index}`}>{issue.message}</li>)}</ul></div>}
      {mode === "admin" && <>
        <div className={styles.toolbar}><label>담당 차량<select aria-label="배차안 담당 차량" value={vehicleId} disabled={busy || draft.status === "CONFIRMED"} onChange={event => setVehicleId(event.target.value)}><option value="">차량 선택</option>{data?.vehicles.map(vehicle => <option key={vehicle.id} value={vehicle.id}>{vehicle.name}</option>)}</select></label><button className={styles.button} disabled={busy || !vehicleId || draft.status === "CONFIRMED"} onClick={() => void write("SET_VEHICLE", { id: draft.id, revision: draft.revision, vehicleId })}>차량 반영·재계산</button></div>
        {baselineIds.length > 0 && <div className={styles.alert}><p>기존 학생의 마지막 전달 완료 시각이 없습니다. 현재 저장된 운행 시각이 학부모에게 마지막 안내한 시각과 같은지 직접 확인해야 합니다.</p><label><input type="checkbox" checked={baselineChecked} onChange={event => setBaselineChecked(event.target.checked)} /> 해당 학생들의 마지막 안내와 현재 저장된 시각이 일치함을 확인했습니다.</label><button className={styles.button} disabled={busy || !baselineChecked} onClick={() => void write("BASELINE", { id: draft.id, revision: draft.revision, acknowledgeStudentIds: baselineIds })}>안내 기준 확인 반영</button></div>}
        {draft.status === "CONFIRMED" && <section aria-label="학부모 안내 발송 결과"><div className={styles.toolbar}><h2 className={styles.sectionTitle}>학부모 안내 발송 결과</h2><button className={styles.button} disabled={busy} onClick={() => void reloadDraft()}>발송 결과 새로 읽기</button></div>
          {draft.noticeDelivery?.enabled === false && <p role="status" className={styles.alert}>문자 자동 발송이 꺼져 있습니다. 배차만 확정했습니다.</p>}
          {!draft.noticeDelivery && <p role="status">발송 결과를 아직 확인하지 못했습니다. 새로 읽어 확인해 주세요.</p>}
          {draft.noticeDelivery?.items.map((delivery, index) => <div className={styles.request} key={`${delivery.studentId}-${index}`}><strong>{draft.impacts.find(impact => impact.studentId === delivery.studentId)?.studentName ?? draft.runs.flatMap(item => item.stops.flatMap(stop => stop.students)).find(student => student.studentId === delivery.studentId)?.name ?? "안내 대상 학생"}</strong><span role="status" className={styles.badge}>{DELIVERY[delivery.status] ?? DELIVERY.UNKNOWN}</span></div>)}
          {draft.noticeDelivery?.items.length === 0 && <p className={styles.muted}>이 배차안에는 별도로 안내할 대상이 없습니다.</p>}
        </section>}
        <h2 className={styles.sectionTitle}>학부모 안내 미리보기 · {draft.notices.length}명</h2><p className={styles.muted}>마지막 안내 대비 5분 이상 변경, 장소 변경, 신규 학생의 첫 확정 안내를 구분합니다. 접수만으로 전달 완료로 표시하지 않습니다.</p>{draft.notices.map(item => <div className={styles.impact} key={item.studentId}><strong>{item.studentName} · {item.recipientLabel}</strong><p className={styles.message}>{item.message}</p></div>)}
      </>}
      <div className={styles.actions}>{mode === "admin" && draft.status === "SUBMITTED" && <button className={styles.button} disabled={busy || dirty} onClick={() => void write("RETURN_TO_DRIVER", { id: draft.id, revision: draft.revision })}>기사님께 수정 요청</button>}{mode === "driver" ? <button className={styles.primary} disabled={busy || dirty || draft.status !== "DRAFT"} onClick={() => void write("SUBMIT", { id: draft.id, revision: draft.revision })}>원장님께 배차안 제출</button> : <button className={styles.primary} disabled={busy || dirty || draft.status !== "SUBMITTED" || !draft.canConfirm || !draft.previewHash} onClick={() => void reloadDraft(true)}>원장님 확정·안내</button>}<span className={styles.muted}>{busy ? "처리 결과를 확인하고 있습니다…" : mode === "driver" ? "제출해도 실제 배차·문자는 변경되지 않습니다." : "확정과 안내 발송 결과는 각각 확인합니다."}</span></div>
      {mode === "admin" && confirmOpen && <AdminModal titleId="plan-confirm-title" onClose={() => setConfirmOpen(false)} closeOnBackdrop={false}><div className={styles.workspace}><h2 id="plan-confirm-title">배차 확정·안내 최종 확인</h2><p>{draft.serviceMonth} · {draft.effectiveFrom}부터</p><p>{draft.runs.map(item => `${DAYS[item.dayOfWeek] ?? item.dayOfWeek} ${direction(item.direction)}`).join(" · ")}</p><p>{draft.noticeDelivery?.enabled === false ? "문자 자동 발송이 꺼져 있습니다. 위 순서·시각으로 배차만 확정하며 문자는 접수하지 않습니다." : <>위 순서·시각으로 배차를 확정하고 안내 대상 {draft.notices.length}명에게 안내를 접수합니다. 실제 전달 결과는 별도로 확인합니다.</>}</p>{(!draft.canConfirm || draft.status !== "SUBMITTED") && <p role="alert">확인해야 할 내용이 남았거나 배차안 상태가 변경됐습니다. 지금은 확정할 수 없습니다.</p>}<div className={styles.actions}><button className={styles.button} disabled={busy} onClick={() => setConfirmOpen(false)}>돌아가기</button><button className={styles.primary} disabled={busy || !draft.canConfirm || draft.status !== "SUBMITTED" || !draft.previewHash} onClick={() => void write("CONFIRM", { id: draft.id, revision: draft.revision, previewHash: draft.previewHash })}>{draft.noticeDelivery?.enabled === false ? "이 배차안만 확정" : "이 배차안 확정·안내 접수"}</button></div></div></AdminModal>}
    </>}
  </div>;
}
