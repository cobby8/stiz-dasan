"use client";

// 학생별 고정 월 수강료(2026-11-16 원장 결정 — 결정표 x4).
// 학생 상세 «청구/수납» 탭(원장만 보임)에 둔다. 켜 두면 청구 준비가 그 달 정규반 수강료를
// 반별 합산 대신 이 금액 1건으로 계산한다(형제할인·3회 달 차감 없음, 셔틀비는 따로).
// 바꾸려면 지우고 다시 추가한다(기간이 겹치면 서버가 거절) — 수정 화면을 따로 두지 않아 단순하게.

import { useCallback, useEffect, useState, useTransition } from "react";
import { loadFixedTuition, removeFixedTuition, saveFixedTuition } from "@/app/actions/fixed-tuition";
import type { FixedTuitionRow } from "@/lib/billing/fixed-tuition";
import { askConfirm } from "@/components/ui/feedback";
import { todayKst } from "@/lib/datetime/kst";

const won = (n: number) => `${n.toLocaleString("ko-KR")}원`;
const LABEL_CLASS = "mb-1 block text-xs font-medium text-[var(--color-academy-muted)]";

export default function FixedTuitionPanel({ studentId }: { studentId: string }) {
    const [rows, setRows] = useState<FixedTuitionRow[]>([]);
    const [ready, setReady] = useState(true);
    const [loaded, setLoaded] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);
    const [open, setOpen] = useState(false);
    // 입력칸 — 시작 달 기본값은 이번 달(KST)
    const [amount, setAmount] = useState("");
    const [startMonth, setStartMonth] = useState(() => todayKst().slice(0, 7));
    const [endMonth, setEndMonth] = useState("");
    const [memo, setMemo] = useState("");
    const [isPending, startTransition] = useTransition();

    const reload = useCallback(async () => {
        const result = await loadFixedTuition(studentId);
        if (result.ok) { setRows(result.rows); setReady(result.ready); setError(null); }
        else setError(result.message);
        setLoaded(true);
    }, [studentId]);

    useEffect(() => { void reload(); }, [reload]);

    const submit = (event: React.FormEvent) => {
        event.preventDefault();
        setError(null); setNotice(null);
        startTransition(async () => {
            const result = await saveFixedTuition({ studentId, amount, startMonth, endMonth, memo });
            if (!result.ok) { setError(result.message); return; }
            setNotice(result.message);
            setOpen(false); setAmount(""); setEndMonth(""); setMemo("");
            await reload();
        });
    };

    const remove = async (row: FixedTuitionRow) => {
        // 위험 작업 확인 — 지우면 그다음 청구 준비부터 반별 요금으로 돌아간다
        if (!(await askConfirm(`고정 수강료 월 ${won(row.amount)}(${row.startMonth}~${row.endMonth ?? "끝 없음"})을 지울까요? 청구 준비는 반별 요금으로 다시 계산합니다.`, { tone: "danger" }))) return;
        setError(null); setNotice(null);
        startTransition(async () => {
            const result = await removeFixedTuition(row.id, studentId);
            if (result.ok) setNotice(result.message); else setError(result.message);
            await reload();
        });
    };

    return (
        <div className="academy-panel p-5">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <h3 className="academy-section-title">고정 수강료</h3>
                {ready && !open && (
                    <button type="button" onClick={() => { setOpen(true); setError(null); setNotice(null); }} disabled={isPending} className="academy-button-secondary academy-button-sm min-h-11">
                        고정 수강료 추가
                    </button>
                )}
            </div>
            <p className="text-xs text-[var(--color-academy-muted)]">
                켜 두면 청구 준비가 이 학생의 정규반 수강료를 반별 합산 대신 이 금액 1건으로 계산합니다. 형제할인·3회 달 차감은 붙지 않고, 셔틀비는 따로 계산됩니다.
            </p>
            {/* 검수 반영(2026-11-16): 추가·삭제하면 그 달 청구 준비에 저장해 둔 초안이 «원본 변경»으로 바뀐다 — 미리 알린다 */}
            <p className="mt-1 text-xs text-[var(--color-academy-muted)]">
                추가하거나 지우면 그 달 청구 준비에 저장해 둔 초안은 «원본 변경»으로 바뀌어 다시 저장·확정해야 합니다.
            </p>

            {!loaded ? (
                <p className="py-3 text-xs text-[var(--color-academy-faint)]">불러오는 중…</p>
            ) : !ready ? (
                <p className="py-3 text-sm text-[var(--color-academy-muted)]">고정 수강료 저장 공간이 아직 준비되지 않았습니다. 준비되면 여기서 켤 수 있어요.</p>
            ) : rows.length === 0 ? (
                <p className="py-3 text-sm text-[var(--color-academy-muted)]">고정 수강료 없음 — 반별 요금으로 계산합니다.</p>
            ) : (
                <ul className="mt-2 divide-y divide-[var(--color-academy-line)]">
                    {rows.map((row) => (
                        <li key={row.id} className="flex min-h-11 flex-wrap items-center justify-between gap-2 py-1 text-sm">
                            <span>
                                <span className="font-semibold tabular-nums">월 {won(row.amount)}</span>
                                <span className="ml-2 text-[var(--color-academy-muted)]">{row.startMonth} ~ {row.endMonth ?? "끝 없음"}</span>
                                {row.memo && <span className="block text-xs text-[var(--color-academy-muted)]">{row.memo}</span>}
                            </span>
                            <button type="button" onClick={() => void remove(row)} disabled={isPending} className="academy-button-secondary academy-button-sm min-h-11">
                                지우기
                            </button>
                        </li>
                    ))}
                </ul>
            )}

            {open && (
                <form onSubmit={submit} className="mt-3 grid gap-3 sm:grid-cols-2">
                    <label className="block">
                        <span className={LABEL_CLASS}>월 수강료(원)</span>
                        <input type="text" inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="예: 150000" className="academy-input" required />
                    </label>
                    <label className="block">
                        <span className={LABEL_CLASS}>메모(선택)</span>
                        <input type="text" value={memo} maxLength={200} onChange={(e) => setMemo(e.target.value)} placeholder="예: 원장 합의 — 수7+토7" className="academy-input" />
                    </label>
                    <label className="block">
                        <span className={LABEL_CLASS}>시작 달</span>
                        <input type="month" value={startMonth} onChange={(e) => setStartMonth(e.target.value)} className="academy-input" required />
                    </label>
                    <label className="block">
                        <span className={LABEL_CLASS}>끝 달(선택 · 비우면 계속)</span>
                        <input type="month" value={endMonth} onChange={(e) => setEndMonth(e.target.value)} className="academy-input" />
                    </label>
                    <div className="flex justify-end gap-2 sm:col-span-2">
                        <button type="button" onClick={() => setOpen(false)} disabled={isPending} className="academy-button-secondary min-h-11">닫기</button>
                        <button type="submit" disabled={isPending} className="academy-button-primary min-h-11">{isPending ? "저장 중…" : "저장"}</button>
                    </div>
                </form>
            )}

            {error && <p role="alert" className="mt-2 text-sm font-medium text-[var(--color-academy-danger)]">{error}</p>}
            {notice && <p role="status" className="mt-2 text-sm text-[var(--color-academy-muted)]">{notice}</p>}
        </div>
    );
}
