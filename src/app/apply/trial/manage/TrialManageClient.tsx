"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import type { AvailableSlot } from "@/app/actions/public";
import {
    cancelMyTrialApplication,
    changeMyTrialApplication,
    lookupMyTrialApplications,
    type MyTrialApplication,
} from "@/app/actions/trial-self-service";
import { publicErrorText } from "@/components/ui/public-error-text";
import { isKstYmd, todayKst } from "@/lib/datetime/kst";
import { SEAT_LEVEL_LABEL, SEAT_LEVEL_TEXT_CLASS } from "@/lib/seats/seatLevel";
import { trialDayForDate, trialScheduleError, trialScheduleForDate, trialSlotPeriod, type TrialScheduleSelection } from "../trialScheduleSelection";

interface Props {
    availableSlots: AvailableSlot[];
    contactPhone: string;
}

type Mode = { kind: "idle" } | { kind: "change"; id: string; selection: TrialScheduleSelection } | { kind: "cancel"; id: string; reason: string };

const FALLBACK_ERROR = "처리하지 못했어요. 잠시 후 다시 시도해 주세요.";
const INPUT_CLASS = "w-full rounded-xl border border-[var(--color-public-line)] px-4 py-3 text-[var(--color-public-ink)] outline-none transition-colors focus:border-[var(--color-public-accent)] focus:ring-2 focus:ring-[var(--color-public-accent)] dark:bg-[var(--color-public-tint)] dark:text-white";
const PRIMARY_BUTTON = "inline-flex min-h-11 items-center justify-center rounded-xl bg-[var(--color-public-trial)] px-5 text-sm font-bold text-[var(--color-public-white)] hover:bg-[var(--color-public-trial-hover)] disabled:cursor-not-allowed disabled:opacity-50";
const SECONDARY_BUTTON = "inline-flex min-h-11 items-center justify-center rounded-xl border border-[var(--color-public-line)] px-5 text-sm font-medium text-[var(--color-public-ink)] hover:bg-[var(--color-public-tint)] disabled:cursor-not-allowed disabled:opacity-50 dark:text-white";

function formatPhone(value: string) {
    const digits = value.replace(/\D/g, "").slice(0, 11);
    if (digits.length <= 3) return digits;
    if (digits.length <= 7) return `${digits.slice(0, 3)}-${digits.slice(3)}`;
    return `${digits.slice(0, 3)}-${digits.slice(3, 7)}-${digits.slice(7)}`;
}

export default function TrialManageClient({ availableSlots, contactPhone }: Props) {
    const [childName, setChildName] = useState("");
    const [parentPhone, setParentPhone] = useState("");
    const [items, setItems] = useState<MyTrialApplication[] | null>(null);
    const [mode, setMode] = useState<Mode>({ kind: "idle" });
    const [error, setError] = useState("");
    const [notice, setNotice] = useState("");
    const [isPending, startTransition] = useTransition();

    const credentials = { childName, parentPhone };

    const handleLookup = () => {
        setError("");
        setNotice("");
        if (!childName.trim()) { setError("아이 이름을 입력해 주세요."); return; }
        const digits = parentPhone.replace(/\D/g, "");
        if (digits.length < 10 || digits.length > 11) { setError("휴대폰 번호를 정확히 입력해 주세요. 예: 010-1234-5678"); return; }
        startTransition(async () => {
            try {
                const result = await lookupMyTrialApplications(credentials);
                setMode({ kind: "idle" });
                if (!result.ok) { setItems(null); setError(result.message); return; }
                setItems(result.items);
            } catch (e) {
                console.error("[trial-manage] lookup failed", e);
                setError(publicErrorText(e, FALLBACK_ERROR));
            }
        });
    };

    const startChange = (item: MyTrialApplication) => {
        setError("");
        setNotice("");
        setMode({
            kind: "change",
            id: item.id,
            selection: { trialDate: "", trialDay: "", trialPeriod: "" },
        });
    };

    const submitChange = () => {
        if (mode.kind !== "change") return;
        const scheduleError = trialScheduleError(mode.selection, availableSlots);
        if (scheduleError) { setError(scheduleError); return; }
        setError("");
        startTransition(async () => {
            try {
                const result = await changeMyTrialApplication({ id: mode.id, ...credentials, ...mode.selection });
                if (!result.ok) { setError(result.message); return; }
                setItems((prev) => prev?.map((item) => (item.id === mode.id && result.item ? result.item : item)) ?? null);
                setMode({ kind: "idle" });
                setNotice(result.message);
            } catch (e) {
                console.error("[trial-manage] change failed", e);
                setError(publicErrorText(e, FALLBACK_ERROR));
            }
        });
    };

    const submitCancel = () => {
        if (mode.kind !== "cancel") return;
        setError("");
        startTransition(async () => {
            try {
                const result = await cancelMyTrialApplication({ id: mode.id, ...credentials, reason: mode.reason });
                if (!result.ok) { setError(result.message); return; }
                setItems((prev) => prev?.filter((item) => item.id !== mode.id) ?? null);
                setMode({ kind: "idle" });
                setNotice(result.message);
            } catch (e) {
                console.error("[trial-manage] cancel failed", e);
                setError(publicErrorText(e, FALLBACK_ERROR));
            }
        });
    };

    return (
        <div className="space-y-4">
            <div className="rounded-2xl bg-white p-6 shadow-lg dark:bg-[var(--color-public-tint)]">
                <h2 className="mb-4 text-lg font-bold text-[var(--color-public-ink)] dark:text-white">신청 불러오기</h2>
                <form
                    className="space-y-4"
                    onSubmit={(event) => { event.preventDefault(); handleLookup(); }}
                >
                    <div>
                        <label htmlFor="trial-manage-child" className="mb-2 block text-sm font-medium text-[var(--color-public-muted)]">아이 이름</label>
                        <input id="trial-manage-child" value={childName} onChange={(event) => { setChildName(event.target.value); setItems(null); }} placeholder="신청할 때 적은 아이 이름" autoComplete="off" className={INPUT_CLASS} />
                    </div>
                    <div>
                        <label htmlFor="trial-manage-phone" className="mb-2 block text-sm font-medium text-[var(--color-public-muted)]">학부모 휴대폰</label>
                        <input id="trial-manage-phone" type="tel" inputMode="numeric" value={parentPhone} onChange={(event) => { setParentPhone(formatPhone(event.target.value)); setItems(null); }} placeholder="010-0000-0000" autoComplete="tel" className={INPUT_CLASS} />
                    </div>
                    <button type="submit" disabled={isPending} className={`${PRIMARY_BUTTON} w-full`}>
                        {isPending && mode.kind === "idle" ? "불러오는 중..." : "신청 불러오기"}
                    </button>
                </form>
            </div>

            {error && <div role="alert" className="rounded-xl border border-[var(--color-academy-danger-line)] bg-[var(--color-academy-danger-soft)] px-4 py-3 text-sm text-[var(--color-academy-danger)]">{error}</div>}
            {notice && <div role="status" className="rounded-xl border border-[var(--color-public-line)] bg-[var(--color-public-tint)] px-4 py-3 text-sm font-semibold text-[var(--color-public-strong)]">{notice}</div>}

            {items && items.length === 0 && (
                <div className="rounded-2xl bg-white p-6 text-sm text-[var(--color-public-muted)] shadow-lg dark:bg-[var(--color-public-tint)]">
                    진행 중인 체험 신청이 없어요. <Link href="/apply/trial" className="font-semibold text-[var(--color-public-accent)] underline">새로 신청하기</Link>
                </div>
            )}

            {items?.map((item) => (
                <div key={item.id} className="rounded-2xl bg-white p-6 shadow-lg dark:bg-[var(--color-public-tint)]">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                        <div>
                            <p className="text-xs text-[var(--color-public-muted)]">{item.receivedText ? `${item.receivedText} 접수` : "체험 신청"}</p>
                            <p className="mt-1 text-lg font-bold text-[var(--color-public-ink)] dark:text-white">희망 일정: {item.scheduleText}</p>
                            {item.confirmedText && <p className="mt-1 text-sm font-semibold text-[var(--color-public-ink)] dark:text-white">확정 일시: {item.confirmedText}</p>}
                        </div>
                        <span className="rounded-full bg-[var(--color-public-tint)] px-3 py-1 text-xs font-bold text-[var(--color-public-strong)] dark:bg-[var(--color-public-paper)] dark:text-white">{item.statusLabel}</span>
                    </div>

                    {mode.kind === "change" && mode.id === item.id ? (
                        <ScheduleEditor
                            availableSlots={availableSlots}
                            selection={mode.selection}
                            confirmed={Boolean(item.confirmedText)}
                            pending={isPending}
                            onChange={(selection) => { setError(""); setMode({ ...mode, selection }); }}
                            onSubmit={submitChange}
                            onCancel={() => { setError(""); setMode({ kind: "idle" }); }}
                        />
                    ) : mode.kind === "cancel" && mode.id === item.id ? (
                        <div className="mt-4 space-y-3 rounded-xl border border-[var(--color-academy-danger-line)] bg-[var(--color-academy-danger-soft)] p-4">
                            <p className="text-sm font-semibold text-[var(--color-academy-danger)]">이 체험 신청을 취소할까요? 취소한 뒤에는 다시 신청해야 해요.</p>
                            <label htmlFor={`trial-cancel-reason-${item.id}`} className="block text-sm text-[var(--color-public-muted)]">취소 사유(선택)</label>
                            <input id={`trial-cancel-reason-${item.id}`} value={mode.reason} maxLength={200} onChange={(event) => setMode({ ...mode, reason: event.target.value })} placeholder="예: 일정이 맞지 않아요" className={INPUT_CLASS} />
                            <div className="flex flex-wrap gap-2">
                                <button type="button" disabled={isPending} onClick={submitCancel} className="inline-flex min-h-11 items-center justify-center rounded-xl bg-[var(--color-academy-danger-fill)] px-5 text-sm font-bold text-white hover:bg-[var(--color-academy-danger-fill-hover)] disabled:opacity-50">
                                    {isPending ? "취소하는 중..." : "신청 취소하기"}
                                </button>
                                <button type="button" disabled={isPending} onClick={() => setMode({ kind: "idle" })} className={SECONDARY_BUTTON}>돌아가기</button>
                            </div>
                        </div>
                    ) : (
                        <div className="mt-4 space-y-2">
                            <div className="flex flex-wrap gap-2">
                                <button type="button" disabled={!item.canChange || isPending} onClick={() => startChange(item)} className={PRIMARY_BUTTON}>일정 변경</button>
                                <button type="button" disabled={!item.canCancel || isPending} onClick={() => { setError(""); setNotice(""); setMode({ kind: "cancel", id: item.id, reason: "" }); }} className={SECONDARY_BUTTON}>신청 취소</button>
                            </div>
                            {(item.changeBlockedMessage || item.cancelBlockedMessage) && (
                                <p className="text-xs text-[var(--color-public-muted)]">{item.changeBlockedMessage ?? item.cancelBlockedMessage}</p>
                            )}
                        </div>
                    )}
                </div>
            ))}

            <p className="text-center text-sm text-[var(--color-public-muted)]">
                불러오기가 안 되거나 다른 내용을 바꾸려면{" "}
                <a href={`tel:${contactPhone.replace(/-/g, "")}`} className="font-semibold text-[var(--color-public-accent)]">{contactPhone}</a>
                로 연락해 주세요.
            </p>
        </div>
    );
}

function ScheduleEditor({
    availableSlots,
    selection,
    confirmed,
    pending,
    onChange,
    onSubmit,
    onCancel,
}: {
    availableSlots: AvailableSlot[];
    selection: TrialScheduleSelection;
    confirmed: boolean;
    pending: boolean;
    onChange: (selection: TrialScheduleSelection) => void;
    onSubmit: () => void;
    onCancel: () => void;
}) {
    const dateDay = trialDayForDate(selection.trialDate);
    const periodOptions = dateDay
        ? availableSlots
            .filter((slot) => slot.dayLabel === dateDay)
            .map((slot) => ({ period: trialSlotPeriod(slot.slotKey), slot }))
            .filter((option) => option.period)
        : [];
    const pastDate = isKstYmd(selection.trialDate) && selection.trialDate < todayKst();

    return (
        <div className="mt-4 space-y-4 rounded-xl border border-[var(--color-public-line)] p-4">
            {confirmed && <p className="text-sm text-[var(--color-public-muted)]">이미 확정된 체험이에요. 바꾸면 확정이 풀리고 학원에서 새 일정을 다시 안내해 드려요.</p>}
            <div>
                <label htmlFor="trial-manage-date" className="mb-2 block text-sm font-medium text-[var(--color-public-muted)]">새 체험 희망일</label>
                <input id="trial-manage-date" type="date" min={todayKst()} value={selection.trialDate} onChange={(event) => onChange(trialScheduleForDate(selection, event.target.value, availableSlots))} className={INPUT_CLASS} />
                {dateDay && <p className="mt-1 text-xs text-[var(--color-public-muted)]">{dateDay}요일</p>}
                {pastDate && <p className="mt-1 text-xs text-[var(--color-academy-danger)]">오늘 이후 날짜를 골라 주세요.</p>}
            </div>
            {dateDay && (
                <div>
                    <p className="mb-2 block text-sm font-medium text-[var(--color-public-muted)]">희망 교시</p>
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                        {periodOptions.map(({ period, slot }) => {
                            const isFull = slot.seatLevel === "FULL";
                            const selected = selection.trialPeriod === period;
                            return (
                                <button key={period} type="button" disabled={isFull} onClick={() => onChange({ ...selection, trialDay: dateDay, trialPeriod: period })} className={`rounded-xl border px-3 py-3 text-sm font-medium transition-colors ${isFull ? "cursor-not-allowed border-[var(--color-public-line)] bg-[var(--color-public-tint)] text-[var(--color-public-dark-muted)]" : selected ? "border-[var(--color-public-accent)] bg-[var(--color-public-tint)] text-[var(--color-public-strong)] dark:border-brand-neon-lime dark:text-brand-neon-lime" : "border-[var(--color-public-line)] text-[var(--color-public-muted)] hover:border-[var(--color-public-muted)]"}`}>
                                    <span className="block">{period}교시</span>
                                    {slot.startTime && <span className="mt-0.5 block text-xs font-semibold">{slot.startTime}~{slot.endTime}</span>}
                                    <span className={`mt-1 block text-xs font-bold ${isFull ? "" : SEAT_LEVEL_TEXT_CLASS[slot.seatLevel]}`}>{SEAT_LEVEL_LABEL[slot.seatLevel]}</span>
                                </button>
                            );
                        })}
                    </div>
                    {periodOptions.length === 0 && <p className="mt-2 text-sm text-[var(--color-public-muted)]">선택한 날짜의 요일에는 등록된 수업이 없어요. 다른 날짜를 골라 주세요.</p>}
                </div>
            )}
            <div className="flex flex-wrap gap-2">
                <button type="button" disabled={pending} onClick={onSubmit} className={PRIMARY_BUTTON}>{pending ? "저장하는 중..." : "이 일정으로 변경"}</button>
                <button type="button" disabled={pending} onClick={onCancel} className={SECONDARY_BUTTON}>돌아가기</button>
            </div>
        </div>
    );
}
