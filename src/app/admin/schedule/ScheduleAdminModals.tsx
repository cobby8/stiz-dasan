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

const INPUT = "w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm dark:text-white focus:ring-2 focus:ring-brand-orange-500 dark:focus:ring-brand-neon-lime focus:border-brand-orange-500 dark:border-brand-neon-lime bg-gray-50 focus:bg-white dark:focus:bg-gray-700 dark:bg-gray-800";
const TIME_INPUT = "border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm dark:text-white focus:ring-2 focus:ring-brand-orange-500 dark:focus:ring-brand-neon-lime focus:border-brand-orange-500 dark:border-brand-neon-lime bg-gray-50 focus:bg-white dark:focus:bg-gray-700 dark:bg-gray-800";

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
                        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 dark:border-gray-800">
                            <div className="flex items-center gap-3">
                                <span className="bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-200 text-xs font-bold px-2.5 py-1 rounded-full">
                                    {editingSheetSlot.period}교시
                                </span>
                                <span className="font-bold text-gray-800 dark:text-gray-100">
                                    {DAY_LABEL[editingSheetSlot.dayKey]} {editingSheetSlot.startTime} ~ {editingSheetSlot.endTime}
                                </span>
                                {editingSheetSlot.gradeRange && (
                                    <span className="bg-blue-50 text-blue-700 text-xs font-bold px-2 py-0.5 rounded-full border border-blue-200 dark:border-blue-500/30 dark:bg-blue-500/10 dark:text-blue-300">
                                        {editingSheetSlot.gradeRange}
                                    </span>
                                )}
                            </div>
                            <button onClick={onCloseSheetSlot} className="text-gray-400 hover:text-gray-600 dark:text-gray-300">
                                <span className="material-symbols-outlined" style={{ fontSize: "22px" }}>close</span>
                            </button>
                        </div>

                        <div className="p-6 space-y-4">
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                                <div>
                                    <label className="block text-xs font-bold text-gray-600 dark:text-gray-300 mb-1">
                                        표시 레이블<span className="font-normal text-gray-400 ml-1">(비워두면 &quot;n교시&quot; 자동)</span>
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
                                    <label className="block text-xs font-bold text-gray-600 dark:text-gray-300 mb-1">
                                        정원<span className="font-normal text-gray-400 ml-1">(기본 12명)</span>
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
                                    <label className="block text-xs font-bold text-gray-600 dark:text-gray-300 mb-1">
                                        시작 시간 조정<span className="font-normal text-gray-400 ml-1">(기본: {editingSheetSlot.startTime})</span>
                                    </label>
                                    <div className="flex items-center gap-2">
                                        <input
                                            type="time"
                                            value={editingSheetState.startTimeOverride}
                                            onChange={(event) => onUpdateSlot(editingSheetSlot.slotKey, { startTimeOverride: event.target.value })}
                                            className={TIME_INPUT + " flex-1"}
                                        />
                                        {editingSheetState.startTimeOverride && (
                                            <button type="button" onClick={() => onUpdateSlot(editingSheetSlot.slotKey, { startTimeOverride: "" })} className="text-gray-400 hover:text-gray-600 dark:text-gray-300 shrink-0">
                                                <span className="material-symbols-outlined" style={{ fontSize: "18px" }}>close</span>
                                            </button>
                                        )}
                                    </div>
                                </div>

                                <div>
                                    <label className="block text-xs font-bold text-gray-600 dark:text-gray-300 mb-1">
                                        종료 시간 조정<span className="font-normal text-gray-400 ml-1">(기본: {editingSheetSlot.endTime})</span>
                                    </label>
                                    <div className="flex items-center gap-2">
                                        <input
                                            type="time"
                                            value={editingSheetState.endTimeOverride}
                                            onChange={(event) => onUpdateSlot(editingSheetSlot.slotKey, { endTimeOverride: event.target.value })}
                                            className={TIME_INPUT + " flex-1"}
                                        />
                                        {editingSheetState.endTimeOverride && (
                                            <button type="button" onClick={() => onUpdateSlot(editingSheetSlot.slotKey, { endTimeOverride: "" })} className="text-gray-400 hover:text-gray-600 dark:text-gray-300 shrink-0">
                                                <span className="material-symbols-outlined" style={{ fontSize: "18px" }}>close</span>
                                            </button>
                                        )}
                                    </div>
                                </div>

                                <div className="md:col-span-2">
                                    <label className="block text-xs font-bold text-gray-600 dark:text-gray-300 mb-1">
                                        메모 / 특이사항<span className="font-normal text-gray-400 ml-1">(공개 시간표에 표시)</span>
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
                                    <label className="block text-xs font-bold text-gray-600 dark:text-gray-300 mb-1">
                                        담당 코치<span className="font-normal text-gray-400 ml-1">(공개 시간표 카드에 표시)</span>
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
                                            <img src={coachMap[editingSheetState.coachId].imageUrl!} alt="" className="w-9 h-9 rounded-full object-cover border border-gray-200 dark:border-gray-700 shrink-0" />
                                        )}
                                    </div>
                                    {coaches.length === 0 && (
                                        <p className="text-xs text-amber-600 mt-1 dark:text-amber-300">등록된 코치가 없습니다. <a href="/admin/coaches" className="underline">코치 추가</a></p>
                                    )}
                                </div>

                                {programs.length > 0 && (
                                    <div className="md:col-span-2">
                                        <label className="block text-xs font-bold text-gray-600 dark:text-gray-300 mb-1">
                                            프로그램 분류<span className="font-normal text-gray-400 ml-1">(공개 시간표 필터에 사용)</span>
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
                                    className="w-4 h-4 rounded border-gray-300 text-brand-orange-500 dark:text-brand-neon-lime focus:ring-brand-orange-500 dark:focus:ring-brand-neon-lime"
                                />
                                <span className="text-sm text-gray-600 dark:text-gray-300 font-medium">공개 시간표에서 숨기기</span>
                            </label>
                        </div>

                        <div className="flex items-center justify-between px-6 py-4 border-t border-gray-100 dark:border-gray-800 bg-gray-50 dark:bg-gray-900 rounded-b-2xl">
                            <div className="flex items-center gap-2">
                                {editingSheetState.error && <span className="text-xs text-red-500 flex items-center gap-1"><span className="material-symbols-outlined" style={{ fontSize: "14px" }}>error</span>{editingSheetState.error}</span>}
                                {editingSheetState.saved && !editingSheetState.dirty && <span className="text-xs text-green-600 font-medium flex items-center gap-1 dark:text-emerald-300"><span className="material-symbols-outlined" style={{ fontSize: "14px" }}>check_circle</span>저장됨</span>}
                            </div>
                            <div className="flex items-center gap-2">
                                <button onClick={onCloseSheetSlot} className="bg-white dark:bg-gray-800 border border-gray-300 text-gray-600 dark:text-gray-300 text-sm font-medium px-4 py-2 rounded-lg hover:bg-gray-100 dark:bg-gray-800 transition">
                                    닫기
                                </button>
                                <button
                                    onClick={() => onSaveSheetSlot(editingSheetSlot)}
                                    disabled={pending || !editingSheetState.dirty}
                                    className="bg-brand-navy-900 text-white text-sm font-bold px-5 py-2 rounded-lg hover:bg-gray-800 transition disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5"
                                >
                                    <span className="material-symbols-outlined" style={{ fontSize: "16px" }}>save</span>
                                    {pending ? "저장 중..." : "저장"}
                                </button>
                            </div>
                        </div>
                </AdminModal>
            )}

            {editingCustomSlot && (
                <AdminModal onClose={onCloseCustomEdit} titleId="custom-slot-edit-title" panelClassName="max-w-2xl">
                    <span id="custom-slot-edit-title" className="sr-only">커스텀 수업 수정</span>
                        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 dark:border-gray-800">
                            <div className="flex items-center gap-3">
                                <span className="bg-brand-orange-500 dark:bg-brand-neon-lime dark:text-brand-navy-900 text-white text-xs font-bold px-2.5 py-1 rounded-full">커스텀</span>
                                <span className="font-bold text-gray-800 dark:text-gray-100">수업 수정</span>
                            </div>
                            <button onClick={onCloseCustomEdit} className="text-gray-400 hover:text-gray-600 dark:text-gray-300">
                                <span className="material-symbols-outlined" style={{ fontSize: "22px" }}>close</span>
                            </button>
                        </div>

                        <div className="p-6">
                            <CustomSlotFormFields form={editCustomForm} onChange={onEditCustomFormChange} coaches={coaches} programs={programs} />
                        </div>

                        <div className="flex items-center justify-between px-6 py-4 border-t border-gray-100 dark:border-gray-800 bg-gray-50 dark:bg-gray-900 rounded-b-2xl">
                            <div>
                                {deletingCustomId === editingCustomSlot.id ? (
                                    <span className="flex items-center gap-2">
                                        <span className="text-xs text-gray-500 dark:text-gray-400">정말 삭제할까요?</span>
                                    <button onClick={() => onConfirmDeleteCustom(editingCustomSlot.id)} disabled={customPending} className="text-xs text-red-600 hover:text-red-800 font-bold dark:text-red-300 dark:hover:text-red-200">삭제 확인</button>
                                        <button onClick={onCancelDeleteCustom} className="text-xs text-gray-500 hover:text-gray-700 dark:text-gray-200">취소</button>
                                    </span>
                                ) : (
                                    <button onClick={() => onStartDeleteCustom(editingCustomSlot.id)} className="flex items-center gap-1 text-sm text-red-400 hover:text-red-600 font-medium transition-colors">
                                        <span className="material-symbols-outlined" style={{ fontSize: "16px" }}>delete</span>
                                        삭제
                                    </button>
                                )}
                            </div>

                            <div className="flex items-center gap-2">
                                <button onClick={onCloseCustomEdit} className="bg-white dark:bg-gray-800 border border-gray-300 text-gray-600 dark:text-gray-300 text-sm font-medium px-4 py-2 rounded-lg hover:bg-gray-100 dark:bg-gray-800 transition">
                                    닫기
                                </button>
                                <button
                                    onClick={() => onSaveCustomEdit(editingCustomSlot.id)}
                                    disabled={customPending || !editCustomForm.label.trim()}
                                    className="bg-brand-navy-900 text-white text-sm font-bold px-5 py-2 rounded-lg hover:bg-gray-800 transition disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5"
                                >
                                    <span className="material-symbols-outlined" style={{ fontSize: "16px" }}>save</span>
                                    {customPending ? "저장 중..." : "저장"}
                                </button>
                            </div>
                        </div>
                </AdminModal>
            )}

            {showSheetModal && (
                <AdminModal onClose={onCloseSheetUrl} titleId="sheet-url-title" panelClassName="max-w-xl">
                    <span id="sheet-url-title" className="sr-only">구글 시트 연동 관리</span>
                        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 dark:border-gray-800">
                            <span className="font-bold text-gray-800 dark:text-gray-100 text-base flex items-center gap-2">
                                <span className="material-symbols-outlined" style={{ fontSize: "20px" }}>link</span>
                                구글시트 연동관리
                            </span>
                            <button onClick={onCloseSheetUrl} className="text-gray-400 hover:text-gray-600 dark:text-gray-300">
                                <span className="material-symbols-outlined" style={{ fontSize: "22px" }}>close</span>
                            </button>
                        </div>
                        <div className="p-6 space-y-4">
                            <div className="bg-green-50 border border-green-200 rounded-lg p-3 text-xs text-green-800 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300">
                                <p className="font-bold mb-1">URL 확인 방법</p>
                                <p>구글시트 열기 → 주소창 URL 복사</p>
                                <p className="mt-1 font-mono bg-green-100 px-2 py-1 rounded dark:bg-emerald-500/10 dark:text-emerald-200">spreadsheets/d/.../edit?gid=... 형태 그대로</p>
                                <p className="mt-1 font-bold">시트가 &quot;링크가 있는 모든 사용자 - 뷰어&quot; 공개 설정이어야 합니다.</p>
                            </div>
                            <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 text-xs text-blue-800 dark:border-blue-500/30 dark:bg-blue-500/10 dark:text-blue-300">
                                <p className="font-bold mb-1">운영 방식</p>
                                <p>저장된 시간표를 표시합니다. 구글시트 변경 내용은 “지금 동기화”를 눌러 가져오세요.</p>
                            </div>
                            <div>
                                <label className="block text-sm font-bold text-gray-700 dark:text-gray-200 mb-1.5">구글시트 URL</label>
                                <input
                                    type="url"
                                    value={sheetUrlInput}
                                    onChange={(event) => onSheetUrlChange(event.target.value)}
                                    placeholder="https://docs.google.com/spreadsheets/d/.../edit?gid=..."
                                    className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm font-mono bg-gray-50 focus:bg-white dark:focus:bg-gray-700 dark:bg-gray-800 focus:ring-2 focus:ring-brand-orange-500 dark:focus:ring-brand-neon-lime focus:border-brand-orange-500 dark:border-brand-neon-lime"
                                />
                            </div>
                            {sheetError && (
                                <p className="text-sm text-red-600 font-medium flex items-center gap-1 dark:text-red-300">
                                    <span className="material-symbols-outlined" style={{ fontSize: "16px" }}>warning</span>
                                    {sheetError}
                                </p>
                            )}
                            {sheetSyncMessage && (
                                <p className="text-sm text-green-700 font-medium flex items-center gap-1 dark:text-emerald-300">
                                    <span className="material-symbols-outlined" style={{ fontSize: "16px" }}>check_circle</span>
                                    {sheetSyncMessage}
                                </p>
                            )}
                            <div className="flex flex-wrap gap-2 pt-1">
                                <button
                                    onClick={onSaveSheetUrl}
                                    disabled={sheetSaving || sheetSyncing}
                                    className="bg-brand-orange-500 dark:bg-brand-neon-lime dark:text-brand-navy-900 hover:bg-orange-600 text-white text-sm font-bold px-5 py-2.5 rounded-lg transition disabled:opacity-40 flex items-center gap-2"
                                >
                                    {sheetSaving ? "저장 중..." : sheetSaved ? "저장됨" : "저장"}
                                </button>
                                <button
                                    onClick={onSyncSheet}
                                    disabled={sheetSaving || sheetSyncing || !sheetUrlInput.trim()}
                                    className="bg-brand-navy-900 hover:bg-brand-navy-800 text-white text-sm font-bold px-5 py-2.5 rounded-lg transition disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-2"
                                >
                                    <span className="material-symbols-outlined" style={{ fontSize: "16px" }}>sync</span>
                                    {sheetSyncing ? "동기화 중..." : "지금 동기화"}
                                </button>
                                <button onClick={onCloseSheetUrl} className="bg-white dark:bg-gray-800 border border-gray-300 text-gray-600 dark:text-gray-300 text-sm font-medium px-4 py-2.5 rounded-lg hover:bg-gray-50 dark:bg-gray-900 transition">
                                    취소
                                </button>
                                {sheetUrlInput && (
                                    <button onClick={onClearSheetUrl} className="ml-auto text-xs text-red-400 hover:text-red-600 font-medium">
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
                        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 dark:border-gray-800">
                            <span className="font-bold text-gray-800 dark:text-gray-100 text-base flex items-center gap-2">
                                <span className="material-symbols-outlined text-brand-orange-500 dark:text-brand-neon-lime" style={{ fontSize: "20px" }}>add_circle</span>
                                새 수업 추가
                            </span>
                            <button onClick={onCloseAddCustom} className="text-gray-400 hover:text-gray-600 dark:text-gray-300">
                                <span className="material-symbols-outlined" style={{ fontSize: "22px" }}>close</span>
                            </button>
                        </div>
                        <div className="p-6">
                            <CustomSlotFormFields form={newCustomForm} onChange={onNewCustomFormChange} coaches={coaches} programs={programs} />
                        </div>
                        <div className="flex items-center justify-end px-6 py-4 border-t border-gray-100 dark:border-gray-800 bg-gray-50 dark:bg-gray-900 rounded-b-2xl gap-2">
                            <button onClick={onCloseAddCustom} className="bg-white dark:bg-gray-800 border border-gray-300 text-gray-600 dark:text-gray-300 text-sm font-medium px-4 py-2 rounded-lg hover:bg-gray-100 dark:bg-gray-800 transition">
                                취소
                            </button>
                            <button
                                onClick={onSaveNewCustom}
                                disabled={customPending || !newCustomForm.label.trim()}
                                className="bg-brand-orange-500 dark:bg-brand-neon-lime dark:text-brand-navy-900 hover:bg-orange-600 text-white text-sm font-bold px-5 py-2 rounded-lg transition disabled:opacity-40 flex items-center gap-1.5"
                            >
                                <span className="material-symbols-outlined" style={{ fontSize: "16px" }}>add</span>
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
                <label className="block text-xs font-bold text-gray-600 dark:text-gray-300 mb-1">요일 *</label>
                <select value={form.dayKey} onChange={(event) => patch({ dayKey: event.target.value })} className={INPUT}>
                    {DAY_OPTIONS.map((day) => <option key={day.key} value={day.key}>{day.label}</option>)}
                </select>
            </div>
            <div>
                <label className="block text-xs font-bold text-gray-600 dark:text-gray-300 mb-1">표시 레이블 *</label>
                <input type="text" value={form.label} onChange={(event) => patch({ label: event.target.value })} placeholder="예: 성인반 A" className={INPUT} />
            </div>
            <div>
                <label className="block text-xs font-bold text-gray-600 dark:text-gray-300 mb-1">시작 시간 *</label>
                <input type="time" value={form.startTime} onChange={(event) => patch({ startTime: event.target.value })} className={TIME_INPUT + " w-full"} />
            </div>
            <div>
                <label className="block text-xs font-bold text-gray-600 dark:text-gray-300 mb-1">종료 시간 *</label>
                <input type="time" value={form.endTime} onChange={(event) => patch({ endTime: event.target.value })} className={TIME_INPUT + " w-full"} />
            </div>
            <div>
                <label className="block text-xs font-bold text-gray-600 dark:text-gray-300 mb-1">학년 범위</label>
                <input type="text" value={form.gradeRange} onChange={(event) => patch({ gradeRange: event.target.value })} placeholder="예: 초4~중1" className={INPUT} />
            </div>
            <div>
                <label className="block text-xs font-bold text-gray-600 dark:text-gray-300 mb-1">정원</label>
                <input type="number" min={1} max={50} value={form.capacity} onChange={(event) => patch({ capacity: parseInt(event.target.value) || 12 })} className={INPUT} />
            </div>
            <div>
                <label className="block text-xs font-bold text-gray-600 dark:text-gray-300 mb-1">현재 수강 인원</label>
                <input type="number" min={0} value={form.enrolled} onChange={(event) => patch({ enrolled: parseInt(event.target.value) || 0 })} className={INPUT} />
            </div>
            <div>
                <label className="block text-xs font-bold text-gray-600 dark:text-gray-300 mb-1">담당 코치</label>
                <select value={form.coachId} onChange={(event) => patch({ coachId: event.target.value })} className={INPUT}>
                    <option value="">-- 코치 미배정 --</option>
                    {coaches.map((coach) => <option key={coach.id} value={coach.id}>{coach.name} ({coach.role})</option>)}
                </select>
            </div>
            {programs.length > 0 && (
                <div>
                    <label className="block text-xs font-bold text-gray-600 dark:text-gray-300 mb-1">프로그램 분류</label>
                    <select value={form.programId} onChange={(event) => patch({ programId: event.target.value })} className={INPUT}>
                        <option value="">-- 프로그램 미설정 --</option>
                        {programs.map((program) => <option key={program.id} value={program.id}>{program.name}</option>)}
                    </select>
                </div>
            )}
            <div className="md:col-span-2">
                <label className="block text-xs font-bold text-gray-600 dark:text-gray-300 mb-1">메모 / 특이사항</label>
                <input type="text" value={form.note} onChange={(event) => patch({ note: event.target.value })} placeholder="예: 이번 주 보강 있음" className={INPUT} />
            </div>
            <div className="md:col-span-2">
                <label className="flex items-center gap-2 cursor-pointer select-none">
                    <input type="checkbox" checked={form.isHidden} onChange={(event) => patch({ isHidden: event.target.checked })} className="w-4 h-4 rounded border-gray-300" />
                    <span className="text-sm text-gray-600 dark:text-gray-300 font-medium">공개 시간표에서 숨기기</span>
                </label>
            </div>
        </div>
    );
}
