"use client";

import type { SheetClassSlot } from "@/lib/googleSheetsSchedule";
import AdminModal from "@/components/admin/AdminModal";

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

interface ScheduleAdminModalsProps {
    editingSheetSlot: SheetClassSlot | null;
    editingSheetState: SlotState | null;
    editingCustomSlot: CustomSlot | null;
    editCustomForm: CustomSlotForm;
    newCustomForm: CustomSlotForm;
    coaches: Coach[];
    programs: Program[];
    pending: boolean;
    customPending: boolean;
    deletingCustomId: string | null;
    showSheetModal: boolean;
    sheetUrlInput: string;
    sheetSaving: boolean;
    sheetSaved: boolean;
    sheetError: string | null;
    sheetSyncing: boolean;
    sheetSyncMessage: string | null;
    isAddingCustom: boolean;
    onCloseSheetSlot: () => void;
    onUpdateSlot: (slotKey: string, patch: Partial<SlotState>) => void;
    onSaveSheetSlot: (slot: SheetClassSlot) => void;
    onCloseCustomEdit: () => void;
    onEditCustomFormChange: (form: CustomSlotForm) => void;
    onStartDeleteCustom: (id: string) => void;
    onCancelDeleteCustom: () => void;
    onConfirmDeleteCustom: (id: string) => void;
    onSaveCustomEdit: (id: string) => void;
    onCloseSheetUrl: () => void;
    onSheetUrlChange: (value: string) => void;
    onSaveSheetUrl: () => void;
    onSyncSheet: () => void;
    onClearSheetUrl: () => void;
    onCloseAddCustom: () => void;
    onNewCustomFormChange: (form: CustomSlotForm) => void;
    onSaveNewCustom: () => void;
}

const DAY_LABEL: Record<string, string> = {
    Mon: "월요일",
    Tue: "화요일",
    Wed: "수요일",
    Thu: "목요일",
    Fri: "금요일",
    Sat: "토요일",
    Sun: "일요일",
};

const DAY_OPTIONS = [
    { key: "Mon", label: "월요일" },
    { key: "Tue", label: "화요일" },
    { key: "Wed", label: "수요일" },
    { key: "Thu", label: "목요일" },
    { key: "Fri", label: "금요일" },
    { key: "Sat", label: "토요일" },
    { key: "Sun", label: "일요일" },
];

// 입력칸 = 테마 공용 모양(academy-input: 흰 면·입력선 테두리·44px). 2026-11-13 UI 통일
const INPUT = "academy-input";
const TIME_INPUT = "academy-input";
// 닫기·지우기(✕) 버튼 — 글자를 둘 자리가 없는 조작이라 기호를 남기되, 누르는 영역은 44px

export default function ScheduleAdminModals({
    editingSheetSlot,
    editingSheetState,
    editingCustomSlot,
    editCustomForm,
    newCustomForm,
    coaches,
    programs,
    pending,
    customPending,
    deletingCustomId,
    showSheetModal,
    sheetUrlInput,
    sheetSaving,
    sheetSaved,
    sheetError,
    sheetSyncing,
    sheetSyncMessage,
    isAddingCustom,
    onCloseSheetSlot,
    onUpdateSlot,
    onSaveSheetSlot,
    onCloseCustomEdit,
    onEditCustomFormChange,
    onStartDeleteCustom,
    onCancelDeleteCustom,
    onConfirmDeleteCustom,
    onSaveCustomEdit,
    onCloseSheetUrl,
    onSheetUrlChange,
    onSaveSheetUrl,
    onSyncSheet,
    onClearSheetUrl,
    onCloseAddCustom,
    onNewCustomFormChange,
    onSaveNewCustom,
}: ScheduleAdminModalsProps) {
    const coachMap = Object.fromEntries(coaches.map((coach) => [coach.id, coach]));

    return (
        <>
            {editingSheetSlot && editingSheetState && (
                <AdminModal onClose={onCloseSheetSlot} titleId="sheet-slot-title" panelClassName="max-w-2xl">
                    <span id="sheet-slot-title" className="sr-only">시트 수업 수정</span>
                        <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--color-academy-line)]">
                            <div className="flex items-center gap-3">
                                <span className="bg-[var(--color-academy-soft)] text-[var(--color-academy-muted)] text-xs tabular-nums px-2.5 py-1 rounded-full">
                                    {editingSheetSlot.period}교시
                                </span>
                                <span className="font-bold tabular-nums text-[var(--color-academy-ink)]">
                                    {DAY_LABEL[editingSheetSlot.dayKey]} {editingSheetSlot.startTime} ~ {editingSheetSlot.endTime}
                                </span>
                                {editingSheetSlot.gradeRange && (
                                    <span className="bg-[var(--color-academy-soft)] text-[var(--color-academy-muted)] text-xs px-2 py-0.5 rounded-full border border-[var(--color-academy-line)]">
                                        {editingSheetSlot.gradeRange}
                                    </span>
                                )}
                            </div>
                            <button type="button" aria-label="닫기" onClick={onCloseSheetSlot} className="academy-button-text academy-button-sm shrink-0">닫기</button>
                        </div>

                        <div className="p-6 space-y-4">
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                                <div>
                                    <label className="block text-xs font-medium text-[var(--color-academy-muted)] mb-1">
                                        표시 레이블<span className="font-normal text-[var(--color-academy-faint)] ml-1">(비워두면 &quot;n교시&quot; 자동)</span>
                                    </label>
                                    <input
                                        type="text"
                                        value={editingSheetState.label}
                                        onChange={(event) => onUpdateSlot(editingSheetSlot.slotKey, { label: event.target.value })}
                                        placeholder={`${editingSheetSlot.dayLabel} ${editingSheetSlot.period}교시`}
                                        className={INPUT}
                                    />
                                </div>

                                <div>
                                    <label className="block text-xs font-medium text-[var(--color-academy-muted)] mb-1">
                                        정원<span className="font-normal text-[var(--color-academy-faint)] ml-1">(기본 12명)</span>
                                    </label>
                                    <input
                                        type="number"
                                        min={1}
                                        max={50}
                                        value={editingSheetState.capacity}
                                        onChange={(event) => onUpdateSlot(editingSheetSlot.slotKey, { capacity: parseInt(event.target.value) || 12 })}
                                        className={INPUT}
                                    />
                                </div>

                                <div>
                                    <label className="block text-xs font-medium text-[var(--color-academy-muted)] mb-1">
                                        시작 시간 조정<span className="font-normal text-[var(--color-academy-faint)] ml-1">(기본: {editingSheetSlot.startTime})</span>
                                    </label>
                                    <div className="flex items-center gap-2">
                                        <input
                                            type="time"
                                            value={editingSheetState.startTimeOverride}
                                            onChange={(event) => onUpdateSlot(editingSheetSlot.slotKey, { startTimeOverride: event.target.value })}
                                            className={TIME_INPUT + " flex-1"}
                                        />
                                        {editingSheetState.startTimeOverride && (
                                            <button type="button" aria-label="시작 시간 조정 지우기" onClick={() => onUpdateSlot(editingSheetSlot.slotKey, { startTimeOverride: "" })} className="academy-button-text academy-button-sm shrink-0 whitespace-nowrap">지우기</button>
                                        )}
                                    </div>
                                </div>

                                <div>
                                    <label className="block text-xs font-medium text-[var(--color-academy-muted)] mb-1">
                                        종료 시간 조정<span className="font-normal text-[var(--color-academy-faint)] ml-1">(기본: {editingSheetSlot.endTime})</span>
                                    </label>
                                    <div className="flex items-center gap-2">
                                        <input
                                            type="time"
                                            value={editingSheetState.endTimeOverride}
                                            onChange={(event) => onUpdateSlot(editingSheetSlot.slotKey, { endTimeOverride: event.target.value })}
                                            className={TIME_INPUT + " flex-1"}
                                        />
                                        {editingSheetState.endTimeOverride && (
                                            <button type="button" aria-label="종료 시간 조정 지우기" onClick={() => onUpdateSlot(editingSheetSlot.slotKey, { endTimeOverride: "" })} className="academy-button-text academy-button-sm shrink-0 whitespace-nowrap">지우기</button>
                                        )}
                                    </div>
                                </div>

                                <div className="md:col-span-2">
                                    <label className="block text-xs font-medium text-[var(--color-academy-muted)] mb-1">
                                        메모 / 특이사항<span className="font-normal text-[var(--color-academy-faint)] ml-1">(공개 시간표에 표시)</span>
                                    </label>
                                    <input
                                        type="text"
                                        value={editingSheetState.note}
                                        onChange={(event) => onUpdateSlot(editingSheetSlot.slotKey, { note: event.target.value })}
                                        placeholder="예: 이번 주 보강 있음, 코치 변경 예정"
                                        className={INPUT}
                                    />
                                </div>

                                <div className="md:col-span-2">
                                    <label className="block text-xs font-medium text-[var(--color-academy-muted)] mb-1">
                                        담당 코치<span className="font-normal text-[var(--color-academy-faint)] ml-1">(공개 시간표 카드에 표시)</span>
                                    </label>
                                    <div className="flex items-center gap-3">
                                        <select
                                            value={editingSheetState.coachId}
                                            onChange={(event) => onUpdateSlot(editingSheetSlot.slotKey, { coachId: event.target.value })}
                                            className={INPUT + " flex-1"}
                                        >
                                            <option value="">-- 코치 미배정 --</option>
                                            {coaches.map((coach) => <option key={coach.id} value={coach.id}>{coach.name} ({coach.role})</option>)}
                                        </select>
                                        {editingSheetState.coachId && coachMap[editingSheetState.coachId]?.imageUrl && (
                                            <img src={coachMap[editingSheetState.coachId].imageUrl!} alt="" className="w-9 h-9 rounded-full object-cover border border-[var(--color-academy-line)] shrink-0" />
                                        )}
                                    </div>
                                    {coaches.length === 0 && (
                                        <p className="text-xs text-[var(--color-academy-warning)] mt-1">등록된 코치가 없습니다. <a href="/admin/coaches" className="underline">코치 추가</a></p>
                                    )}
                                </div>

                                {programs.length > 0 && (
                                    <div className="md:col-span-2">
                                        <label className="block text-xs font-medium text-[var(--color-academy-muted)] mb-1">
                                            프로그램 분류<span className="font-normal text-[var(--color-academy-faint)] ml-1">(공개 시간표 필터에 사용)</span>
                                        </label>
                                        <select
                                            value={editingSheetState.programId}
                                            onChange={(event) => onUpdateSlot(editingSheetSlot.slotKey, { programId: event.target.value })}
                                            className={INPUT}
                                        >
                                            <option value="">-- 프로그램 미설정 --</option>
                                            {programs.map((program) => <option key={program.id} value={program.id}>{program.name}</option>)}
                                        </select>
                                    </div>
                                )}
                            </div>

                            <label className="flex items-center gap-2 cursor-pointer select-none">
                                <input
                                    type="checkbox"
                                    checked={editingSheetState.isHidden}
                                    onChange={(event) => onUpdateSlot(editingSheetSlot.slotKey, { isHidden: event.target.checked })}
                                    className="w-4 h-4 rounded border-[var(--color-academy-line-input)] text-[var(--color-academy-ink)] focus:ring-[var(--color-academy-primary)]"
                                />
                                <span className="text-sm text-[var(--color-academy-ink)]">공개 시간표에서 숨기기</span>
                            </label>
                        </div>

                        <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 px-6 py-4 border-t border-[var(--color-academy-line)] bg-[var(--color-academy-soft)] rounded-b-2xl">
                            <div className="flex items-center gap-2">
                                {editingSheetState.error && <span className="text-xs text-[var(--color-academy-danger)]">{editingSheetState.error}</span>}
                                {editingSheetState.saved && !editingSheetState.dirty && <span className="text-xs text-[var(--color-academy-success)]">저장됨</span>}
                            </div>
                            <div className="flex items-center gap-2">
                                <button type="button" onClick={onCloseSheetSlot} className="academy-button-secondary">
                                    닫기
                                </button>
                                <button
                                    type="button"
                                    onClick={() => onSaveSheetSlot(editingSheetSlot)}
                                    disabled={pending || !editingSheetState.dirty}
                                    className="academy-button-primary"
                                >
                                    {pending ? "저장 중..." : "저장"}
                                </button>
                            </div>
                        </div>
                </AdminModal>
            )}

            {editingCustomSlot && (
                <AdminModal onClose={onCloseCustomEdit} titleId="custom-slot-edit-title" panelClassName="max-w-2xl">
                    <span id="custom-slot-edit-title" className="sr-only">커스텀 수업 수정</span>
                        <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--color-academy-line)]">
                            <div className="flex items-center gap-3">
                                <span className="bg-[var(--color-academy-neutral-soft)] text-[var(--color-academy-neutral)] text-xs px-2.5 py-1 rounded-full">커스텀</span>
                                <span className="font-bold text-[var(--color-academy-ink)]">수업 수정</span>
                            </div>
                            <button type="button" aria-label="닫기" onClick={onCloseCustomEdit} className="academy-button-text academy-button-sm shrink-0">닫기</button>
                        </div>

                        <div className="p-6">
                            <CustomSlotFormFields form={editCustomForm} onChange={onEditCustomFormChange} coaches={coaches} programs={programs} />
                        </div>

                        <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 px-6 py-4 border-t border-[var(--color-academy-line)] bg-[var(--color-academy-soft)] rounded-b-2xl">
                            <div>
                                {deletingCustomId === editingCustomSlot.id ? (
                                    <span className="flex flex-wrap items-center gap-2">
                                        <span className="text-xs text-[var(--color-academy-muted)]">정말 삭제할까요?</span>
                                    <button type="button" onClick={() => onConfirmDeleteCustom(editingCustomSlot.id)} disabled={customPending} className="academy-button-danger-solid academy-button-sm">삭제 확인</button>
                                        <button type="button" onClick={onCancelDeleteCustom} className="academy-button-text academy-button-sm">취소</button>
                                    </span>
                                ) : (
                                    <button type="button" onClick={() => onStartDeleteCustom(editingCustomSlot.id)} className="academy-button-danger academy-button-sm">
                                        삭제
                                    </button>
                                )}
                            </div>

                            <div className="flex items-center gap-2">
                                <button type="button" onClick={onCloseCustomEdit} className="academy-button-secondary">
                                    닫기
                                </button>
                                <button
                                    type="button"
                                    onClick={() => onSaveCustomEdit(editingCustomSlot.id)}
                                    disabled={customPending || !editCustomForm.label.trim()}
                                    className="academy-button-primary"
                                >
                                    {customPending ? "저장 중..." : "저장"}
                                </button>
                            </div>
                        </div>
                </AdminModal>
            )}

            {showSheetModal && (
                <AdminModal onClose={onCloseSheetUrl} titleId="sheet-url-title" panelClassName="max-w-xl">
                    <span id="sheet-url-title" className="sr-only">구글 시트 연동 관리</span>
                        <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--color-academy-line)]">
                            <span className="academy-section-title">구글시트 연동관리</span>
                            <button type="button" aria-label="닫기" onClick={onCloseSheetUrl} className="academy-button-text academy-button-sm shrink-0">닫기</button>
                        </div>
                        <div className="p-6 space-y-4">
                            <div className="bg-[var(--color-academy-success-soft)] border border-[var(--color-academy-line)] rounded-lg p-3 text-xs text-[var(--color-academy-success)]">
                                <p className="font-semibold mb-1">URL 확인 방법</p>
                                <p>구글시트 열기 → 주소창 URL 복사</p>
                                <p className="mt-1 font-mono bg-[var(--color-academy-success-soft)] px-2 py-1 rounded">spreadsheets/d/.../edit?gid=... 형태 그대로</p>
                                <p className="mt-1 font-semibold">시트가 &quot;링크가 있는 모든 사용자 - 뷰어&quot; 공개 설정이어야 합니다.</p>
                            </div>
                            <div className="bg-[var(--color-academy-soft)] border border-[var(--color-academy-line)] rounded-lg p-3 text-xs text-[var(--color-academy-ink)]">
                                <p className="font-semibold mb-1">운영 방식</p>
                                <p>저장된 시간표를 표시합니다. 구글시트 변경 내용은 “지금 동기화”를 눌러 가져오세요.</p>
                            </div>
                            <div>
                                <label className="block text-sm font-medium text-[var(--color-academy-muted)] mb-1.5">구글시트 URL</label>
                                <input
                                    type="url"
                                    value={sheetUrlInput}
                                    onChange={(event) => onSheetUrlChange(event.target.value)}
                                    placeholder="https://docs.google.com/spreadsheets/d/.../edit?gid=..."
                                    className="academy-input font-mono"
                                />
                            </div>
                            {sheetError && (
                                <p role="alert" className="text-sm text-[var(--color-academy-danger)] font-medium">
                                    {sheetError}
                                </p>
                            )}
                            {sheetSyncMessage && (
                                <p className="text-sm text-[var(--color-academy-success)] font-medium">
                                    {sheetSyncMessage}
                                </p>
                            )}
                            <div className="flex flex-wrap gap-2 pt-1">
                                {/* 이 창의 주 버튼은 «저장» 하나 — «지금 동기화»는 보조 버튼 */}
                                <button
                                    type="button"
                                    onClick={onSaveSheetUrl}
                                    disabled={sheetSaving || sheetSyncing}
                                    className="academy-button-primary"
                                >
                                    {sheetSaving ? "저장 중..." : sheetSaved ? "저장됨" : "저장"}
                                </button>
                                <button
                                    type="button"
                                    onClick={onSyncSheet}
                                    disabled={sheetSaving || sheetSyncing || !sheetUrlInput.trim()}
                                    className="academy-button-secondary"
                                >
                                    {sheetSyncing ? "동기화 중..." : "지금 동기화"}
                                </button>
                                <button type="button" onClick={onCloseSheetUrl} className="academy-button-text">
                                    취소
                                </button>
                                {sheetUrlInput && (
                                    <button type="button" onClick={onClearSheetUrl} className="academy-button-danger academy-button-sm ml-auto">
                                        URL 초기화
                                    </button>
                                )}
                            </div>
                        </div>
                </AdminModal>
            )}

            {isAddingCustom && (
                <AdminModal onClose={onCloseAddCustom} titleId="custom-slot-add-title" panelClassName="max-w-2xl">
                    <span id="custom-slot-add-title" className="sr-only">커스텀 수업 추가</span>
                        <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--color-academy-line)]">
                            <span className="academy-section-title">새 수업 추가</span>
                            <button type="button" aria-label="닫기" onClick={onCloseAddCustom} className="academy-button-text academy-button-sm shrink-0">닫기</button>
                        </div>
                        <div className="p-6">
                            <CustomSlotFormFields form={newCustomForm} onChange={onNewCustomFormChange} coaches={coaches} programs={programs} />
                        </div>
                        <div className="flex items-center justify-end px-6 py-4 border-t border-[var(--color-academy-line)] bg-[var(--color-academy-soft)] rounded-b-2xl gap-2">
                            <button type="button" onClick={onCloseAddCustom} className="academy-button-secondary">
                                취소
                            </button>
                            <button
                                type="button"
                                onClick={onSaveNewCustom}
                                disabled={customPending || !newCustomForm.label.trim()}
                                className="academy-button-primary"
                            >
                                {customPending ? "저장 중..." : "저장"}
                            </button>
                        </div>
                </AdminModal>
            )}
        </>
    );
}

function CustomSlotFormFields({
    form,
    onChange,
    coaches,
    programs,
}: {
    form: CustomSlotForm;
    onChange: (form: CustomSlotForm) => void;
    coaches: Coach[];
    programs: Program[];
}) {
    const patch = (next: Partial<CustomSlotForm>) => onChange({ ...form, ...next });

    return (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
                <label className="block text-xs font-medium text-[var(--color-academy-muted)] mb-1">요일 *</label>
                <select value={form.dayKey} onChange={(event) => patch({ dayKey: event.target.value })} className={INPUT}>
                    {DAY_OPTIONS.map((day) => <option key={day.key} value={day.key}>{day.label}</option>)}
                </select>
            </div>
            <div>
                <label className="block text-xs font-medium text-[var(--color-academy-muted)] mb-1">표시 레이블 *</label>
                <input type="text" value={form.label} onChange={(event) => patch({ label: event.target.value })} placeholder="예: 성인반 A" className={INPUT} />
            </div>
            <div>
                <label className="block text-xs font-medium text-[var(--color-academy-muted)] mb-1">시작 시간 *</label>
                <input type="time" value={form.startTime} onChange={(event) => patch({ startTime: event.target.value })} className={TIME_INPUT + " w-full"} />
            </div>
            <div>
                <label className="block text-xs font-medium text-[var(--color-academy-muted)] mb-1">종료 시간 *</label>
                <input type="time" value={form.endTime} onChange={(event) => patch({ endTime: event.target.value })} className={TIME_INPUT + " w-full"} />
            </div>
            <div>
                <label className="block text-xs font-medium text-[var(--color-academy-muted)] mb-1">학년 범위</label>
                <input type="text" value={form.gradeRange} onChange={(event) => patch({ gradeRange: event.target.value })} placeholder="예: 초4~중1" className={INPUT} />
            </div>
            <div>
                <label className="block text-xs font-medium text-[var(--color-academy-muted)] mb-1">정원</label>
                <input type="number" min={1} max={50} value={form.capacity} onChange={(event) => patch({ capacity: parseInt(event.target.value) || 12 })} className={INPUT} />
            </div>
            <div>
                <label className="block text-xs font-medium text-[var(--color-academy-muted)] mb-1">현재 수강 인원</label>
                <input type="number" min={0} value={form.enrolled} onChange={(event) => patch({ enrolled: parseInt(event.target.value) || 0 })} className={INPUT} />
            </div>
            <div>
                <label className="block text-xs font-medium text-[var(--color-academy-muted)] mb-1">담당 코치</label>
                <select value={form.coachId} onChange={(event) => patch({ coachId: event.target.value })} className={INPUT}>
                    <option value="">-- 코치 미배정 --</option>
                    {coaches.map((coach) => <option key={coach.id} value={coach.id}>{coach.name} ({coach.role})</option>)}
                </select>
            </div>
            {programs.length > 0 && (
                <div>
                    <label className="block text-xs font-medium text-[var(--color-academy-muted)] mb-1">프로그램 분류</label>
                    <select value={form.programId} onChange={(event) => patch({ programId: event.target.value })} className={INPUT}>
                        <option value="">-- 프로그램 미설정 --</option>
                        {programs.map((program) => <option key={program.id} value={program.id}>{program.name}</option>)}
                    </select>
                </div>
            )}
            <div className="md:col-span-2">
                <label className="block text-xs font-medium text-[var(--color-academy-muted)] mb-1">메모 / 특이사항</label>
                <input type="text" value={form.note} onChange={(event) => patch({ note: event.target.value })} placeholder="예: 이번 주 보강 있음" className={INPUT} />
            </div>
            <div className="md:col-span-2">
                <label className="flex items-center gap-2 cursor-pointer select-none">
                    <input type="checkbox" checked={form.isHidden} onChange={(event) => patch({ isHidden: event.target.checked })} className="w-4 h-4 rounded border-[var(--color-academy-line-input)]" />
                    <span className="text-sm text-[var(--color-academy-ink)]">공개 시간표에서 숨기기</span>
                </label>
            </div>
        </div>
    );
}
