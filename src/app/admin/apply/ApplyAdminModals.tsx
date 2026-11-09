"use client";
import { adminErrorText } from "@/components/admin/adminDisplayText";

import { formatPhoneInput, formatClassLabel } from "@/lib/application-display-format";
import { formatEnrollmentMonthsShort, formatEnrollmentStartOn } from "@/lib/enrollment-application-display";
import type { EnrollmentShuttleProgress } from "@/lib/enrollment/shuttle-progress";
import EnrollmentShuttleProgressView from "./EnrollmentShuttleProgressView";

import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import {
    approveEnrollApplication,
    cancelEnrollApplication,
    rejectEnrollApplication,
    updateEnrollApplication,
    getEnrollmentParentCandidates,
    reopenEnrollApplicationForReview,
} from "@/app/actions/admin";
import AdminModal from "@/components/admin/AdminModal";
import ListDetailPanel from "@/components/admin/list/ListDetailPanel";
import { REQUEST_TONE, statusBadgeClass } from "@/lib/ui/statusTones";

interface EnrollApplication {
    id: string;
    trialLeadId: string | null;
    childName: string;
    childBirthDate: string;
    childGender: string | null;
    childGrade: string | null;
    childSchool: string | null;
    childPhone: string | null;
    parentName: string;
    parentPhone: string;
    parentRelation: string | null;
    address: string | null;
    enrollmentMonths: string | null;
    requestedStartOn?: string | null;
    shuttleProgress?: EnrollmentShuttleProgress | null;
    preferredSlotKeys: string | null;
    assignedClassId: string | null;
    basketballExp: string | null;
    uniformSize: string | null;
    shuttleNeeded: boolean;
    shuttlePickup: string | null;
    shuttleTime: string | null;
    shuttleDropoff: string | null;
    paymentMethod: string | null;
    referralSource: string | null;
    memo: string | null;
    applicationNoticeConfirmed: boolean;
    shuttleNoticeConfirmed: boolean;
    status: string;
    processedAt: string | null;
    processedNote: string | null;
    convertedStudentId: string | null;
    createdAt: string;
    updatedAt: string;
    latestContactAction: string | null;
    latestContactNote: string | null;
    latestContactAt: string | null;
    latestContactBy: string | null;
    openFollowUpAt: string | null;
    openFollowUpNote: string | null;
}

interface ClassInfo {
    id: string;
    name: string;
    dayOfWeek: string;
    startTime: string;
    endTime: string;
    capacity: number;
    slotKey: string | null;
    program: { id: string; name: string } | null;
}

interface ApplyAdminModalsProps {
    approveApp: EnrollApplication | null;
    rejectApp: EnrollApplication | null;
    detailApp: EnrollApplication | null;
    editApp: EnrollApplication | null;
    cancelApp: EnrollApplication | null;
    reopenApp?: EnrollApplication | null;
    classes: ClassInfo[];
    onCloseApprove: () => void;
    onCloseReject: () => void;
    onCloseDetail: () => void;
    onCloseEdit: () => void;
    onCloseCancel: () => void;
    onCloseReopen?: () => void;
    onSaved: () => Promise<void> | void;
    onFeedback: (type: "success" | "error", message: string) => void;
}

// 신청 상태색 = 공용 지도(statusTones) — 목록(ApplyAdminClient)과 같은 색: 대기 주의 · 승인 정상 · 반려 위험 · 취소 중립
const STATUS_CONFIG: Record<string, { label: string; color: string; icon: string }> = {
    PENDING: { label: "대기중", color: statusBadgeClass(REQUEST_TONE.PENDING), icon: "hourglass_top" },
    APPROVED: { label: "승인완료", color: statusBadgeClass(REQUEST_TONE.APPROVED), icon: "check_circle" },
    REJECTED: { label: "반려", color: statusBadgeClass(REQUEST_TONE.REJECTED), icon: "cancel" },
    CANCELLED: { label: "취소", color: statusBadgeClass(REQUEST_TONE.CANCELLED), icon: "block" },
};

const CONTACT_ACTION_LABELS: Record<string, string> = {
    CONTACTED: "연락 완료",
    NO_ANSWER: "부재",
    FOLLOW_UP: "재연락 예약",
    MEMO: "상담 메모",
    UPDATED: "내용 수정",
    SCHEDULED: "일정 변경",
    CANCELLED: "취소 처리",
};

const SOURCE_LABELS: Record<string, string> = {
    REFERRAL: "지인소개",
    PASSBY: "지나가다 발견",
    NAVER_SEARCH: "네이버 키워드 검색",
    NAVER_BLOG: "네이버 블로그",
    PORTAL_OTHER: "기타 포털검색",
    INSTAGRAM: "인스타그램",
    SOOMGO: "숨고",
    EXISTING_STUDENT: "기존 수강생",
    OTHER: "기타",
    WEBSITE: "홈페이지",
    NAVER: "네이버",
    FLYER: "전단지",
};

const DAY_LABELS: Record<string, string> = {
    Mon: "월",
    Tue: "화",
    Wed: "수",
    Thu: "목",
    Fri: "금",
    Sat: "토",
    Sun: "일",
};

const REJECT_REASON_OPTIONS = ["정원 마감", "희망 시간대 불일치", "연락 불가", "셔틀 동선 확인 필요"];
const CANCEL_REASON_OPTIONS = ["학부모 요청", "일정 변경", "중복 신청", "연락 불가", "기타"];
const MODAL_INPUT_CLASS = "w-full rounded-lg border border-[var(--color-academy-line-input)] bg-white px-3 py-2 text-sm text-[var(--color-academy-ink)] focus:outline-none focus:ring-2 focus:ring-[var(--color-academy-primary)]";

function phoneHref(phone: string) {
    const digits = phone.replace(/\D/g, "");
    return digits ? `tel:${digits}` : undefined;
}

function joinSummaryLines(lines: Array<string | null | undefined | false>) {
    return lines.filter(Boolean).join("\n");
}

async function copyTextToClipboard(text: string) {
    if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return;
    }

    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    textarea.remove();
}

function formatDetailDate(dateStr: string | null) {
    if (!dateStr) return "-";
    const date = new Date(dateStr);
    return `${date.getFullYear()}.${String(date.getMonth() + 1).padStart(2, "0")}.${String(date.getDate()).padStart(2, "0")}`;
}

function formatDetailDateTime(dateStr: string | null) {
    if (!dateStr) return "-";
    const date = new Date(dateStr);
    if (Number.isNaN(date.getTime())) return "-";
    return `${formatDetailDate(dateStr)} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function dateInputValue(dateStr: string | null) {
    if (!dateStr) return "";
    const date = new Date(dateStr);
    if (Number.isNaN(date.getTime())) return "";
    return date.toISOString().slice(0, 10);
}

function FormField({ label, children }: { label: string; children: ReactNode }) {
    return (
        <label className="block text-sm font-medium text-[var(--color-academy-muted)]">
            <span className="mb-1 block">{label}</span>
            {children}
        </label>
    );
}

function InfoRow({ label, value }: { label: string; value: string | null | undefined | boolean }) {
    if (value === null || value === undefined || value === "") return null;
    const displayValue = typeof value === "boolean" ? (value ? "네" : "아니오") : value;
    return (
        <div className="flex items-start gap-2 text-sm">
            <span className="text-[var(--color-academy-muted)] min-w-[80px] flex-shrink-0">{label}</span>
            <span className="text-[var(--color-academy-ink)] font-medium">{displayValue}</span>
        </div>
    );
}

function formatPreferredSlots(slotKeys: string | null, classes: ClassInfo[]) {
    if (!slotKeys) return null;
    const keys = slotKeys.split(",").map((key) => key.trim()).filter(Boolean);
    if (keys.length === 0) return null;

    const classesBySlotKey = new Map<string, ClassInfo>();
    classes.forEach((classInfo) => {
        if (classInfo.slotKey) classesBySlotKey.set(classInfo.slotKey, classInfo);
    });

    const labels: string[] = [];
    let unknownCount = 0;

    keys.forEach((key) => {
        const classInfo = classesBySlotKey.get(key);
        if (classInfo) {
            labels.push(formatClassLabel(classInfo));
        } else {
            unknownCount += 1;
        }
    });

    if (labels.length === 0) return "희망 시간 확인 필요";
    if (unknownCount > 0) return `${labels.join(" / ")} 외 ${unknownCount}개 시간 확인 필요`;
    return labels.join(" / ");
}

function formatApplicationCopySummary(app: EnrollApplication, preferredSlotLabel: string | null) {
    const childInfo = [app.childGrade, app.childSchool, app.childGender].filter(Boolean).join(" / ");
    const parentInfo = `${app.parentName}${app.parentRelation ? ` (${app.parentRelation})` : ""}`;
    const shuttleInfo = app.shuttleNeeded
        ? [app.shuttlePickup, app.shuttleDropoff, app.shuttleTime].filter(Boolean).join(" / ") || "필요"
        : null;

    return joinSummaryLines([
        `[수강신청] ${app.childName}`,
        childInfo ? `학생: ${childInfo}` : null,
        `보호자: ${parentInfo}`,
        `연락처: ${app.parentPhone}`,
        `수강 개시일: ${formatEnrollmentStartOn(app.requestedStartOn)}`,
        !app.requestedStartOn && app.enrollmentMonths ? `기존 신청 월: ${formatEnrollmentMonthsShort(app.enrollmentMonths)}` : null,
        preferredSlotLabel ? `희망 시간: ${preferredSlotLabel}` : null,
        app.basketballExp ? `농구 경험: ${app.basketballExp}` : null,
        shuttleInfo ? `셔틀: ${shuttleInfo}` : null,
        app.memo ? `메모: ${app.memo}` : null,
    ]);
}

export default function ApplyAdminModals({
    approveApp,
    rejectApp,
    detailApp,
    editApp,
    cancelApp,
    reopenApp,
    classes,
    onCloseApprove,
    onCloseReject,
    onCloseDetail,
    onCloseEdit,
    onCloseCancel,
    onCloseReopen,
    onSaved,
    onFeedback,
}: ApplyAdminModalsProps) {
    const [busy, setBusy] = useState(false);
    const [approvalError, setApprovalError] = useState("");
    const [reopenError, setReopenError] = useState("");

    async function handleApprove(classIds: string[], note: string, parentUserId?: string, startOn?: string, force = false) {
        if (!approveApp) return;
        setBusy(true);
        setApprovalError("");
        try {
            // 반환값은 3가지 형태(성공 / 정원경고 / 학생모호) 중 하나 — 형태를 명시해 안전하게 분기한다.
            const result = (await approveEnrollApplication(approveApp.id, {
                classIds,
                processedNote: note,
                force,
                parentUserId,
                startOn,
            })) as
                | { approved: true; sms: { parentFailed: boolean; adminFailed: number; coachFailed: number; errors: string[] } }
                | { ok: false; code: "INVALID_CLASSES" | "INVALID_START_DATE"; message: string }
                | { ok: false; code: "PARENT_SELECTION_REQUIRED"; message: string }
                | { ok: false; code: "CAPACITY_WARNING"; classes: { classId: string; name: string; current: number; capacity: number }[] }
                | { ok: false; code: "STUDENT_AMBIGUOUS"; candidates: { id: string; name: string; birthDate: string | null }[] };

            if ("ok" in result && (result.code === "INVALID_CLASSES" || result.code === "INVALID_START_DATE" || result.code === "PARENT_SELECTION_REQUIRED")) {
                setApprovalError(result.message);
                return;
            }
            // A. 정원 초과 경고 — 하드 차단이 아니라 관리자에게 재확인 후 강행(force) 여부를 묻는다.
            if (result && "ok" in result && result.ok === false && result.code === "CAPACITY_WARNING") {
                const lines = (result.classes ?? [])
                    .map((c) => `· ${c.name} (${c.current}/${c.capacity})`)
                    .join("\n");
                const proceed = window.confirm(
                    `다음 반은 이미 정원을 채웠습니다.\n${lines}\n\n그래도 계속 배정할까요?`,
                );
                setBusy(false);
                if (proceed) {
                    // 관리자가 확인했으므로 force:true로 재호출.
                    await handleApprove(classIds, note, parentUserId, startOn, true);
                }
                return;
            }

            // B. 학생 모호(동명 형제) — 자동 선택이 위험하므로, 관리자에게 생년으로 구분하도록 안내만 한다.
            if (result && "ok" in result && result.ok === false && result.code === "STUDENT_AMBIGUOUS") {
                const lines = (result.candidates ?? [])
                    .map((c) => {
                        const b = c.birthDate ? new Date(c.birthDate).toLocaleDateString("ko-KR") : "생년 미상";
                        return `· ${c.name} (${b})`;
                    })
                    .join("\n");
                onFeedback(
                    "error",
                    `같은 이름의 자녀가 여러 명이라 어느 학생인지 확정할 수 없습니다.\n${lines}\n원생/수강 등록 메뉴에서 생년을 확인해 정리한 뒤 다시 승인해주세요.`,
                );
                setBusy(false);
                return;
            }

            // 여기부터는 승인 성공 경로(기존 동작 그대로). 위에서 모든 ok:false 분기를 처리했으므로 안전.
            if ("ok" in result) {
                return;
            }

            onCloseApprove();
            await onSaved();
            onFeedback("success", `${approveApp.childName} 수강신청을 승인했습니다. 안내 알림은 발송하지 않았습니다.`);
        } catch (error) {
            setApprovalError(adminErrorText(error, "승인 처리 중 문제가 생겼습니다. 선택 내용을 확인하고 다시 시도해 주세요."));
            onFeedback("error", "승인 처리 중 문제가 생겼습니다. 잠시 후 다시 시도해주세요.");
        } finally {
            setBusy(false);
        }
    }

    async function handleReopen(reason: string) {
        if (!reopenApp || reopenApp.status !== "REJECTED" || reopenApp.convertedStudentId) return;
        setBusy(true);
        setReopenError("");
        try {
            await reopenEnrollApplicationForReview(reopenApp.id, { reason });
            onCloseReopen?.();
            onFeedback("success", "상담 대기로 되돌렸습니다. 원생 등록·청구·알림 발송은 하지 않았습니다.");
            try {
                await onSaved();
            } catch {
                onFeedback("error", "재검토 상태는 상담 대기로 저장되었습니다. 목록을 새로고침하지 못했으니 페이지를 다시 열어 확인해 주세요. 재검토 처리를 반복할 필요는 없습니다.");
            }
        } catch (error) {
            setReopenError(adminErrorText(error, "재검토로 되돌리지 못했습니다. 내용을 유지했으니 다시 확인해 주세요."));
        } finally {
            setBusy(false);
        }
    }

    async function handleReject(reason: string) {
        if (!rejectApp) return;
        setBusy(true);
        try {
            await rejectEnrollApplication(rejectApp.id, reason);
            onCloseReject();
            await onSaved();
            onFeedback("success", `${rejectApp.childName} 수강신청을 반려 처리했습니다.`);
        } catch {
            onFeedback("error", "반려 처리 중 문제가 생겼습니다. 잠시 후 다시 시도해주세요.");
        } finally {
            setBusy(false);
        }
    }

    async function handleEdit(data: Record<string, unknown>) {
        if (!editApp) return;
        setBusy(true);
        try {
            await updateEnrollApplication(editApp.id, data);
            onCloseEdit();
            await onSaved();
            onFeedback("success", `${editApp.childName} 수강신청 내용을 수정했습니다.`);
        } catch {
            onFeedback("error", "수정 저장 중 문제가 생겼습니다. 승인된 신청은 원생/수강 등록 메뉴에서 수정해주세요.");
        } finally {
            setBusy(false);
        }
    }

    async function handleCancel(reason: string) {
        if (!cancelApp) return;
        setBusy(true);
        try {
            await cancelEnrollApplication(cancelApp.id, reason);
            onCloseCancel();
            await onSaved();
            onFeedback("success", `${cancelApp.childName} 수강신청을 취소 처리했습니다.`);
        } catch {
            onFeedback("error", "취소 처리 중 문제가 생겼습니다. 승인된 신청은 원생/수강 등록 메뉴에서 정리해주세요.");
        } finally {
            setBusy(false);
        }
    }

    return (
        <>
            {approveApp && (
                <ApproveModal
                    key={approveApp.id}
                    app={approveApp}
                    classes={classes}
                    onClose={() => { if (!busy) { setApprovalError(""); onCloseApprove(); } }}
                    onSubmit={handleApprove}
                    busy={busy}
                    error={approvalError}
                />
            )}

            {reopenApp && onCloseReopen && reopenApp.status === "REJECTED" && !reopenApp.convertedStudentId && (
                <ReopenApplicationModal key={reopenApp.id} app={reopenApp} busy={busy} error={reopenError} onClose={() => { if (!busy) { setReopenError(""); onCloseReopen(); } }} onSubmit={handleReopen} />
            )}

            {rejectApp && (
                <RejectModal
                    app={rejectApp}
                    onClose={onCloseReject}
                    onSubmit={handleReject}
                    busy={busy}
                />
            )}

            {editApp && (
                <EditApplicationModal
                    app={editApp}
                    classes={classes}
                    onClose={onCloseEdit}
                    onSubmit={handleEdit}
                    busy={busy}
                />
            )}

            {cancelApp && (
                <CancelApplicationModal
                    app={cancelApp}
                    onClose={onCloseCancel}
                    onSubmit={handleCancel}
                    busy={busy}
                />
            )}

            {detailApp && (
                <DetailModal
                    app={detailApp}
                    classes={classes}
                    onClose={onCloseDetail}
                    onFeedback={onFeedback}
                />
            )}
        </>
    );
}

function ApproveModal({
    app,
    classes,
    onClose,
    onSubmit,
    busy,
    error,
}: {
    app: EnrollApplication;
    classes: ClassInfo[];
    onClose: () => void;
    onSubmit: (classIds: string[], note: string, parentUserId?: string, startOn?: string) => void;
    busy: boolean;
    error: string;
}) {
    const preferredKeys = app.preferredSlotKeys?.split(",").map((key) => key.trim()) ?? [];
    const preferredSlotLabel = formatPreferredSlots(app.preferredSlotKeys, classes);
    const [selectedClassIds, setSelectedClassIds] = useState<string[]>(() => {
        return classes
            .filter((classInfo) => classInfo.slotKey && preferredKeys.includes(classInfo.slotKey))
            .map((classInfo) => classInfo.id);
    });
    const [note, setNote] = useState("");
    const [startOn, setStartOn] = useState(app.requestedStartOn || "");
    const [formError, setFormError] = useState("");
    const [parentCandidates, setParentCandidates] = useState<Array<{ id: string; name: string; role: string; phoneLast4: string; authLinked: boolean; isCurrentAccount: boolean }>>([]);
    const [selectedParent, setSelectedParent] = useState("");
    const [linkedParentUserId, setLinkedParentUserId] = useState<string | null>(null);
    const [hasUnselectableMatches, setHasUnselectableMatches] = useState(false);
    const [parentLoading, setParentLoading] = useState(true);
    const [parentError, setParentError] = useState("");
    const [parentRetry, setParentRetry] = useState(0);
    useEffect(() => {
        let cancelled = false;
        getEnrollmentParentCandidates(app.id).then(result => {
            if (cancelled) return;
            setParentCandidates(result.candidates);
            setHasUnselectableMatches(result.hasUnselectableMatches);
            setLinkedParentUserId(result.linkedParentUserId);
            // 이미 명시적으로 연결된 계정만 복원하고, 전화번호가 같은 후보는 자동 선택하지 않습니다.
            setSelectedParent(result.linkedParentUserId ?? "");
            setParentLoading(false);
        }).catch(() => {
            if (cancelled) return;
            setParentError("보호자 계정을 확인하지 못했습니다. 조회가 완료되기 전에는 승인할 수 없습니다.");
            setParentLoading(false);
        });
        return () => { cancelled = true; };
    }, [app.id, parentRetry]);
    const selectedCandidate = parentCandidates.find(candidate => candidate.id === selectedParent);
    const parentReady = !parentLoading && !parentError && (selectedCandidate !== undefined || (parentCandidates.length === 0 && !hasUnselectableMatches && selectedParent === "__NEW__"));

    function toggleClass(classId: string) {
        setFormError("");
        setSelectedClassIds((prev) =>
            prev.includes(classId)
                ? prev.filter((id) => id !== classId)
                : [...prev, classId]
        );
    }

    function handleSubmit(event: FormEvent) {
        event.preventDefault();
        if (selectedClassIds.length === 0) {
            setFormError("배정할 반을 1개 이상 선택해주세요.");
            return;
        }
        if (!parentReady) {
            setFormError("연결할 보호자 계정을 직접 선택해 주세요.");
            return;
        }
        setFormError("");
        if (!startOn) { setFormError("수강 개시일을 확인해 주세요."); return; }
        onSubmit(selectedClassIds, note, selectedParent, startOn);
    }

    const classesByDay = classes.reduce<Record<string, ClassInfo[]>>((acc, classInfo) => {
        const day = classInfo.dayOfWeek || "기타";
        if (!acc[day]) acc[day] = [];
        acc[day].push(classInfo);
        return acc;
    }, {});

    return (
        <AdminModal onClose={onClose} titleId="approve-application-title" panelClassName="max-w-lg p-6">
                <h2 id="approve-application-title" className="text-lg font-bold text-[var(--color-academy-ink)] flex items-center gap-2 mb-1">
                    <span className="material-symbols-outlined text-[var(--color-academy-success)]">check_circle</span>
                    수강 신청 승인
                </h2>
                <p className="text-sm text-[var(--color-academy-muted)] mb-4">
                    <span className="font-medium text-[var(--color-academy-ink)]">{app.childName}</span>을(를) 어떤 반에 배정하시겠습니까?
                </p>

                {preferredSlotLabel && (
                    <div className="bg-[var(--color-academy-neutral-soft)] text-[var(--color-academy-neutral)] text-sm rounded-lg px-3 py-2 mb-4 flex items-center gap-2">
                        <span className="material-symbols-outlined text-base">info</span>
                        <span>희망 시간대: <span className="font-medium">{preferredSlotLabel}</span></span>
                    </div>
                )}

                <form onSubmit={handleSubmit} className="space-y-4">
                    <label className="block space-y-1 text-sm font-bold">수강 개시일 *
                        <input aria-label="확정 수강 개시일" required type="date" value={startOn} disabled={busy} onChange={event => setStartOn(event.target.value)} className={`${MODAL_INPUT_CLASS} box-border min-h-11 min-w-0 max-w-full text-[17px]`} />
                        <span className="block text-xs font-normal text-[var(--color-academy-muted)]">승인하면 바로 수강 중(재원생)으로 등록됩니다. 이 날짜는 출석부·수강료 시수 계산의 시작일입니다.</span>
                    </label>
                    <section aria-label="보호자 계정 연결" className="space-y-2 rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-soft)] p-3">
                        <label className="grid gap-1 text-sm font-bold" htmlFor="enrollment-parent-account">연결할 보호자 계정 *</label>
                        {parentLoading ? <p role="status" className="text-sm text-[var(--color-academy-muted)]">계정 확인 중…</p> : parentError ? <div role="alert" className="text-sm"><p>{parentError}</p><button type="button" className="min-h-11 font-bold text-[var(--color-academy-ink)] underline" onClick={() => { setParentLoading(true); setParentError(""); setSelectedParent(""); setParentRetry(value => value + 1); }}>다시 조회</button></div> : <>
                            <select id="enrollment-parent-account" value={selectedParent} onChange={event => setSelectedParent(event.target.value)} disabled={busy || linkedParentUserId !== null} className="h-11 min-h-11 w-full min-w-0 rounded-lg border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] px-3 text-[17px]">
                                <option value="">직접 선택해 주세요</option>
                                {parentCandidates.map(candidate => <option key={candidate.id} value={candidate.id}>{candidate.isCurrentAccount ? "내 계정 · " : ""}{candidate.name} · {({ ADMIN: "관리자", VICE_ADMIN: "부관리자", INSTRUCTOR: "선생님", PARENT: "학부모" } as Record<string, string>)[candidate.role] ?? candidate.role} · 연락처 끝 {candidate.phoneLast4}{!candidate.authLinked ? " · 로그인 연결 전" : ""}</option>)}
                                {parentCandidates.length === 0 && !hasUnselectableMatches && <option value="__NEW__">신규 보호자 계정으로 등록</option>}
                            </select>
                            <p className="text-xs text-[var(--color-academy-muted)]">같은 전화번호만으로 연결하지 않습니다. 신청자와 계정 주인을 확인해 선택해 주세요.</p>
                            {linkedParentUserId && <p className="text-xs text-[var(--color-academy-muted)]">이미 확인된 보호자 연결을 유지합니다. 이 승인창에서는 연결 계정을 바꾸지 않습니다.</p>}
                            {parentCandidates.length === 0 && hasUnselectableMatches && <p role="alert" className="text-sm font-bold">같은 연락처의 계정이 있지만 바로 연결할 수 없습니다. 로그인 연결과 보호자 자격을 확인해 주세요. 신규 계정은 만들지 않습니다.</p>}
                            {selectedCandidate && ["ADMIN", "VICE_ADMIN", "INSTRUCTOR"].includes(selectedCandidate.role) && <p role="status" className="flex items-start gap-1 text-sm font-bold text-[var(--color-academy-ink)]"><span className="material-symbols-outlined text-lg" aria-hidden="true">verified_user</span>기존 관리자·선생님 역할을 유지하고 자녀 연결만 추가합니다.</p>}
                        </>}
                    </section>
                    <div>
                        <label className="block text-sm font-medium text-[var(--color-academy-muted)] mb-2">
                            배정할 반 선택 (복수 선택 가능) *
                        </label>
                        <div className="space-y-3 max-h-60 overflow-y-auto">
                            {Object.entries(classesByDay).map(([day, dayClasses]) => (
                                <div key={day}>
                                    <p className="text-xs font-bold text-[var(--color-academy-muted)] mb-1">
                                        {DAY_LABELS[day] || day}요일
                                    </p>
                                    <div className="space-y-1">
                                        {dayClasses.map((classInfo) => {
                                            const selected = selectedClassIds.includes(classInfo.id);
                                            return (
                                                <button
                                                    key={classInfo.id}
                                                    type="button"
                                                    disabled={busy}
                                                    onClick={() => toggleClass(classInfo.id)}
                                                    className={`min-h-11 w-full text-left px-3 py-2 rounded-lg text-sm transition border ${
                                                        selected
                                                            ? "border-[var(--color-academy-primary)] bg-[var(--color-academy-primary-soft)] text-[var(--color-academy-ink)]"
                                                            : "border-[var(--color-academy-line)] hover:border-[var(--color-academy-line-input)] text-[var(--color-academy-muted)]"
                                                    }`}
                                                >
                                                    <div className="flex items-center justify-between">
                                                        <span>
                                                            {classInfo.name}
                                                            <span className="text-[var(--color-academy-faint)] ml-2">
                                                                {classInfo.startTime}~{classInfo.endTime}
                                                            </span>
                                                        </span>
                                                        {selected && (
                                                            <span className="material-symbols-outlined text-[var(--color-academy-success)] text-lg">check</span>
                                                        )}
                                                    </div>
                                                    {classInfo.program && (
                                                        <span className="text-xs text-[var(--color-academy-faint)]">{classInfo.program.name}</span>
                                                    )}
                                                </button>
                                            );
                                        })}
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>

                    {formError && (
                        <p className="rounded-lg bg-[var(--color-academy-danger-soft)] px-3 py-2 text-sm font-semibold text-[var(--color-academy-danger)]">
                            {formError}
                        </p>
                    )}
                    {error && <p role="alert" className="rounded-lg border border-[var(--color-academy-line)] p-3 text-sm">{error}</p>}

                    <div>
                        <label className="block text-sm font-medium text-[var(--color-academy-muted)] mb-1">관리자 메모</label>
                        <textarea
                            value={note}
                            onChange={(event) => setNote(event.target.value)}
                            rows={2}
                            className="w-full border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] rounded-lg px-3 py-2 text-[17px] focus:outline-none focus:ring-2 focus:ring-[var(--color-academy-primary)] resize-none"
                        />
                    </div>

                    <p className="rounded-lg bg-[var(--color-academy-soft)] p-3 text-sm" aria-label="승인 내용 확인"><strong>{app.childName}</strong> · {classes.filter(item => selectedClassIds.includes(item.id)).map(formatClassLabel).join(" / ") || "반 미선택"}<br />보호자: {selectedCandidate ? `${selectedCandidate.name} · 연락처 끝 ${selectedCandidate.phoneLast4}` : selectedParent === "__NEW__" ? "신규 보호자 계정" : "미선택"}<br /><span className="text-xs text-[var(--color-academy-muted)]">승인하면 원생·수강 등록이 진행됩니다. 알림은 자동 발송하지 않습니다.</span></p>
                    <div className="flex justify-end gap-3 pt-2">
                        <button
                            type="button"
                            onClick={onClose}
                            className="min-h-11 px-4 py-2 text-sm text-[var(--color-academy-muted)] hover:text-[var(--color-academy-ink)] transition"
                        >
                            취소
                        </button>
                        <button
                            type="submit"
                            disabled={busy || selectedClassIds.length === 0 || !parentReady}
                            className="flex min-h-11 items-center gap-1.5 px-5 py-2.5 bg-[var(--color-academy-primary)] text-[var(--color-academy-on-primary)] rounded-xl transition font-medium text-sm disabled:opacity-40"
                        >
                            {busy ? (
                                <span className="material-symbols-outlined text-lg animate-spin">progress_activity</span>
                            ) : (
                                <span className="material-symbols-outlined text-lg">check_circle</span>
                            )}
                            {busy ? "처리 중..." : `승인 (${selectedClassIds.length}개 반)`}
                        </button>
                    </div>
                </form>
        </AdminModal>
    );
}

function EditApplicationModal({
    app,
    classes,
    onClose,
    onSubmit,
    busy,
}: {
    app: EnrollApplication;
    classes: ClassInfo[];
    onClose: () => void;
    onSubmit: (data: Record<string, unknown>) => void;
    busy: boolean;
}) {
    const initialSlotKeys = app.preferredSlotKeys?.split(",").map((key) => key.trim()).filter(Boolean) ?? [];
    const [form, setForm] = useState({
        childName: app.childName ?? "",
        childBirthDate: dateInputValue(app.childBirthDate),
        childGender: app.childGender ?? "",
        childGrade: app.childGrade ?? "",
        childSchool: app.childSchool ?? "",
        childPhone: app.childPhone ?? "",
        parentName: app.parentName ?? "",
        parentPhone: app.parentPhone ?? "",
        parentRelation: app.parentRelation ?? "",
        address: app.address ?? "",
        requestedStartOn: app.requestedStartOn ?? "",
        basketballExp: app.basketballExp ?? "",
        uniformSize: app.uniformSize ?? "",
        shuttleNeeded: Boolean(app.shuttleNeeded),
        shuttlePickup: app.shuttlePickup ?? "",
        shuttleTime: app.shuttleTime ?? "",
        shuttleDropoff: app.shuttleDropoff ?? "",
        paymentMethod: app.paymentMethod ?? "",
        referralSource: app.referralSource ?? "",
        memo: app.memo ?? "",
        applicationNoticeConfirmed: Boolean(app.applicationNoticeConfirmed),
        shuttleNoticeConfirmed: Boolean(app.shuttleNoticeConfirmed),
        processedNote: app.processedNote ?? "",
    });
    const [selectedSlotKeys, setSelectedSlotKeys] = useState<string[]>(initialSlotKeys);
    const [formError, setFormError] = useState("");

    function toggleSlot(slotKey: string) {
        setSelectedSlotKeys((current) =>
            current.includes(slotKey)
                ? current.filter((key) => key !== slotKey)
                : [...current, slotKey],
        );
    }

    function handleSubmit(event: FormEvent) {
        event.preventDefault();
        if (!form.childName.trim() || !form.childBirthDate || !form.parentName.trim() || !form.parentPhone.trim()) {
            setFormError("아이 이름, 생년월일, 보호자 이름, 연락처를 입력해주세요.");
            return;
        }
        setFormError("");
        onSubmit({
            childName: form.childName.trim(),
            childBirthDate: form.childBirthDate,
            childGender: form.childGender || null,
            childGrade: form.childGrade.trim() || null,
            childSchool: form.childSchool.trim() || null,
            childPhone: form.childPhone.trim() || null,
            parentName: form.parentName.trim(),
            parentPhone: form.parentPhone.trim(),
            parentRelation: form.parentRelation.trim() || null,
            address: form.address.trim() || null,
            ...(form.requestedStartOn ? { requestedStartOn: form.requestedStartOn } : app.requestedStartOn ? { requestedStartOn: null } : {}),
            preferredSlotKeys: selectedSlotKeys.join(",") || null,
            basketballExp: form.basketballExp.trim() || null,
            uniformSize: form.uniformSize.trim() || null,
            shuttleNeeded: form.shuttleNeeded,
            shuttlePickup: form.shuttleNeeded ? form.shuttlePickup.trim() || null : null,
            shuttleTime: form.shuttleNeeded ? form.shuttleTime.trim() || null : null,
            shuttleDropoff: form.shuttleNeeded ? form.shuttleDropoff.trim() || null : null,
            paymentMethod: form.paymentMethod.trim() || null,
            referralSource: form.referralSource || null,
            memo: form.memo.trim() || null,
            applicationNoticeConfirmed: form.applicationNoticeConfirmed,
            shuttleNoticeConfirmed: form.shuttleNoticeConfirmed,
            processedNote: form.processedNote.trim() || null,
        });
    }

    const classesByDay = classes.reduce<Record<string, ClassInfo[]>>((acc, classInfo) => {
        const day = classInfo.dayOfWeek || "기타";
        if (!acc[day]) acc[day] = [];
        acc[day].push(classInfo);
        return acc;
    }, {});

    return (
        <AdminModal onClose={onClose} titleId="edit-application-title" panelClassName="max-w-3xl p-6">
                {/* 부제 문구를 없애면서 아래 폼과의 간격(mb-4)은 제목으로 옮겨 유지한다 */}
                <h2 id="edit-application-title" className="mb-4 flex items-center gap-2 text-lg font-bold text-[var(--color-academy-ink)]">
                    <span className="material-symbols-outlined text-[var(--color-academy-ink)]">edit</span>
                    수강신청 수정
                </h2>

                <form onSubmit={handleSubmit} className="space-y-5">
                    {formError && (
                        <p className="rounded-lg bg-[var(--color-academy-danger-soft)] px-3 py-2 text-sm font-semibold text-[var(--color-academy-danger)]">
                            {formError}
                        </p>
                    )}

                    <section>
                        <h3 className="mb-2 text-xs font-black uppercase text-[var(--color-academy-muted)]">아이 정보</h3>
                        <div className="grid gap-3 sm:grid-cols-2">
                            <FormField label="아이 이름 *">
                                <input value={form.childName} onChange={(e) => setForm({ ...form, childName: e.target.value })} className={MODAL_INPUT_CLASS} />
                            </FormField>
                            <FormField label="생년월일 *">
                                <input type="date" value={form.childBirthDate} onChange={(e) => setForm({ ...form, childBirthDate: e.target.value })} className={MODAL_INPUT_CLASS} />
                            </FormField>
                            <FormField label="성별">
                                <select value={form.childGender} onChange={(e) => setForm({ ...form, childGender: e.target.value })} className={MODAL_INPUT_CLASS}>
                                    <option value="">선택 안 함</option>
                                    <option value="남">남</option>
                                    <option value="여">여</option>
                                </select>
                            </FormField>
                            <FormField label="학년">
                                <input value={form.childGrade} onChange={(e) => setForm({ ...form, childGrade: e.target.value })} className={MODAL_INPUT_CLASS} />
                            </FormField>
                            <FormField label="학교">
                                <input value={form.childSchool} onChange={(e) => setForm({ ...form, childSchool: e.target.value })} className={MODAL_INPUT_CLASS} />
                            </FormField>
                            <FormField label="아이 연락처">
                                <input type="tel" value={form.childPhone} onChange={(e) => setForm({ ...form, childPhone: formatPhoneInput(e.target.value) })} className={MODAL_INPUT_CLASS} />
                            </FormField>
                        </div>
                    </section>

                    <section>
                        <h3 className="mb-2 text-xs font-black uppercase text-[var(--color-academy-muted)]">보호자 정보</h3>
                        <div className="grid gap-3 sm:grid-cols-2">
                            <FormField label="보호자 이름 *">
                                <input value={form.parentName} onChange={(e) => setForm({ ...form, parentName: e.target.value })} className={MODAL_INPUT_CLASS} />
                            </FormField>
                            <FormField label="보호자 연락처 *">
                                <input type="tel" value={form.parentPhone} onChange={(e) => setForm({ ...form, parentPhone: formatPhoneInput(e.target.value) })} className={MODAL_INPUT_CLASS} />
                            </FormField>
                            <FormField label="관계">
                                <input value={form.parentRelation} onChange={(e) => setForm({ ...form, parentRelation: e.target.value })} className={MODAL_INPUT_CLASS} placeholder="부 / 모 / 기타" />
                            </FormField>
                            <FormField label="주소">
                                <input value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} className={MODAL_INPUT_CLASS} />
                            </FormField>
                        </div>
                    </section>

                    <section>
                        <h3 className="mb-2 text-xs font-black uppercase text-[var(--color-academy-muted)]">수강 정보</h3>
                        <div className="grid gap-3 sm:grid-cols-2">
                            <FormField label="수강 개시일">
                                <input type="date" disabled={app.status === "APPROVED"} value={form.requestedStartOn} onChange={(e) => setForm({ ...form, requestedStartOn: e.target.value })} className={`${MODAL_INPUT_CLASS} box-border min-w-0 max-w-full text-[17px]`} />
                                {app.status === "APPROVED" && <p className="mt-1 text-xs text-[var(--color-academy-muted)]">승인된 수강의 개시일은 이 신청서에서 변경하지 않습니다.</p>}
                                {!app.requestedStartOn && app.enrollmentMonths && <p className="mt-1 text-xs text-[var(--color-academy-muted)]">기존 신청 월 {formatEnrollmentMonthsShort(app.enrollmentMonths)} · 정확한 개시일을 확인해 주세요.</p>}
                            </FormField>
                            <FormField label="농구 경험">
                                <input value={form.basketballExp} onChange={(e) => setForm({ ...form, basketballExp: e.target.value })} className={MODAL_INPUT_CLASS} />
                            </FormField>
                            <FormField label="유니폼 사이즈">
                                <input value={form.uniformSize} onChange={(e) => setForm({ ...form, uniformSize: e.target.value })} className={MODAL_INPUT_CLASS} />
                            </FormField>
                            <FormField label="납부 방식">
                                <input value={form.paymentMethod} onChange={(e) => setForm({ ...form, paymentMethod: e.target.value })} className={MODAL_INPUT_CLASS} />
                            </FormField>
                            <FormField label="유입 경로">
                                <select value={form.referralSource} onChange={(e) => setForm({ ...form, referralSource: e.target.value })} className={MODAL_INPUT_CLASS}>
                                    <option value="">선택 안 함</option>
                                    {Object.entries(SOURCE_LABELS).map(([value, label]) => (
                                        <option key={value} value={value}>{label}</option>
                                    ))}
                                </select>
                            </FormField>
                        </div>
                    </section>

                    <section>
                        <h3 className="mb-2 text-xs font-black uppercase text-[var(--color-academy-muted)]">희망 시간</h3>
                        <div className="max-h-56 space-y-3 overflow-y-auto rounded-xl border border-[var(--color-academy-line)] p-3">
                            {Object.entries(classesByDay).map(([day, dayClasses]) => (
                                <div key={day}>
                                    <p className="mb-1 text-xs font-bold text-[var(--color-academy-muted)]">{DAY_LABELS[day] || day}요일</p>
                                    <div className="grid gap-2 sm:grid-cols-2">
                                        {dayClasses.map((classInfo) => {
                                            const slotKey = classInfo.slotKey;
                                            if (!slotKey) return null;
                                            const selected = selectedSlotKeys.includes(slotKey);
                                            return (
                                                <button
                                                    key={classInfo.id}
                                                    type="button"
                                                    onClick={() => toggleSlot(slotKey)}
                                                    className={`rounded-lg border px-3 py-2 text-left text-sm transition ${
                                                        selected
                                                            ? "border-[var(--color-academy-primary)] bg-[var(--color-academy-primary-soft)] text-[var(--color-academy-ink)]"
                                                            : "border-[var(--color-academy-line)] text-[var(--color-academy-muted)] hover:border-[var(--color-academy-line-input)]"
                                                    }`}
                                                >
                                                    <div className="flex items-center justify-between gap-2">
                                                        <span className="font-bold">{classInfo.name}</span>
                                                        {selected && <span className="material-symbols-outlined text-lg text-[var(--color-academy-ink)]">check</span>}
                                                    </div>
                                                    <span className="text-xs text-[var(--color-academy-muted)]">{classInfo.startTime}~{classInfo.endTime}</span>
                                                </button>
                                            );
                                        })}
                                    </div>
                                </div>
                            ))}
                        </div>
                    </section>

                    <section>
                        <h3 className="mb-2 text-xs font-black uppercase text-[var(--color-academy-muted)]">셔틀/메모</h3>
                        <label className="mb-3 flex items-center gap-2 rounded-lg border border-[var(--color-academy-line)] px-3 py-2 text-sm font-semibold text-[var(--color-academy-muted)]">
                            <input
                                type="checkbox"
                                checked={form.shuttleNeeded}
                                onChange={(e) => setForm({ ...form, shuttleNeeded: e.target.checked })}
                            />
                            셔틀 필요
                        </label>
                        {form.shuttleNeeded && (
                            <div className="mb-3 grid gap-3 sm:grid-cols-3">
                                <FormField label="탑승지">
                                    <input value={form.shuttlePickup} onChange={(e) => setForm({ ...form, shuttlePickup: e.target.value })} className={MODAL_INPUT_CLASS} />
                                </FormField>
                                <FormField label="하차지">
                                    <input value={form.shuttleDropoff} onChange={(e) => setForm({ ...form, shuttleDropoff: e.target.value })} className={MODAL_INPUT_CLASS} />
                                </FormField>
                                <FormField label="셔틀 시간">
                                    <input value={form.shuttleTime} onChange={(e) => setForm({ ...form, shuttleTime: e.target.value })} className={MODAL_INPUT_CLASS} />
                                </FormField>
                            </div>
                        )}
                        <div className="grid gap-3 sm:grid-cols-2">
                            <FormField label="보호자 메모">
                                <textarea value={form.memo} onChange={(e) => setForm({ ...form, memo: e.target.value })} rows={3} className={`${MODAL_INPUT_CLASS} resize-none`} />
                            </FormField>
                            <FormField label="관리 메모">
                                <textarea value={form.processedNote} onChange={(e) => setForm({ ...form, processedNote: e.target.value })} rows={3} className={`${MODAL_INPUT_CLASS} resize-none`} />
                            </FormField>
                        </div>
                        <div className="mt-3 grid gap-2 sm:grid-cols-2">
                            <label className="flex items-center gap-2 rounded-lg border border-[var(--color-academy-line)] px-3 py-2 text-sm font-semibold text-[var(--color-academy-muted)]">
                                <input
                                    type="checkbox"
                                    checked={form.applicationNoticeConfirmed}
                                    onChange={(e) => setForm({ ...form, applicationNoticeConfirmed: e.target.checked })}
                                />
                                신청 안내 확인
                            </label>
                            <label className="flex items-center gap-2 rounded-lg border border-[var(--color-academy-line)] px-3 py-2 text-sm font-semibold text-[var(--color-academy-muted)]">
                                <input
                                    type="checkbox"
                                    checked={form.shuttleNoticeConfirmed}
                                    onChange={(e) => setForm({ ...form, shuttleNoticeConfirmed: e.target.checked })}
                                />
                                셔틀 안내 확인
                            </label>
                        </div>
                    </section>

                    <div className="flex gap-3 pt-2">
                        <button
                            type="button"
                            onClick={onClose}
                            className="flex-1 rounded-lg border border-[var(--color-academy-line-input)] px-4 py-2.5 text-sm font-medium text-[var(--color-academy-muted)] transition hover:bg-[var(--color-academy-soft)]"
                        >
                            닫기
                        </button>
                        <button
                            type="submit"
                            disabled={busy}
                            className="flex-1 rounded-lg bg-[var(--color-academy-primary)] px-4 py-2.5 text-sm font-bold text-white transition hover:bg-[var(--color-academy-primary-hover)] disabled:opacity-50"
                        >
                            {busy ? "저장 중..." : "수정 저장"}
                        </button>
                    </div>
                </form>
        </AdminModal>
    );
}

function CancelApplicationModal({
    app,
    onClose,
    onSubmit,
    busy,
}: {
    app: EnrollApplication;
    onClose: () => void;
    onSubmit: (reason: string) => void;
    busy: boolean;
}) {
    const [reason, setReason] = useState("학부모 요청");

    return (
        <AdminModal onClose={onClose} titleId="cancel-application-title" panelClassName="max-w-md p-6">
                <h2 id="cancel-application-title" className="mb-1 flex items-center gap-2 text-lg font-bold text-[var(--color-academy-ink)]">
                    <span className="material-symbols-outlined text-[var(--color-academy-muted)]">block</span>
                    수강신청 취소
                </h2>
                <p className="mb-4 text-sm text-[var(--color-academy-muted)]">
                    <span className="font-medium text-[var(--color-academy-ink)]">{app.childName}</span> 신청을 삭제하지 않고 취소 상태로 남깁니다.
                </p>
                <form
                    onSubmit={(event) => {
                        event.preventDefault();
                        onSubmit(reason.trim() || "관리자 취소");
                    }}
                    className="space-y-4"
                >
                    <div className="flex flex-wrap gap-2">
                        {CANCEL_REASON_OPTIONS.map((option) => (
                            <button
                                key={option}
                                type="button"
                                onClick={() => setReason(option)}
                                className={`rounded-full border px-3 py-1 text-xs font-semibold transition ${
                                    reason === option
                                        ? "border-[var(--color-academy-line-input)] bg-[var(--color-academy-soft)] text-[var(--color-academy-ink)]"
                                        : "border-[var(--color-academy-line)] text-[var(--color-academy-muted)] hover:border-[var(--color-academy-line-input)] hover:text-[var(--color-academy-ink)]"
                                }`}
                            >
                                {option}
                            </button>
                        ))}
                    </div>
                    <FormField label="취소 사유">
                        <textarea value={reason} onChange={(event) => setReason(event.target.value)} rows={3} className={`${MODAL_INPUT_CLASS} resize-none`} />
                    </FormField>
                    <div className="flex gap-3 pt-2">
                        <button
                            type="button"
                            onClick={onClose}
                            className="flex-1 rounded-lg border border-[var(--color-academy-line-input)] px-4 py-2.5 text-sm font-medium text-[var(--color-academy-muted)] transition hover:bg-[var(--color-academy-line)]"
                        >
                            닫기
                        </button>
                        <button
                            type="submit"
                            disabled={busy}
                            className="flex-1 rounded-lg bg-[var(--color-academy-primary-hover)] px-4 py-2.5 text-sm font-bold text-white transition hover:bg-[var(--color-academy-primary-hover)] disabled:opacity-50"
                        >
                            {busy ? "처리 중..." : "취소 처리"}
                        </button>
                    </div>
                </form>
        </AdminModal>
    );
}

function ReopenApplicationModal({ app, onClose, onSubmit, busy, error }: {
    app: EnrollApplication;
    onClose: () => void;
    onSubmit: (reason: string) => void;
    busy: boolean;
    error: string;
}) {
    const [reason, setReason] = useState("");
    return <AdminModal titleId="reopen-application-title" onClose={onClose} panelClassName="max-w-lg p-5">
        <h2 id="reopen-application-title" className="flex items-center gap-2 text-lg font-bold"><span aria-hidden="true" className="material-symbols-outlined text-[var(--color-academy-ink)]">restart_alt</span>수강신청 재검토</h2>
        <p className="mt-2 text-sm"><strong>{app.childName}</strong> 신청을 반려에서 상담 대기로 되돌립니다. 기존 반려 사유는 이력으로 남깁니다.</p>
        <p className="mt-2 rounded-lg bg-[var(--color-academy-soft)] p-3 text-sm text-[var(--color-academy-muted)]">원생 등록·수업 배정·청구·알림 발송은 하지 않습니다. 내용을 다시 확인한 뒤 별도로 승인해야 합니다.</p>
        <form className="mt-3 space-y-3" onSubmit={event => { event.preventDefault(); if (!busy && reason.trim()) onSubmit(reason.trim()); }}>
            <label className="grid gap-1 text-sm font-bold">재검토 사유 *<textarea required maxLength={500} rows={3} value={reason} onChange={event => setReason(event.target.value)} disabled={busy} placeholder="재검토가 필요한 이유를 적어주세요" className="min-h-11 w-full resize-none rounded-lg border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] px-3 py-2 text-[17px] font-normal" /></label>
            {error && <p role="alert" className="rounded-lg border border-[var(--color-academy-line)] p-3 text-sm">{error}</p>}
            <footer className="flex justify-end gap-2"><button type="button" disabled={busy} onClick={onClose} className="min-h-11 rounded-lg border border-[var(--color-academy-line)] px-4 text-sm font-bold disabled:opacity-50">닫기</button><button type="submit" disabled={busy || !reason.trim()} className="min-h-11 rounded-lg bg-[var(--color-academy-primary)] px-4 text-sm font-bold text-[var(--color-academy-on-primary)] disabled:opacity-50">{busy ? "처리 중…" : "상담 대기로 되돌리기"}</button></footer>
        </form>
    </AdminModal>;
}

function RejectModal({
    app,
    onClose,
    onSubmit,
    busy,
}: {
    app: EnrollApplication;
    onClose: () => void;
    onSubmit: (reason: string) => void;
    busy: boolean;
}) {
    const [reason, setReason] = useState("");

    return (
        <AdminModal onClose={onClose} titleId="reject-application-title" panelClassName="max-w-md p-6">
                <h2 id="reject-application-title" className="text-lg font-bold text-[var(--color-academy-ink)] flex items-center gap-2 mb-1">
                    <span className="material-symbols-outlined text-[var(--color-academy-danger)]">cancel</span>
                    수강 신청 반려
                </h2>
                <p className="text-sm text-[var(--color-academy-muted)] mb-4">
                    <span className="font-medium text-[var(--color-academy-ink)]">{app.childName}</span>의 신청을 반려합니다.
                </p>

                <div className="space-y-4">
                    <div>
                        <label className="block text-sm font-medium text-[var(--color-academy-muted)] mb-1">반려 사유</label>
                        <div className="mb-2 flex flex-wrap gap-2">
                            {REJECT_REASON_OPTIONS.map((option) => (
                                <button
                                    key={option}
                                    type="button"
                                    onClick={() => setReason(option)}
                                    className={`rounded-full border px-3 py-1 text-xs font-semibold transition ${
                                        reason === option
                                            ? "border-[var(--color-academy-danger)] bg-[var(--color-academy-danger-soft)] text-[var(--color-academy-danger)]"
                                            : "border-[var(--color-academy-line)] text-[var(--color-academy-muted)] hover:border-[var(--color-academy-line)] hover:text-[var(--color-academy-danger)]"
                                    }`}
                                >
                                    {option}
                                </button>
                            ))}
                        </div>
                        <textarea
                            value={reason}
                            onChange={(event) => setReason(event.target.value)}
                            rows={3}
                            className="w-full border border-[var(--color-academy-line-input)] rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-academy-danger)] resize-none"
                            placeholder="반려 사유를 입력하세요 (선택)"
                        />
                    </div>

                    <div className="flex justify-end gap-3">
                        <button
                            type="button"
                            onClick={onClose}
                            className="px-4 py-2 text-sm text-[var(--color-academy-muted)] hover:text-[var(--color-academy-ink)] transition"
                        >
                            취소
                        </button>
                        <button
                            onClick={() => onSubmit(reason)}
                            disabled={busy}
                            className="flex items-center gap-1.5 px-5 py-2.5 bg-[var(--color-academy-danger-fill)] text-white rounded-xl hover:bg-[var(--color-academy-danger-fill-hover)] transition font-medium text-sm disabled:opacity-40"
                        >
                            {busy ? (
                                <span className="material-symbols-outlined text-lg animate-spin">progress_activity</span>
                            ) : (
                                <span className="material-symbols-outlined text-lg">cancel</span>
                            )}
                            {busy ? "처리 중..." : "반려 처리"}
                        </button>
                    </div>
                </div>
        </AdminModal>
    );
}

function DetailModal({
    app,
    classes,
    onClose,
    onFeedback,
}: {
    app: EnrollApplication;
    classes: ClassInfo[];
    onClose: () => void;
    onFeedback: (type: "success" | "error", message: string) => void;
}) {
    const cfg = STATUS_CONFIG[app.status] || STATUS_CONFIG.PENDING;
    const preferredSlotLabel = formatPreferredSlots(app.preferredSlotKeys, classes);
    const parentPhoneHref = phoneHref(app.parentPhone);

    async function handleCopy(text: string, message: string) {
        try {
            await copyTextToClipboard(text);
            onFeedback("success", message);
        } catch {
            onFeedback("error", "복사 중 문제가 생겼습니다. 직접 선택해서 복사해주세요.");
        }
    }

    return (
        // 목록 개편: 상세는 가운데 모달 대신 오른쪽 패널(모바일은 아래 시트)로 연다. 내용·기능은 그대로.
        <ListDetailPanel onClose={onClose} titleId="application-detail-title" panelClassName="p-4">
                <div className="flex items-center justify-between mb-4">
                    <h2 id="application-detail-title" className="text-lg font-bold text-[var(--color-academy-ink)] flex items-center gap-2">
                        <span className="material-symbols-outlined text-[var(--color-academy-ink)]">assignment</span>
                        수강 신청 상세
                    </h2>
                    <div className="flex items-center gap-1">
                        <span className={`inline-flex items-center gap-1 px-2.5 py-1 rounded text-xs font-semibold ${cfg.color}`}>
                            <span className="material-symbols-outlined text-sm">{cfg.icon}</span>
                            {cfg.label}
                        </span>
                        {/* 패널이 길어도 위에서 바로 닫을 수 있게 */}
                        <button type="button" onClick={onClose} aria-label="상세 닫기" className="inline-flex size-11 items-center justify-center rounded-lg text-[var(--color-academy-muted)] hover:bg-[var(--color-academy-soft)]">
                            <span className="material-symbols-outlined text-xl" aria-hidden="true">close</span>
                        </button>
                    </div>
                </div>

                <div className="mb-5 grid gap-2 sm:grid-cols-3">
                    <a
                        href={parentPhoneHref}
                        className="flex items-center justify-center gap-1.5 rounded-xl border border-[var(--color-academy-line)] px-3 py-2 text-sm font-bold text-[var(--color-academy-muted)] transition hover:border-[var(--color-academy-line-input)] hover:bg-[var(--color-academy-primary-soft)] hover:text-[var(--color-academy-ink)]"
                    >
                        <span className="material-symbols-outlined text-lg">call</span>
                        전화
                    </a>
                    <button
                        type="button"
                        onClick={() => handleCopy(app.parentPhone, `${app.childName} 보호자 연락처를 복사했습니다.`)}
                        className="flex items-center justify-center gap-1.5 rounded-xl border border-[var(--color-academy-line)] px-3 py-2 text-sm font-bold text-[var(--color-academy-muted)] transition hover:border-[var(--color-academy-line-input)] hover:bg-[var(--color-academy-primary-soft)] hover:text-[var(--color-academy-ink)]"
                    >
                        <span className="material-symbols-outlined text-lg">content_copy</span>
                        번호 복사
                    </button>
                    <button
                        type="button"
                        onClick={() =>
                            handleCopy(
                                formatApplicationCopySummary(app, preferredSlotLabel),
                                `${app.childName} 신청 요약을 복사했습니다.`,
                            )
                        }
                        className="flex items-center justify-center gap-1.5 rounded-xl border border-[var(--color-academy-line)] px-3 py-2 text-sm font-bold text-[var(--color-academy-muted)] transition hover:border-[var(--color-academy-line-input)] hover:bg-[var(--color-academy-primary-soft)] hover:text-[var(--color-academy-ink)]"
                    >
                        <span className="material-symbols-outlined text-lg">assignment</span>
                        요약 복사
                    </button>
                </div>

                {app.convertedStudentId && (
                    <div className="mb-5 grid gap-2 rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-success-soft)] p-3 sm:grid-cols-2">
                        <a
                            href={`/admin/students/${app.convertedStudentId}`}
                            className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-[var(--color-academy-primary-soft)] text-[var(--color-academy-primary)] px-3 py-2 text-sm font-black transition hover:bg-[var(--color-academy-line)]"
                        >
                            <span className="material-symbols-outlined text-lg">person_search</span>
                            원생 상세 열기
                        </a>
                        <a
                            href={`/admin/finance?studentId=${encodeURIComponent(app.convertedStudentId)}`}
                            className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-[var(--color-academy-line)] bg-white px-3 py-2 text-sm font-bold text-[var(--color-academy-success)] transition hover:bg-[var(--color-academy-success-soft)]"
                        >
                            <span className="material-symbols-outlined text-lg">receipt_long</span>
                            이 학생 청구·수납
                        </a>
                    </div>
                )}

                <div className="space-y-5">
                    <div>
                        <h3 className="text-xs font-bold text-[var(--color-academy-muted)] uppercase mb-2 flex items-center gap-1">
                            <span className="material-symbols-outlined text-sm">child_care</span>
                            아이 정보
                        </h3>
                        <div className="space-y-1.5 bg-[var(--color-academy-soft)] rounded-lg p-3">
                            <InfoRow label="이름" value={app.childName} />
                            <InfoRow label="생년월일" value={formatDetailDate(app.childBirthDate)} />
                            <InfoRow label="성별" value={app.childGender} />
                            <InfoRow label="학년" value={app.childGrade} />
                            <InfoRow label="학교" value={app.childSchool} />
                            <InfoRow label="전화번호" value={app.childPhone} />
                        </div>
                    </div>

                    <div>
                        <h3 className="text-xs font-bold text-[var(--color-academy-muted)] uppercase mb-2 flex items-center gap-1">
                            <span className="material-symbols-outlined text-sm">person</span>
                            보호자 정보
                        </h3>
                        <div className="space-y-1.5 bg-[var(--color-academy-soft)] rounded-lg p-3">
                            <InfoRow label="이름" value={app.parentName} />
                            <InfoRow label="연락처" value={app.parentPhone} />
                            <InfoRow label="관계" value={app.parentRelation} />
                            <InfoRow label="주소" value={app.address} />
                        </div>
                    </div>

                    <div>
                        <h3 className="text-xs font-bold text-[var(--color-academy-muted)] uppercase mb-2 flex items-center gap-1">
                            <span className="material-symbols-outlined text-sm">sports_basketball</span>
                            수강 정보
                        </h3>
                        <div className="space-y-1.5 bg-[var(--color-academy-soft)] rounded-lg p-3">
                            <InfoRow label="수강 개시일" value={formatEnrollmentStartOn(app.requestedStartOn)} />
                            {!app.requestedStartOn && app.enrollmentMonths && <InfoRow label="기존 신청 월" value={formatEnrollmentMonthsShort(app.enrollmentMonths)} />}
                            <InfoRow label="희망 수업" value={preferredSlotLabel} />
                            <InfoRow label="농구 경험" value={app.basketballExp} />
                            <InfoRow label="유니폼" value={app.uniformSize} />
                            <InfoRow label="납부 방식" value={app.paymentMethod} />
                            <InfoRow label="셔틀" value={app.shuttleNeeded} />
                            <InfoRow label="탑승지" value={app.shuttlePickup} />
                            <InfoRow label="하차지" value={app.shuttleDropoff} />
                            <InfoRow label="셔틀 희망 시간" value={app.shuttleTime} />
                            <InfoRow label="유입경로" value={app.referralSource ? (SOURCE_LABELS[app.referralSource] || app.referralSource) : null} />
                            <InfoRow label="확정 안내 확인" value={app.applicationNoticeConfirmed} />
                            <InfoRow label="셔틀 주의 확인" value={app.shuttleNoticeConfirmed} />
                        </div>
                    </div>

                    {app.shuttleNeeded && <EnrollmentShuttleProgressView progress={app.shuttleProgress} detailed />}

                    {app.memo && (
                        <div>
                            <h3 className="text-xs font-bold text-[var(--color-academy-muted)] uppercase mb-2">보호자 메모</h3>
                            <p className="text-sm text-[var(--color-academy-muted)] bg-[var(--color-academy-soft)] rounded-lg p-3">{app.memo}</p>
                        </div>
                    )}

                    {app.processedAt && (
                        <div>
                            <h3 className="text-xs font-bold text-[var(--color-academy-muted)] uppercase mb-2">처리 정보</h3>
                            <div className="space-y-1.5 bg-[var(--color-academy-soft)] rounded-lg p-3">
                                <InfoRow label="처리일" value={formatDetailDate(app.processedAt)} />
                                <InfoRow label="처리메모" value={app.processedNote} />
                            </div>
                        </div>
                    )}

                    {(app.latestContactAction || app.openFollowUpAt) && (
                        <div>
                            <h3 className="text-xs font-bold text-[var(--color-academy-muted)] uppercase mb-2">최근 운영 이력</h3>
                            <div className="space-y-1.5 rounded-lg bg-[var(--color-academy-soft)] p-3">
                                {app.latestContactAction && (
                                    <>
                                        <InfoRow
                                            label="최근 처리"
                                            value={CONTACT_ACTION_LABELS[app.latestContactAction] ?? app.latestContactAction}
                                        />
                                        <InfoRow label="처리 시간" value={formatDetailDateTime(app.latestContactAt)} />
                                        <InfoRow label="담당자" value={app.latestContactBy} />
                                        <InfoRow label="내용" value={app.latestContactNote} />
                                    </>
                                )}
                                {app.openFollowUpAt && (
                                    <>
                                        <InfoRow label="다음 연락" value={formatDetailDateTime(app.openFollowUpAt)} />
                                        <InfoRow label="연락 메모" value={app.openFollowUpNote} />
                                    </>
                                )}
                            </div>
                        </div>
                    )}
                </div>

                <div className="flex justify-end mt-5">
                    <button
                        onClick={onClose}
                        className="px-5 py-2.5 bg-[var(--color-academy-soft)] text-[var(--color-academy-muted)] rounded-xl hover:bg-[var(--color-academy-line)] transition font-medium text-sm"
                    >
                        닫기
                    </button>
                </div>
        </ListDetailPanel>
    );
}
