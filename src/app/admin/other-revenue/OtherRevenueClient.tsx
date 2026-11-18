"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import AdminModal from "@/components/admin/AdminModal";
import AdminPageHeader from "@/components/admin/AdminPageHeader";
import { askConfirm, showNotice } from "@/components/ui/feedback";
import { createOtherRevenue, editOtherRevenue, removeOtherRevenue } from "@/app/actions/other-revenue";
import type { OtherRevenueRow } from "@/lib/billing/other-revenue";
import {
    OTHER_REVENUE_CATEGORIES,
    OTHER_REVENUE_CATEGORY_LABEL,
    OTHER_REVENUE_METHODS,
    OTHER_REVENUE_METHOD_LABEL,
    OTHER_REVENUE_NOTE_MAX,
    OTHER_REVENUE_TITLE_MAX,
    type OtherRevenueCategory,
    type OtherRevenueMethod,
} from "@/lib/billing/other-revenue-rules";
import { addMonthsYm, kstLabel } from "@/lib/datetime/kst";
import { formatKRW } from "@/lib/stats/statsRules";

/** 모달 입력칸 값(금액은 입력 중 글자 그대로 들고, 저장할 때 서버가 확인한다) */
type FormState = {
    id: string | null; // null = 새로 추가
    revenueDate: string;
    category: OtherRevenueCategory;
    title: string;
    amount: string;
    method: OtherRevenueMethod;
    note: string;
};

/** 목록 금액은 장부라 반올림하지 않고 원 단위 그대로 보인다(합계 줄은 통계와 같은 formatKRW) */
const exactWon = (n: number) => `${n.toLocaleString("ko-KR")}원`;
const monthTitle = (ym: string) => `${ym.slice(0, 4)}년 ${Number(ym.slice(5, 7))}월`;

export default function OtherRevenueClient({
    ym,
    thisMonth,
    today,
    ready,
    loadFailed,
    rows,
}: {
    ym: string;
    thisMonth: string;
    today: string;
    ready: boolean;
    loadFailed: boolean;
    rows: OtherRevenueRow[];
}) {
    const router = useRouter();
    const [form, setForm] = useState<FormState | null>(null);
    const [error, setError] = useState("");
    const [pending, startTransition] = useTransition();

    // 그 달 합계와 분류별 합계(0원인 분류는 줄에서 뺀다)
    const total = rows.reduce((sum, r) => sum + r.amount, 0);
    const byCategory = OTHER_REVENUE_CATEGORIES
        .map((c) => ({ c, amount: rows.filter((r) => r.category === c).reduce((sum, r) => sum + r.amount, 0) }))
        .filter((x) => x.amount > 0);

    // 새로 추가 — 보고 있는 달이 이번 달이면 오늘, 아니면 그 달 1일을 기본 날짜로
    const openNew = () => {
        setError("");
        setForm({ id: null, revenueDate: ym === thisMonth ? today : `${ym}-01`, category: "SCHOOL_CLUB", title: "", amount: "", method: "BANK", note: "" });
    };
    const openEdit = (row: OtherRevenueRow) => {
        setError("");
        setForm({ id: row.id, revenueDate: row.revenueDate, category: row.category, title: row.title, amount: String(row.amount), method: row.method, note: row.note ?? "" });
    };
    const close = () => { if (!pending) setForm(null); };

    const save = () => {
        if (!form) return;
        const input = { revenueDate: form.revenueDate, category: form.category, title: form.title, amount: form.amount, method: form.method, note: form.note };
        startTransition(async () => {
            const result = form.id ? await editOtherRevenue(form.id, input) : await createOtherRevenue(input);
            if (!result.ok) { setError(result.message); return; }
            setForm(null);
            router.refresh();
            void showNotice(result.message);
        });
    };

    const remove = async () => {
        if (!form?.id) return;
        // 확인 문구는 수정 중인 값이 아니라 «실제로 지워지는» 저장된 값으로 보인다
        const saved = rows.find((r) => r.id === form.id);
        const label = saved ? `${saved.revenueDate} «${saved.title}» ${exactWon(saved.amount)}` : "이 기록";
        const ok = await askConfirm(`${label}을 지울까요? 지우면 되돌릴 수 없습니다.`, { tone: "danger" });
        if (!ok) return;
        const id = form.id;
        startTransition(async () => {
            const result = await removeOtherRevenue(id);
            if (!result.ok) { setError(result.message); return; }
            setForm(null);
            router.refresh();
            void showNotice(result.message);
        });
    };

    const prevYm = addMonthsYm(ym, -1);
    const nextYm = addMonthsYm(ym, 1);

    return (
        <main className="space-y-3 p-4 md:p-6">
            <div>
                <AdminPageHeader
                    title="기타 매출"
                    actions={
                        <button type="button" className="academy-button-primary" onClick={openNew} disabled={!ready}>
                            추가
                        </button>
                    }
                />
                <p className="academy-page-description mt-1">수강료 청구가 아닌 수입을 적는 곳입니다. 대관은 대관 화면에 따로 있습니다.</p>
            </div>

            {/* 달 고르기 + 그 달 합계 한 줄 — 달 이동은 같은 화면의 보기 설정이라 기록에 쌓지 않는다(replace) */}
            <section className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] px-3 py-2">
                <div className="flex items-center gap-1">
                    <Link href={`/admin/other-revenue?ym=${prevYm}`} replace prefetch={false} className="academy-button-text academy-button-sm">‹ 이전</Link>
                    <h2 className="academy-section-title px-1 tabular-nums">{monthTitle(ym)}</h2>
                    <Link href={`/admin/other-revenue?ym=${nextYm}`} replace prefetch={false} className="academy-button-text academy-button-sm">다음 ›</Link>
                    {ym !== thisMonth && (
                        <Link href="/admin/other-revenue" replace prefetch={false} className="academy-button-text academy-button-sm">이번 달</Link>
                    )}
                </div>
                <p className="text-sm text-[var(--color-academy-muted)]">
                    합계 <span className="font-semibold text-[var(--color-academy-ink)] tabular-nums">{formatKRW(total)}</span>
                    <span className="tabular-nums"> · {rows.length}건</span>
                    {byCategory.map((x) => (
                        <span key={x.c} className="tabular-nums"> · {OTHER_REVENUE_CATEGORY_LABEL[x.c]} {formatKRW(x.amount)}</span>
                    ))}
                </p>
            </section>

            {!ready && (
                <p className="rounded-lg border border-[var(--color-academy-line)] bg-[var(--color-academy-soft)] px-3 py-2 text-sm text-[var(--color-academy-muted)]">
                    기능을 준비 중입니다. 준비가 끝나면 여기에 적을 수 있습니다.
                </p>
            )}
            {loadFailed && (
                <p className="rounded-lg border border-[var(--color-academy-line)] bg-[var(--color-academy-danger-soft)] px-3 py-2 text-sm text-[var(--color-academy-danger)]">
                    기타 매출을 불러오지 못했습니다. 잠시 후 새로고침해 주세요.
                </p>
            )}

            {/* 한 줄 행 목록 — 행을 누르면 수정 창이 열린다 */}
            {ready && !loadFailed && (
                rows.length === 0 ? (
                    <p className="px-1 py-2 text-sm text-[var(--color-academy-muted)]">이 달에 적은 기타 매출이 없습니다.</p>
                ) : (
                    <ul className="divide-y divide-[var(--color-academy-line)] overflow-hidden rounded-lg border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)]">
                        {rows.map((row) => (
                            <li key={row.id}>
                                <button
                                    type="button"
                                    onClick={() => openEdit(row)}
                                    className="flex min-h-11 w-full flex-wrap items-center gap-x-3 gap-y-0.5 px-3 py-2 text-left text-sm hover:bg-[var(--color-academy-soft)] md:flex-nowrap"
                                >
                                    <span className="w-20 shrink-0 tabular-nums text-[var(--color-academy-muted)]">{kstLabel(row.revenueDate)}</span>
                                    <span className="shrink-0 text-[var(--color-academy-muted)]">{OTHER_REVENUE_CATEGORY_LABEL[row.category] ?? "기타"}</span>
                                    <span className="min-w-0 flex-1 break-words font-medium text-[var(--color-academy-ink)]">
                                        {row.title}
                                        {row.note && <span className="ml-2 break-words font-normal text-[var(--color-academy-muted)]">{row.note}</span>}
                                    </span>
                                    <span className="shrink-0 text-[var(--color-academy-muted)]">{OTHER_REVENUE_METHOD_LABEL[row.method] ?? "기타"}</span>
                                    <span className="ml-auto shrink-0 text-right font-semibold tabular-nums text-[var(--color-academy-ink)] md:w-28">{exactWon(row.amount)}</span>
                                </button>
                            </li>
                        ))}
                    </ul>
                )
            )}

            {form && (
                <AdminModal titleId="other-revenue-form-title" onClose={close} closeOnBackdrop={!pending}>
                    <div className="space-y-3 p-4">
                        <h2 id="other-revenue-form-title" className="academy-section-title">{form.id ? "기타 매출 고치기" : "기타 매출 추가"}</h2>

                        <label className="block space-y-1 text-sm">
                            <span className="font-medium text-[var(--color-academy-ink)]">날짜</span>
                            <input
                                type="date"
                                className="academy-input"
                                value={form.revenueDate}
                                onChange={(e) => setForm({ ...form, revenueDate: e.target.value })}
                                data-admin-modal-initial-focus
                            />
                        </label>

                        <fieldset className="space-y-1 text-sm">
                            <legend className="font-medium text-[var(--color-academy-ink)]">분류</legend>
                            <div className="flex flex-wrap gap-2">
                                {OTHER_REVENUE_CATEGORIES.map((c) => (
                                    <button key={c} type="button" className="academy-choice" aria-pressed={form.category === c} onClick={() => setForm({ ...form, category: c })}>
                                        {OTHER_REVENUE_CATEGORY_LABEL[c]}
                                    </button>
                                ))}
                            </div>
                        </fieldset>

                        <label className="block space-y-1 text-sm">
                            <span className="font-medium text-[var(--color-academy-ink)]">내용</span>
                            <input
                                type="text"
                                className="academy-input"
                                maxLength={OTHER_REVENUE_TITLE_MAX}
                                placeholder="예: OO초 스포츠클럽 11월 강사료"
                                value={form.title}
                                onChange={(e) => setForm({ ...form, title: e.target.value })}
                            />
                        </label>

                        <label className="block space-y-1 text-sm">
                            <span className="font-medium text-[var(--color-academy-ink)]">금액(원)</span>
                            <input
                                type="text"
                                inputMode="numeric"
                                className="academy-input tabular-nums"
                                placeholder="예: 300000"
                                value={form.amount}
                                onChange={(e) => setForm({ ...form, amount: e.target.value })}
                            />
                        </label>

                        <fieldset className="space-y-1 text-sm">
                            <legend className="font-medium text-[var(--color-academy-ink)]">결제수단</legend>
                            <div className="flex flex-wrap gap-2">
                                {OTHER_REVENUE_METHODS.map((m) => (
                                    <button key={m} type="button" className="academy-choice" aria-pressed={form.method === m} onClick={() => setForm({ ...form, method: m })}>
                                        {OTHER_REVENUE_METHOD_LABEL[m]}
                                    </button>
                                ))}
                            </div>
                        </fieldset>

                        <label className="block space-y-1 text-sm">
                            <span className="font-medium text-[var(--color-academy-ink)]">메모(선택)</span>
                            <textarea
                                className="academy-input"
                                rows={2}
                                maxLength={OTHER_REVENUE_NOTE_MAX}
                                placeholder="승인번호·입금자 이름 등"
                                value={form.note}
                                onChange={(e) => setForm({ ...form, note: e.target.value })}
                            />
                        </label>

                        {error && <p role="alert" className="text-sm text-[var(--color-academy-danger)]">{error}</p>}

                        <div className="flex flex-wrap items-center gap-2 pt-1">
                            {form.id && (
                                <button type="button" className="academy-button-danger" onClick={remove} disabled={pending}>삭제</button>
                            )}
                            <div className="ml-auto flex gap-2">
                                <button type="button" className="academy-button-text" onClick={close} disabled={pending}>닫기</button>
                                <button type="button" className="academy-button-primary" onClick={save} disabled={pending}>
                                    {pending ? "저장 중" : "저장"}
                                </button>
                            </div>
                        </div>
                    </div>
                </AdminModal>
            )}
        </main>
    );
}
