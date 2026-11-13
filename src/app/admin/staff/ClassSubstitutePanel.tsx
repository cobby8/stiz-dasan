"use client";

// 대타 선생님 지정(f4, 2026-11-13) — 스태프 관리 화면 아래의 작은 칸.
// 머리줄 한 줄(제목 · 건수 · «대타 지정» 버튼) + 오늘 이후 지정 목록(한 줄 행 · 취소).
// 지정 입력은 창(AdminModal) 안에서 «날짜 → 그 요일 반 → 선생님» 순서로 고른다.
// 권한 판정은 서버(staff-class-access)가 한다 — 여기는 지정·취소 화면만.

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import AdminModal from "@/components/admin/AdminModal";
import { useAdminConfirm } from "@/components/admin/AdminConfirmDialog";
import { formatKstDate, kstDow } from "@/lib/datetime/kst";
import { CLASS_DAY_KEYS } from "@/lib/staff/classSubstitute";
import { assignClassSubstitute, cancelClassSubstitute } from "@/app/actions/class-substitute-admin";
import type { ClassSubstituteAdminData } from "@/lib/staff/classSubstituteData";

const FIELD = "min-h-11 w-full rounded-lg border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] px-3 text-sm text-[var(--color-academy-ink)]";

// "YYYY-MM-DD" → «11. 14. (금)» 처럼 짧게(KST 달력 그대로)
function dateLabel(ymd: string) {
    return formatKstDate(ymd, { month: "numeric", day: "numeric", weekday: "short" }, ymd);
}

export default function ClassSubstitutePanel({ data }: { data: ClassSubstituteAdminData }) {
    const router = useRouter();
    const [pending, startTransition] = useTransition();
    const { confirm, confirmDialog } = useAdminConfirm();
    const [open, setOpen] = useState(false);
    const [date, setDate] = useState(data.today);
    const [classId, setClassId] = useState("");
    const [teacherId, setTeacherId] = useState("");
    const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

    // 고른 날짜의 요일에 수업하는 반만 보여 준다(다른 요일 반은 그날 홈에 안 떠서 지정이 헛돈다)
    const dayKey = CLASS_DAY_KEYS[kstDow(date)];
    const dayClasses = useMemo(() => data.classes.filter((c) => c.dayOfWeek === dayKey), [data.classes, dayKey]);

    function openModal() {
        setDate(data.today);
        setClassId("");
        setTeacherId("");
        setMessage(null);
        setOpen(true);
    }

    function submit() {
        startTransition(async () => {
            const result = await assignClassSubstitute({ date, classId, substituteUserId: teacherId });
            if (!result.ok) {
                setMessage({ ok: false, text: result.message });
                return;
            }
            setOpen(false);
            setMessage({ ok: true, text: "대타를 지정했습니다. 그날 선생님 홈에 반이 나타납니다." });
            router.refresh();
        });
    }

    async function cancel(item: ClassSubstituteAdminData["items"][number]) {
        const ok = await confirm({
            title: `${dateLabel(item.date)} ${item.className} 대타 취소`,
            description: `${item.substituteName} 선생님이 이 반 출석부를 더 이상 열 수 없습니다.`,
            confirmLabel: "대타 취소",
        });
        if (!ok) return;
        startTransition(async () => {
            const result = await cancelClassSubstitute({ id: item.id });
            setMessage(result.ok ? { ok: true, text: "대타 지정을 취소했습니다." } : { ok: false, text: result.message });
            if (result.ok) router.refresh();
        });
    }

    return (
        <section aria-labelledby="class-substitute-title" className="rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)]">
            {/* 머리줄 한 줄 */}
            <div className="flex min-h-11 items-center gap-2 px-3 py-1">
                <span className="material-symbols-outlined text-[20px] text-[var(--color-academy-muted)]" aria-hidden="true">swap_horiz</span>
                <h2 id="class-substitute-title" className="text-sm font-black text-[var(--color-academy-ink)]">대타 지정</h2>
                <span className="text-xs tabular-nums text-[var(--color-academy-muted)]">오늘 이후 {data.items.length}건</span>
                <button
                    type="button"
                    onClick={openModal}
                    className="academy-button-secondary ml-auto inline-flex min-h-11 items-center gap-1 rounded-lg px-3 text-sm font-bold"
                >
                    <span className="material-symbols-outlined text-[18px]" aria-hidden="true">add</span>
                    대타 지정
                </button>
            </div>

            {message && !open && (
                <p role="status" className={`px-3 pb-2 text-xs font-bold ${message.ok ? "text-[var(--color-academy-success)]" : "text-[var(--color-academy-danger)]"}`}>{message.text}</p>
            )}

            {/* 목록 = 한 줄 행(날짜 · 시간 반 · 선생님 · 취소) */}
            {data.items.length > 0 && (
                <ul className="border-t border-[var(--color-academy-line)]" aria-label="대타 지정 목록">
                    {data.items.map((item) => (
                        <li key={item.id} className="flex min-h-11 items-center gap-2 border-b border-[var(--color-academy-line)] px-3 text-sm last:border-b-0">
                            <span className={`w-24 shrink-0 font-bold tabular-nums ${item.date === data.today ? "text-[var(--color-academy-primary)]" : "text-[var(--color-academy-ink)]"}`}>
                                {item.date === data.today ? "오늘" : dateLabel(item.date)}
                            </span>
                            <span className="min-w-0 flex-1 truncate text-[var(--color-academy-ink)]">
                                <span className="tabular-nums text-[var(--color-academy-muted)]">{item.startTime}</span> {item.className}
                            </span>
                            <span className="shrink-0 font-bold text-[var(--color-academy-ink)]">{item.substituteName}</span>
                            <button
                                type="button"
                                disabled={pending}
                                onClick={() => cancel(item)}
                                aria-label={`${dateLabel(item.date)} ${item.className} 대타 취소`}
                                className="grid size-11 shrink-0 place-items-center rounded-lg text-[var(--color-academy-muted)] hover:bg-[var(--color-academy-danger-soft)] hover:text-[var(--color-academy-danger)] disabled:opacity-40"
                            >
                                <span className="material-symbols-outlined text-[20px]" aria-hidden="true">close</span>
                            </button>
                        </li>
                    ))}
                </ul>
            )}

            {open && (
                <AdminModal onClose={() => setOpen(false)} titleId="class-substitute-modal-title" panelClassName="max-w-md">
                    <div className="flex items-center justify-between border-b border-[var(--color-academy-line)] px-5 py-3">
                        <h2 id="class-substitute-modal-title" className="flex items-center gap-2 text-base font-bold text-[var(--color-academy-ink)]">
                            <span className="material-symbols-outlined text-[20px]" aria-hidden="true">swap_horiz</span>
                            대타 선생님 지정
                        </h2>
                        <button type="button" onClick={() => setOpen(false)} aria-label="닫기" className="grid size-11 place-items-center rounded-lg text-[var(--color-academy-muted)] hover:bg-[var(--color-academy-line)]">
                            <span className="material-symbols-outlined">close</span>
                        </button>
                    </div>
                    <div className="space-y-3 px-5 py-4">
                        <p className="text-xs text-[var(--color-academy-muted)]">그 날짜에만 고른 선생님이 이 반 출석부를 열고 출석을 찍습니다. 원래 담당 선생님도 그대로 볼 수 있습니다.</p>
                        <label className="block space-y-1">
                            <span className="text-xs font-bold text-[var(--color-academy-muted)]">날짜</span>
                            <input
                                type="date"
                                value={date}
                                min={data.today}
                                onChange={(e) => { setDate(e.target.value); setClassId(""); }}
                                className={FIELD}
                            />
                        </label>
                        <label className="block space-y-1">
                            <span className="text-xs font-bold text-[var(--color-academy-muted)]">반 (그 요일 수업 {dayClasses.length}개)</span>
                            <select value={classId} onChange={(e) => setClassId(e.target.value)} className={FIELD}>
                                <option value="">반 고르기</option>
                                {dayClasses.map((c) => (
                                    <option key={c.id} value={c.id}>{c.startTime}–{c.endTime} {c.name}</option>
                                ))}
                            </select>
                        </label>
                        <label className="block space-y-1">
                            <span className="text-xs font-bold text-[var(--color-academy-muted)]">대타 선생님</span>
                            <select value={teacherId} onChange={(e) => setTeacherId(e.target.value)} className={FIELD}>
                                <option value="">선생님 고르기</option>
                                {data.teachers.map((t) => (
                                    <option key={t.id} value={t.id}>{t.name}</option>
                                ))}
                            </select>
                        </label>
                        {message && !message.ok && (
                            <p role="alert" className="text-sm font-bold text-[var(--color-academy-danger)]">{message.text}</p>
                        )}
                        <div className="flex justify-end gap-2 pt-1">
                            <button type="button" onClick={() => setOpen(false)} className="academy-button-secondary min-h-11 rounded-lg px-4 text-sm font-bold">그만</button>
                            <button
                                type="button"
                                disabled={pending || !date || !classId || !teacherId}
                                onClick={submit}
                                className="min-h-11 rounded-lg bg-[var(--color-academy-primary)] px-4 text-sm font-bold text-[var(--color-academy-on-primary)] hover:bg-[var(--color-academy-primary-hover)] disabled:opacity-40"
                            >
                                {pending ? "저장 중…" : "지정"}
                            </button>
                        </div>
                    </div>
                </AdminModal>
            )}
            {confirmDialog}
        </section>
    );
}
