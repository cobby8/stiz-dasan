"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ShuttleIntakeItem, ShuttleIntakeDashboard } from "@/lib/enrollment/shuttle-review-types";

const FIELD = "min-h-11 w-full min-w-0 rounded-lg border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] px-3 py-2 text-base text-[var(--color-academy-ink)]";
const BUTTON = "inline-flex min-h-11 items-center justify-center gap-1.5 rounded-lg border border-[var(--color-academy-line)] px-3 py-2 text-sm font-bold disabled:opacity-50";
const DAYS: Record<string, string> = { Mon: "월", Tue: "화", Wed: "수", Thu: "목", Fri: "금", Sat: "토", Sun: "일" };
const REVIEW_LABELS = { PENDING: "기사 검토 대기", PROPOSED: "기사 제안 도착", NEEDS_CONFIRMATION: "추가 확인 필요", STALE: "신청 변경·재검토 필요" };
type Mode = "admin" | "driver";
type Payload = ShuttleIntakeDashboard;
type ShuttleIntakeDriver = NonNullable<ShuttleIntakeDashboard["drivers"]>[number];

// 조회 오류는 빈 목록과 구분한다. 화면을 열거나 새로 읽을 때 신청·배차를 저장하지 않는다.
export default function ShuttleIntakeClient({ mode, initialMonth }: { mode: Mode; initialMonth: string }) {
  const [month, setMonth] = useState(initialMonth);
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const [writing, setWriting] = useState(false);
  const [notice, setNotice] = useState("");
  const [moreLoading, setMoreLoading] = useState(false);
  const [moreError, setMoreError] = useState("");
  const sequence = useRef(0);
  const loaded = useRef({ month: initialMonth, pages: 1 });
  const moreAbort = useRef<AbortController | null>(null);
  const moreLock = useRef(false);
  const outstandingWrites = useRef(0);
  const trackBusy = useCallback((busy: boolean) => { outstandingWrites.current += busy ? 1 : -1; setWriting(outstandingWrites.current > 0); }, []);
  const endpoint = mode === "admin" ? "/api/admin/shuttle/intake" : "/api/staff/shuttle/intake";
  useEffect(() => {
    const current = ++sequence.current;
    const controller = new AbortController();
    moreAbort.current?.abort(); moreLock.current = false;
    setLoading(true); setError(""); setMoreLoading(false); setMoreError("");
    const pages = loaded.current.month === month ? loaded.current.pages : 1;
    void (async () => {
      try {
        let combined: Payload | null = null;
        // 이미 펼친 페이지까지 다시 읽어도 카드의 입력 상태는 안정적인 신청 ID로 보존한다.
        for (let page = 1; page <= pages; page++) {
          const response = await fetch(`${endpoint}?month=${encodeURIComponent(month)}&page=${page}`, { cache: "no-store", signal: controller.signal });
          const value = await response.json().catch(() => null);
          if (!response.ok || !Array.isArray(value?.items) || value.serviceMonth !== month || value.page !== page || typeof value.hasMore !== "boolean") throw new Error(value?.error || "신청 목록을 불러오지 못했습니다. 다시 시도해 주세요.");
          combined = mergePage(combined, value);
          if (!value.hasMore) break;
        }
        if (current === sequence.current && !controller.signal.aborted && combined) { loaded.current = { month, pages: combined.page }; setData(combined); }
      } catch (cause) {
        if (!controller.signal.aborted && current === sequence.current) {
          setError(cause instanceof Error ? cause.message : "신청 목록을 불러오지 못했습니다.");
        }
      } finally { if (current === sequence.current && !controller.signal.aborted) setLoading(false); }
    })();
    const cancelMore = () => moreAbort.current?.abort();
    return () => { controller.abort(); cancelMore(); };
  }, [endpoint, month, reload]);
  const refresh = useCallback(() => setReload(value => value + 1), []);
  async function loadMore() {
    if (moreLock.current || loading || writing || error || !data?.hasMore || data.serviceMonth !== month) return;
    moreLock.current = true; setMoreLoading(true); setMoreError("");
    const current = sequence.current, page = data.page + 1;
    const controller = new AbortController(); moreAbort.current = controller;
    try {
      const response = await fetch(`${endpoint}?month=${encodeURIComponent(month)}&page=${page}`, { cache: "no-store", signal: controller.signal });
      const value = await response.json().catch(() => null);
      if (!response.ok || !Array.isArray(value?.items) || value.serviceMonth !== month || value.page !== page || typeof value.hasMore !== "boolean") throw new Error(value?.error || "다음 신청을 불러오지 못했습니다. 다시 시도해 주세요.");
      if (current === sequence.current && !controller.signal.aborted) { loaded.current = { month, pages: page }; setData(previous => previous?.serviceMonth === month ? mergePage(previous, value) : previous); }
    } catch (cause) {
      if (!controller.signal.aborted && current === sequence.current) setMoreError(cause instanceof Error ? cause.message : "다음 신청을 불러오지 못했습니다.");
    } finally { if (current === sequence.current && !controller.signal.aborted) { moreLock.current = false; setMoreLoading(false); } }
  }
  return <main className={`mx-auto w-full min-w-0 px-4 py-4 text-[var(--color-academy-ink)] ${mode === "admin" ? "max-w-6xl" : "max-w-2xl"}`}>
    <header className="flex flex-wrap items-center justify-between gap-3">
      <div><h1 className="text-xl font-black">{mode === "admin" ? "신규 셔틀 신청" : "새 학생 셔틀 검토"}</h1><p className="mt-1 text-sm text-[var(--color-academy-muted)]">{mode === "admin" ? "기사 의견을 확인한 뒤 명단과 노선을 확정하세요." : "가능한 시각이나 추가 확인할 내용을 학원에 남겨주세요."}</p></div>
      <Link href={mode === "admin" ? "/admin/shuttle/regular" : "/staff/shuttle"} className={BUTTON}>{mode === "admin" ? "셔틀 명단" : "운행 관리"}<span aria-hidden="true" className="material-symbols-outlined text-lg">arrow_forward</span></Link>
    </header>
    <div className="my-4 flex flex-wrap items-end gap-2">
      <label className="w-44 max-w-full text-sm font-bold">적용 월<input aria-label="적용 월" className={`${FIELD} mt-1`} type="month" value={month} disabled={writing} onChange={event => { if (/^\d{4}-(0[1-9]|1[0-2])$/.test(event.target.value)) { setMonth(event.target.value); setNotice(""); } }} /></label>
      <button type="button" className={BUTTON} disabled={loading || writing} onClick={refresh}><span aria-hidden="true" className="material-symbols-outlined text-lg">refresh</span>새로 확인</button>
      {!loading && data?.serviceMonth === month && <span className="pb-3 text-sm text-[var(--color-academy-muted)]">확인 {data.items.length}명{data.hasMore ? " · 다음 신청 있음" : ""}</span>}
    </div>
    {notice && <p role="status" className="mb-3 rounded-lg bg-[var(--color-academy-soft)] px-3 py-2 text-sm font-bold">{notice}</p>}
    {loading && <p role="status" className="py-3 text-sm">신청 목록 확인 중…</p>}
    {error && <p role="alert" className="mb-3 rounded-lg border border-[var(--color-academy-line)] p-3 text-sm">{error}</p>}
    {data?.serviceMonth === month && data.items.length > 0 ? <div className="space-y-3">{data.items.map(item => <IntakeCard key={`${month}:${item.applicationId}`} item={item} mode={mode} month={month} drivers={data.drivers ?? []} disabled={loading || Boolean(error)} onBusy={trackBusy} onSaved={() => { setNotice(mode === "admin" ? "기사 검토를 요청했습니다. 실제 배차와 알림은 변경하지 않았습니다." : "검토 의견을 전달했습니다. 배차 확정은 학원에서 진행합니다."); refresh(); }} />)}</div> : !loading && !error ? <p className="rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] px-4 py-6 text-sm">{data?.serviceMonth === month && data.hasMore ? "다음 신청 목록을 확인해 주세요." : mode === "admin" ? "이 달에 확인할 신규 셔틀 신청이 없습니다." : "이 달에 배정된 검토 요청이 없습니다."}</p> : null}
    {moreError && <p role="alert" className="mt-3 text-sm">{moreError}</p>}
    {data?.serviceMonth === month && data.hasMore && <button type="button" className={`${BUTTON} mt-3 w-full`} disabled={loading || writing || moreLoading || Boolean(error)} onClick={() => void loadMore()}>{moreLoading ? "다음 신청 확인 중…" : "신청 더 보기"}</button>}
  </main>;
}

function mergePage(previous: Payload | null, next: Payload): Payload {
  const items = new Map((previous?.items ?? []).map(item => [item.applicationId, item]));
  for (const item of next.items) items.set(item.applicationId, item);
  return { ...next, drivers: next.drivers ?? previous?.drivers, items: [...items.values()] };
}

function IntakeCard({ item, mode, month, drivers, disabled, onBusy, onSaved }: { item: ShuttleIntakeItem; mode: Mode; month: string; drivers: ShuttleIntakeDriver[]; disabled: boolean; onBusy: (busy: boolean) => void; onSaved: () => void }) {
  const [driverId, setDriverId] = useState(item.review?.driverUserId ?? "");
  const [note, setNote] = useState("");
  const [result, setResult] = useState<"PROPOSED" | "NEEDS_CONFIRMATION">("PROPOSED");
  const [times, setTimes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [draftFingerprint, setDraftFingerprint] = useState(item.fingerprint);
  const lock = useRef(false);
  const days = [...new Set(item.classes.map(row => row.dayOfWeek))];
  const stale = item.review?.status === "STALE";
  const changed = draftFingerprint !== item.fingerprint;
  const writable = mode === "admin" || item.review?.status === "PENDING";
  const resetDriver = drivers.some(driver => driver.id === driverId) ? driverId : "";
  async function submit() {
    if (lock.current || disabled || changed || !writable || (mode === "driver" && stale)) return;
    if (mode === "admin" && !resetDriver) { setError("검토할 기사님을 선택해 주세요."); return; }
    if (mode === "driver" && !note.trim()) { setError("확인한 내용이나 필요한 확인 사항을 적어주세요."); return; }
    const proposals = days.flatMap(dayOfWeek => (["PICKUP", "DROPOFF"] as const).flatMap(direction => times[`${dayOfWeek}:${direction}`] ? [{ dayOfWeek, direction, time: times[`${dayOfWeek}:${direction}`] }] : []));
    if (mode === "driver" && result === "PROPOSED" && proposals.length !== days.length * 2) { setError("요일별 등원·하원 가능 시각을 모두 입력해 주세요."); return; }
    lock.current = true; setBusy(true); onBusy(true); setError("");
    try {
      const response = await fetch(mode === "admin" ? "/api/admin/shuttle/intake" : "/api/staff/shuttle/intake", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(mode === "admin" ? { applicationId: item.applicationId, serviceMonth: month, driverUserId: resetDriver, expectedFingerprint: item.fingerprint } : { reviewId: item.review?.id, expectedFingerprint: item.fingerprint, result, note: note.trim(), proposals: result === "PROPOSED" ? proposals : [] }) });
      const value = await response.json().catch(() => null);
      if (!response.ok || !value?.ok) throw new Error(value?.error || "검토 내용을 저장하지 못했습니다. 다시 시도해 주세요.");
      onSaved();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "검토 내용을 저장하지 못했습니다."); }
    finally { lock.current = false; setBusy(false); onBusy(false); }
  }
  return <article className="min-w-0 rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] p-3 sm:p-4">
    <div className="flex flex-wrap items-start justify-between gap-2"><div><h2 className="text-lg font-black">{item.studentName}<span className="ml-2 text-sm font-medium text-[var(--color-academy-muted)]">{item.grade}</span></h2><p className="mt-1 text-sm">개시일 {item.requestedStartOn ?? "확인 필요"}{item.requestedTime ? ` · 희망 ${item.requestedTime}` : ""}</p></div><span className="rounded-lg bg-[var(--color-academy-soft)] px-2 py-1 text-sm font-bold">{item.review ? REVIEW_LABELS[item.review.status] : "기사 지정 전"}</span></div>
    <ul className="mt-2 space-y-1 text-sm">{item.classes.map(row => <li key={row.id} className="break-keep">{row.name} · {DAYS[row.dayOfWeek] ?? row.dayOfWeek} {row.startTime}~{row.endTime}</li>)}</ul>
    {!stale && <dl className="mt-3 grid gap-2 rounded-lg bg-[var(--color-academy-soft)] p-3 text-sm">{item.locations.map(location => <div key={location.kind} className="min-w-0"><dt className="font-bold">{location.kind === "PICKUP" ? "승차" : "하차"}</dt><dd className="break-words">{location.name || "장소 확인 필요"}{location.address && location.address !== location.name ? ` · ${location.address}` : ""}</dd></div>)}</dl>}
    {stale && <p className="mt-3 text-sm font-bold">신청 내용이 변경됐습니다. 관리자가 다시 검토를 요청해야 합니다.</p>}
    {changed && <div className="mt-3 rounded-lg bg-[var(--color-academy-soft)] p-3 text-sm"><p>신청 내용이 바뀌었습니다. 변경 내용을 확인한 뒤 새로 작성해 주세요.</p><button type="button" className={`${BUTTON} mt-2`} onClick={() => { setDraftFingerprint(item.fingerprint); setNote(""); setTimes({}); setError(""); }}>변경 내용 확인 후 새로 작성</button></div>}
    <p className="mt-3 text-sm font-bold">{item.progress.label}</p><p className="mt-1 break-words text-sm text-[var(--color-academy-muted)]">{item.progress.detail}</p>
    {item.review?.note && <div className="mt-3 border-t border-[var(--color-academy-line)] pt-3 text-sm"><p className="font-bold">{item.review.driverName} 기사님 의견</p><p className="mt-1 whitespace-pre-wrap break-words">{item.review.note}</p>{item.review.proposals.map(proposal => <p key={`${proposal.dayOfWeek}:${proposal.direction}`} className="mt-1">{DAYS[proposal.dayOfWeek] ?? proposal.dayOfWeek} {proposal.direction === "PICKUP" ? "등원" : "하원"} {proposal.time}</p>)}</div>}
    {mode === "admin" ? <div className="mt-3 border-t border-[var(--color-academy-line)] pt-3"><label className="block text-sm font-bold">검토 담당 기사<select className={`${FIELD} mt-1`} value={resetDriver} disabled={busy || disabled || changed} onChange={event => setDriverId(event.target.value)}><option value="">기사님 선택</option>{drivers.map(driver => <option key={driver.id} value={driver.id}>{driver.name}</option>)}</select></label>{drivers.length === 0 && <p className="mt-1 text-sm">등록된 기사 계정을 먼저 확인해 주세요.</p>}<div className="mt-2 flex flex-wrap gap-2"><button className={BUTTON} type="button" disabled={busy || disabled || changed || drivers.length === 0} onClick={() => void submit()}>{busy ? "요청 중…" : item.review ? "다시 검토 요청" : "기사 검토 요청"}</button><Link className={BUTTON} href={item.progress.rosterHref}>명단 확인</Link><Link className={BUTTON} href={item.progress.dispatchHref}>배차 확인</Link></div></div> : writable && !stale ? <fieldset disabled={busy || disabled || changed} className="mt-3 min-w-0 space-y-3 border-t border-[var(--color-academy-line)] pt-3"><legend className="sr-only">기사 검토 의견</legend><label className="block text-sm font-bold">검토 결과<select className={`${FIELD} mt-1`} value={result} onChange={event => setResult(event.target.value as typeof result)}><option value="PROPOSED">가능 시각 제안</option><option value="NEEDS_CONFIRMATION">추가 확인 필요</option></select></label>{result === "PROPOSED" && days.map(day => <div key={day} className="grid min-w-0 grid-cols-2 gap-2">{(["PICKUP", "DROPOFF"] as const).map(direction => <label key={direction} className="min-w-0 text-sm font-bold">{DAYS[day] ?? day} {direction === "PICKUP" ? "등원" : "하원"} 가능 시각<input className={`${FIELD} mt-1 box-border max-w-full`} type="time" value={times[`${day}:${direction}`] ?? ""} onChange={event => setTimes(previous => ({ ...previous, [`${day}:${direction}`]: event.target.value }))} /></label>)}</div>)}<label className="block text-sm font-bold">검토 의견<textarea className={`${FIELD} mt-1 min-h-24 resize-y`} maxLength={1000} value={note} onChange={event => setNote(event.target.value)} placeholder="승하차 장소·이동 시간 등 확인한 내용을 적어주세요." /></label><button className={BUTTON} type="button" onClick={() => void submit()}>{busy ? "저장 중…" : "검토 의견 전달"}</button></fieldset> : null}
    {error && <p role="alert" className="mt-2 break-words text-sm font-bold">{error}</p>}
  </article>;
}
