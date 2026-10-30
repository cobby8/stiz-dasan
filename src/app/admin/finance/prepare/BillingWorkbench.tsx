"use client";
import { adminErrorText } from "@/components/admin/adminDisplayText";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import AdminModal from "@/components/admin/AdminModal";
import styles from "./workbench.module.css";
import { type WorkbenchRow, type WorkbenchView, type WorkbenchAbsence, WORKBENCH_MAX_AMOUNT, STANDARD_MONTHLY_SESSIONS, shortMonthProration } from "@/lib/billing/workbench";

type Row = WorkbenchRow;
type View = WorkbenchView;
type AmountKey = "baseAmount" | "discountAmount" | "prorationAmount" | "carryAmount" | "shuttleAmount";
type Edit = Record<AmountKey, string> & { reason: string; periodStart: string; periodEnd: string };
type Action = "SAVE" | "CONFIRM" | "ISSUE";
const amounts: [AmountKey, string][] = [["baseAmount", "기준 수강료"], ["discountAmount", "할인"], ["prorationAmount", "기간 조정"], ["carryAmount", "이월 차감"], ["shuttleAmount", "셔틀"]];
const absenceReasonLabels: Record<string, string> = { ILLNESS_INJURY: "질병·부상", PERSONAL: "개인 사정", FAMILY_TRIP: "가족 여행", SCHOOL_EVENT: "학교 행사", ETC: "기타" };
const suggestedResolution = (item: WorkbenchAbsence): "CARRY" | "MAKEUP" => item.reason === "ILLNESS_INJURY" && !item.makeupStatus?.split(",").some(status => ["USED", "ATTENDED", "NO_SHOW"].includes(status)) ? "CARRY" : "MAKEUP";
// 네트워크·응답 해석 오류는 작업별 안내로, 그 밖의 오류도 개발 언어가 섞이면 안내 문구로 바꾼다
const errorText = (failure: unknown, fallback: string) => failure instanceof TypeError || failure instanceof SyntaxError ? fallback : adminErrorText(failure, fallback);
const won = (amount: number) => `${amount.toLocaleString("ko-KR")}원`;
const label = (row: Row) => (row.blockingReasons?.length ?? 0) > 0 ? "발행 보류" : row.draftStatus === "ZERO" ? "0원 정산" : row.draftStatus === "ISSUED" ? "사이트 발행" : row.status === "ISSUED" ? "기존 청구 유지" : row.draftStatus === "CONFIRMED" ? "확정" : row.status === "REVIEW" ? "확인 필요" : row.status === "EXCLUDED" ? "제외" : "검토 가능";
const asEdit = (row: Row): Edit => ({ baseAmount: String(row.baseAmount), discountAmount: String(row.discountAmount), prorationAmount: String(row.prorationAmount), carryAmount: String(row.carryAmount), shuttleAmount: String(row.shuttleAmount), reason: "", periodStart: row.periodStart?.slice(0, 10) ?? "", periodEnd: row.periodEnd?.slice(0, 10) ?? "" });
// 3회 달: 연간 일정상 그달 수업이 4회 미만. 입력한 기간이 그달 수업일을 모두 덮으면 자동 차감 대상이다(서버 판정과 같은 기준).
const isShortMonth = (row: Row) => (row.monthDates?.length ?? 0) > 0 && row.monthDates.length < STANDARD_MONTHLY_SESSIONS;
const coversMonth = (row: Row, edit: Edit) => Boolean(edit.periodStart && edit.periodEnd) && row.monthDates.filter((date) => date >= edit.periodStart && date <= edit.periodEnd).length === row.monthDates.length;
const total = (row: Row, edit?: Edit) => edit ? Math.max(0, Number(edit.baseAmount) - Number(edit.discountAmount) - Number(edit.prorationAmount) - Number(edit.carryAmount) + Number(edit.shuttleAmount)) : row.totalAmount;

export default function BillingWorkbench() {
    const params = useSearchParams();
    const now = new Date();
    const initialMonth = params.get("month");
    const [month, setMonth] = useState(initialMonth && /^\d{4}-(0[1-9]|1[0-2])$/.test(initialMonth) ? initialMonth : `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`);
    const [view, setView] = useState<View | null>(null);
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [notice, setNotice] = useState("");
    const [conflict, setConflict] = useState(false);
    const [edits, setEdits] = useState<Record<string, Edit>>({});
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [expanded, setExpanded] = useState<Set<string>>(new Set());
    const [search, setSearch] = useState("");
    const [filter, setFilter] = useState("UNISSUED");
    const [classId, setClassId] = useState("");
    const [batchReason, setBatchReason] = useState("");
    const [previewAction, setPreviewAction] = useState<Action | null>(null);
    const [previewStudent, setPreviewStudent] = useState<string | null>(null);
    const requestEpoch = useRef(0);
    const retryRequest = useRef<{ signature: string; id: string } | null>(null);
    const [absence, setAbsence] = useState<WorkbenchAbsence | null>(null);
    const [resolution, setResolution] = useState<"CARRY" | "MAKEUP">("CARRY");
    const [eligibility, setEligibility] = useState("NONE");
    const [evidenceConfirmed, setEvidenceConfirmed] = useState(false);
    const [cancelReservation, setCancelReservation] = useState(false);
    const [absenceReason, setAbsenceReason] = useState("");
    const [originMonth, setOriginMonth] = useState("");
    const dirty = Object.keys(edits).length > 0;
    const rows = useMemo(() => view?.rows ?? [], [view]);
    const selectedRows = rows.filter((row) => selected.has(row.id));
    const editable = Boolean(view?.writesEnabled && view.storageReady && !busy && !loading && !conflict);

    const load = useCallback(async (targetMonth: string) => {
        const epoch = ++requestEpoch.current;
        setLoading(true); setError(""); setNotice("");
        try {
            const response = await fetch(`/api/admin/billing-workbench?month=${encodeURIComponent(targetMonth)}`, { cache: "no-store" });
            const body = await response.json();
            if (!response.ok) throw new Error(body.error || "청구 자료를 불러오지 못했습니다.");
            if (!Array.isArray(body.rows) || body.month !== targetMonth) throw new Error("청구 자료를 확인하지 못했습니다.");
            if (epoch !== requestEpoch.current) return;
            setView(body); setEdits({}); setSelected(new Set()); setExpanded(new Set()); setConflict(false);
        } catch (failure) {
            if (epoch === requestEpoch.current) setError(errorText(failure, "청구 자료를 불러오지 못했습니다. 다시 시도해주세요."));
        } finally { if (epoch === requestEpoch.current) setLoading(false); }
    }, []);

    useEffect(() => { void load(month); }, [month, load]);
    useEffect(() => {
        if (!dirty) return;
        const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
        const guardLink = (event: MouseEvent) => {
            const anchor = (event.target as Element)?.closest?.("a[href]");
            if (anchor && !window.confirm("저장하지 않은 수정이 있습니다. 이 화면을 나갈까요?")) event.preventDefault();
        };
        window.addEventListener("beforeunload", warn); document.addEventListener("click", guardLink, true);
        return () => { window.removeEventListener("beforeunload", warn); document.removeEventListener("click", guardLink, true); };
    }, [dirty]);

    const visible = useMemo(() => rows.filter((row) => {
        const needle = search.trim().toLocaleLowerCase();
        return (!needle || `${row.studentName} ${row.className}`.toLocaleLowerCase().includes(needle))
            && (!classId || row.classId === classId)
            && (filter === "ALL" || (filter === "UNISSUED" ? !["EXCLUDED", "ISSUED"].includes(row.status) : filter === "CONFIRMED" ? row.draftStatus === "CONFIRMED" : row.status === filter));
    }).sort((a, b) => Number(b.status === "REVIEW") - Number(a.status === "REVIEW") || a.studentName.localeCompare(b.studentName, "ko")), [rows, search, classId, filter]);
    const classes = Array.from(new Map(rows.map((row) => [row.classId, row.className])).entries());
    const toggle = (id: string) => setSelected((old) => { const next = new Set(old); if (next.has(id)) next.delete(id); else next.add(id); return next; });
    const toggleDetails = (id: string) => setExpanded((old) => { const next = new Set(old); if (next.has(id)) next.delete(id); else next.add(id); return next; });
    const setField = (row: Row, key: keyof Edit, value: string) => {
        setEdits((old) => {
            const prev = old[row.id] ?? asEdit(row);
            const next = { ...prev, [key]: value };
            // 3회 달을 그달 전체로 청구할 때 수강료·할인을 바꾸거나, 좁혔던 기간을 다시 그달 전체로 넓히면
            // 기간 조정을 할인 후 금액 기준으로 다시 계산한다
            const widenedToMonth = (key === "periodStart" || key === "periodEnd") && !coversMonth(row, prev);
            if ((key === "baseAmount" || key === "discountAmount" || widenedToMonth) && isShortMonth(row) && coversMonth(row, next)) {
                const base = Number(next.baseAmount), discount = Number(next.discountAmount);
                if (next.baseAmount.trim() && next.discountAmount.trim() && Number.isSafeInteger(base) && Number.isSafeInteger(discount)) next.prorationAmount = String(shortMonthProration(base, row.monthDates.length, discount));
            }
            return { ...old, [row.id]: next };
        });
        setSelected((old) => new Set([...old, row.id]));
    };
    const hasHardBlock = (row: Row) => (row.blockingReasons?.length ?? 0) > 0 || (view?.carrySettlementReady === false && row.carryAmount > 0);
    const canSelect = (row: Row) => !["EXCLUDED", "ISSUED"].includes(row.status) && !["ISSUED", "ZERO"].includes(row.draftStatus ?? "");

    async function perform(action: Action) {
        if (!view || !editable || !selectedRows.length) return;
        if (action !== "SAVE" && selectedRows.some(hasHardBlock)) { setError("발행을 보류한 청구가 포함되어 있습니다. 각 행의 확인할 내용을 먼저 해결해주세요."); return; }
        setBusy(true); setError(""); setNotice("");
        try {
            const payloadRows = selectedRows.map((row) => {
                if (action !== "SAVE") return { id: row.id, expectedVersion: row.version };
                const edit = { ...(edits[row.id] ?? asEdit(row)) };
                edit.reason = edit.reason || batchReason || (!edits[row.id] && row.status === "READY" ? "자동 계산 제안 검토" : "");
                if (!edit.reason.trim()) throw new Error(`${row.studentName} · ${row.className}: 검토·수정 사유를 적어주세요.`);
                for (const [key] of amounts) {
                    const value = Number(edit[key]);
                    if (!edit[key].trim() || !Number.isSafeInteger(value) || (value < 0 || value > WORKBENCH_MAX_AMOUNT)) throw new Error("금액은 0~100,000,000원의 원 단위 숫자로 입력해주세요.");
                }
                const hasPeriod = Boolean(edit.periodStart || edit.periodEnd);
                if ((hasPeriod || Number(edit.prorationAmount) > 0) && (!/^\d{4}-\d{2}-\d{2}$/.test(edit.periodStart) || !/^\d{4}-\d{2}-\d{2}$/.test(edit.periodEnd) || edit.periodStart > edit.periodEnd)) throw new Error(`${row.studentName}: 수강 시작일과 종료일을 확인해주세요.`);
                return { id: row.id, expectedVersion: row.version, ...Object.fromEntries(amounts.map(([key]) => [key, Number(edit[key])])), ...(hasPeriod ? { periodStart: edit.periodStart, periodEnd: edit.periodEnd } : {}), reason: edit.reason.trim() };
            });
            const command = { action, month, sourceVersion: view.sourceVersion, rows: payloadRows };
            const signature = JSON.stringify(command);
            if (retryRequest.current?.signature !== signature) retryRequest.current = { signature, id: crypto.randomUUID() };
            const response = await fetch("/api/admin/billing-workbench", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...command, requestId: retryRequest.current.id }) });
            const body = await response.json();
            if (!response.ok) {
                if (response.status === 409 && body.refreshRequired !== false) setConflict(true);
                throw new Error(body.error || "처리하지 못했습니다. 입력한 내용을 유지했습니다.");
            }
            if (!body.view || !Array.isArray(body.view.rows)) throw new Error("저장 결과를 확인하지 못했습니다. 새로 조회해 상태를 확인해주세요.");
            setView(body.view); retryRequest.current = null;
            setEdits((old) => Object.fromEntries(Object.entries(old).filter(([id]) => !selected.has(id))));
            setPreviewAction(null);
            if (action === "ISSUE") setSelected(new Set());
            setNotice(action === "SAVE" ? "검토 내용을 저장하고 최신 자료로 확인했습니다." : action === "CONFIRM" ? "선택한 청구를 확정했습니다. 발행 전 마지막으로 확인해주세요." : `사이트 청구 ${body.operationResult?.paymentIds?.length ?? 0}건을 발행했습니다. 0원 정산 ${body.operationResult?.zeroCount ?? 0}건. 랠리즈 발행과 학부모 전달은 별도 확인이 필요합니다.`);
        } catch (failure) { setError(errorText(failure, "처리 결과를 확인하지 못했습니다. 입력한 내용은 유지됩니다. 새로 조회하거나 다시 시도해주세요.")); }
        finally { setBusy(false); }
    }

    async function resolveAbsence() {
        if (!absence || !view || !editable || dirty) return;
        setBusy(true); setError("");
        try {
            const command = { action: "RESOLVE_ABSENCE", month, sourceVersion: view.sourceVersion, absenceId: absence.id, resolution, eligibility, evidenceConfirmed, cancelReservation, originMonth, reason: absenceReason.trim() };
            const signature = JSON.stringify(command);
            if (retryRequest.current?.signature !== signature) retryRequest.current = { signature, id: crypto.randomUUID() };
            const response = await fetch("/api/admin/billing-workbench", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...command, requestId: retryRequest.current.id }) });
            const body = await response.json();
            if (!response.ok) { if (response.status === 409 && body.refreshRequired !== false) setConflict(true); throw new Error(body.error || "결석 처리를 저장하지 못했습니다."); }
            if (!body.view || !Array.isArray(body.view.rows)) throw new Error("결석 처리 결과를 확인하지 못했습니다. 새로 조회해주세요.");
            setView(body.view); setSelected(new Set()); setAbsence(null); retryRequest.current = null;
            setNotice("결석 처리와 청구 계산을 다시 확인했습니다. 청구 금액을 검토하고 저장·확정해주세요.");
        } catch (failure) { setError(errorText(failure, "결석 처리 결과를 확인하지 못했습니다. 입력한 내용을 유지했습니다.")); }
        finally { setBusy(false); }
    }

    const details = (row: Row) => {
        const edit = edits[row.id] ?? asEdit(row);
        const locked = !editable || !canSelect(row);
        return <div className={styles.details}>
            <div><h3>계산 근거</h3>{(row.blockingReasons?.length ?? 0) > 0 && <div className={styles.error}><strong>확정·발행 보류</strong><ul>{row.blockingReasons.map((reason, index) => <li key={index}>{reason}</li>)}</ul></div>}<ul>{row.basis.map((basis, index) => <li key={index}>{basis}</li>)}</ul>{row.reviewReasons.length > 0 && <><h3 className="mt-3">확인할 내용</h3><ul>{row.reviewReasons.map((reason, index) => <li key={index}>{reason}</li>)}</ul></>}<p className={`${styles.muted} mt-2`}>이월 사용 가능 {won(row.carryAvailable)} · 제안 반영 후 잔액 {won(row.remainingCarry)}</p>
                {(view?.absences ?? []).filter((item) => item.studentId === row.studentId && item.classId === row.classId).map((item) => <div key={item.id} className="mt-2 flex flex-wrap items-center gap-2 text-sm"><span>{item.date.slice(0, 10)} · {absenceReasonLabels[item.reason] ?? "사유 확인"} · {item.resolution === "CARRY" ? "이월" : item.resolution === "MAKEUP" ? "보강" : suggestedResolution(item) === "CARRY" ? "이월 검토 추천" : "보강 추천"}</span><button type="button" className={styles.button} disabled={!editable || dirty || Boolean(item.resolution)} onClick={() => { setAbsence(item); setResolution(suggestedResolution(item)); setEligibility(item.reason === "ILLNESS_INJURY" ? "ILLNESS_INJURY" : "NONE"); setEvidenceConfirmed(false); setCancelReservation(false); setAbsenceReason(""); setOriginMonth(item.date.slice(0, 7)); }}>이월·보강 검토</button></div>)}
                <button type="button" className={`${styles.button} mt-2`} onClick={() => setPreviewStudent(row.id)}>학부모 청구 내역 미리보기</button></div>
            <div><h3>금액 검토·수정</h3><div className={styles.fields}><label>수강 시작일<input aria-label={`${row.studentName} 수강 시작일`} type="date" className={styles.input} value={edit.periodStart} disabled={locked} onChange={(event) => setField(row, "periodStart", event.target.value)} /></label><label>수강 종료일<input aria-label={`${row.studentName} 수강 종료일`} type="date" className={styles.input} value={edit.periodEnd} disabled={locked} onChange={(event) => setField(row, "periodEnd", event.target.value)} /></label>{amounts.map(([key, title]) => <label key={key}>{title}<input aria-label={`${row.studentName} ${title}`} className={styles.input} inputMode="numeric" min="0" max={WORKBENCH_MAX_AMOUNT} type="number" step="1" disabled={locked} value={edit[key]} onChange={(event) => setField(row, key, event.target.value)} /></label>)}<label className={styles.reason}>검토·수정 사유 (필수)<textarea aria-label={`${row.studentName} 검토·수정 사유`} disabled={locked} rows={2} className={styles.input} maxLength={500} value={edit.reason} onChange={(event) => setField(row, "reason", event.target.value)} /></label></div>{isShortMonth(row) && (coversMonth(row, edit)
                ? <p className={`${styles.notice} mt-2`}>이 달은 연간 일정 {row.monthDates.length}회입니다. 기간 조정은 할인 후 금액의 {STANDARD_MONTHLY_SESSIONS - row.monthDates.length}/{STANDARD_MONTHLY_SESSIONS}로 자동 계산되고, 수강료·할인을 바꾸면 다시 계산됩니다.</p>
                : <p role="alert" className={`${styles.error} mt-2`}>수강 기간을 그달 일부로 좁혔습니다. 기간 조정 {won(Number(edit.prorationAmount) || 0)}에는 3회 달 자동 차감이 들어 있을 수 있으니, 실제 듣는 수업일 기준으로 다시 입력해주세요.</p>)}
                <p className={`${styles.muted} mt-2`}>입력한 행은 자동 선택됩니다. 기간을 바꾸면 실제 수업일과 기간 차감액을 함께 확인해주세요. 수정 후에는 다시 확정해야 합니다.</p></div>
        </div>;
    };

    const check = (row: Row) => <label className={styles.check}><input aria-label={`${row.studentName} ${row.className} 선택`} type="checkbox" checked={selected.has(row.id)} disabled={!canSelect(row) || busy} onChange={() => toggle(row.id)} /></label>;
    const previewRow = rows.find((row) => row.id === previewStudent);
    const selectedTotal = selectedRows.reduce((sum, row) => sum + total(row, edits[row.id]), 0);

    return <div className={styles.workbench}>
        <header className={styles.header}><div><Link href="/admin/finance" className={styles.muted}>청구·수납으로</Link><h1>이번 달 청구 준비</h1></div><label className="flex min-w-0 items-center gap-2 whitespace-nowrap text-sm font-bold"><span className="shrink-0">청구 기간</span><input aria-label="청구 기간" type="month" className={styles.input} value={month} disabled={busy} onChange={(event) => { if (!event.target.value || (dirty && !confirm("저장하지 않은 수정을 버리고 기간을 바꿀까요?"))) return; setMonth(event.target.value); setBatchReason(""); setNotice(""); setError(""); setConflict(false); setSelected(new Set()); setEdits({}); setView(null); setClassId(""); setPreviewAction(null); setPreviewStudent(null); setAbsence(null); }} /></label></header>
        {!loading && view && (!view.writesEnabled || !view.storageReady) && <p className={styles.notice}>지금은 계산 제안만 확인할 수 있습니다. 저장·확정·발행은 준비 후 사용할 수 있습니다.</p>}
        {!loading && (view?.notices ?? []).map((message, index) => <p key={index} className={styles.notice}>{message}</p>)}
        {error && <div role="alert" className={styles.error}>{error} {conflict && "자료가 변경되어 확정·발행을 멈췄습니다. 수정 내용을 확인한 뒤 새 자료를 조회해주세요."}<button type="button" className={`${styles.button} ml-2`} disabled={busy} onClick={() => { if (!dirty || confirm("입력한 수정을 버리고 최신 자료를 조회할까요?")) void load(month); }}>새로 조회</button></div>}
        {notice && <p role="status" className={styles.notice}>{notice}</p>}
        <div className={styles.toolbar}><label className={styles.search}><span className="sr-only">학생·반 검색</span><input className={styles.input} placeholder="학생·반 검색" value={search} onChange={(event) => setSearch(event.target.value)} /></label><details className={styles.filter}><summary className={styles.button}><span className="material-symbols-outlined" aria-hidden="true">filter_list</span>필터{filter !== "ALL" || classId ? " · 적용 중" : ""}</summary><div className={styles.filterPanel}><label>검토 상태<select className={styles.select} value={filter} onChange={(event) => setFilter(event.target.value)}><option value="UNISSUED">이번 발행 대상</option><option value="ALL">전체 이력</option><option value="REVIEW">확인 필요</option><option value="READY">검토 가능</option><option value="CONFIRMED">확정</option><option value="EXCLUDED">제외</option><option value="ISSUED">사이트 발행</option></select></label><label>반<select className={styles.select} value={classId} onChange={(event) => setClassId(event.target.value)}><option value="">전체 반</option>{classes.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label><button className={styles.button} type="button" onClick={() => { setFilter("UNISSUED"); setClassId(""); }}>기본 조건으로</button></div></details></div>
        <div className={styles.summary}><span>전체 {rows.length}건</span><span>확인 필요 <strong>{rows.filter((row) => row.status === "REVIEW").length}</strong></span><span>선택 {selectedRows.length}건 · <strong>{won(selectedTotal)}</strong></span>{dirty && <span>저장 전 수정 있음</span>}</div>
        <div className={`${styles.actions} mb-3`}><button className={styles.button} type="button" disabled={loading || busy} onClick={() => setSelected(new Set(visible.filter((row) => row.status === "READY" && canSelect(row) && !row.draftStatus).map((row) => row.id)))}>미검토 정상 건 선택</button><button className={styles.button} type="button" disabled={loading || busy} onClick={() => setSelected(new Set(visible.filter(canSelect).map((row) => row.id)))}>검색 결과 선택</button><button className={styles.button} type="button" disabled={!selected.size || busy} onClick={() => setSelected(new Set())}>선택 해제</button><span className={styles.muted}>확인 필요한 건부터 표시 · 검색 결과 {visible.length}건</span></div>
        {loading ? <p role="status" className={styles.empty}>청구 계산을 확인하고 있습니다…</p> : visible.length === 0 ? <p className={styles.empty}>{rows.length ? "검색 조건에 맞는 청구가 없습니다." : "이 기간의 청구 대상이 없습니다."}</p> : <>
            <div className={styles.tableWrap}><table className={styles.table}><thead><tr>{["선택", "학생·반", "수강료", "할인", "이월", "기간 조정", "셔틀", "최종액", "상태·근거"].map((title) => <th key={title} scope="col">{title}</th>)}</tr></thead><tbody>{visible.map((row) => <Fragment key={row.id}><tr><td>{check(row)}</td><td><span className={styles.student}>{row.studentName}</span><p className={styles.className}>{row.className}</p></td>{[Number(edits[row.id]?.baseAmount ?? row.baseAmount), Number(edits[row.id]?.discountAmount ?? row.discountAmount), Number(edits[row.id]?.carryAmount ?? row.carryAmount), Number(edits[row.id]?.prorationAmount ?? row.prorationAmount), Number(edits[row.id]?.shuttleAmount ?? row.shuttleAmount)].map((amount, index) => <td key={index}>{amount.toLocaleString("ko-KR")}</td>)}<td><strong>{won(total(row, edits[row.id]))}</strong></td><td><button type="button" className={styles.button} aria-expanded={expanded.has(row.id)} onClick={() => toggleDetails(row.id)}><span className={`${styles.badge} ${row.status === "REVIEW" ? styles.review : ""}`}>{label(row)}</span><span className="material-symbols-outlined" aria-hidden="true">{expanded.has(row.id) ? "expand_less" : "expand_more"}</span></button></td></tr>{expanded.has(row.id) && <tr><td colSpan={9}>{details(row)}</td></tr>}</Fragment>)}</tbody></table></div>
            <div className={styles.mobileRows}>{visible.map((row) => <section key={row.id} className={styles.mobileRow}><div className={styles.mobileHead}>{check(row)}<span className={styles.student}>{row.studentName}</span><strong className={styles.amount}>{won(total(row, edits[row.id]))}</strong></div><div className={styles.mobileMeta}><span>{row.className}</span><button className={styles.button} type="button" aria-expanded={expanded.has(row.id)} onClick={() => toggleDetails(row.id)}>{label(row)} · 근거<span className="material-symbols-outlined" aria-hidden="true">{expanded.has(row.id) ? "expand_less" : "expand_more"}</span></button></div>{expanded.has(row.id) && details(row)}</section>)}</div>
        </>}
        <section className={styles.bottom} aria-label="선택 청구 처리"><p className={styles.muted}>검토 저장 → 확정 → 사이트 발행 순서입니다. 랠리즈 발행·학부모 전달은 별도로 확인합니다.</p><label className="mt-2 flex flex-wrap items-center gap-2 text-sm">선택 항목 공통 검토 사유<input className={styles.input} style={{flex: "1 1 200px"}} value={batchReason} maxLength={500} onChange={(event) => setBatchReason(event.target.value)} placeholder="수정·확인 필요 건은 사유를 적어주세요" disabled={!editable} /></label><div className={styles.actions}><button type="button" className={styles.button} disabled={!editable || !selectedRows.length} onClick={() => void perform("SAVE")}>{busy ? "처리 중…" : "선택 검토 저장"}</button><button type="button" className={styles.button} disabled={!editable || !selectedRows.length || dirty || selectedRows.some((row) => row.draftStatus !== "DRAFT" || row.status === "REVIEW" || hasHardBlock(row))} onClick={() => setPreviewAction("CONFIRM")}>선택 청구 확정</button><button type="button" className={styles.primary} disabled={!editable || !selectedRows.length || dirty || selectedRows.some((row) => row.draftStatus !== "CONFIRMED" || hasHardBlock(row))} onClick={() => setPreviewAction("ISSUE")}>선택 일괄 발행</button></div></section>
        {absence && <AdminModal titleId="absence-resolution-title" onClose={() => { if (!busy) setAbsence(null); }} panelClassName="max-w-lg"><div className="p-4">{error && <p role="alert" className={styles.error}>{error}</p>}<h2 id="absence-resolution-title" className="text-lg font-extrabold">결석 이월·보강 검토</h2><p className="my-2 text-sm">{absence.studentName} · {absence.date.slice(0, 10)}</p><ul className="my-2 text-sm">{absence.reviewReasons.map((reason, index) => <li key={index}>{reason}</li>)}</ul><div className="grid gap-3"><label>처리 방식<select aria-label="처리 방식" className={styles.select} value={resolution} onChange={(event) => setResolution(event.target.value as "CARRY" | "MAKEUP")}><option value="CARRY">이월</option><option value="MAKEUP">보강</option></select></label>{resolution === "CARRY" && <><label>원결석 청구 기간<input aria-label="원결석 청구 기간" type="month" className={styles.input} value={originMonth} onChange={(event) => setOriginMonth(event.target.value)} /></label><label>인정 사유<select aria-label="인정 사유" className={styles.select} value={eligibility} onChange={(event) => setEligibility(event.target.value)}><option value="NONE">선택해주세요</option><option value="ILLNESS_INJURY">질병·부상</option><option value="DIRECT_FAMILY_EVENT">직계가족 경조사</option></select></label><label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={evidenceConfirmed} onChange={(event) => setEvidenceConfirmed(event.target.checked)} />인정 사유와 증빙을 확인했습니다.</label>{(absence.makeupStatus?.includes("RESERVED") || absence.makeupStatus?.includes("BOOKED")) && <label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={cancelReservation} onChange={(event) => setCancelReservation(event.target.checked)} />연결된 보강 예약 취소·좌석 해제에 동의합니다.</label>}<p className={styles.muted}>원기간의 할인 후 수강료와 실제 수업일을 대조합니다. 미사용 보강권은 회수하며, 이미 사용한 보강은 자동 이월하지 않습니다.</p></>}<label>처리 사유<textarea className={styles.input} value={absenceReason} maxLength={500} onChange={(event) => setAbsenceReason(event.target.value)} rows={2} /></label></div><div className={`${styles.actions} mt-3`}><button className={styles.button} type="button" disabled={busy} onClick={() => setAbsence(null)}>돌아가기</button><button className={styles.primary} type="button" disabled={!editable || !absenceReason.trim() || (resolution === "CARRY" && (!evidenceConfirmed || eligibility === "NONE" || !originMonth))} onClick={() => void resolveAbsence()}>{busy ? "처리 중…" : "위 내용으로 결석 처리"}</button></div></div></AdminModal>}
        {previewAction && <AdminModal titleId="billing-approval-title" onClose={() => { if (!busy) setPreviewAction(null); }} panelClassName="max-w-xl"><div className="p-4">{error && <p role="alert" className={styles.error}>{error}</p>}<h2 id="billing-approval-title" className="text-lg font-extrabold">{previewAction === "ISSUE" ? "사이트 청구 발행 확인" : "청구 확정 확인"}</h2><p className="my-3 text-sm">{month} · {selectedRows.length}건 · {won(selectedRows.reduce((sum, row) => sum + row.totalAmount, 0))}</p><ul className="max-h-56 overflow-y-auto text-sm">{selectedRows.map((row) => <li key={row.id} className="flex flex-wrap justify-between gap-2 border-b py-2"><span>{row.studentName} · {row.className}<span className="block text-xs text-gray-500">납부기한 {row.dueDate?.slice(0, 10) ?? "확인 필요"}</span></span><strong>{won(row.totalAmount)}</strong></li>)}</ul><p className="my-3 text-sm">0원 {selectedRows.filter((row) => row.totalAmount === 0).length}건은 청구서 없이 정산 이력만 남깁니다. 외부 발행·알림은 실행하지 않습니다.</p><div className={styles.actions}><button className={styles.button} disabled={busy} onClick={() => setPreviewAction(null)}>돌아가기</button><button className={styles.primary} disabled={busy} onClick={() => void perform(previewAction)}>{busy ? "처리 중…" : previewAction === "ISSUE" ? "위 내역으로 사이트 발행" : "위 내역 확정"}</button></div></div></AdminModal>}
        {previewRow && <AdminModal titleId="parent-invoice-preview-title" onClose={() => setPreviewStudent(null)} panelClassName="max-w-md"><div className="p-4"><h2 id="parent-invoice-preview-title" className="text-lg font-extrabold">학부모 청구 내역 미리보기</h2><p className="my-3 text-sm">{previewRow.studentName} · {previewRow.className} · {month}<span className="block mt-1">수강 기간 {edits[previewRow.id]?.periodStart ?? previewRow.periodStart?.slice(0, 10) ?? "확인 필요"} ~ {edits[previewRow.id]?.periodEnd ?? previewRow.periodEnd?.slice(0, 10) ?? "확인 필요"}</span><span className="block mt-1">납부기한 {previewRow.dueDate?.slice(0, 10) ?? "확인 필요"}</span></p><dl className={styles.preview}>{amounts.map(([key, title]) => <div className="flex justify-between gap-2 py-1 text-sm" key={key}><dt>{title}</dt><dd>{won(Number(edits[previewRow.id]?.[key] ?? previewRow[key]))}</dd></div>)}<div className="mt-2 flex justify-between gap-2 border-t pt-2 font-bold"><dt>납부 금액</dt><dd>{won(total(previewRow, edits[previewRow.id]))}</dd></div></dl><p className={`${styles.muted} my-3`}>금액 내역 검토용입니다. 청구 발행·학부모 전달은 아직 실행되지 않았습니다.</p><button type="button" className={styles.button} onClick={() => setPreviewStudent(null)}>닫기</button></div></AdminModal>}
    </div>;
}
