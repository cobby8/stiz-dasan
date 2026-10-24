"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { calculateMonthlyRegister, validateMonthlyRegisterDraft, type MonthlyRegisterDraft, type MonthlyRegisterTotals, type MonthlyRegisterView } from "@/lib/billing/monthly-register";

type Row = MonthlyRegisterDraft["classes"][number];
type EditorRow = Omit<Row, "baseAmount" | "discountAmount" | "carryAmount" | "prorationAmount" | "status"> & {
  status: Row["status"] | "";
  baseAmount: string; discountAmount: string; carryAmount: string; prorationAmount: string;
};
type Editor = { classes: EditorRow[]; shuttleAmount: string; shuttleBasis: string };
type Action = "SAVE_DRAFT" | "CONFIRM" | "REOPEN";
type Target = { studentId: string; month: string };
type Preview = { action: Action; target: Target; version: number; payload: MonthlyRegisterDraft; totals: MonthlyRegisterTotals; reason: string };
const actions: Record<Action, string> = { SAVE_DRAFT: "초안 저장", CONFIRM: "장부 확정", REOPEN: "수정용으로 다시 열기" };
const statuses: Record<Row["status"], string> = { ACTIVE: "수강", PAUSED: "휴원", WITHDRAWN: "퇴원", CARRY_OVER: "이월" };
const amounts = [
  ["baseAmount", "기본 수강료"], ["discountAmount", "할인 차감"], ["carryAmount", "이월 차감"], ["prorationAmount", "일할 차감"],
] as const;
const money = (value: number) => `${value.toLocaleString("ko-KR")}원`;
const blankEditor = (): Editor => ({ classes: [], shuttleAmount: "", shuttleBasis: "" });
const toEditor = (payload: MonthlyRegisterDraft): Editor => ({
  classes: payload.classes.map((row) => ({ ...row, baseAmount: String(row.baseAmount), discountAmount: String(row.discountAmount), carryAmount: String(row.carryAmount), prorationAmount: String(row.prorationAmount) })),
  shuttleAmount: String(payload.shuttleAmount), shuttleBasis: payload.shuttleBasis,
});

function readAmount(value: string, label: string) {
  if (!/^\d+$/.test(value.trim())) throw new Error(`${label}: 빈칸 없이 0 이상의 정수를 입력해 주세요.`);
  const amount = Number(value);
  if (!Number.isSafeInteger(amount)) throw new Error(`${label}: 금액이 너무 큽니다.`);
  return amount;
}

function buildDraft(editor: Editor, target: Target, reason: string): MonthlyRegisterDraft {
  if (!reason.trim()) throw new Error("이번 작업의 사유를 입력해 주세요.");
  if (!editor.classes.length) throw new Error("실제 등록된 반을 하나 이상 선택해 주세요.");
  const classes = editor.classes.map((row, index): Row => {
    if (!row.status) throw new Error(`${index + 1}번째 반의 이번 달 상태를 직접 선택해 주세요.`);
    if (!row.basis.trim()) throw new Error(`${index + 1}번째 반의 금액·감면 근거를 입력해 주세요.`);
    const parsed = { ...row, status: row.status, baseAmount: readAmount(row.baseAmount, "기본 수강료"), discountAmount: readAmount(row.discountAmount, "할인"), carryAmount: readAmount(row.carryAmount, "이월"), prorationAmount: readAmount(row.prorationAmount, "일할 차감") };
    if (parsed.baseAmount < parsed.discountAmount + parsed.carryAmount + parsed.prorationAmount) throw new Error(`${index + 1}번째 반의 차감액이 기본 수강료보다 큽니다.`);
    return parsed;
  });
  if (!editor.shuttleBasis.trim()) throw new Error("월 셔틀비 근거를 입력해 주세요. 이용하지 않으면 미이용으로 적어 주세요.");
  // 서버와 같은 검증을 사용해 날짜·휴원 0원·감면 합계 기준이 달라지지 않게 한다.
  return validateMonthlyRegisterDraft({ ...target, classes, shuttleAmount: readAmount(editor.shuttleAmount, "월 셔틀비"), shuttleBasis: editor.shuttleBasis.trim(), reason: reason.trim() });
}

export default function MonthlyRegisterClient({ initialStudentId, initialMonth }: { initialStudentId: string; initialMonth: string }) {
  const [studentId, setStudentId] = useState(initialStudentId);
  const [month, setMonth] = useState(initialMonth);
  const [target, setTarget] = useState<Target | null>(initialStudentId && initialMonth ? { studentId: initialStudentId, month: initialMonth } : null);
  const [reload, setReload] = useState(0);
  const [view, setView] = useState<MonthlyRegisterView | null>(null);
  const [editor, setEditor] = useState<Editor>(blankEditor);
  const [reason, setReason] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const requestId = useRef(0);
  const posting = useRef(false);
  const targetMatches = Boolean(target && target.studentId === studentId.trim() && target.month === month);
  const ready = Boolean(view && targetMatches && !loading);
  const confirmed = view?.record?.status === "CONFIRMED";
  const dirty = Boolean(view && JSON.stringify(editor) !== JSON.stringify(view.record ? toEditor(view.record.payload) : blankEditor()));
  const hasUnknownClasses = Boolean(view && editor.classes.some((row) => !view.candidates.some((candidate) => candidate.classId === row.classId)));
  const locked = !ready || saving || Boolean(preview) || confirmed || !view?.writesEnabled || needsRefresh || hasUnknownClasses;
  const hasUnsavedWork = dirty || Boolean(reason.trim()) || Boolean(preview);

  useEffect(() => {
    if (!hasUnsavedWork && !saving && !needsRefresh) return;
    let linkApproved = false;
    let approvalTimer: ReturnType<typeof setTimeout> | undefined;
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      // 새로고침·창 닫기는 브라우저 기본 경고로 보호한다. 강제 종료를 막지는 못한다.
      if (linkApproved) return;
      event.preventDefault();
      event.returnValue = "";
    };
    const guardLink = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (!(anchor instanceof HTMLAnchorElement) || anchor.hasAttribute("download") || (anchor.target && anchor.target !== "_self")) return;
      const destination = new URL(anchor.href, window.location.href);
      if (!["http:", "https:"].includes(destination.protocol)) return;
      if (destination.origin === window.location.origin && destination.pathname === window.location.pathname && destination.search === window.location.search && destination.hash) return;
      const block = () => { event.preventDefault(); event.stopImmediatePropagation(); };
      if (posting.current || saving || (needsRefresh && loading)) {
        block(); setError("저장 결과를 확인 중입니다. 확인이 끝난 뒤 이동해 주세요."); return;
      }
      const message = needsRefresh
        ? "저장 결과가 아직 확인되지 않았습니다. 재조회하지 않고 이동할까요?"
        : "저장하지 않은 편집이나 작업 사유가 있습니다. 내용을 버리고 이동할까요?";
      if (!window.confirm(message)) { block(); return; }
      // 같은 클릭의 전체 페이지 이동에서는 이미 받은 확인을 두 번 묻지 않는다.
      linkApproved = true;
      approvalTimer = setTimeout(() => { linkApproved = false; }, 0);
    };
    window.addEventListener("beforeunload", warnBeforeUnload);
    // 이 화면의 돌아가기뿐 아니라 관리자 메뉴의 같은 창 링크도 먼저 확인한다.
    document.addEventListener("click", guardLink, true);
    return () => {
      clearTimeout(approvalTimer);
      window.removeEventListener("beforeunload", warnBeforeUnload);
      document.removeEventListener("click", guardLink, true);
    };
  }, [hasUnsavedWork, saving, needsRefresh, loading]);

  useEffect(() => {
    const controller = new AbortController();
    const id = ++requestId.current;
    setView(null); setEditor(blankEditor()); setReason(""); setPreview(null); setError("");
    if (!target) return () => controller.abort();
    setLoading(true);
    void (async () => {
      try {
        const response = await fetch(`/api/admin/finance/monthly-register?${new URLSearchParams(target)}`, { cache: "no-store", signal: controller.signal });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "월 장부를 불러오지 못했습니다.");
        if (id !== requestId.current || controller.signal.aborted) return;
        const next = result as MonthlyRegisterView;
        if (next.record && (next.record.studentId !== target.studentId || next.record.month !== target.month)) throw new Error("조회 대상과 반환된 장부가 다릅니다. 다시 조회해 주세요.");
        setNeedsRefresh(false);
        setView(next); setEditor(next.record ? toEditor(next.record.payload) : blankEditor());
      } catch (cause) {
        if (id === requestId.current && !controller.signal.aborted) setError(cause instanceof Error ? cause.message : "조회 실패");
      } finally {
        if (id === requestId.current && !controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [target, reload]);

  function chooseTarget() {
    if (posting.current) return;
    if (!studentId.trim() || !/^\d{4}-\d{2}$/.test(month)) { setError("학생 ID와 적용 월을 입력해 주세요."); return; }
    if (dirty && !window.confirm("저장하지 않은 편집을 버리고 다시 조회할까요?")) return;
    // 새 학생·월을 선택한 즉시 이전 응답과 저장 대상을 무효화한다.
    requestId.current += 1;
    setView(null); setPreview(null); setLoading(true);
    setNotice(""); setTarget({ studentId: studentId.trim(), month }); setReload((value) => value + 1);
  }

  function prepare(action: Action) {
    if (!view || !target || !ready || saving || !view.writesEnabled || needsRefresh) return;
    setError(""); setNotice("");
    try {
      if (!reason.trim()) throw new Error("이번 작업의 사유를 입력해 주세요.");
      if (hasUnknownClasses) throw new Error("현재 등록 후보에 없는 과거 반이 포함되어 있어 확인보류합니다.");
      if (action === "CONFIRM" && (dirty || !view.record)) throw new Error("편집 내용을 먼저 초안으로 저장하고 다시 확인해 주세요.");
      if (action === "SAVE_DRAFT" && confirmed) throw new Error("확정된 장부는 먼저 수정용으로 다시 열어 주세요.");
      if (action === "REOPEN" && !confirmed) throw new Error("확정된 장부만 다시 열 수 있습니다.");
      const payload = action === "SAVE_DRAFT" ? buildDraft(editor, target, reason) : view.record!.payload;
      if (action === "CONFIRM") {
        const missing = view.candidates.filter((candidate) => ["ACTIVE", "PAUSED"].includes(candidate.status) && !payload.classes.some((row) => row.classId === candidate.classId));
        if (missing.length) throw new Error(`현재 등록 반이 빠져 있습니다: ${missing.map((row) => row.className).join(", ")}. 제외 반도 휴원·퇴원·이월과 0원 근거로 기록해 주세요.`);
      }
      setPreview({ action, target: { ...target }, version: view.record?.version ?? 0, payload, totals: calculateMonthlyRegister(payload), reason: reason.trim() });
    } catch (cause) { setError(cause instanceof Error ? cause.message : "입력값을 확인해 주세요."); }
  }

  async function executePreview() {
    if (!preview || !view?.writesEnabled || posting.current || !ready) return;
    if (preview.target.studentId !== target?.studentId || preview.target.month !== target?.month || preview.version !== (view.record?.version ?? 0)) {
      setError("대상 또는 버전이 달라졌습니다. 다시 조회해 주세요."); setPreview(null); return;
    }
    posting.current = true; setSaving(true); setError("");
    // POST 응답 이후에도 재조회가 성공하기 전까지 결과 미확인 경고를 유지한다.
    setNeedsRefresh(true);
    const id = requestId.current;
    try {
      const response = await fetch("/api/admin/finance/monthly-register", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: preview.action, ...preview.target, expectedVersion: preview.version, reason: preview.reason,
          ...(preview.action === "SAVE_DRAFT" ? { payload: preview.payload } : {}) }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "처리하지 못했습니다. 다시 조회해 주세요.");
      if (id !== requestId.current) return;
      setNotice(`${actions[preview.action]} 완료. 저장 결과를 다시 조회합니다. 청구서·문자는 생성하지 않았습니다.`);
      setPreview(null); setView(null); setReload((value) => value + 1);
    } catch (cause) {
      if (id === requestId.current) { setError(`${cause instanceof Error ? cause.message : "저장 결과를 확인하지 못했습니다."} 자동 재시도하지 않습니다. 현재 상태를 다시 조회한 뒤 진행해 주세요.`); setNeedsRefresh(true); setPreview(null); }
    } finally { posting.current = false; setSaving(false); }
  }

  function patchRow(index: number, patch: Partial<EditorRow>) {
    setEditor((current) => ({ ...current, classes: current.classes.map((row, i) => i === index ? { ...row, ...patch } : row) }));
  }
  const className = (classId: string) => view?.candidates.find((row) => row.classId === classId)?.className ?? "반 이름 확인 필요";

  return <section className="space-y-5">
    <Link href="/admin/finance/monthly-ledger" className="underline">월별·반별 장부 점검으로 돌아가기</Link>
    <header><h1 className="text-2xl font-bold">학생별 월 운영 장부</h1><p className="mt-2">학생·월·반별 금액과 근거를 초안으로 작성하고 확인합니다. 청구·수납·문자·시트·Rallyz에는 반영하지 않습니다.</p></header>
    <div className="rounded border border-[var(--color-brand-orange-500)] p-4">이 화면의 확정은 장부 내용 확인입니다. 청구서 발행이나 운영 시스템 전환을 뜻하지 않습니다. 빈 금액과 날짜를 자동으로 채우지 않습니다.</div>
    <form onSubmit={(event) => { event.preventDefault(); chooseTarget(); }} className="flex flex-wrap items-end gap-3">
      <label className="grid gap-1">원생 번호<input value={studentId} disabled={saving || Boolean(preview)} onChange={(event) => setStudentId(event.target.value)} className="rounded border p-2" /></label>
      <label className="grid gap-1">적용 월<input type="month" value={month} disabled={saving || Boolean(preview)} onChange={(event) => setMonth(event.target.value)} className="rounded border p-2" /></label>
      <button disabled={saving || Boolean(preview) || loading} className="rounded border px-4 py-2 disabled:opacity-50">조회 / 새로고침</button>
    </form>
    {loading && <p role="status">장부를 조회하고 있습니다.</p>}
    {!targetMatches && view && <p>입력한 학생·월로 다시 조회해 주세요. 이전 장부의 편집과 저장은 잠겨 있습니다.</p>}
    {error && <p role="alert" className="rounded border p-3">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {ready && view && target && <>
      <div className="rounded border p-4"><h2 className="text-lg font-bold">{view.studentName} · {target.month}</h2><p className="break-all text-sm">원생 번호: {target.studentId}</p>
        <p>{view.record ? `${view.record.status === "CONFIRMED" ? "확정" : "초안"} · 기록 ${view.record.version}차` : "저장된 장부 없음"}</p>
        {!view.writesEnabled && <p className="mt-2 font-bold">현재 조회만 가능합니다. 저장 기능은 준비 중입니다.</p>}
        {hasUnknownClasses && <p className="mt-2 font-bold">현재 등록 후보에 없는 과거 반이 있어 확인보류합니다. 내용을 조회할 수 있지만 수정·확정은 잠겨 있습니다.</p>}
        {confirmed && <p>확정 장부는 편집할 수 없습니다. 사유를 입력하고 수정용으로 다시 열어 주세요.</p>}
        {view.record && <p>저장된 수강료 {money(view.record.totals.tuitionAmount)} + 월 셔틀비 {money(view.record.totals.shuttleAmount)} = 합계 {money(view.record.totals.totalAmount)}</p>}
      </div>
      <fieldset disabled={locked} className="space-y-4 disabled:opacity-70">
        <legend className="font-bold">반별 월 내역</legend>
        <p>현재 수강·휴원 반은 확정 전에 모두 기록해야 합니다. 월에 제외할 반도 상태와 0원 근거를 남겨 주세요. 휴원·퇴원·이월 상태는 모든 금액을 직접 0으로 입력해야 합니다.</p>
        <label className="grid max-w-lg gap-1">실제 등록 반 추가<select value="" className="rounded border p-2" onChange={(event) => {
          const candidate = view.candidates.find((row) => row.classId === event.target.value);
          if (!candidate) return;
          setEditor((current) => ({ ...current, classes: [...current.classes, { classId: candidate.classId, status: "", periodStart: "", periodEnd: "", baseAmount: "", discountAmount: "", carryAmount: "", prorationAmount: "", basis: "" }] }));
        }}><option value="">반을 선택해 주세요</option>{view.candidates.filter((candidate) => !editor.classes.some((row) => row.classId === candidate.classId)).map((candidate) => <option key={candidate.classId} value={candidate.classId}>{candidate.className} (현재 {statuses[candidate.status as Row["status"]] ?? candidate.status})</option>)}</select></label>
        {editor.classes.map((row, index) => <div key={row.classId} className="space-y-3 rounded border p-4">
          <div className="flex items-center justify-between gap-3"><h3 className="font-bold">{index + 1}. {className(row.classId)}</h3><button type="button" className="rounded border px-3 py-1" onClick={() => setEditor((current) => ({ ...current, classes: current.classes.filter((_, i) => i !== index) }))}>초안에서 제외</button></div>
          <p className="break-all text-xs">반 ID: {row.classId}</p>
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="grid gap-1">이번 달 상태<select className="rounded border p-2" value={row.status} onChange={(event) => patchRow(index, { status: event.target.value as EditorRow["status"] })}><option value="">상태를 선택해 주세요</option>{Object.entries(statuses).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
            <label className="grid gap-1">실제 시작일<input type="date" className="rounded border p-2" value={row.periodStart} onChange={(event) => patchRow(index, { periodStart: event.target.value })} /></label>
            <label className="grid gap-1">실제 종료일<input type="date" className="rounded border p-2" value={row.periodEnd} onChange={(event) => patchRow(index, { periodEnd: event.target.value })} /></label>
          </div>
          <div className="grid gap-3 sm:grid-cols-4">{amounts.map(([key, label]) => <label key={key} className="grid gap-1">{label} (원)<input type="text" inputMode="numeric" className="min-w-0 rounded border p-2" value={row[key]} onChange={(event) => patchRow(index, { [key]: event.target.value })} placeholder="없으면 0을 입력" /></label>)}</div>
          <label className="grid gap-1">금액·할인·이월·일할 근거<textarea className="rounded border p-2" value={row.basis} onChange={(event) => patchRow(index, { basis: event.target.value })} /></label>
        </div>)}
        <div className="grid gap-3 rounded border p-4 sm:grid-cols-2"><label className="grid gap-1">월 전체 셔틀비 — 한 번만 (원)<input type="text" inputMode="numeric" className="rounded border p-2" value={editor.shuttleAmount} onChange={(event) => setEditor((current) => ({ ...current, shuttleAmount: event.target.value }))} placeholder="미이용이면 0을 입력" /></label>
          <label className="grid gap-1">셔틀비 근거<textarea className="rounded border p-2" value={editor.shuttleBasis} onChange={(event) => setEditor((current) => ({ ...current, shuttleBasis: event.target.value }))} /></label></div>
      </fieldset>
      <label className="grid gap-1">이번 저장·확정·재열기 사유<textarea disabled={saving || Boolean(preview) || !view.writesEnabled} className="rounded border p-2" value={reason} onChange={(event) => setReason(event.target.value)} /></label>
      <div className="flex flex-wrap gap-3">
        {confirmed ? <button type="button" disabled={saving || Boolean(preview) || !view.writesEnabled || needsRefresh || hasUnknownClasses} onClick={() => prepare("REOPEN")} className="rounded border px-4 py-2 disabled:opacity-50">재열기 미리보기</button> : <>
          <button type="button" disabled={locked} onClick={() => prepare("SAVE_DRAFT")} className="rounded border px-4 py-2 disabled:opacity-50">초안 저장 미리보기</button>
          <button type="button" disabled={locked || dirty || !view.record} onClick={() => prepare("CONFIRM")} className="rounded border px-4 py-2 disabled:opacity-50">저장된 장부 확정 미리보기</button>
        </>}
      </div>
      {dirty && !confirmed && <p>저장하지 않은 편집이 있습니다. 확정 전에 초안을 저장해야 합니다.</p>}
      {preview && <section aria-label="작업 미리보기" className="space-y-3 rounded border-2 border-[var(--color-brand-orange-500)] p-4">
        <h2 className="text-lg font-bold">{actions[preview.action]} 전 최종 확인</h2>
        <p>{view.studentName} · {preview.target.month} · 기준 버전 {preview.version}</p><p className="break-all text-xs">원생 번호: {preview.target.studentId}</p>
        {preview.payload.classes.map((row) => <div key={row.classId} className="border-b pb-2"><p>{className(row.classId)} · {statuses[row.status]} · {row.periodStart} ~ {row.periodEnd}</p><p className="break-all text-xs">반 ID: {row.classId}</p><p>기본 {money(row.baseAmount)} − 할인 {money(row.discountAmount)} − 이월 {money(row.carryAmount)} − 일할 {money(row.prorationAmount)} = {money(preview.totals.rows.find((item) => item.classId === row.classId)?.amount ?? 0)}</p><p>근거: {row.basis}</p></div>)}
        <p>월 셔틀비 {money(preview.payload.shuttleAmount)} · {preview.payload.shuttleBasis}</p><p>작업 사유: {preview.reason}</p>
        <p className="font-bold">수강료 합계 {money(preview.totals.tuitionAmount)} + 월 셔틀비 {money(preview.totals.shuttleAmount)} = 월 총액 {money(preview.totals.totalAmount)}</p>
        <p>장부에만 기록하며 청구서 발행·수납·문자 발송은 하지 않습니다.</p>
        <div className="flex gap-3"><button type="button" disabled={saving} onClick={() => void executePreview()} className="rounded border px-4 py-2 disabled:opacity-50">{saving ? "처리 중…" : `위 내용을 확인했고 ${actions[preview.action]}합니다`}</button><button type="button" disabled={saving} onClick={() => setPreview(null)} className="rounded border px-4 py-2">취소</button></div>
      </section>}
      <section className="space-y-2"><h2 className="font-bold">장부 변경 이력</h2>{view.history.length ? view.history.map((entry) => <p key={entry.version}>버전 {entry.version} · {entry.status === "CONFIRMED" ? "확정" : "초안"} · {entry.createdAt} · {entry.reason}</p>) : <p>변경 이력 없음</p>}</section>
    </>}
  </section>;
}
