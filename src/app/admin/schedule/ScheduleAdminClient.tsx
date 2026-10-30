"use client";
import { adminErrorText } from "@/components/admin/adminDisplayText";

import { useCallback, useEffect, useMemo, useState, useTransition } from "react";
import dynamic from "next/dynamic";
import {
    upsertClassSlotOverride,
    createCustomSlot,
    updateCustomSlot,
    deleteCustomSlot,
} from "@/app/actions/schedule";
import { updateAcademySettings } from "@/app/actions/admin";
import type { SheetClassSlot } from "@/lib/googleSheetsSchedule";
import type { SchedulePayloadSource } from "@/lib/scheduleSlotPayload";
import type { MergedSlot } from "@/app/schedule/ScheduleClient";

const ScheduleTableView = dynamic(() => import("@/components/ScheduleTableView"), {
    loading: () => (
        <div className="rounded-2xl border border-gray-200 bg-white p-6 text-center text-sm text-gray-500 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400">
            시간표 미리보기를 불러오는 중...
        </div>
    ),
});

const ScheduleAdminModals = dynamic(() => import("./ScheduleAdminModals"), {
    loading: () => null,
});

const DAY_ORDER = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const DAY_LABEL: Record<string, string> = {
    Mon: "월요일", Tue: "화요일", Wed: "수요일", Thu: "목요일",
    Fri: "금요일", Sat: "토요일", Sun: "일요일",
};
const DAY_COLOR: Record<string, string> = {
    Mon: "bg-blue-600", Tue: "bg-green-600", Wed: "bg-yellow-500",
    Thu: "bg-purple-600", Fri: "bg-red-500", Sat: "bg-brand-orange-500 dark:bg-brand-neon-lime dark:text-brand-navy-900", Sun: "bg-gray-500",
};

interface Coach {
    id: string;
    name: string;
    role: string;
    imageUrl: string | null;
}

interface Program {
    id: string;
    name: string;
}

interface Override {
    slotKey: string;
    label: string | null;
    note: string | null;
    isHidden: boolean;
    capacity: number;
    coachId: string | null;
    startTimeOverride?: string | null;
    endTimeOverride?: string | null;
    programId?: string | null;
}

interface SlotState {
    label: string;
    note: string;
    isHidden: boolean;
    capacity: number;
    coachId: string;
    startTimeOverride: string;
    endTimeOverride: string;
    programId: string;
    dirty: boolean;
    saved: boolean;
    error: string | null;
}

interface CustomSlot {
    id: string;
    dayKey: string;
    startTime: string;
    endTime: string;
    label: string;
    gradeRange: string | null;
    enrolled: number;
    capacity: number;
    note: string | null;
    isHidden: boolean;
    coachId: string | null;
    coach: Coach | null;
    programId: string | null;
}

interface CustomSlotForm {
    dayKey: string;
    startTime: string;
    endTime: string;
    label: string;
    gradeRange: string;
    enrolled: number;
    capacity: number;
    note: string;
    isHidden: boolean;
    coachId: string;
    programId: string;
}

interface SchedulePayload {
    slots: SheetClassSlot[];
    overrides: Override[];
    coaches: Coach[];
    customSlots: CustomSlot[];
    hasSheetUrl: boolean;
    sheetUrl: string | null;
    programs: Program[];
    scheduleSource?: SchedulePayloadSource;
}

interface ScheduleAdminClientProps {
    slots?: SheetClassSlot[];
    overrides?: Override[];
    coaches?: Coach[];
    customSlots?: CustomSlot[];
    hasSheetUrl?: boolean;
    sheetUrl?: string | null;
    programs?: Program[];
    scheduleSource?: SchedulePayloadSource;
    // 구글 시트 원장 은퇴 여부(서버가 isSheetSyncRetired 로 판정해 넘김). true 면 시트 연동·동기화 버튼을 숨긴다.
    sheetRetired?: boolean;
}

function defaultCustomSlotForm(): CustomSlotForm {
    return { dayKey: "Mon", startTime: "14:00", endTime: "15:00", label: "", gradeRange: "", enrolled: 0, capacity: 12, note: "", isHidden: false, coachId: "", programId: "" };
}

function buildInitialState(overrides: Override[]): Record<string, SlotState> {
    const map: Record<string, SlotState> = {};
    for (const o of overrides) {
        map[o.slotKey] = {
            label: o.label ?? "",
            note: o.note ?? "",
            isHidden: o.isHidden,
            capacity: o.capacity,
            coachId: o.coachId ?? "",
            startTimeOverride: o.startTimeOverride ?? "",
            endTimeOverride: o.endTimeOverride ?? "",
            programId: o.programId ?? "",
            dirty: false,
            saved: false,
            error: null,
        };
    }
    return map;
}

function defaultSlotState(): SlotState {
    return { label: "", note: "", isHidden: false, capacity: 12, coachId: "", startTimeOverride: "", endTimeOverride: "", programId: "", dirty: false, saved: false, error: null };
}

function ScheduleLoadingFallback() {
    return (
        <div className="space-y-6">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                <div>
                    <div className="h-8 w-48 rounded bg-gray-200 dark:bg-gray-700 animate-pulse" />
                    <div className="mt-2 h-4 w-96 max-w-full rounded bg-gray-100 dark:bg-gray-800 animate-pulse" />
                </div>
                <div className="flex flex-wrap gap-2">
                    <div className="h-10 w-36 rounded-lg bg-gray-200 dark:bg-gray-700 animate-pulse" />
                    <div className="h-10 w-28 rounded-lg bg-gray-100 dark:bg-gray-700 animate-pulse" />
                </div>
            </div>

            <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
                {Array.from({ length: 4 }).map((_, index) => (
                    <div
                        key={index}
                        className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-800"
                    >
                        <div className="h-4 w-24 rounded bg-gray-100 dark:bg-gray-700 animate-pulse" />
                        <div className="mt-3 h-7 w-16 rounded bg-gray-200 dark:bg-gray-700 animate-pulse" />
                    </div>
                ))}
            </div>

            <div className="rounded-2xl border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-800">
                <div className="border-b border-gray-100 p-5 dark:border-gray-700">
                    <div className="h-6 w-40 rounded bg-gray-200 dark:bg-gray-700 animate-pulse" />
                    <div className="mt-2 h-3 w-72 max-w-full rounded bg-gray-100 dark:bg-gray-700 animate-pulse" />
                </div>
                <div className="grid gap-3 p-5 md:grid-cols-2 xl:grid-cols-3">
                    {Array.from({ length: 9 }).map((_, index) => (
                        <div key={index} className="rounded-xl border border-gray-100 p-4 dark:border-gray-700">
                            <div className="flex items-center justify-between gap-3">
                                <div className="h-5 w-24 rounded bg-gray-200 dark:bg-gray-700 animate-pulse" />
                                <div className="h-6 w-16 rounded-full bg-gray-100 dark:bg-gray-700 animate-pulse" />
                            </div>
                            <div className="mt-4 space-y-2">
                                <div className="h-4 rounded bg-gray-100 dark:bg-gray-700 animate-pulse" />
                                <div className="h-4 w-2/3 rounded bg-gray-100 dark:bg-gray-700 animate-pulse" />
                            </div>
                            <div className="mt-4 h-9 rounded-lg bg-gray-100 dark:bg-gray-700 animate-pulse" />
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
}

function ScheduleErrorState({ onRetry }: { onRetry: () => void }) {
    return (
        <div className="rounded-2xl border border-red-100 bg-white p-8 text-center shadow-sm dark:border-red-900/40 dark:bg-gray-800">
            <span className="material-symbols-outlined mb-3 text-4xl text-red-500">error</span>
            <p className="font-bold text-gray-900 dark:text-white">시간표 데이터를 불러오지 못했습니다.</p>
            <button
                type="button"
                onClick={onRetry}
                className="mt-4 rounded-xl bg-brand-orange-500 px-4 py-2 text-sm font-bold text-white transition hover:bg-orange-600 dark:bg-brand-neon-lime dark:text-brand-navy-900"
            >
                다시 시도
            </button>
        </div>
    );
}

export default function ScheduleAdminClient(props: ScheduleAdminClientProps = {}) {
    const {
        slots: initialSlots = [],
        overrides: initialOverrides = [],
        coaches: initialCoaches = [],
        customSlots: initialCustomSlots = [],
        hasSheetUrl: initialHasSheetUrl = false,
        sheetUrl: initialSheetUrl = null,
        programs: initialPrograms = [],
        scheduleSource: initialScheduleSource = "SHEET_CACHE",
        sheetRetired = false,
    } = props;
    const hasInitialData = Boolean(
        props.slots ||
        props.overrides ||
        props.coaches ||
        props.customSlots ||
        props.hasSheetUrl !== undefined ||
        props.sheetUrl !== undefined ||
        props.programs ||
        props.scheduleSource,
    );
    const [slots, setSlots] = useState<SheetClassSlot[]>(initialSlots);
    const [stateMap, setStateMap] = useState<Record<string, SlotState>>(() => buildInitialState(initialOverrides));
    const [coaches, setCoaches] = useState<Coach[]>(initialCoaches);
    const [customSlots, setCustomSlots] = useState<CustomSlot[]>(initialCustomSlots);
    const [hasSheetUrl, setHasSheetUrl] = useState(initialHasSheetUrl);
    const [sheetUrl, setSheetUrl] = useState<string | null>(initialSheetUrl);
    const [programs, setPrograms] = useState<Program[]>(initialPrograms);
    const [scheduleSource, setScheduleSource] = useState<SchedulePayloadSource>(initialScheduleSource);
    const [loading, setLoading] = useState(!hasInitialData);
    const [loadError, setLoadError] = useState(false);
    const [pending, startTransition] = useTransition();

    // Google Sheets modal state
    const [showSheetModal, setShowSheetModal] = useState(false);
    const [sheetUrlInput, setSheetUrlInput] = useState(sheetUrl || "");
    const [sheetSaving, setSheetSaving] = useState(false);
    const [sheetSaved, setSheetSaved] = useState(false);
    const [sheetError, setSheetError] = useState<string | null>(null);
    const [sheetSyncing, setSheetSyncing] = useState(false);
    const [sheetSyncMessage, setSheetSyncMessage] = useState<string | null>(null);

    async function handleSaveSheetUrl() {
        setSheetSaving(true);
        setSheetError(null);
        setSheetSyncMessage(null);
        try {
            await updateAcademySettings({ googleSheetsScheduleUrl: sheetUrlInput });
            setSheetUrl(sheetUrlInput || null);
            setHasSheetUrl(Boolean(sheetUrlInput));
            setSheetSaved(true);
            setTimeout(() => {
                setShowSheetModal(false);
                setSheetSaved(false);
                void loadScheduleData();
            }, 800);
        } catch (e: any) {
            setSheetError(adminErrorText(e, "저장 실패"));
        } finally {
            setSheetSaving(false);
        }
    }

    async function handleSyncSheet() {
        setSheetSyncing(true);
        setSheetError(null);
        setSheetSyncMessage(null);

        try {
            if (sheetUrlInput !== (sheetUrl || "")) {
                await updateAcademySettings({ googleSheetsScheduleUrl: sheetUrlInput });
                setSheetUrl(sheetUrlInput || null);
                setHasSheetUrl(Boolean(sheetUrlInput));
            }

            const response = await fetch("/api/admin/sync-schedule", { method: "POST" });
            const result = (await response.json()) as { synced?: number; error?: string };
            if (!response.ok) {
                throw new Error(result.error || "동기화 실패");
            }

            setSheetSyncMessage(`${result.synced ?? 0}개 수업을 시간표에 반영했습니다.`);
            await loadScheduleData();
        } catch (error: any) {
            setSheetError(adminErrorText(error, "동기화 실패"));
        } finally {
            setSheetSyncing(false);
        }
    }

    function handleSheetUrlChange(value: string) {
        setSheetUrlInput(value);
        setSheetError(null);
        setSheetSyncMessage(null);
    }

    // Custom slot state
    const [isAddingCustom, setIsAddingCustom] = useState(false);
    const [newCustomForm, setNewCustomForm] = useState<CustomSlotForm>(defaultCustomSlotForm);
    const [editingCustomId, setEditingCustomId] = useState<string | null>(null);
    const [editCustomForm, setEditCustomForm] = useState<CustomSlotForm>(defaultCustomSlotForm);
    const [customPending, startCustomTransition] = useTransition();
    const [deletingCustomId, setDeletingCustomId] = useState<string | null>(null);

    // 시트 슬롯 편집 모달 state — 클릭한 슬롯의 slotKey를 저장
    const [editingSlotKey, setEditingSlotKey] = useState<string | null>(null);

    const hasAnyData = slots.length > 0 || customSlots.length > 0 || coaches.length > 0 || programs.length > 0 || hasSheetUrl;

    const loadScheduleData = useCallback(async () => {
        setLoading(true);
        setLoadError(false);

        try {
            const response = await fetch("/api/admin/schedule");
            if (!response.ok) {
                throw new Error("Failed to load schedule data.");
            }

            const data = (await response.json()) as SchedulePayload;
            setSlots(data.slots);
            setStateMap(buildInitialState(data.overrides));
            setCoaches(data.coaches);
            setCustomSlots(data.customSlots);
            setHasSheetUrl(data.hasSheetUrl);
            setSheetUrl(data.sheetUrl);
            setPrograms(data.programs);
            setScheduleSource(data.scheduleSource ?? "SHEET_CACHE");
        } catch (error) {
            console.error("Failed to load schedule data:", error);
            setLoadError(true);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        if (hasInitialData) return;
        void loadScheduleData();
    }, [hasInitialData, loadScheduleData]);

    const coachMap = useMemo(() => Object.fromEntries(coaches.map((c) => [c.id, c])), [coaches]);
    const isDbScheduleSource = scheduleSource === "SCHEDULE_SLOT";

    function getState(slotKey: string): SlotState {
        return stateMap[slotKey] ?? defaultSlotState();
    }

    function update(slotKey: string, patch: Partial<SlotState>) {
        setStateMap((prev) => ({
            ...prev,
            [slotKey]: { ...(prev[slotKey] ?? defaultSlotState()), ...patch, dirty: true, saved: false },
        }));
    }

    function save(slot: SheetClassSlot) {
        const s = getState(slot.slotKey);
        startTransition(async () => {
            try {
                await upsertClassSlotOverride(slot.slotKey, {
                    label: s.label || undefined,
                    note: s.note || undefined,
                    isHidden: s.isHidden,
                    capacity: s.capacity,
                    coachId: s.coachId || null,
                    startTimeOverride: s.startTimeOverride || null,
                    endTimeOverride: s.endTimeOverride || null,
                    programId: s.programId || null,
                });
                setStateMap((prev) => ({
                    ...prev,
                    [slot.slotKey]: { ...s, dirty: false, saved: true, error: null },
                }));
            } catch {
                setStateMap((prev) => ({
                    ...prev,
                    [slot.slotKey]: { ...s, error: "저장 실패" },
                }));
            }
        });
    }

    function handleAddCustom() {
        if (!newCustomForm.label.trim()) return;
        startCustomTransition(async () => {
            try {
                await createCustomSlot({
                    dayKey: newCustomForm.dayKey,
                    startTime: newCustomForm.startTime,
                    endTime: newCustomForm.endTime,
                    label: newCustomForm.label.trim(),
                    gradeRange: newCustomForm.gradeRange.trim() || undefined,
                    enrolled: newCustomForm.enrolled,
                    capacity: newCustomForm.capacity,
                    note: newCustomForm.note.trim() || undefined,
                    isHidden: newCustomForm.isHidden,
                    coachId: newCustomForm.coachId || null,
                    programId: newCustomForm.programId || null,
                });
                setNewCustomForm(defaultCustomSlotForm());
                setIsAddingCustom(false);
                await loadScheduleData();
            } catch (e: any) {
                alert(adminErrorText(e, "생성 실패"));
            }
        });
    }

    function startEditCustom(cs: CustomSlot) {
        setEditingCustomId(cs.id);
        setEditCustomForm({
            dayKey: cs.dayKey, startTime: cs.startTime, endTime: cs.endTime,
            label: cs.label, gradeRange: cs.gradeRange ?? "", enrolled: cs.enrolled,
            capacity: cs.capacity, note: cs.note ?? "", isHidden: cs.isHidden,
            coachId: cs.coachId ?? "", programId: cs.programId ?? "",
        });
    }

    function handleUpdateCustom(id: string) {
        if (!editCustomForm.label.trim()) return;
        startCustomTransition(async () => {
            try {
                await updateCustomSlot(id, {
                    dayKey: editCustomForm.dayKey, startTime: editCustomForm.startTime,
                    endTime: editCustomForm.endTime, label: editCustomForm.label.trim(),
                    gradeRange: editCustomForm.gradeRange.trim() || null, enrolled: editCustomForm.enrolled,
                    capacity: editCustomForm.capacity, note: editCustomForm.note.trim() || null,
                    isHidden: editCustomForm.isHidden, coachId: editCustomForm.coachId || null,
                    programId: editCustomForm.programId || null,
                });
                setEditingCustomId(null);
                await loadScheduleData();
            } catch (e: any) {
                alert(adminErrorText(e, "수정 실패"));
            }
        });
    }

    function handleDeleteCustom(id: string) {
        startCustomTransition(async () => {
            try {
                await deleteCustomSlot(id);
                setDeletingCustomId(null);
                await loadScheduleData();
            } catch (e: any) {
                alert(adminErrorText(e, "삭제 실패"));
            }
        });
    }

    // 시트 슬롯을 요일별로 그룹핑 (period 기준 정렬)
    const sheetByDay = DAY_ORDER.reduce<Record<string, SheetClassSlot[]>>((acc, d) => {
        acc[d] = slots.filter((s) => s.dayKey === d).sort((a, b) => a.period - b.period);
        return acc;
    }, {});
    // 커스텀 슬롯도 요일별로 그룹핑 (startTime 기준 정렬)
    const customByDay = DAY_ORDER.reduce<Record<string, CustomSlot[]>>((acc, d) => {
        acc[d] = customSlots.filter((cs) => cs.dayKey === d).sort((a, b) => a.startTime.localeCompare(b.startTime));
        return acc;
    }, {});
    // 시트 슬롯 또는 커스텀 슬롯이 하나라도 있는 요일만 표시
    const activeDays = DAY_ORDER.filter((d) => sheetByDay[d].length > 0 || customByDay[d].length > 0);

    // 관리자 뷰 토글 상태 — "edit"(편집 모드) / "table"(표 미리보기)
    const [adminViewMode, setAdminViewMode] = useState<"edit" | "table">("edit");

    // SheetClassSlot + CustomSlot -> MergedSlot 변환 (표 뷰 전용)
    const mergedSlotsForTable = useMemo<MergedSlot[]>(() => {
        const result: MergedSlot[] = [];
        for (const slot of slots) {
            const s = stateMap[slot.slotKey];
            const isHidden = s?.isHidden ?? false;
            if (isHidden) continue;
            const coachId = s?.coachId || null;
            const coach = coachId ? coachMap[coachId] ?? null : null;
            result.push({
                slotKey: slot.slotKey,
                dayKey: slot.dayKey,
                dayLabel: slot.dayLabel,
                startTime: s?.startTimeOverride || slot.startTime,
                endTime: s?.endTimeOverride || slot.endTime,
                gradeRange: slot.gradeRange,
                enrolled: slot.enrolled,
                displayLabel: s?.label || `${slot.period}교시`,
                note: s?.note || null,
                capacity: s?.capacity ?? 12,
                isFull: slot.enrolled >= (s?.capacity ?? 12),
                coach: coach ? { name: coach.name, role: coach.role, imageUrl: coach.imageUrl } : null,
                programId: s?.programId || null,
            });
        }
        for (const cs of customSlots) {
            if (cs.isHidden) continue;
            result.push({
                slotKey: `custom-${cs.id}`,
                dayKey: cs.dayKey,
                dayLabel: DAY_LABEL[cs.dayKey] || cs.dayKey,
                startTime: cs.startTime,
                endTime: cs.endTime,
                gradeRange: cs.gradeRange || "",
                enrolled: cs.enrolled,
                displayLabel: cs.label,
                note: cs.note,
                capacity: cs.capacity,
                isFull: cs.enrolled >= cs.capacity,
                coach: cs.coach ? { name: cs.coach.name, role: cs.coach.role, imageUrl: cs.coach.imageUrl } : null,
                programId: cs.programId,
            });
        }
        return result;
    }, [slots, stateMap, customSlots, coachMap]);

    // 현재 편집 모달이 열린 시트 슬롯 객체 찾기
    const editingSheetSlot = editingSlotKey ? slots.find((s) => s.slotKey === editingSlotKey) : null;
    const editingCustomSlot = editingCustomId ? customSlots.find((c) => c.id === editingCustomId) ?? null : null;
    const hasOpenModal = Boolean(editingSheetSlot || editingCustomSlot || showSheetModal || isAddingCustom);

    if (loading && !hasAnyData) {
        return <ScheduleLoadingFallback />;
    }

    if (loadError && !hasAnyData) {
        return <ScheduleErrorState onRetry={loadScheduleData} />;
    }

    return (
        <div className="space-y-8">
            {/* 페이지 헤더 */}
            <div className="flex items-start justify-between gap-4">
                <div>
                    <h1 className="text-2xl font-bold text-gray-900 dark:text-white mb-1">수업시간표 관리</h1>
                    {/* 구글시트에서 불러오는 경우에만 데이터 출처를 안내한다 */}
                    {!isDbScheduleSource && (
                        <p className="text-gray-500 dark:text-gray-400 text-sm">
                            학년·인원은 구글시트에서 마지막으로 가져온 내용을 보여줍니다. 카드를 클릭하면 편집할 수 있습니다.
                        </p>
                    )}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                    {/* 편집/표 뷰 토글 */}
                    <div className="flex rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden shadow-sm">
                        <button
                            onClick={() => setAdminViewMode("edit")}
                            className={`flex items-center gap-1 px-3 py-2 text-sm font-bold transition-colors ${
                                adminViewMode === "edit"
                                    ? "bg-brand-navy-900 text-white"
                                    : "bg-white text-gray-500 hover:bg-gray-50 dark:bg-gray-900 dark:text-gray-400 dark:hover:bg-gray-800"
                            }`}
                        >
                            <span className="material-symbols-outlined" style={{ fontSize: "18px" }}>edit</span>
                            편집
                        </button>
                        <button
                            onClick={() => setAdminViewMode("table")}
                            className={`flex items-center gap-1 px-3 py-2 text-sm font-bold transition-colors ${
                                adminViewMode === "table"
                                    ? "bg-brand-navy-900 text-white"
                                    : "bg-white text-gray-500 hover:bg-gray-50 dark:bg-gray-900 dark:text-gray-400 dark:hover:bg-gray-800"
                            }`}
                        >
                            <span className="material-symbols-outlined" style={{ fontSize: "18px" }}>table_chart</span>
                            표 보기
                        </button>
                    </div>
                    {/* 시트 원장 은퇴면 「구글시트 연동」 버튼(→ 지금 동기화 모달)을 숨긴다. 원본은 사이트 DB 시간표. */}
                    {!sheetRetired && (
                    <button
                        onClick={() => { setSheetUrlInput(sheetUrl || ""); setShowSheetModal(true); }}
                        className={`bg-white border text-sm font-bold px-4 py-2 rounded-xl shadow-sm transition flex items-center gap-1.5 dark:bg-gray-800 ${hasSheetUrl ? "border-green-300 text-green-800 hover:bg-green-50 dark:border-emerald-500/40 dark:text-emerald-300 dark:hover:bg-emerald-500/10" : "border-amber-300 text-amber-800 hover:bg-amber-50 dark:border-amber-500/40 dark:text-amber-300 dark:hover:bg-amber-500/10"}`}
                    >
                        <span className="material-symbols-outlined" style={{ fontSize: "18px" }}>link</span>
                        {isDbScheduleSource ? "사이트 시간표" : `구글시트 연동${hasSheetUrl ? " " : " 설정"}`}
                        {hasSheetUrl && <span className="material-symbols-outlined text-green-600 dark:text-emerald-300" style={{ fontSize: "16px" }}>check_circle</span>}
                    </button>
                    )}
                    {/* 은퇴 상태에서도 지금 원본이 무엇인지는 보이게 — 누를 수 없는 표시 배지 */}
                    {sheetRetired && isDbScheduleSource && (
                        <span className="bg-white border border-green-300 text-green-800 text-sm font-bold px-4 py-2 rounded-xl flex items-center gap-1.5 dark:bg-gray-800 dark:border-emerald-500/40 dark:text-emerald-300">
                            <span className="material-symbols-outlined" style={{ fontSize: "18px" }}>database</span>
                            사이트 시간표
                        </span>
                    )}
                </div>
            </div>

            {/* 표 보기 모드 — 공개 시간표 미리보기 (편집 불가) */}
            {adminViewMode === "table" && (
                <div className="space-y-4">
                    <ScheduleTableView slots={mergedSlotsForTable} />
                </div>
            )}

            {/* 시트 URL 미설정 안내 — 시트 원장 은퇴면 띄우지 않는다 */}
            {adminViewMode === "edit" && !sheetRetired && !hasSheetUrl && !isDbScheduleSource && (
                <div className="bg-amber-50 border border-amber-200 rounded-xl p-5 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
                    <p className="font-bold mb-1">구글시트 URL이 설정되지 않았습니다.</p>
                    <p>
                        <button
                            onClick={() => setShowSheetModal(true)}
                            className="underline font-medium hover:text-amber-900 dark:hover:text-amber-200"
                        >
                            구글시트 연동 설정
                        </button>
                        을 눌러 URL을 먼저 입력해 주세요.
                    </p>
                </div>
            )}

            {adminViewMode === "edit" && !sheetRetired && hasSheetUrl && slots.length === 0 && (
                <div className="bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl p-10 text-center text-gray-500 dark:text-gray-400">
                    <p className="text-lg font-medium mb-1">시트에서 수업 데이터를 찾을 수 없습니다.</p>
                    <p className="text-sm">시트가 공개 설정인지, 주소와 탭이 올바른지 확인해 주세요.</p>
                </div>
            )}

            {/* ── 요일별 수업 카드 목록 (편집 모드) ── */}
            {adminViewMode === "edit" && activeDays.map((dayKey) => (
                <div key={dayKey} className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 overflow-hidden">
                    {/* 요일 헤더 */}
                    <div className={`${DAY_COLOR[dayKey]} text-white px-5 py-3 flex items-center gap-3`}>
                        <span className="font-black text-lg">{DAY_LABEL[dayKey]}</span>
                        <span className="text-white/70 text-sm">{sheetByDay[dayKey].length + customByDay[dayKey].length}개 수업</span>
                    </div>

                    {/* 수업 카드 목록 — 컴팩트 한 줄 카드 */}
                    <div className="divide-y divide-gray-100 dark:divide-gray-700">
                        {/* 시트 슬롯 — 클릭하면 편집 모달 열림 */}
                        {sheetByDay[dayKey].map((slot) => {
                            const s = getState(slot.slotKey);
                            const assignedCoach = s.coachId ? coachMap[s.coachId] : null;
                            const displayStart = s.startTimeOverride || slot.startTime;
                            const displayEnd = s.endTimeOverride || slot.endTime;
                            const isFull = slot.enrolled >= s.capacity;

                            return (
                                <button
                                    key={slot.slotKey}
                                    type="button"
                                    onClick={() => setEditingSlotKey(slot.slotKey)}
                                    className="w-full text-left px-4 py-3 hover:bg-gray-50 dark:bg-gray-900 dark:hover:bg-gray-800 transition-colors flex items-center gap-3 group"
                                >
                                    {/* 교시 뱃지 */}
                                    <span className="bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-200 text-xs font-bold px-2.5 py-1 rounded-full shrink-0">
                                        {slot.period}교시
                                    </span>

                                    {/* 시간 */}
                                    <span className="text-sm font-semibold text-gray-800 dark:text-gray-100 shrink-0">
                                        {displayStart} ~ {displayEnd}
                                    </span>
                                    {/* 시간 조정 표시 */}
                                    {s.startTimeOverride && (
                                        <span className="text-[10px] text-brand-orange-600 dark:text-brand-neon-lime shrink-0">(조정)</span>
                                    )}

                                    {/* 레이블 (override 있을 때만) */}
                                    {s.label && (
                                        <span className="text-xs text-gray-500 dark:text-gray-400 shrink-0">{s.label}</span>
                                    )}

                                    {/* 학년 범위 */}
                                    {slot.gradeRange && (
                                        <span className="bg-blue-50 text-blue-700 text-[11px] font-bold px-2 py-0.5 rounded-full border border-blue-200 shrink-0 dark:border-blue-500/30 dark:bg-blue-500/10 dark:text-blue-300">
                                            {slot.gradeRange}
                                        </span>
                                    )}

                                    {/* 인원 현황 */}
                                    <span className={`text-[11px] font-bold px-2 py-0.5 rounded-full shrink-0 ${
                                        isFull ? "bg-red-100 text-red-700 dark:bg-red-500/10 dark:text-red-300" : "bg-green-50 text-green-700 dark:bg-emerald-500/10 dark:text-emerald-300"
                                    }`}>
                                        {slot.enrolled}/{s.capacity}명{isFull && " 마감"}
                                    </span>

                                    {/* 코치 */}
                                    {assignedCoach && (
                                        <span className="flex items-center gap-1 text-[11px] text-gray-600 dark:text-gray-300 bg-orange-50 border border-orange-200 px-2 py-0.5 rounded-full shrink-0 dark:border-orange-500/30 dark:bg-orange-500/10">
                                            {assignedCoach.imageUrl && <img src={assignedCoach.imageUrl} className="w-3.5 h-3.5 rounded-full object-cover" alt="" />}
                                            {assignedCoach.name}
                                        </span>
                                    )}

                                    {/* 숨김 상태 표시 */}
                                    {s.isHidden && (
                                        <span className="flex items-center gap-0.5 text-[11px] text-gray-400 bg-gray-100 dark:bg-gray-800 px-2 py-0.5 rounded-full shrink-0 dark:text-gray-300">
                                            <span className="material-symbols-outlined" style={{ fontSize: "12px" }}>visibility_off</span>
                                            숨김
                                        </span>
                                    )}

                                    {/* 메모 아이콘 (메모가 있을 때만) */}
                                    {s.note && (
                                        <span className="material-symbols-outlined text-brand-orange-400 shrink-0" style={{ fontSize: "16px" }}>push_pin</span>
                                    )}

                                    {/* 수정/저장 상태 — 우측 정렬 */}
                                    <span className="ml-auto flex items-center gap-2 shrink-0">
                                        {s.dirty && <span className="w-2 h-2 rounded-full bg-amber-400 shrink-0" title="미저장 변경사항" />}
                                        {s.saved && !s.dirty && <span className="material-symbols-outlined text-green-500" style={{ fontSize: "16px" }}>check_circle</span>}
                                        {s.error && <span className="material-symbols-outlined text-red-500" style={{ fontSize: "16px" }}>error</span>}
                                        {/* 편집 아이콘 (hover 시 강조) */}
                                        <span className="material-symbols-outlined text-gray-300 group-hover:text-gray-500 dark:text-gray-400 transition-colors" style={{ fontSize: "18px" }}>chevron_right</span>
                                    </span>
                                </button>
                            );
                        })}

                        {/* 커스텀 슬롯 — 동일한 컴팩트 카드 */}
                        {customByDay[dayKey].map((cs) => {
                            const isFull = cs.enrolled >= cs.capacity;
                            return (
                                <button
                                    key={`custom-${cs.id}`}
                                    type="button"
                                    onClick={() => startEditCustom(cs)}
                                    className="w-full text-left px-4 py-3 hover:bg-gray-50 dark:bg-gray-900 dark:hover:bg-gray-800 transition-colors flex items-center gap-3 group"
                                >
                                    {/* 커스텀 뱃지 */}
                                    <span className="bg-brand-orange-500 dark:bg-brand-neon-lime dark:text-brand-navy-900 text-white text-[11px] font-bold px-2.5 py-1 rounded-full shrink-0">
                                        커스텀
                                    </span>

                                    {/* 시간 */}
                                    <span className="text-sm font-semibold text-gray-800 dark:text-gray-100 shrink-0">
                                        {cs.startTime} ~ {cs.endTime}
                                    </span>

                                    {/* 레이블 */}
                                    <span className="text-xs text-gray-600 dark:text-gray-300 font-medium shrink-0">{cs.label}</span>

                                    {/* 학년 범위 */}
                                    {cs.gradeRange && (
                                        <span className="bg-blue-50 text-blue-700 text-[11px] font-bold px-2 py-0.5 rounded-full border border-blue-200 shrink-0 dark:border-blue-500/30 dark:bg-blue-500/10 dark:text-blue-300">
                                            {cs.gradeRange}
                                        </span>
                                    )}

                                    {/* 인원 현황 */}
                                    <span className={`text-[11px] font-bold px-2 py-0.5 rounded-full shrink-0 ${
                                        isFull ? "bg-red-100 text-red-700 dark:bg-red-500/10 dark:text-red-300" : "bg-green-50 text-green-700 dark:bg-emerald-500/10 dark:text-emerald-300"
                                    }`}>
                                        {cs.enrolled}/{cs.capacity}명{isFull && " 마감"}
                                    </span>

                                    {/* 코치 */}
                                    {cs.coach && (
                                        <span className="flex items-center gap-1 text-[11px] text-gray-600 dark:text-gray-300 bg-orange-50 border border-orange-200 px-2 py-0.5 rounded-full shrink-0 dark:border-orange-500/30 dark:bg-orange-500/10">
                                            {cs.coach.imageUrl && <img src={cs.coach.imageUrl} className="w-3.5 h-3.5 rounded-full object-cover" alt="" />}
                                            {cs.coach.name}
                                        </span>
                                    )}

                                    {/* 숨김 상태 */}
                                    {cs.isHidden && (
                                        <span className="flex items-center gap-0.5 text-[11px] text-gray-400 bg-gray-100 dark:bg-gray-800 px-2 py-0.5 rounded-full shrink-0 dark:text-gray-300">
                                            <span className="material-symbols-outlined" style={{ fontSize: "12px" }}>visibility_off</span>
                                            숨김
                                        </span>
                                    )}

                                    {/* 메모 아이콘 */}
                                    {cs.note && (
                                        <span className="material-symbols-outlined text-brand-orange-400 shrink-0" style={{ fontSize: "16px" }}>push_pin</span>
                                    )}

                                    {/* 우측 편집 화살표 */}
                                    <span className="ml-auto shrink-0">
                                        <span className="material-symbols-outlined text-gray-300 group-hover:text-gray-500 dark:text-gray-400 transition-colors" style={{ fontSize: "18px" }}>chevron_right</span>
                                    </span>
                                </button>
                            );
                        })}
                    </div>

                    {/* 요일 섹션 하단: + 수업 추가 버튼 */}
                    <div className="px-4 py-3 border-t border-gray-100 dark:border-gray-800">
                        <button
                            onClick={() => {
                                // 해당 요일을 기본값으로 설정하고 추가 모달 열기
                                setNewCustomForm({ ...defaultCustomSlotForm(), dayKey });
                                setIsAddingCustom(true);
                            }}
                            className="flex items-center gap-1.5 text-sm text-gray-400 hover:text-brand-orange-500 dark:text-brand-neon-lime font-medium transition-colors"
                        >
                            <span className="material-symbols-outlined" style={{ fontSize: "18px" }}>add_circle</span>
                            수업 추가
                        </button>
                    </div>
                </div>
            ))}

            {hasOpenModal && (
                <ScheduleAdminModals
                    editingSheetSlot={editingSheetSlot ?? null}
                    editingSheetState={editingSheetSlot ? getState(editingSheetSlot.slotKey) : null}
                    editingCustomSlot={editingCustomSlot}
                    editCustomForm={editCustomForm}
                    newCustomForm={newCustomForm}
                    coaches={coaches}
                    programs={programs}
                    pending={pending}
                    customPending={customPending}
                    deletingCustomId={deletingCustomId}
                    showSheetModal={showSheetModal}
                    sheetUrlInput={sheetUrlInput}
                    sheetSaving={sheetSaving}
                    sheetSaved={sheetSaved}
                    sheetError={sheetError}
                    sheetSyncing={sheetSyncing}
                    sheetSyncMessage={sheetSyncMessage}
                    isAddingCustom={isAddingCustom}
                    onCloseSheetSlot={() => setEditingSlotKey(null)}
                    onUpdateSlot={update}
                    onSaveSheetSlot={save}
                    onCloseCustomEdit={() => setEditingCustomId(null)}
                    onEditCustomFormChange={setEditCustomForm}
                    onStartDeleteCustom={setDeletingCustomId}
                    onCancelDeleteCustom={() => setDeletingCustomId(null)}
                    onConfirmDeleteCustom={handleDeleteCustom}
                    onSaveCustomEdit={handleUpdateCustom}
                    onCloseSheetUrl={() => setShowSheetModal(false)}
                    onSheetUrlChange={handleSheetUrlChange}
                    onSaveSheetUrl={handleSaveSheetUrl}
                    onSyncSheet={handleSyncSheet}
                    onClearSheetUrl={() => setSheetUrlInput("")}
                    onCloseAddCustom={() => setIsAddingCustom(false)}
                    onNewCustomFormChange={setNewCustomForm}
                    onSaveNewCustom={handleAddCustom}
                />
            )}
        </div>
    );
}
