"use client";
import { adminErrorText, paymentMethodLabel } from "@/components/admin/adminDisplayText";

import { useCallback, useEffect, useState, useTransition, type FormEvent } from "react";
import Link from "next/link";
import { updateEnrollmentStatus, updateStudentMemo, updateStudent, updateStudentUniform, updatePaymentStatus, enrollStudent } from "@/app/actions/admin";
import { todayKst } from "@/lib/datetime/kst";
import { isCurrentEnrollment } from "@/lib/enrollment/commencement";
import LocationPickerModal, { type MapLocationData } from "@/components/maps/LocationPickerModal";
import AdminModal from "@/components/admin/AdminModal";
import AdminQuickActionMenu from "@/components/admin/AdminQuickActionMenu";
import { useAdminConfirm } from "@/components/admin/AdminConfirmDialog";
import { removeMistakenEnrollment } from "@/app/actions/enrollment-admin-edit";
import EnrollmentMoveModal, { type EnrollmentMoveSource } from "./EnrollmentMoveModal";
import { statusToneClass } from "@/components/admin/StatusBadge";
import { PAYMENT_TONE, TONE_SOLID_CLASS } from "@/lib/ui/statusTones";
import ParentRequestLinkPanel from "./ParentRequestLinkPanel";
import GuardianPanel from "./GuardianPanel";
import AbsencePeriodPanel from "./AbsencePeriodPanel";
// 학부모에게 카카오채널 링크 안내 문자 — 미리보기 후 원장이 «보내기»를 눌러야만 발송
import CustomerNoticeSender from "@/components/admin/CustomerNoticeSender";
import type { StudentTenure } from "@/lib/student-tenure";

type MediaItem = { url: string; type: "image" | "video" };

// 배차용 실제 셔틀 위치(StudentShuttleLocation) — page.tsx가 getStudentShuttleLocations로 전달
type ShuttleLocationRow = {
    kind: string;               // "PICKUP" | "DROPOFF"
    name: string | null;
    address: string | null;
    roadAddress: string | null;
    latitude: number | null;
    longitude: number | null;
    confirmedAt: Date | string | null;
};

const DAY_LABELS: Record<string, string> = {
    Mon: "월", Tue: "화", Wed: "수", Thu: "목", Fri: "금", Sat: "토", Sun: "일",
};
// 출결·납부 상태 색 = 공용 상태 배지 색(학원 변수, 게슈탈트 C-A3)
const ATT_STATUS: Record<string, { label: string; color: string }> = {
    PRESENT: { label: "출석", color: statusToneClass("success") },
    ABSENT: { label: "결석", color: statusToneClass("danger") },
    LATE: { label: "지각", color: statusToneClass("warning") },
    EXCUSED: { label: "사유결석", color: statusToneClass("neutral") },
};
const PAY_STATUS: Record<string, { label: string; color: string }> = {
    PENDING: { label: "미납", color: statusToneClass("warning") },
    PAID: { label: "납부완료", color: statusToneClass("success") },
    OVERDUE: { label: "연체", color: statusToneClass("danger") },
    CANCELED: { label: "취소/이월", color: statusToneClass("neutral") },
};
// 청구서 상태 — 발행·발송(아직 안 냄) 주의 · 연체 위험 · 납부 정상 · 취소 중립 (공용 지도 statusTones)
const INVOICE_STATUS: Record<string, { label: string; color: string }> = {
    ISSUED: { label: "발행", color: statusToneClass(PAYMENT_TONE.ISSUED) },
    SENT: { label: "발송", color: statusToneClass(PAYMENT_TONE.SENT) },
    OVERDUE: { label: "연체", color: statusToneClass(PAYMENT_TONE.OVERDUE) },
    PAID: { label: "납부", color: statusToneClass(PAYMENT_TONE.PAID) },
    CANCELED: { label: "취소", color: statusToneClass(PAYMENT_TONE.CANCELED) },
};
// 수강 상태 — 수강 중 정상 · 휴원 주의 · 퇴원 위험 · 미배정 중립 (뜻은 예전 그대로, 색만 공용 토큰)
const ENROLLMENT_STATUS: Record<string, { label: string; color: string }> = {
    ACTIVE: { label: "수강 중", color: statusToneClass("success") },
    PAUSED: { label: "휴원", color: statusToneClass("warning") },
    WITHDRAWN: { label: "퇴원", color: statusToneClass("danger") },
    NONE: { label: "미배정", color: statusToneClass("neutral") },
};
// 반 줄 토글 — «퇴원»은 학생 단위 말이라 반 단위는 «수강 종료»(그 반만 그만둠, 효력일=종료일 기록). 값(WITHDRAWN)은 그대로
const ENROLLMENT_STATUS_OPTIONS = [
    { value: "ACTIVE", label: "수강 중" },
    { value: "PAUSED", label: "휴원" },
    { value: "WITHDRAWN", label: "수강 종료" },
] as const;

// 상태변경 세그먼트 버튼: 선택된 상태를 의미색(성공/경고/위험)으로 채워 시각적으로 구분한다
const ENROLLMENT_SEG_SELECTED: Record<string, string> = {
    ACTIVE: TONE_SOLID_CLASS.success,
    PAUSED: TONE_SOLID_CLASS.warning,
    WITHDRAWN: TONE_SOLID_CLASS.danger,
};

// 결제 상태 변경 옵션(완납/대기/연체/취소). 완납(PAID)은 이미 완납인 건의 «현재 상태» 표시용으로만 남는다 —
// 서버 updatePaymentStatus 는 PAID 를 거부한다(납부완료는 수납 관리 «납부 처리» 창에서만, 2026-11-08)
const PAY_STATUS_OPTIONS = [
    { value: "PAID", label: "완납" },
    { value: "PENDING", label: "대기" },
    { value: "OVERDUE", label: "연체" },
    { value: "CANCELED", label: "취소" },
] as const;

// 결제 상태 세그먼트: 선택된 상태를 의미색(완납=성공/대기=경고/연체·취소=위험·중립)으로 채운다
const PAY_SEG_SELECTED: Record<string, string> = {
    PAID: "bg-[var(--color-academy-success)] text-white",
    PENDING: "bg-[var(--color-academy-warning)] text-white",
    OVERDUE: "bg-[var(--color-academy-danger)] text-white",
    CANCELED: "bg-[var(--color-academy-muted)] text-white",
};

function toDateStr(d: Date | string | null): string {
    if (!d) return "-";
    const date = typeof d === "string" ? new Date(d) : d;
    return date.toISOString().split("T")[0];
}
// 날짜 인풋(<input type="date">)용 변환 — 값이 없으면 빈 문자열(빈칸 허용)
function toInputDate(d: Date | string | null | undefined): string {
    if (!d) return "";
    const date = typeof d === "string" ? new Date(d) : d;
    if (Number.isNaN(date.getTime())) return "";
    return date.toISOString().split("T")[0];
}
// 편집 인풋 공통 클래스 — 앱 톤(rounded, border, dark 대응, 하드코딩 hex 없음)
const EDIT_INPUT_CLASS = "w-full rounded-lg border border-[var(--color-academy-line)] bg-white px-2.5 py-1.5 text-sm text-[var(--color-academy-ink)] focus:ring-2 focus:ring-[var(--color-academy-primary)]";

function calcAge(birthDate: Date | string): number {
    const birth = typeof birthDate === "string" ? new Date(birthDate) : birthDate;
    const today = new Date();
    let age = today.getFullYear() - birth.getFullYear();
    const m = today.getMonth() - birth.getMonth();
    if (m < 0 || (m === 0 && today.getDate() < birth.getDate())) age--;
    return age;
}
function formatKRW(n: number): string {
    return n.toLocaleString("ko-KR") + "원";
}

function getErrorMessage(error: unknown, fallback: string) {
    return adminErrorText(error, fallback);
}

function SymbolIcon({
    name,
    size = 18,
    className = "",
}: {
    name: string;
    size?: number;
    className?: string;
}) {
    return (
        <span
            className={`material-symbols-outlined leading-none ${className}`}
            style={{ fontSize: `${size}px` }}
            aria-hidden="true"
        >
            {name}
        </span>
    );
}

// 미니 도넛 — KPI 출석률 표시용. 하드코딩 hex 없이 currentColor + Tailwind 색으로 그린다.
// pathLength=100 을 써서 stroke-dasharray 를 퍼센트 단위로 다룬다.
function MiniDonut({ rate, className = "text-[var(--color-academy-success)]" }: { rate: number; className?: string }) {
    const dash = Math.max(0, Math.min(100, rate)); // 0~100 범위로 보정
    return (
        <svg viewBox="0 0 36 36" className="h-12 w-12 flex-none" aria-hidden="true">
            {/* 배경 트랙 (회색) */}
            <circle cx="18" cy="18" r="15.9155" fill="none" strokeWidth="4" stroke="currentColor" className="text-[var(--color-academy-faint)]" />
            {/* 채워진 비율 (의미색) */}
            <circle
                cx="18" cy="18" r="15.9155" fill="none" strokeWidth="4" strokeLinecap="round"
                stroke="currentColor" className={className}
                pathLength={100} strokeDasharray={`${dash} 100`}
                transform="rotate(-90 18 18)"
            />
        </svg>
    );
}

type StudentActivityData = {
    student: {
        id: string; name: string; birthDate: Date | string; gender: string | null;
        memo: string | null; parentId: string; createdAt: Date | string;
        // 새 필드: 학생 추가 정보
        phone: string | null; school: string | null; grade: string | null;
        address: string | null; enrollDate: Date | string | null;
        uniformStatus: string | null; uniformAppliedAt: Date | string | null;
        uniformOrderedAt: Date | string | null; uniformReceivedAt: Date | string | null;
        uniformSource: string | null; uniformNote: string | null;
        parent: { name: string | null; phone: string | null; email: string | null };
    };
    enrollments: {
        id: string; classId: string; status: string; displayStatus?: string; startsOn?: string | null; startsLater?: boolean; createdAt: Date | string;
        className: string; dayOfWeek: string; startTime: string; endTime: string; programName: string;
    }[];
    attendances: { id: string; status: string; date: Date | string; className: string }[];
    payments: {
        id: string;
        amount: number;
        status: string;
        dueDate: Date | string;
        paidDate: Date | string | null;
        type?: string | null;
        description?: string | null;
        method?: string | null;
        invoiceId?: string | null;
        invoiceNo?: string | null;
        invoiceStatus?: string | null;
        invoiceSentAt?: Date | string | null;
        invoiceCheckoutUrl?: string | null;
        issuedAt?: Date | string | null;
        payableUntil?: Date | string | null;
        receiptUrl?: string | null;
    }[];
    attendanceStats: { total: number; present: number; absent: number; late: number; excused: number; rate: number };
    galleryPosts: { id: string; title: string | null; mediaJSON: string; createdAt: Date | string }[];
    monthlyHistory: {
        id: string;
        registrationMonth: string | null;
        year: number | null;
        month: number | null;
        status: string;
        rowCount: number;
        classes: {
            slotKey: string;
            className: string;
            dayOfWeek: string | null;
            startTime: string | null;
            endTime: string | null;
            programName: string | null;
        }[];
        paymentAmount: number;
        tuitionAmount: number;
        shuttleFee: number;
        carryOverAmount: number;
        paymentMethods: string[];
        paymentDate: Date | string | null;
        shuttle: {
            needed: boolean;
            pickup: string | null;
            preferredTime: string | null;
            dropoff: string | null;
        };
        school: string | null;
        grade: string | null;
        changes: { summary: string | null; note: string | null; occurredAt: Date | string | null; createdAt: Date | string | null }[];
    }[];
};

function getEnrollmentStatusInfo(status: string | null) {
    return ENROLLMENT_STATUS[status ?? "NONE"] ?? ENROLLMENT_STATUS.NONE;
}

// 반 한 줄(수강 하나)의 상태 이름 — 학생 대표 상태(퇴원)와 달리 반 단위는 «수강 종료»
function getClassEnrollmentStatusInfo(status: string | null) {
    const info = getEnrollmentStatusInfo(status);
    return status === "WITHDRAWN" ? { ...info, label: "수강 종료" } : info;
}

function getInvoiceStatusInfo(status: string | null | undefined) {
    return status ? INVOICE_STATUS[status] ?? INVOICE_STATUS.ISSUED : null;
}

function getRepresentativeEnrollmentStatus(enrollments: StudentActivityData["enrollments"]) {
    if (enrollments.length === 0) return null;
    // 2026-11-09 새 기준: ACTIVE 수강이 하나라도 있으면 개시일과 무관하게 «수강 중»(공용 판정 isCurrentEnrollment)
    if (enrollments.some((enrollment) => isCurrentEnrollment(enrollment.status))) return "ACTIVE";

    return [...enrollments].sort((a, b) => {
        const bTime = new Date(b.createdAt).getTime();
        const aTime = new Date(a.createdAt).getTime();
        return bTime - aTime;
    }).map((enrollment) => enrollment.displayStatus ?? enrollment.status)[0] ?? null;
}

function sortEnrollments(enrollments: StudentActivityData["enrollments"]) {
    const statusOrder: Record<string, number> = { ACTIVE: 0, PAUSED: 2, WITHDRAWN: 3 };

    return [...enrollments].sort((a, b) => {
        const statusDiff = (statusOrder[a.displayStatus ?? a.status] ?? 9) - (statusOrder[b.displayStatus ?? b.status] ?? 9);
        if (statusDiff !== 0) return statusDiff;
        return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });
}

function formatMonthLabel(history: StudentActivityData["monthlyHistory"][number]) {
    if (history.registrationMonth) return history.registrationMonth;
    if (history.year && history.month) return `${history.year}년 ${history.month}월`;
    if (history.month) return `${history.month}월`;
    return "월 정보 없음";
}

function formatClassLabel(classItem: StudentActivityData["monthlyHistory"][number]["classes"][number]) {
    const day = classItem.dayOfWeek ? DAY_LABELS[classItem.dayOfWeek] || classItem.dayOfWeek : "";
    const time = classItem.startTime ? `${classItem.startTime}${classItem.endTime ? `~${classItem.endTime}` : ""}` : "";
    const prefix = [day, time].filter(Boolean).join(" ");
    return prefix ? `${prefix} · ${classItem.className}` : classItem.className;
}

function getMonthlyPaymentInfo(history: StudentActivityData["monthlyHistory"][number]) {
    const hasUnpaidMethod = history.paymentMethods.some((method) => method.includes("미결제"));
    const hasTuitionGap = history.tuitionAmount > 0 && history.paymentAmount < history.tuitionAmount;

    if (hasUnpaidMethod || hasTuitionGap) {
        return {
            label: "미납 확인",
            className: statusToneClass(PAYMENT_TONE.PENDING),
        };
    }

    if (history.paymentAmount > 0) {
        return {
            label: "납부 완료",
            className: statusToneClass(PAYMENT_TONE.PAID),
        };
    }

    return {
        label: "수납 정보 없음",
        className: statusToneClass("neutral"),
    };
}

function getCurrentMonthHistory(monthlyHistory: StudentActivityData["monthlyHistory"]) {
    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth() + 1;
    return monthlyHistory.find((history) => history.year === currentYear && history.month === currentMonth)
        ?? monthlyHistory[0]
        ?? null;
}

// 공통 카드 컨테이너 클래스 — 기존 앱 카드 관례를 그대로 사용(하드코딩 색 없음)
// 학생의 정보와 편집 동선은 유지하고 역할 공통 카드 표면을 공유한다.
const CARD_CLASS = "academy-panel p-5";

// 섹션 제목 (아이콘 + 텍스트 + 우측 부가정보)
function SectionTitle({ icon, title, right }: { icon: string; title: string; right?: React.ReactNode }) {
    return (
        <div className="mb-3 flex items-center justify-between gap-2">
            <h3 className="flex items-center gap-2 text-sm font-extrabold text-[var(--color-academy-ink)]">
                <SymbolIcon name={icon} size={17} className="text-[var(--color-academy-ink)]" />
                {title}
            </h3>
            {right}
        </div>
    );
}

// 빈 상태 — 섹션이 사라지지 않고 점선 카드로 "아직 없습니다"를 안내한다
function EmptyState({ text }: { text: string }) {
    return (
        <div className="rounded-xl border border-dashed border-[var(--color-academy-line)] px-4 py-6 text-center text-sm text-[var(--color-academy-faint)]">
            {text}
        </div>
    );
}

// 확정일 표시용 간단 포맷(YYYY-MM-DD HH:MM)
function formatShuttleConfirmedAt(value: Date | string | null): string {
    if (!value) return "";
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return "";
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// 배차용 셔틀 위치 한 방향(승차/하차) 블록 — 주소·좌표·확정일 + 위치 설정 버튼
// loc이 없으면 "미설정" 빈 상태를 보여준다. 저장 로직은 부모(saveShuttleLocation)가 담당.
function ShuttleLocationBlock({
    label, icon, loc, onEdit, disabled,
}: {
    label: string;
    icon: string;
    loc: ShuttleLocationRow | null;
    onEdit: () => void;
    disabled: boolean;
}) {
    const hasCoord = loc && loc.latitude != null && loc.longitude != null;
    const addr = loc ? (loc.roadAddress || loc.address || loc.name) : null;
    return (
        <div className="rounded-xl border border-[var(--color-academy-line)] p-3">
            <div className="mb-1.5 flex items-center justify-between gap-2">
                <span className="inline-flex items-center gap-1.5 text-[13px] font-bold text-[var(--color-academy-ink)]">
                    <span className="grid h-6 w-6 shrink-0 place-items-center rounded-lg bg-[var(--color-academy-primary-soft)] text-[var(--color-academy-ink)]">
                        <SymbolIcon name={icon} size={14} />
                    </span>
                    {label}
                </span>
                <button
                    onClick={onEdit}
                    disabled={disabled}
                    className="inline-flex items-center gap-1 rounded-lg border border-[var(--color-academy-line)] px-2 py-1 text-xs font-bold text-[var(--color-academy-muted)] transition hover:bg-[var(--color-academy-soft)] disabled:opacity-50"
                >
                    <SymbolIcon name={hasCoord ? "edit_location" : "add_location_alt"} size={13} />
                    {hasCoord ? "위치 수정" : "위치 설정"}
                </button>
            </div>
            {hasCoord ? (
                <div className="space-y-0.5 pl-8">
                    <p className="text-[13px] text-[var(--color-academy-ink)]">{addr || "주소 미상"}</p>
                    <p className="text-xs text-[var(--color-academy-faint)]">
                        📍 {loc!.latitude!.toFixed(6)}, {loc!.longitude!.toFixed(6)}
                        {loc!.confirmedAt ? ` · ${formatShuttleConfirmedAt(loc!.confirmedAt)} 확정` : ""}
                    </p>
                </div>
            ) : (
                <p className="pl-8 text-[12px] text-[var(--color-academy-faint)]">{label} 위치 미설정</p>
            )}
        </div>
    );
}

// ── 반 추가 선택지용 클래스 타입 (E3) ──────────────────────────────
// 학생관리 목록 페이지가 쓰는 getClasses() 결과의 부분집합만 사용한다(id·이름·요일·시간·프로그램).
type ClassOption = {
    id: string;
    name: string;
    dayOfWeek: string;
    startTime: string;
    endTime: string;
    slotKey?: string | null;
    program: { id: string; name: string } | null;
};

// 요일 정렬 순서(월~일) — 그룹 안에서 요일→시작시각 순으로 나열하기 위함
const DAY_ORDER: Record<string, number> = {
    Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6,
};

// 클래스를 프로그램별로 묶고, 그룹 안에서 요일+시작시각 순으로 정렬
// (StudentManagementClient.groupClassesByProgram 패턴을 상세페이지에 맞게 간소화)
function groupClassesByProgram(classes: ClassOption[]) {
    const groups = new Map<string, { programName: string; classes: ClassOption[] }>();
    for (const c of classes) {
        const key = c.program?.id ?? "__no_program__";
        const name = c.program?.name ?? "미지정 프로그램";
        if (!groups.has(key)) groups.set(key, { programName: name, classes: [] });
        groups.get(key)!.classes.push(c);
    }
    for (const group of groups.values()) {
        group.classes.sort((a, b) => {
            const dayDiff = (DAY_ORDER[a.dayOfWeek] ?? 99) - (DAY_ORDER[b.dayOfWeek] ?? 99);
            if (dayDiff !== 0) return dayDiff;
            return (a.startTime || "").localeCompare(b.startTime || "");
        });
    }
    return Array.from(groups.values());
}

type TabKey = "overview" | "class" | "pay" | "history" | "photo";

export default function StudentDetailClient({
    data: initialData,
    studentId,
    classes = [],
    shuttleLocations = [],
    tenure = null,
}: {
    data?: StudentActivityData;
    studentId?: string;
    // 반 추가 선택지 — page.tsx가 getClasses()로 조회해 전달(신규 prop, 기본 빈 배열로 안전)
    classes?: ClassOption[];
    // 배차용 실제 셔틀 위치 — page.tsx가 getStudentShuttleLocations로 전달(신규 prop)
    shuttleLocations?: ShuttleLocationRow[];
    // 총 재원기간 — page.tsx 가 getStudentTenure 로 전달(자료 없으면 null → 표시 안 함)
    tenure?: StudentTenure | null;
}) {
    const [activityData, setActivityData] = useState<StudentActivityData | null>(initialData ?? null);
    const [loading, setLoading] = useState(!initialData);
    const [error, setError] = useState<string | null>(null);
    const [memo, setMemo] = useState(initialData?.student.memo || "");
    const [isPending, startTransition] = useTransition();
    const [memoSaved, setMemoSaved] = useState(false);
    const [statusUpdatingId, setStatusUpdatingId] = useState<string | null>(null);
    const [statusFeedback, setStatusFeedback] = useState<{ type: "success" | "error"; message: string } | null>(null);
    const [statusChange, setStatusChange] = useState<{
        enrollmentId: string;
        className: string;
        currentStatus: string;
        nextStatus: string;
        effectiveFrom: string;
        reason: string;
    } | null>(null);
    const [statusFormError, setStatusFormError] = useState<string | null>(null);
    // 반 줄 ⋯ 메뉴: 반 이동 창 대상 / 삭제 확인 창(빨간 확인 — 공용 부품)
    const [moveSource, setMoveSource] = useState<EnrollmentMoveSource | null>(null);
    const { confirm: confirmDanger, confirmDialog: dangerConfirmDialog } = useAdminConfirm();
    // ── 반 추가 상태 (E3) ───────────────────────────────────
    // showClassPicker: 반 선택 UI 펼침 / enrollingClassId: 등록 처리 중(disabled)
    // enrollError: 수강 반 추가/상태 변경 실패 사유
    const [showClassPicker, setShowClassPicker] = useState(false);
    const [enrollingClassId, setEnrollingClassId] = useState<string | null>(null);
    const [enrollError, setEnrollError] = useState<string | null>(null);
    // ── 결제 상태 변경 상태 (E2) ──────────────────────────────
    // payEditingId: 상태선택 세그먼트를 펼친 결제 건 / payUpdatingId: 처리 중(disabled)
    // payChangedId: "변경됨" 잠깐 표시 / payErrorId·payError: 실패한 건과 사유(권한 등)
    const [payEditingId, setPayEditingId] = useState<string | null>(null);
    const [payUpdatingId, setPayUpdatingId] = useState<string | null>(null);
    const [payChangedId, setPayChangedId] = useState<string | null>(null);
    const [payError, setPayError] = useState<{ id: string; message: string } | null>(null);
    // 우측 본문 탭 상태 (UI 전용 — 데이터/로직 무관)
    const [activeTab, setActiveTab] = useState<TabKey>("overview");
    const [uniformForm, setUniformForm] = useState(() => ({
        status: initialData?.student.uniformStatus || "",
        appliedAt: toInputDate(initialData?.student.uniformAppliedAt),
        orderedAt: toInputDate(initialData?.student.uniformOrderedAt),
        receivedAt: toInputDate(initialData?.student.uniformReceivedAt),
        source: initialData?.student.uniformSource || "",
        note: initialData?.student.uniformNote || "",
    }));
    const [uniformSaving, setUniformSaving] = useState(false);
    const [uniformFeedback, setUniformFeedback] = useState<string | null>(null);

    // ── 배차용 셔틀 위치 편집 상태 (E4) ──────────────────────────────
    // shuttleLocs: PICKUP/DROPOFF 로컬 상태(저장 성공 시 응답으로 그 카드만 즉시 갱신)
    // pickerKind: 지도 모달을 연 종류 / shuttleSaving: 저장 중(disabled) / shuttleError: 실패 사유
    const [shuttleLocs, setShuttleLocs] = useState<ShuttleLocationRow[]>(shuttleLocations);
    const [pickerKind, setPickerKind] = useState<null | "PICKUP" | "DROPOFF">(null);
    const [shuttleSaving, setShuttleSaving] = useState(false);
    const [shuttleError, setShuttleError] = useState<string | null>(null);
    // 위치 저장 뒤 «명단 N칸 반영» 안내(성공 문구)
    const [shuttleNotice, setShuttleNotice] = useState<string | null>(null);

    // 종류별 현재 위치를 꺼내는 헬퍼
    const pickupLoc = shuttleLocs.find(l => l.kind === "PICKUP") ?? null;
    const dropoffLoc = shuttleLocs.find(l => l.kind === "DROPOFF") ?? null;

    // 지도 모달 확정 → /api/admin/shuttle(studentLocation·confirmLocation)로 저장
    // 서버 updateStudentShuttleLocation은 좌표·주소 필수(없으면 400). 성공 시 응답 location으로 로컬만 갱신.
    async function saveShuttleLocation(kind: "PICKUP" | "DROPOFF", value: MapLocationData) {
        if (!studentId) return;
        setShuttleSaving(true);
        setShuttleError(null);
        setShuttleNotice(null);
        try {
            const response = await fetch("/api/admin/shuttle", {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    resource: "studentLocation",
                    id: studentId,
                    action: "confirmLocation",
                    data: {
                        kind, // "PICKUP" | "DROPOFF"
                        // 장소명(예: «다산이편한세상자이 후문») — 이 이름이 그대로 셔틀 명단 정류장 이름이 된다(2026-11-09 D3).
                        // 예전처럼 도로명·지번을 보내면 정류장이 «다산동 4002-1» 같은 주소로 바뀐다(서버도 거부).
                        name: value.placeName?.trim() ?? "",
                        address: value.address,
                        roadAddress: value.roadAddress,
                        latitude: value.latitude,
                        longitude: value.longitude,
                        placeId: value.placeId,
                        source: value.source,
                        accuracyMeters: value.accuracyMeters,
                    },
                }),
            });
            const result = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(result.error || "위치를 저장하지 못했습니다.");
            // 서버 응답(location)으로 해당 종류 행만 즉시 교체(전체 새로고침 대신)
            const loc = result.location ?? {};
            const nextRow: ShuttleLocationRow = {
                kind,
                name: loc.name ?? value.roadAddress ?? value.address ?? null,
                address: loc.address ?? value.address ?? null,
                roadAddress: loc.roadAddress ?? loc.roadaddress ?? value.roadAddress ?? null,
                latitude: loc.latitude != null ? Number(loc.latitude) : value.latitude,
                longitude: loc.longitude != null ? Number(loc.longitude) : value.longitude,
                confirmedAt: loc.confirmedAt ?? loc.confirmedat ?? new Date().toISOString(),
            };
            setShuttleLocs(prev => [...prev.filter(l => l.kind !== kind), nextRow]);
            setPickerKind(null);
            // 같은 저장에서 셔틀 명단(이번 달부터) 정류장도 바뀐다 — 몇 칸 바뀌었는지 알린다(기사님께는 서버가 알림).
            const applied = result.location?.rosterApplied ?? result.rosterApplied;
            const updated = Number(applied?.updated ?? 0);
            setShuttleNotice(updated > 0 ? `셔틀 명단 ${updated}칸도 «${value.placeName?.trim()}»(으)로 바꿨어요. 정규 셔틀 운행표에서 순서·시각을 확인해 주세요.` : "위치를 저장했어요. (이번 달 셔틀 명단에 이 학생 칸이 없어 명단은 그대로예요)");
        } catch (e) {
            setShuttleError(adminErrorText(e, "위치를 저장하지 못했습니다."));
        } finally {
            setShuttleSaving(false);
        }
    }

    // ── 인라인 편집 상태 (A: 헤더 기본정보 / B: 연락처·프로필) ─────────────
    // 편집 중인 섹션, 저장 전용 트랜지션, 저장 성공/에러 피드백을 별도로 둔다(메모 저장과 충돌 방지)
    const [editSection, setEditSection] = useState<null | "header" | "profile">(null);
    const [isSavingSection, startSectionTransition] = useTransition();
    const [sectionSaved, setSectionSaved] = useState<null | "header" | "profile">(null);
    const [sectionError, setSectionError] = useState<string | null>(null);
    // 학부모 이름·전화를 바꾸려 했지만 로그인 계정이라 서버가 그대로 둔 경우 안내 표시
    const [parentLockedNotice, setParentLockedNotice] = useState(false);
    // 편집 폼: 전체 편집 필드를 한 객체로 관리(편집 안 한 섹션 값은 현재값 유지 → 저장 시 함께 전송)
    const [editForm, setEditForm] = useState({
        name: "", grade: "", school: "", birthDate: "", gender: "", enrollDate: "",
        phone: "", parentName: "", parentPhone: "", parentEmail: "", address: "",
    });

    const loadData = useCallback(async () => {
        if (!studentId) return;

        setLoading(true);
        setError(null);

        try {
            const response = await fetch(`/api/admin/students/${studentId}/activity`, {
                cache: "no-store",
            });

            if (!response.ok) {
                throw new Error("Failed to load student activity.");
            }

            const payload = (await response.json()) as { data?: StudentActivityData };
            if (!payload.data) {
                throw new Error("Student activity is empty.");
            }

            setActivityData(payload.data);
            setMemo(payload.data.student.memo || "");
        } catch (loadError) {
            console.error("Failed to load student activity:", loadError);
            setError("원생 상세 정보를 불러오지 못했습니다.");
        } finally {
            setLoading(false);
        }
    }, [studentId]);

    useEffect(() => {
        if (!initialData) void loadData();
    }, [initialData, loadData]);

    if (loading && !activityData) {
        return (
            <div className="mx-auto max-w-6xl space-y-6">
                <div className="flex items-center gap-4">
                    <div className="h-10 w-10 rounded-lg bg-[var(--color-academy-soft)] animate-pulse" />
                    <div>
                        <div className="h-8 w-40 rounded bg-[var(--color-academy-soft)] animate-pulse" />
                        <div className="mt-2 h-4 w-80 max-w-full rounded bg-[var(--color-academy-soft)] animate-pulse" />
                    </div>
                </div>

                <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
                    {Array.from({ length: 4 }).map((_, index) => (
                        <div
                            key={index}
                            className="rounded-2xl border border-[var(--color-academy-line)] bg-white p-4 shadow-sm"
                        >
                            <div className="h-4 w-20 rounded bg-[var(--color-academy-soft)] animate-pulse" />
                            <div className="mt-3 h-8 w-24 rounded bg-[var(--color-academy-soft)] animate-pulse" />
                            <div className="mt-2 h-3 w-16 rounded bg-[var(--color-academy-soft)] animate-pulse" />
                        </div>
                    ))}
                </div>

                <div className="grid grid-cols-1 gap-6 lg:grid-cols-[320px_1fr]">
                    <div className="space-y-4">
                        {Array.from({ length: 3 }).map((_, index) => (
                            <div
                                key={index}
                                className="rounded-2xl border border-[var(--color-academy-line)] bg-white p-5 shadow-sm"
                            >
                                <div className="h-5 w-32 rounded bg-[var(--color-academy-soft)] animate-pulse" />
                                <div className="mt-4 space-y-3">
                                    {Array.from({ length: 3 }).map((__, rowIndex) => (
                                        <div key={rowIndex} className="h-4 rounded bg-[var(--color-academy-soft)] animate-pulse" />
                                    ))}
                                </div>
                            </div>
                        ))}
                    </div>

                    <div className="space-y-4">
                        {Array.from({ length: 2 }).map((_, sectionIndex) => (
                            <div
                                key={sectionIndex}
                                className="rounded-2xl border border-[var(--color-academy-line)] bg-white p-5 shadow-sm"
                            >
                                <div className="h-5 w-32 rounded bg-[var(--color-academy-soft)] animate-pulse" />
                                <div className="mt-4 space-y-3">
                                    {Array.from({ length: 6 }).map((__, rowIndex) => (
                                        <div key={rowIndex} className="h-10 rounded bg-[var(--color-academy-soft)] animate-pulse" />
                                    ))}
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            </div>
        );
    }

    if (error && !activityData) {
        return (
            <div className="mx-auto max-w-6xl rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-danger-soft)] p-8 text-center">
                <p className="font-bold text-[var(--color-academy-danger)]">{error}</p>
                <button
                    type="button"
                    onClick={() => void loadData()}
                    className="mt-4 rounded-lg bg-[var(--color-academy-primary)] px-4 py-2 text-sm font-bold text-white transition hover:bg-[var(--color-academy-primary-hover)]"
                >
                    다시 불러오기
                </button>
                <div className="mt-4">
                    <Link href="/admin/students" prefetch={false} className="text-sm font-medium text-[var(--color-academy-muted)] hover:text-[var(--color-academy-ink)]">
                        원생 목록으로 돌아가기
                    </Link>
                </div>
            </div>
        );
    }

    if (!activityData) return null;

    const { student, enrollments, attendances, payments, attendanceStats, galleryPosts, monthlyHistory } = activityData;

    function saveMemo() {
        startTransition(async () => {
            await updateStudentMemo(student.id, memo);
            setMemoSaved(true);
            setTimeout(() => setMemoSaved(false), 2000);
        });
    }

    // 편집 시작: 현재 학생 데이터로 폼 전체를 채운 뒤 해당 섹션을 편집모드로 전환
    // (전체를 채워두면 편집 안 한 섹션 값도 현재값 그대로 유지되어 저장 시 안전하게 함께 전송된다)
    function startEditSection(section: "header" | "profile") {
        setEditForm({
            name: student.name ?? "",
            grade: student.grade ?? "",
            school: student.school ?? "",
            birthDate: toInputDate(student.birthDate),
            gender: student.gender ?? "",
            enrollDate: toInputDate(student.enrollDate),
            phone: student.phone ?? "",
            parentName: student.parent.name ?? "",
            parentPhone: student.parent.phone ?? "",
            parentEmail: student.parent.email ?? "",
            address: student.address ?? "",
        });
        setSectionError(null);
        setEditSection(section);
    }

    // 취소: 편집모드 종료(폼 값은 다음 편집 시작 때 현재값으로 다시 채워지므로 되돌릴 필요 없음)
    function cancelEditSection() {
        setEditSection(null);
        setSectionError(null);
    }

    // 저장: 편집 폼 전체를 updateStudent에 전달(편집 안 한 필드는 현재값 그대로) → 성공 시 재조회 + "저장됨"
    function saveSection(section: "header" | "profile") {
        setSectionError(null);
        startSectionTransition(async () => {
            try {
                const result = await updateStudent(student.id, {
                    name: editForm.name,
                    birthDate: editForm.birthDate,
                    gender: editForm.gender || null,
                    parentName: editForm.parentName,
                    parentPhone: editForm.parentPhone || null,
                    parentEmail: editForm.parentEmail || null,
                    phone: editForm.phone || null,
                    school: editForm.school || null,
                    grade: editForm.grade || null,
                    address: editForm.address || null,
                    enrollDate: editForm.enrollDate || null,
                });
                // 학부모 칸을 실제로 고쳤는데 서버가 계정을 안 바꿨으면(로그인·직원 계정) 안내한다
                const parentChanged = editForm.parentName.trim() !== (student.parent.name ?? "").trim()
                    || editForm.parentPhone.trim() !== (student.parent.phone ?? "").trim();
                setParentLockedNotice(parentChanged && !result.parentAccountUpdated);
                await loadData();
                setEditSection(null);
                setSectionSaved(section);
                window.setTimeout(() => setSectionSaved(null), 2000);
            } catch (saveError) {
                setSectionError(getErrorMessage(saveError, "저장에 실패했습니다."));
            }
        });
    }

    // 편집 필드 한 개 갱신 헬퍼
    function setField(key: keyof typeof editForm, value: string) {
        setEditForm((prev) => ({ ...prev, [key]: value }));
    }

    // 섹션별 편집 컨트롤: 읽기모드=연필(edit), 편집모드=저장(check)/취소(close)
    function renderEditControls(section: "header" | "profile") {
        const editing = editSection === section;
        const saving = isSavingSection && editing;
        if (editing) {
            return (
                <div className="flex items-center gap-1">
                    <button
                        type="button"
                        onClick={() => saveSection(section)}
                        disabled={saving}
                        className="inline-flex items-center gap-1 rounded-lg bg-[var(--color-academy-primary)] px-2.5 py-1.5 text-xs font-bold text-white transition hover:bg-[var(--color-academy-primary-hover)] disabled:opacity-50"
                    >
                        <SymbolIcon name="check" size={14} /> {saving ? "저장 중…" : "저장"}
                    </button>
                    <button
                        type="button"
                        onClick={cancelEditSection}
                        disabled={saving}
                        className="inline-flex items-center gap-1 rounded-lg border border-[var(--color-academy-line)] bg-white px-2.5 py-1.5 text-xs font-bold text-[var(--color-academy-muted)] transition hover:bg-[var(--color-academy-line)] disabled:opacity-50"
                    >
                        <SymbolIcon name="close" size={14} /> 취소
                    </button>
                </div>
            );
        }
        return (
            <button
                type="button"
                onClick={() => startEditSection(section)}
                disabled={Boolean(editSection)}
                aria-label="편집"
                className="grid h-8 w-8 place-items-center rounded-lg border border-[var(--color-academy-line)] bg-white text-[var(--color-academy-muted)] transition hover:bg-[var(--color-academy-line)] hover:text-[var(--color-academy-ink)] disabled:opacity-40"
            >
                <SymbolIcon name="edit" size={16} />
            </button>
        );
    }

    function changeEnrollmentStatus(enrollment: StudentActivityData["enrollments"][number], nextStatus: string) {
        if (enrollment.status === nextStatus || statusUpdatingId) return;
        setStatusChange({
            enrollmentId: enrollment.id,
            className: enrollment.className,
            currentStatus: enrollment.status,
            nextStatus,
            effectiveFrom: todayKst(),
            reason: "",
        });
        setStatusFormError(null);
        setStatusFeedback(null);
    }

    async function submitEnrollmentStatusChange(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        if (!statusChange || statusUpdatingId) return;
        const { enrollmentId, nextStatus } = statusChange;
        const formData = new FormData(event.currentTarget);
        const effectiveFrom = String(formData.get("effectiveFrom") || "");
        const reason = String(formData.get("reason") || "");
        if (effectiveFrom > todayKst()) {
            setStatusFormError("미래 효력일은 예약 변경으로 신청해 주세요.");
            return;
        }
        setStatusUpdatingId(enrollmentId);
        setStatusFormError(null);

        try {
            await updateEnrollmentStatus(enrollmentId, nextStatus, { effectiveFrom, reason });
            await loadData();
            setStatusChange(null);
            setStatusFeedback({ type: "success", message: "수강 상태를 변경했습니다." });
            window.setTimeout(() => setStatusFeedback(null), 2500);
        } catch (statusError) {
            setStatusFormError(getErrorMessage(statusError, "수강 상태 변경에 실패했습니다."));
        } finally {
            setStatusUpdatingId(null);
        }
    }

    // 반 추가 — 기존 서버액션 enrollStudent 재사용(ON CONFLICT로 ACTIVE 복원). 성공 시 목록 재조회.
    async function addEnrollment(classId: string) {
        if (!studentId || enrollingClassId) return;

        setEnrollingClassId(classId);
        setEnrollError(null);

        try {
            await enrollStudent(studentId, classId);
            await loadData();
            setShowClassPicker(false);
            setStatusFeedback({ type: "success", message: "수강 반을 추가했습니다." });
            window.setTimeout(() => setStatusFeedback(null), 2500);
        } catch (addError) {
            setEnrollError(getErrorMessage(addError, "반 추가에 실패했습니다."));
        } finally {
            setEnrollingClassId(null);
        }
    }

    // 결제 상태 변경 — 취소(CANCELED)만 되돌리기 어려우므로 window.confirm 한 번, 나머지는 바로 실행
    // 서버 updatePaymentStatus 는 requireFinanceOwner() 권한이라 재무 권한 없으면 throw → 에러 문구로 표면화(조용한 실패 금지)
    async function changePaymentStatus(paymentId: string, currentStatus: string, nextStatus: string) {
        if (currentStatus === nextStatus || payUpdatingId) return;

        const nextInfo = PAY_STATUS[nextStatus] || PAY_STATUS.PENDING;
        // 되돌리기 힘든 변경(취소)만 확인창
        if (nextStatus === "CANCELED" && !window.confirm(`이 결제 건을 '${nextInfo.label}' 상태로 변경할까요?`)) return;

        setPayUpdatingId(paymentId);
        setPayError(null);

        try {
            await updatePaymentStatus(paymentId, nextStatus);
            await loadData();
            setPayEditingId(null);
            // 성공 시 해당 건에 "변경됨" 2초 표시
            setPayChangedId(paymentId);
            window.setTimeout(() => setPayChangedId((prev) => (prev === paymentId ? null : prev)), 2000);
        } catch (payErr) {
            // 권한 없음 등 서버 메시지를 그대로 노출("수납 상태 변경 실패" 등)
            setPayError({ id: paymentId, message: getErrorMessage(payErr, "결제 상태 변경에 실패했습니다.") });
        } finally {
            setPayUpdatingId(null);
        }
    }

    // 잘못 등록한 수강 삭제 — 빨간 확인 창(대상 반·학생 이름) → 서버가 출석·청구·보강 연결을 다시 세고 없을 때만 지운다
    async function deleteEnrollmentRow(enrollment: StudentActivityData["enrollments"][number]) {
        if (statusUpdatingId) return;
        const ok = await confirmDanger({
            title: `"${student.name}" 학생의 «${enrollment.className}» 수강 삭제`,
            description: "잘못 등록한 수강 기록을 없앱니다.\n출석·청구·보강·결석·셔틀 기록이 하나라도 있으면 삭제되지 않아요 — 그만두는 반이면 «수강 종료»를 쓰세요.\n시트·랠리즈에 이미 등록된 경우 그쪽은 직접 정리해 주세요.",
            confirmLabel: "삭제",
            tone: "danger",
        });
        if (!ok) return;
        setStatusUpdatingId(enrollment.id);
        try {
            const result = await removeMistakenEnrollment(enrollment.id);
            if (result.ok) {
                await loadData();
                // 이미 랠리즈(시트)에 반영 확인된 등록이었다면 그쪽은 직접 지워야 한다 — 안내를 닫지 않고 남긴다
                const synced = result.alreadySyncedTargets.map((t) => (t === "RALLYZ" ? "랠리즈" : t === "SHEET" ? "시트" : t));
                setStatusFeedback({ type: "success", message: synced.length > 0
                    ? `«${enrollment.className}» 수강 기록을 삭제했습니다. ${synced.join("·")}에는 이미 등록돼 있어 직접 정리해 주세요.`
                    : `«${enrollment.className}» 수강 기록을 삭제했습니다.` });
                if (synced.length === 0) window.setTimeout(() => setStatusFeedback(null), 2500);
            } else {
                setStatusFeedback({ type: "error", message: result.message });
            }
        } catch {
            setStatusFeedback({ type: "error", message: "수강 삭제에 실패했어요. 잠시 후 다시 해 주세요." });
        } finally {
            setStatusUpdatingId(null);
        }
    }

    // 수강 반 한 줄 카드 — 반명/상태칩 + 세그먼트 상태변경 버튼(수강중/휴원/수강 종료) + ⋯ 메뉴(반 이동·삭제)
    function renderEnrollmentRow(enrollment: StudentActivityData["enrollments"][number]) {
        const info = getClassEnrollmentStatusInfo(enrollment.displayStatus ?? enrollment.status);
        const isUpdating = statusUpdatingId === enrollment.id;

        return (
            <div
                key={enrollment.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-soft)] p-3.5"
            >
                <div className="min-w-0">
                    <p className="flex items-center gap-1.5 text-sm font-extrabold text-[var(--color-academy-ink)]">
                        {enrollment.className}
                        <span className={`shrink-0 rounded px-2 py-0.5 text-xs font-bold ${info.color}`}>{info.label}</span>
                    </p>
                    <p className="mt-1 text-xs text-[var(--color-academy-muted)]">
                        {DAY_LABELS[enrollment.dayOfWeek] || enrollment.dayOfWeek} {enrollment.startTime}~{enrollment.endTime} · {enrollment.programName}
                        {/* 개시일은 안내만(상태는 수강 중 그대로) — 첫 수업 전이면 «개시 예정»으로 */}
                        {enrollment.startsOn && ` · ${enrollment.startsOn} ${enrollment.startsLater ? "개시 예정" : "개시"}`}
                    </p>
                </div>
                {/* 우측: 상태 세그먼트. 퇴원도 이력을 보존하는 상태 변경으로 처리한다. */}
                <div className="flex items-center gap-2">
                {/* 세그먼트 버튼: 입력 양식에서 반·효력일·사유를 확인한 뒤 저장한다. */}
                <div className="inline-flex overflow-hidden rounded-lg border border-[var(--color-academy-line)] bg-white">
                    {ENROLLMENT_STATUS_OPTIONS.map((option) => {
                        const selected = (enrollment.displayStatus ?? enrollment.status) === option.value;
                        return (
                            <button
                                key={option.value}
                                type="button"
                                onClick={() => changeEnrollmentStatus(enrollment, option.value)}
                                disabled={Boolean(statusUpdatingId)}
                                className={`px-3 py-1.5 text-xs font-bold transition disabled:cursor-not-allowed disabled:opacity-60 ${
                                    selected
                                        ? ENROLLMENT_SEG_SELECTED[option.value] ?? "bg-[var(--color-academy-primary)] text-white"
                                        : "text-[var(--color-academy-muted)] hover:bg-[var(--color-academy-soft)] hover:text-[var(--color-academy-ink)]"
                                }`}
                            >
                                {isUpdating && selected ? "저장 중" : option.label}
                            </button>
                        );
                    })}
                </div>
                {/* ⋯ 메뉴: 반 이동(수강 중인 반만) · 삭제(위험 — 메뉴 맨 아래 구분선 밑) */}
                <AdminQuickActionMenu
                    label={`${enrollment.className} 수강 작업`}
                    actions={[
                        {
                            key: "move",
                            label: "반 이동",
                            icon: "swap_horiz",
                            disabled: Boolean(statusUpdatingId) || enrollment.status !== "ACTIVE",
                            onSelect: () => setMoveSource({ enrollmentId: enrollment.id, classId: enrollment.classId, className: enrollment.className, dayOfWeek: enrollment.dayOfWeek, startsOn: enrollment.startsOn ?? null, createdAt: enrollment.createdAt }),
                        },
                        { key: "delete", label: "삭제(잘못 등록)", icon: "delete", tone: "danger", disabled: Boolean(statusUpdatingId), onSelect: () => deleteEnrollmentRow(enrollment) },
                    ]}
                />
                </div>
            </div>
        );
    }

    const sortedEnrollments = sortEnrollments(enrollments);
    // 수강 중 = ACTIVE(승인일부터). 개시일이 미래여도 여기 센다 — 개시일은 청구 시수·출석부 회차에만 쓴다
    const activeEnrollments = sortedEnrollments.filter(e => isCurrentEnrollment(e.status));
    const inactiveEnrollments = sortedEnrollments.filter(e => !isCurrentEnrollment(e.status));
    const representativeStatus = getRepresentativeEnrollmentStatus(enrollments);
    const representativeStatusInfo = getEnrollmentStatusInfo(representativeStatus);
    const totalPaid = payments.filter(p => p.status === "PAID").reduce((s, p) => s + p.amount, 0);
    const unpaid = payments.filter(p => p.status === "PENDING" || p.status === "OVERDUE");
    const currentMonthHistory = getCurrentMonthHistory(monthlyHistory);
    const currentMonthPaymentInfo = currentMonthHistory ? getMonthlyPaymentInfo(currentMonthHistory) : null;
    // 장부 수납(시트 원장) — 금액/청구/셔틀 신호가 있는 월만 노출
    const ledgerHistory = monthlyHistory.filter(
        (h) => h.paymentAmount > 0 || h.tuitionAmount > 0 || h.shuttleFee > 0 || h.paymentMethods.length > 0,
    );

    // media-consent 라우트는 그대로 유지 — 헤더 액션으로만 위치 이동
    const mediaConsentHref = `/admin/students/${studentId ?? student.id}/media-consent`;

    // 출석 통계 막대 정의 (present/late/absent/excused)
    const attBars = [
        { key: "present", label: "출석", value: attendanceStats.present, bar: "bg-[var(--color-academy-success)]", text: "text-[var(--color-academy-success)]" },
        { key: "late", label: "지각", value: attendanceStats.late, bar: "bg-[var(--color-academy-warning)]", text: "text-[var(--color-academy-warning)]" },
        { key: "absent", label: "결석", value: attendanceStats.absent, bar: "bg-[var(--color-academy-danger)]", text: "text-[var(--color-academy-danger)]" },
        { key: "excused", label: "사유", value: attendanceStats.excused, bar: "bg-[var(--color-academy-primary)]", text: "text-[var(--color-academy-muted)]" },
    ];

    const tabs: { key: TabKey; label: string; count?: number }[] = [
        { key: "overview", label: "개요" },
        { key: "class", label: "수강·출결", count: attendances.length },
        { key: "pay", label: "수납" },
        { key: "history", label: "월별 히스토리", count: monthlyHistory.length },
        { key: "photo", label: "사진", count: galleryPosts.length },
    ];

    return (
        <div className="mx-auto max-w-6xl space-y-6">
            {/* 학생의 맥락을 브랜드 헤더로 묶고 기존 편집 기능은 유지한다. */}
            <div className="academy-hero flex flex-wrap items-start gap-4 p-5 md:p-6">
                <Link href="/admin/students" prefetch={false} className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-[var(--color-academy-line)] bg-white text-[var(--color-academy-muted)] shadow-sm transition hover:bg-[var(--color-academy-soft)]">
                    <SymbolIcon name="arrow_back" size={20} />
                </Link>
                <div className="min-w-0 basis-60 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                        <h1 className="academy-heading">
                            {student.name}
                            <span className="ml-1.5 text-lg font-normal text-[var(--color-academy-faint)]">학생</span>
                        </h1>
                        <span className={`rounded px-2.5 py-0.5 text-xs font-bold ${representativeStatusInfo.color}`}>
                            {representativeStatusInfo.label}
                        </span>
                        {activeEnrollments.length > 0 && (
                            <span className="rounded-full bg-[var(--color-academy-primary-soft)] px-2.5 py-0.5 text-xs font-bold text-[var(--color-academy-ink)]">
                                {activeEnrollments.length}개 반
                            </span>
                        )}
                        {sectionSaved === "header" && <span className="text-xs font-medium text-[var(--color-academy-success)]">저장됨</span>}
                    </div>
                    {editSection === "header" ? (
                        // (A) 편집 폼: 이름·학년·학교·생년월일·성별·등록일
                        <div className="mt-3 grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
                            <label className="block">
                                <span className="mb-1 block text-xs font-bold text-[var(--color-academy-faint)]">이름</span>
                                <input type="text" value={editForm.name} onChange={(e) => setField("name", e.target.value)} className={EDIT_INPUT_CLASS} />
                            </label>
                            <label className="block">
                                <span className="mb-1 block text-xs font-bold text-[var(--color-academy-faint)]">학년</span>
                                <input type="text" value={editForm.grade} onChange={(e) => setField("grade", e.target.value)} className={EDIT_INPUT_CLASS} />
                            </label>
                            <label className="block">
                                <span className="mb-1 block text-xs font-bold text-[var(--color-academy-faint)]">학교</span>
                                <input type="text" value={editForm.school} onChange={(e) => setField("school", e.target.value)} className={EDIT_INPUT_CLASS} />
                            </label>
                            <label className="block">
                                <span className="mb-1 block text-xs font-bold text-[var(--color-academy-faint)]">생년월일</span>
                                <input type="date" value={editForm.birthDate} onChange={(e) => setField("birthDate", e.target.value)} className={EDIT_INPUT_CLASS} />
                            </label>
                            <label className="block">
                                <span className="mb-1 block text-xs font-bold text-[var(--color-academy-faint)]">성별</span>
                                <select value={editForm.gender} onChange={(e) => setField("gender", e.target.value)} className={EDIT_INPUT_CLASS}>
                                    <option value="">미지정</option>
                                    <option value="남">남</option>
                                    <option value="여">여</option>
                                </select>
                            </label>
                            <label className="block">
                                <span className="mb-1 block text-xs font-bold text-[var(--color-academy-faint)]">등록일</span>
                                <input type="date" value={editForm.enrollDate} onChange={(e) => setField("enrollDate", e.target.value)} className={EDIT_INPUT_CLASS} />
                            </label>
                            {sectionError && <p className="text-xs font-medium text-[var(--color-academy-danger)] sm:col-span-2 lg:col-span-3">{sectionError}</p>}
                        </div>
                    ) : (
                        // 한 줄 사실: 학년·학교·성별·나이(생년월일)·등록일
                        <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-[var(--color-academy-muted)]">
                            {student.grade && <span>{student.grade}</span>}
                            {student.school && <><span className="text-[var(--color-academy-faint)]">·</span><span>{student.school}</span></>}
                            <span className="text-[var(--color-academy-faint)]">·</span>
                            <span>
                                {student.gender ? `${student.gender} · ` : ""}만 {calcAge(student.birthDate)}세 ({toDateStr(student.birthDate)})
                            </span>
                            <span className="text-[var(--color-academy-faint)]">·</span>
                            <span>등록 {toDateStr(student.enrollDate ?? student.createdAt)}</span>
                            {/* 총 재원기간 한 줄: «재원 3년 2개월 · 실제 수강 38개월 · 첫 등록 2023-10» (자료 없으면 생략) */}
                            {tenure && (
                                <>
                                    <span className="text-[var(--color-academy-faint)]">·</span>
                                    <span className="inline-flex items-center gap-1 font-semibold text-[var(--color-academy-muted)]">
                                        <SymbolIcon name="workspace_premium" size={15} className="text-[var(--color-academy-faint)]" />
                                        {[
                                            tenure.spanLabel ? `재원 ${tenure.spanLabel}` : null,
                                            `실제 수강 ${tenure.actualMonths}개월`,
                                            tenure.firstMonth ? `첫 등록 ${tenure.firstMonth}` : null,
                                        ].filter(Boolean).join(" · ")}
                                    </span>
                                </>
                            )}
                        </p>
                    )}
                </div>
                {/* 우측 액션: 기본정보 편집(연필) + 사진 사용 동의 (media-consent 라우트 유지) */}
                <div className="flex items-center gap-2">
                    {renderEditControls("header")}
                    <Link
                        href={mediaConsentHref}
                        className="inline-flex items-center gap-1.5 rounded-xl border border-[var(--color-academy-line)] bg-white px-3.5 py-2 text-sm font-bold text-[var(--color-academy-muted)] shadow-sm transition hover:bg-[var(--color-academy-line)]"
                    >
                        <SymbolIcon name="photo_camera" size={16} className="text-[var(--color-academy-faint)]" />
                        사진 사용 동의
                    </Link>
                </div>
            </div>

            {/* ===== KPI 4칸 ===== */}
            <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
                {/* 출석률 */}
                <div className="academy-panel flex items-center gap-3 p-4">
                    <MiniDonut rate={attendanceStats.rate} />
                    <div className="min-w-0">
                        <p className="text-xs font-bold uppercase tracking-wide text-[var(--color-academy-faint)]">출석률</p>
                        <p className="text-2xl font-extrabold text-[var(--color-academy-ink)]">
                            {attendanceStats.rate}<span className="text-base">%</span>
                        </p>
                        <p className="truncate text-xs text-[var(--color-academy-faint)]">{attendanceStats.present}/{attendanceStats.total}회 출석</p>
                    </div>
                </div>

                {/* 수강 중 반 수 */}
                <div className="academy-panel flex items-center gap-3 p-4">
                    <div className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-[var(--color-academy-primary-soft)] text-[var(--color-academy-ink)]">
                        <SymbolIcon name="sports_basketball" size={22} />
                    </div>
                    <div className="min-w-0">
                        <p className="text-xs font-bold uppercase tracking-wide text-[var(--color-academy-faint)]">수강 중</p>
                        <p className="text-2xl font-extrabold text-[var(--color-academy-ink)]">
                            {activeEnrollments.length}<span className="text-base"> 개 반</span>
                        </p>
                        <p className="truncate text-xs text-[var(--color-academy-faint)]">이전/휴원 {inactiveEnrollments.length}개</p>
                    </div>
                </div>

                {/* 이번 달 수납 */}
                <div className="academy-panel flex items-center gap-3 p-4">
                    <div className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-[var(--color-academy-soft)] text-[var(--color-academy-muted)]">
                        <SymbolIcon name="account_balance_wallet" size={22} />
                    </div>
                    <div className="min-w-0">
                        <p className="text-xs font-bold uppercase tracking-wide text-[var(--color-academy-faint)]">이번 달 수납</p>
                        {currentMonthHistory ? (
                            <>
                                <p className="flex items-center gap-1.5 text-lg font-extrabold text-[var(--color-academy-ink)]">
                                    <span className={`rounded px-2 py-0.5 text-xs ${currentMonthPaymentInfo?.className ?? PAY_STATUS.PENDING.color}`}>
                                        {currentMonthPaymentInfo?.label ?? "정보 없음"}
                                    </span>
                                </p>
                                <p className="mt-0.5 truncate text-xs text-[var(--color-academy-faint)]">
                                    {formatMonthLabel(currentMonthHistory)} · {formatKRW(currentMonthHistory.paymentAmount)}
                                </p>
                            </>
                        ) : (
                            <p className="text-lg font-extrabold text-[var(--color-academy-faint)]">이력 없음</p>
                        )}
                    </div>
                </div>

                {/* 미납 */}
                <div className="academy-panel flex items-center gap-3 p-4">
                    <div className={`grid h-11 w-11 shrink-0 place-items-center rounded-xl ${unpaid.length > 0 ? "bg-[var(--color-academy-danger-soft)] text-[var(--color-academy-danger)]" : "bg-[var(--color-academy-soft)] text-[var(--color-academy-faint)]"}`}>
                        <SymbolIcon name={unpaid.length > 0 ? "error" : "check_circle"} size={22} />
                    </div>
                    <div className="min-w-0">
                        <p className="text-xs font-bold uppercase tracking-wide text-[var(--color-academy-faint)]">미납</p>
                        <p className="text-2xl font-extrabold text-[var(--color-academy-ink)]">
                            {unpaid.length}<span className="text-base"> 건</span>
                        </p>
                        <p className="truncate text-xs text-[var(--color-academy-faint)]">누적 납부 {formatKRW(totalPaid)}</p>
                    </div>
                </div>
            </div>

            {/* ===== 본문 2열 그리드 ===== */}
            <div className="grid grid-cols-1 gap-6 lg:grid-cols-[320px_1fr] lg:items-start">
                {/* ---- 좌측 고정 레일 ---- */}
                <aside className="space-y-4 lg:sticky lg:top-4">
                    {/* 연락처·프로필 */}
                    <div className={CARD_CLASS}>
                        <SectionTitle
                            icon="contact_page"
                            title="연락처 · 프로필"
                            right={
                                <div className="flex items-center gap-2">
                                    {sectionSaved === "profile" && <span className="text-xs font-medium text-[var(--color-academy-success)]">저장됨</span>}
                                    {renderEditControls("profile")}
                                </div>
                            }
                        />
                        {/* 저장은 됐지만 로그인 계정이라 학부모 이름·전화는 그대로 둔 경우 안내 */}
                        {parentLockedNotice && editSection !== "profile" && (
                            <p role="status" className="mb-2 rounded-lg bg-[var(--color-academy-warning-soft)] px-3 py-2 text-xs font-bold text-[var(--color-academy-warning)]">
                                학부모 로그인 계정의 이름·전화는 바꾸지 않았습니다. 아래 «보호자» 카드에서 고쳐 주세요.
                            </p>
                        )}
                        {editSection === "profile" ? (
                            // (B) 편집 폼: 학생 전화·학부모 이름·학부모 전화·학부모 이메일·주소
                            <div className="space-y-2.5">
                                <label className="block">
                                    <span className="mb-1 block text-xs font-bold text-[var(--color-academy-faint)]">학생 전화</span>
                                    <input type="tel" value={editForm.phone} onChange={(e) => setField("phone", e.target.value)} className={EDIT_INPUT_CLASS} />
                                </label>
                                <label className="block">
                                    <span className="mb-1 block text-xs font-bold text-[var(--color-academy-faint)]">학부모 이름</span>
                                    <input type="text" value={editForm.parentName} onChange={(e) => setField("parentName", e.target.value)} className={EDIT_INPUT_CLASS} />
                                </label>
                                <label className="block">
                                    <span className="mb-1 block text-xs font-bold text-[var(--color-academy-faint)]">학부모 전화</span>
                                    <input type="tel" value={editForm.parentPhone} onChange={(e) => setField("parentPhone", e.target.value)} className={EDIT_INPUT_CLASS} />
                                </label>
                                {/* 학부모 이메일 칸은 2026-11-09 제거 — 로그인 이메일은 학부모가 가입 때 정하고, 관리자 화면에서 바꾸지 않는다 */}
                                <p className="text-xs text-[var(--color-academy-muted)]">
                                    학부모 이름·전화는 학원이 만든 계정(학부모 가입 전)일 때만 바뀝니다. 로그인하는 학부모 계정은 «보호자» 카드에서 고쳐 주세요.
                                </p>
                                <label className="block">
                                    <span className="mb-1 block text-xs font-bold text-[var(--color-academy-faint)]">주소</span>
                                    <input type="text" value={editForm.address} onChange={(e) => setField("address", e.target.value)} className={EDIT_INPUT_CLASS} />
                                </label>
                                {sectionError && <p className="text-xs font-medium text-[var(--color-academy-danger)]">{sectionError}</p>}
                            </div>
                        ) : (
                            <div className="space-y-2.5 text-sm">
                                <div className="flex gap-3">
                                    <span className="w-14 shrink-0 text-xs font-bold text-[var(--color-academy-faint)]">학생</span>
                                    <span className="font-medium text-[var(--color-academy-ink)]">{student.phone || "-"}</span>
                                </div>
                                <div className="flex gap-3">
                                    <span className="w-14 shrink-0 text-xs font-bold text-[var(--color-academy-faint)]">학부모</span>
                                    <span className="font-medium text-[var(--color-academy-ink)]">
                                        {student.parent.name || "-"}
                                        {student.parent.phone && (
                                            <>
                                                {" · "}
                                                <a href={`tel:${student.parent.phone}`} className="text-[var(--color-academy-ink)] hover:underline">
                                                    {student.parent.phone}
                                                </a>
                                            </>
                                        )}
                                    </span>
                                </div>
                                <div className="flex gap-3">
                                    <span className="w-14 shrink-0 text-xs font-bold text-[var(--color-academy-faint)]">이메일</span>
                                    <span className="break-all font-medium text-[var(--color-academy-ink)]">{student.parent.email || "-"}</span>
                                </div>
                                <div className="flex gap-3">
                                    <span className="w-14 shrink-0 text-xs font-bold text-[var(--color-academy-faint)]">주소</span>
                                    <span className="font-medium text-[var(--color-academy-ink)]">{student.address || "-"}</span>
                                </div>
                                {/* 학부모 번호가 있을 때만: 카카오채널 추가 링크 + 계정 연결 방법 안내 (번호는 서버가 학생 id 로 다시 찾는다) */}
                                {student.parent.phone && (
                                    <div className="border-t border-[var(--color-academy-line)] pt-2.5">
                                        <CustomerNoticeSender kind="KAKAO_CHANNEL_INVITE" studentId={student.id} />
                                    </div>
                                )}
                            </div>
                        )}
                    </div>

                    {/* 보호자 여러 명(엄마·할머니 등) 관리 — 계정 전화는 읽기 전용으로만 표시 */}
                    <GuardianPanel studentId={student.id} accountPhone={student.parent.phone ?? null} />

                    {/* 셔틀 (배차용 실제 위치 — StudentShuttleLocation) */}
                    <div className={CARD_CLASS}>
                        <SectionTitle
                            icon="directions_bus"
                            title="셔틀 위치 (배차용)"
                            right={
                                (pickupLoc || dropoffLoc) ? (
                                    <span className="rounded-full px-2 py-0.5 text-xs font-bold text-[var(--color-academy-success)] ring-1 ring-[var(--color-academy-line)]">설정됨</span>
                                ) : (
                                    <span className="rounded-full px-2 py-0.5 text-xs font-bold text-[var(--color-academy-muted)] ring-1 ring-[var(--color-academy-line)]">미설정</span>
                                )
                            }
                        />
                        <div className="space-y-2">
                            {/* 승차(PICKUP) */}
                            <ShuttleLocationBlock
                                label="승차"
                                icon="login"
                                loc={pickupLoc}
                                disabled={shuttleSaving}
                                onEdit={() => { setShuttleError(null); setPickerKind("PICKUP"); }}
                            />
                            {/* 하차(DROPOFF) */}
                            <ShuttleLocationBlock
                                label="하차"
                                icon="logout"
                                loc={dropoffLoc}
                                disabled={shuttleSaving}
                                onEdit={() => { setShuttleError(null); setPickerKind("DROPOFF"); }}
                            />
                        </div>
                        {shuttleError && (
                            <p className="mt-2 text-xs font-semibold text-[var(--color-academy-danger)]">{shuttleError}</p>
                        )}
                        {/* 위치 저장과 함께 셔틀 명단(이번 달부터)에 반영된 결과 안내 */}
                        {shuttleNotice && !shuttleError && (
                            <p role="status" className="mt-2 text-xs font-semibold text-[var(--color-academy-success)]">{shuttleNotice}</p>
                        )}
                        {/* 신청서 희망 셔틀(시트 장부)은 참고용 작은 줄로만 남긴다(혼동 방지) */}
                        {currentMonthHistory?.shuttle.needed && (
                            <p className="mt-2 border-t border-[var(--color-academy-line)] pt-2 text-xs text-[var(--color-academy-faint)]">
                                신청서 희망: 승차 {currentMonthHistory.shuttle.pickup || "미입력"}
                                {currentMonthHistory.shuttle.preferredTime ? ` (${currentMonthHistory.shuttle.preferredTime})` : ""}
                                {" · 하차 "}{currentMonthHistory.shuttle.dropoff || "승차와 동일"}
                                {` · ${formatMonthLabel(currentMonthHistory)} 기준`}
                            </p>
                        )}
                    </div>

                    {/* 학생을 다시 검색하지 않고 현재 학생의 학부모 요청 링크만 관리한다. */}
                    <ParentRequestLinkPanel studentId={student.id} studentName={student.name} />

                    {/* 메모 */}
                    <div className={CARD_CLASS}>
                        <SectionTitle
                            icon="edit_note"
                            title="메모"
                            right={
                                <button
                                    onClick={saveMemo}
                                    disabled={isPending}
                                    className="inline-flex items-center gap-1 rounded-lg bg-[var(--color-academy-primary)] px-3 py-1.5 text-xs font-bold text-white transition hover:bg-[var(--color-academy-primary-hover)] disabled:opacity-50"
                                >
                                    <SymbolIcon name="save" size={14} /> {isPending ? "저장 중..." : "저장"}
                                </button>
                            }
                        />
                        <textarea
                            value={memo}
                            onChange={e => { setMemo(e.target.value); setMemoSaved(false); }}
                            rows={4}
                            placeholder="특이사항·건강 이슈"
                            className="w-full resize-none rounded-xl border border-[var(--color-academy-line)] bg-white px-3 py-2.5 text-sm text-[var(--color-academy-ink)] focus:ring-2 focus:ring-[var(--color-academy-primary)]"
                        />
                        {memoSaved && <p className="mt-2 text-xs font-medium text-[var(--color-academy-success)]">저장됨</p>}
                    </div>
                </aside>

                {/* ---- 우측 본문 (탭) ---- */}
                <section className="min-w-0">
                    {/* 탭 바 */}
                    <div role="tablist" className="mb-4 flex gap-1 overflow-x-auto rounded-2xl border border-[var(--color-academy-line)] bg-[var(--color-academy-soft)] p-1">
                        {tabs.map((tab) => {
                            const selected = activeTab === tab.key;
                            return (
                                <button
                                    key={tab.key}
                                    type="button"
                                    role="tab"
                                    onClick={() => setActiveTab(tab.key)}
                                    aria-selected={selected}
                                    className={`inline-flex flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-xl px-3 py-2 text-sm font-bold transition ${
                                        selected
                                            ? "bg-white text-[var(--color-academy-ink)] shadow-sm"
                                            : "text-[var(--color-academy-muted)] hover:text-[var(--color-academy-ink)]"
                                    }`}
                                >
                                    {tab.label}
                                    {tab.count != null && <span className="text-xs font-extrabold text-[var(--color-academy-faint)]">{tab.count}</span>}
                                </button>
                            );
                        })}
                    </div>

                    {/* ===== 개요 탭 ===== */}
                    {activeTab === "overview" && (
                        <div className="space-y-4">
                            <div className={CARD_CLASS}>
                                <SectionTitle icon="checkroom" title="유니폼 보유 정보" right={<span className="text-xs text-[var(--color-academy-faint)]">세 시트·사이트 주문 대조</span>} />
                                <div className="grid gap-3 sm:grid-cols-2">
                                    <label className="text-xs font-bold text-[var(--color-academy-muted)]">상태
                                        <select value={uniformForm.status} onChange={(e) => setUniformForm((v) => ({ ...v, status: e.target.value }))} className={`${EDIT_INPUT_CLASS} mt-1`}>
                                            <option value="">미확인</option><option value="보유">보유</option><option value="미보유">미보유</option><option value="신청">신청</option><option value="주문">주문</option><option value="수령완료">수령완료</option><option value="미수령">미수령</option><option value="확인보류">확인보류</option><option value="미신청">미신청</option><option value="해당없음">해당없음</option>
                                        </select>
                                    </label>
                                    <label className="text-xs font-bold text-[var(--color-academy-muted)]">출처<input value={uniformForm.source} onChange={(e) => setUniformForm((v) => ({ ...v, source: e.target.value }))} placeholder="가입신청서 · 유니폼 신청서 · 사이트 주문" className={`${EDIT_INPUT_CLASS} mt-1`} /></label>
                                    <label className="text-xs font-bold text-[var(--color-academy-muted)]">신청일<input type="date" value={uniformForm.appliedAt} onChange={(e) => setUniformForm((v) => ({ ...v, appliedAt: e.target.value }))} className={`${EDIT_INPUT_CLASS} mt-1`} /></label>
                                    <label className="text-xs font-bold text-[var(--color-academy-muted)]">주문일<input type="date" value={uniformForm.orderedAt} onChange={(e) => setUniformForm((v) => ({ ...v, orderedAt: e.target.value }))} className={`${EDIT_INPUT_CLASS} mt-1`} /></label>
                                    <label className="text-xs font-bold text-[var(--color-academy-muted)]">수령일<input type="date" value={uniformForm.receivedAt} onChange={(e) => setUniformForm((v) => ({ ...v, receivedAt: e.target.value }))} className={`${EDIT_INPUT_CLASS} mt-1`} /></label>
                                    <label className="text-xs font-bold text-[var(--color-academy-muted)]">대조 메모<input value={uniformForm.note} onChange={(e) => setUniformForm((v) => ({ ...v, note: e.target.value }))} className={`${EDIT_INPUT_CLASS} mt-1`} /></label>
                                </div>
                                <div className="mt-3 flex items-center justify-between gap-3">
                                    <p className="text-xs text-[var(--color-academy-faint)]">미확인 학생은 추측하지 않고 확인보류로 남깁니다.</p>
                                    <button type="button" disabled={uniformSaving} onClick={() => { setUniformSaving(true); setUniformFeedback(null); void updateStudentUniform(student.id, uniformForm).then(() => setUniformFeedback("저장되었습니다.")).catch((e) => setUniformFeedback(adminErrorText(e, "유니폼 정보를 저장하지 못했습니다."))).finally(() => setUniformSaving(false)); }} className="rounded-lg bg-[var(--color-academy-primary)] px-3 py-2 text-xs font-extrabold text-white disabled:opacity-50">{uniformSaving ? "저장 중…" : "유니폼 정보 저장"}</button>
                                </div>
                                {uniformFeedback && <p className="mt-2 text-xs font-bold text-[var(--color-academy-ink)]">{uniformFeedback}</p>}
                            </div>
                            <div className={CARD_CLASS}>
                                <SectionTitle
                                    icon="menu_book"
                                    title="수강 반"
                                    right={
                                        <button
                                            type="button"
                                            onClick={() => { setShowClassPicker((v) => !v); setEnrollError(null); }}
                                            className="inline-flex items-center gap-1 rounded-lg border border-[var(--color-academy-line)] bg-[var(--color-academy-primary-soft)] px-2.5 py-1 text-xs font-bold text-[var(--color-academy-ink)] transition hover:bg-[var(--color-academy-primary-soft)]"
                                        >
                                            <SymbolIcon name={showClassPicker ? "close" : "add"} size={15} />
                                            {showClassPicker ? "닫기" : "반 추가"}
                                        </button>
                                    }
                                />
                                {statusFeedback && (
                                    <p className={`mb-3 rounded-lg px-3 py-2 text-xs font-bold ${
                                        statusFeedback.type === "success"
                                            ? "bg-[var(--color-academy-success-soft)] text-[var(--color-academy-success)]"
                                            : "bg-[var(--color-academy-danger-soft)] text-[var(--color-academy-danger)]"
                                    }`}>
                                        {statusFeedback.message}
                                    </p>
                                )}
                                {enrollError && (
                                    <p className="mb-3 rounded-lg bg-[var(--color-academy-danger-soft)] px-3 py-2 text-xs font-bold text-[var(--color-academy-danger)]">
                                        {enrollError}
                                    </p>
                                )}
                                {/* 반 추가 선택 UI — 이미 수강 중인 반은 제외하고 프로그램별로 묶어 보여준다 */}
                                {showClassPicker && (() => {
                                    const enrolledClassIds = new Set(enrollments.map((e) => e.classId));
                                    const selectable = classes.filter((c) => !enrolledClassIds.has(c.id));
                                    return (
                                        <div className="mb-3 rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-soft)] p-3">
                                            {selectable.length === 0 ? (
                                                <p className="py-2 text-center text-xs text-[var(--color-academy-faint)]">추가할 수 있는 반이 없습니다.</p>
                                            ) : (
                                                <div className="max-h-72 space-y-3 overflow-y-auto">
                                                    {groupClassesByProgram(selectable).map((group) => (
                                                        <div key={group.programName}>
                                                            <p className="mb-1.5 rounded-md bg-[var(--color-academy-soft)] px-2.5 py-1 text-xs font-bold text-[var(--color-academy-muted)]">
                                                                {group.programName} <span className="text-[var(--color-academy-faint)]">({group.classes.length})</span>
                                                            </p>
                                                            <div className="space-y-1">
                                                                {group.classes.map((c) => (
                                                                    <button
                                                                        key={c.id}
                                                                        type="button"
                                                                        onClick={() => void addEnrollment(c.id)}
                                                                        disabled={Boolean(enrollingClassId)}
                                                                        className="flex w-full items-center justify-between gap-2 rounded-lg border border-[var(--color-academy-line)] bg-white px-3 py-2 text-left transition hover:border-[var(--color-academy-primary)] hover:bg-[var(--color-academy-primary-soft)] disabled:opacity-50"
                                                                    >
                                                                        <span className="min-w-0 truncate text-sm font-bold text-[var(--color-academy-ink)]">{c.name}</span>
                                                                        <span className="shrink-0 text-xs text-[var(--color-academy-faint)]">
                                                                            {enrollingClassId === c.id
                                                                                ? "추가 중…"
                                                                                : `${DAY_LABELS[c.dayOfWeek] || c.dayOfWeek} ${c.startTime}~${c.endTime}`}
                                                                        </span>
                                                                    </button>
                                                                ))}
                                                            </div>
                                                        </div>
                                                    ))}
                                                </div>
                                            )}
                                        </div>
                                    );
                                })()}
                                {activeEnrollments.length === 0 ? (
                                    <EmptyState text="수강 중인 반이 없습니다." />
                                ) : (
                                    <div className="space-y-2.5">
                                        {activeEnrollments.map(renderEnrollmentRow)}
                                    </div>
                                )}
                                {inactiveEnrollments.length > 0 && (
                                    <div className="mt-4 border-t border-[var(--color-academy-line)] pt-4">
                                        <p className="mb-2 text-xs font-bold text-[var(--color-academy-muted)]">이전/휴원 이력</p>
                                        <div className="space-y-2.5">
                                            {inactiveEnrollments.map(renderEnrollmentRow)}
                                        </div>
                                    </div>
                                )}
                            </div>

                            <div className={CARD_CLASS}>
                                <SectionTitle
                                    icon="summarize"
                                    title="이번 달 요약"
                                    right={currentMonthHistory && <span className="text-xs font-bold text-[var(--color-academy-faint)]">{formatMonthLabel(currentMonthHistory)}</span>}
                                />
                                {currentMonthHistory ? (
                                    <div className="grid gap-3 sm:grid-cols-2">
                                        <div className="rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-soft)] p-3.5">
                                            <p className="mb-1.5 text-xs font-bold uppercase tracking-wide text-[var(--color-academy-faint)]">수납</p>
                                            <p className="flex items-center gap-1.5 text-lg font-extrabold text-[var(--color-academy-ink)]">
                                                {formatKRW(currentMonthHistory.paymentAmount)}
                                                <span className={`rounded px-2 py-0.5 text-xs ${currentMonthPaymentInfo?.className ?? PAY_STATUS.PENDING.color}`}>
                                                    {currentMonthPaymentInfo?.label ?? "정보 없음"}
                                                </span>
                                            </p>
                                            <p className="mt-1 text-xs text-[var(--color-academy-muted)]">
                                                수강 {formatKRW(currentMonthHistory.tuitionAmount)}
                                                {currentMonthHistory.shuttleFee > 0 ? ` + 셔틀 ${formatKRW(currentMonthHistory.shuttleFee)}` : ""}
                                                {currentMonthHistory.paymentMethods.length > 0 ? ` · ${currentMonthHistory.paymentMethods.join(" · ")}` : ""}
                                                {currentMonthHistory.paymentDate ? ` · ${toDateStr(currentMonthHistory.paymentDate)}` : ""}
                                            </p>
                                        </div>
                                        <div className="rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-soft)] p-3.5">
                                            <p className="mb-1.5 text-xs font-bold uppercase tracking-wide text-[var(--color-academy-faint)]">변동 기록</p>
                                            {currentMonthHistory.changes.length > 0 ? (
                                                <ul className="space-y-1.5">
                                                    {currentMonthHistory.changes.slice(0, 3).map((change, index) => (
                                                        <li key={`cm-change-${index}`} className="border-l-2 border-[var(--color-academy-primary)] pl-2.5 text-xs text-[var(--color-academy-muted)]">
                                                            {change.summary || change.note}
                                                            {change.occurredAt ? ` · ${toDateStr(change.occurredAt)}` : ""}
                                                        </li>
                                                    ))}
                                                </ul>
                                            ) : (
                                                <p className="text-xs text-[var(--color-academy-faint)]">변동 기록이 없습니다.</p>
                                            )}
                                        </div>
                                    </div>
                                ) : (
                                    <EmptyState text="최신 월별 이력이 없습니다." />
                                )}
                            </div>
                        </div>
                    )}

                    {/* ===== 수강·출결 탭 ===== */}
                    {activeTab === "class" && (
                        <div className="space-y-4">
                            {/* 기간 결석(부상·질병) — 휴원 대신 그 기간 수업일만 결석으로. 대상 반 기본값 = 수강 중 반 전부 */}
                            <AbsencePeriodPanel
                                studentId={student.id}
                                studentName={student.name}
                                activeClasses={enrollments
                                    .filter((e) => e.status === "ACTIVE")
                                    .map((e) => ({ classId: e.classId, className: e.className, dayLabel: DAY_LABELS[e.dayOfWeek] ?? e.dayOfWeek, startTime: e.startTime }))}
                            />
                            <div className={CARD_CLASS}>
                                <SectionTitle
                                    icon="bar_chart"
                                    title="출석 통계"
                                    right={<span className="text-xs text-[var(--color-academy-faint)]">전체 {attendanceStats.total}회</span>}
                                />
                                {attendanceStats.total === 0 ? (
                                    <EmptyState text="출석 통계가 없습니다." />
                                ) : (
                                    <div className="space-y-2.5">
                                        {attBars.map((b) => {
                                            const pct = attendanceStats.total > 0 ? Math.round((b.value / attendanceStats.total) * 100) : 0;
                                            return (
                                                <div key={b.key} className="flex items-center gap-3 text-xs">
                                                    <span className={`w-9 shrink-0 font-bold ${b.text}`}>{b.label}</span>
                                                    <div className="h-2 flex-1 overflow-hidden rounded-full bg-[var(--color-academy-soft)]">
                                                        <span className={`block h-full rounded-full ${b.bar}`} style={{ width: `${pct}%` }} />
                                                    </div>
                                                    <span className="w-8 shrink-0 text-right font-medium text-[var(--color-academy-muted)]">{b.value}</span>
                                                </div>
                                            );
                                        })}
                                    </div>
                                )}
                            </div>

                            <div className={CARD_CLASS}>
                                <SectionTitle
                                    icon="event_available"
                                    title="최근 출결"
                                    right={<span className="text-xs text-[var(--color-academy-faint)]">최근 50건</span>}
                                />
                                {attendances.length === 0 ? (
                                    <EmptyState text="출결 기록이 없습니다." />
                                ) : (
                                    <div className="divide-y divide-[var(--color-academy-line)]">
                                        {attendances.map((a) => {
                                            const info = ATT_STATUS[a.status] || ATT_STATUS.PRESENT;
                                            return (
                                                <div key={a.id} className="flex items-center gap-3 py-2.5">
                                                    <span className="w-16 shrink-0 text-xs font-bold text-[var(--color-academy-muted)]">{toDateStr(a.date)}</span>
                                                    <span className="min-w-0 flex-1 truncate text-sm text-[var(--color-academy-ink)]">{a.className}</span>
                                                    <span className={`shrink-0 rounded px-2 py-0.5 text-xs font-bold ${info.color}`}>{info.label}</span>
                                                </div>
                                            );
                                        })}
                                    </div>
                                )}
                            </div>
                        </div>
                    )}

                    {/* ===== 수납 탭 (두 출처 분리) ===== */}
                    {activeTab === "pay" && (
                        <div className="space-y-4">
                            {/* 청구·납부(시스템) */}
                            <div className={CARD_CLASS}>
                                <SectionTitle
                                    icon="receipt_long"
                                    title="청구·납부"
                                    right={<span className="rounded-full bg-[var(--color-academy-soft)] px-2 py-0.5 text-xs font-bold text-[var(--color-academy-muted)]">시스템</span>}
                                />
                                {payments.length === 0 ? (
                                    <EmptyState text="청구·납부 내역이 없습니다." />
                                ) : (
                                    <div className="divide-y divide-[var(--color-academy-line)]">
                                        {payments.map((p) => {
                                            const info = PAY_STATUS[p.status] || PAY_STATUS.PENDING;
                                            const invoiceInfo = getInvoiceStatusInfo(p.invoiceStatus);
                                            const editing = payEditingId === p.id;      // 이 건의 상태선택 세그먼트 펼침 여부
                                            const updating = payUpdatingId === p.id;    // 이 건 처리 중(disabled)
                                            const changed = payChangedId === p.id;      // 방금 변경 성공("변경됨")
                                            const rowError = payError?.id === p.id ? payError.message : null;
                                            return (
                                                <div key={p.id} className="py-3">
                                                  <div className="flex items-start gap-3">
                                                    <span className="w-16 shrink-0 pt-0.5 text-xs font-bold text-[var(--color-academy-muted)]">{toDateStr(p.dueDate)}</span>
                                                    <div className="min-w-0 flex-1">
                                                        <p className="flex flex-wrap items-center gap-1.5 text-sm font-medium text-[var(--color-academy-ink)]">
                                                            {p.description || "수강료"}
                                                            {p.invoiceNo && <span className="text-xs font-bold text-[var(--color-academy-muted)]">· {p.invoiceNo}</span>}
                                                            {invoiceInfo && (
                                                                <span className={`rounded px-2 py-0.5 text-xs font-bold ${invoiceInfo.color}`}>{invoiceInfo.label}</span>
                                                            )}
                                                        </p>
                                                        <p className="mt-0.5 text-xs text-[var(--color-academy-faint)]">
                                                            {p.method ? `${paymentMethodLabel(p.method)} · ` : ""}
                                                            {p.paidDate ? `${toDateStr(p.paidDate)} 납부` : "미납부"}
                                                        </p>
                                                        {p.invoiceCheckoutUrl && (
                                                            <a
                                                                href={p.invoiceCheckoutUrl}
                                                                target="_blank"
                                                                rel="noreferrer"
                                                                className="mt-1 inline-flex text-xs font-bold text-[var(--color-academy-ink)] hover:underline"
                                                            >
                                                                납부 링크 열기 ↗
                                                            </a>
                                                        )}
                                                    </div>
                                                    <div className="shrink-0 text-right">
                                                        <p className="text-sm font-extrabold text-[var(--color-academy-ink)]">{formatKRW(p.amount)}</p>
                                                        {/* 상태 칩 + 상태변경 연필 버튼(+ 변경됨 표시) */}
                                                        <div className="mt-1 flex items-center justify-end gap-1.5">
                                                            {changed && <span className="text-xs font-bold text-[var(--color-academy-success)]">변경됨</span>}
                                                            <span className={`inline-flex rounded px-2 py-0.5 text-xs font-bold ${info.color}`}>{info.label}</span>
                                                            <button
                                                                type="button"
                                                                onClick={() => { setPayError(null); setPayEditingId(editing ? null : p.id); }}
                                                                disabled={updating}
                                                                aria-label="결제 상태 변경"
                                                                className="grid h-6 w-6 place-items-center rounded-md border border-[var(--color-academy-line)] bg-white text-[var(--color-academy-muted)] transition hover:bg-[var(--color-academy-soft)] hover:text-[var(--color-academy-ink)] disabled:opacity-40"
                                                            >
                                                                <SymbolIcon name={editing ? "close" : "edit"} size={13} />
                                                            </button>
                                                        </div>
                                                    </div>
                                                  </div>
                                                  {/* 상태 선택 세그먼트(펼쳤을 때만) — 선택 즉시 changePaymentStatus 호출 */}
                                                  {editing && (
                                                    <div className="mt-2.5 pl-[76px]">
                                                        <div className="inline-flex overflow-hidden rounded-lg border border-[var(--color-academy-line)] bg-white">
                                                            {/* 완납은 여기서 바로 고르지 않는다(2026-11-08) — 수납 관리 «납부 처리»에서 방법·근거를 남겨야 한다 */}
                                                            {PAY_STATUS_OPTIONS.filter((option) => option.value !== "PAID" || p.status === "PAID").map((option) => {
                                                                const selected = p.status === option.value;
                                                                return (
                                                                    <button
                                                                        key={option.value}
                                                                        type="button"
                                                                        onClick={() => void changePaymentStatus(p.id, p.status, option.value)}
                                                                        disabled={updating || selected}
                                                                        className={`px-2.5 py-1 text-xs font-bold transition disabled:cursor-default ${
                                                                            selected
                                                                                ? PAY_SEG_SELECTED[option.value]
                                                                                : "text-[var(--color-academy-muted)] hover:bg-[var(--color-academy-soft)] disabled:opacity-60"
                                                                        }`}
                                                                    >
                                                                        {option.label}
                                                                    </button>
                                                                );
                                                            })}
                                                        </div>
                                                        {updating && <span className="ml-2 text-xs font-medium text-[var(--color-academy-faint)]">변경 중…</span>}
                                                        {p.status !== "PAID" && (
                                                            <p className="mt-1.5 text-xs text-[var(--color-academy-muted)]">
                                                                납부완료는 <Link href="/admin/finance" prefetch={false} className="font-bold text-[var(--color-academy-ink)] underline">수납 관리</Link>의 «납부처리»에서 결제 방법과 함께 기록해요.
                                                            </p>
                                                        )}
                                                    </div>
                                                  )}
                                                  {/* 실패 사유(권한 없음 등) 표면화 — 조용한 실패 금지 */}
                                                  {rowError && (
                                                    <p className="mt-2 pl-[76px] text-xs font-medium text-[var(--color-academy-danger)]">{rowError}</p>
                                                  )}
                                                </div>
                                            );
                                        })}
                                    </div>
                                )}
                            </div>

                            {/* 장부 수납(시트 원장) */}
                            <div className={CARD_CLASS}>
                                <SectionTitle
                                    icon="menu_book"
                                    title="장부 수납"
                                    right={<span className="rounded-full bg-[var(--color-academy-soft)] px-2 py-0.5 text-xs font-bold text-[var(--color-academy-muted)]">시트 원장</span>}
                                />
                                {ledgerHistory.length === 0 ? (
                                    <EmptyState text="시트 원장에서 이관된 수납 기록이 없습니다." />
                                ) : (
                                    <div className="divide-y divide-[var(--color-academy-line)]">
                                        {ledgerHistory.map((h) => (
                                            <div key={h.id} className="flex items-start gap-3 py-3">
                                                <span className="w-16 shrink-0 pt-0.5 text-xs font-bold text-[var(--color-academy-muted)]">{formatMonthLabel(h)}</span>
                                                <div className="min-w-0 flex-1">
                                                    <p className="text-sm font-medium text-[var(--color-academy-ink)]">
                                                        수강 {formatKRW(h.tuitionAmount)}
                                                        {h.shuttleFee > 0 ? ` · 셔틀 ${formatKRW(h.shuttleFee)}` : ""}
                                                    </p>
                                                    <p className="mt-0.5 text-xs text-[var(--color-academy-faint)]">
                                                        {h.paymentMethods.length > 0 ? h.paymentMethods.join(" · ") : "결제수단 없음"}
                                                        {h.carryOverAmount > 0 ? ` · 이월 ${formatKRW(h.carryOverAmount)}` : ""}
                                                        {h.paymentDate ? ` · ${toDateStr(h.paymentDate)}` : ""}
                                                    </p>
                                                </div>
                                                <p className="shrink-0 text-right text-sm font-extrabold text-[var(--color-academy-ink)]">{formatKRW(h.paymentAmount)}</p>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>
                        </div>
                    )}

                    {/* ===== 월별 히스토리 탭 ===== */}
                    {activeTab === "history" && (
                        <div className={CARD_CLASS}>
                            <SectionTitle
                                icon="history"
                                title="월별 운영 히스토리"
                            />
                            {monthlyHistory.length === 0 ? (
                                <EmptyState text="월별 이관 이력이 없습니다." />
                            ) : (
                                <div className="space-y-2.5">
                                    {monthlyHistory.map((history, historyIndex) => {
                                        const statusInfo = getEnrollmentStatusInfo(history.status);
                                        const paymentInfo = getMonthlyPaymentInfo(history);
                                        return (
                                            <details
                                                key={history.id}
                                                open={historyIndex === 0}
                                                className="group overflow-hidden rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-soft)]"
                                            >
                                                <summary className="flex cursor-pointer list-none items-center gap-3 p-3.5 [&::-webkit-details-marker]:hidden">
                                                    <span className="w-20 shrink-0 text-sm font-extrabold text-[var(--color-academy-ink)]">{formatMonthLabel(history)}</span>
                                                    <div className="flex min-w-0 flex-1 flex-wrap gap-1.5">
                                                        <span className={`rounded px-2 py-0.5 text-xs font-bold ${statusInfo.color}`}>{statusInfo.label}</span>
                                                        {/* 반 뱃지 전체 노출 (기존 +N 숨김 개선) */}
                                                        {history.classes.map((c) => (
                                                            <span key={c.slotKey} className="rounded-full bg-[var(--color-academy-primary-soft)] px-2 py-0.5 text-xs font-bold text-[var(--color-academy-ink)]">
                                                                {c.className}
                                                            </span>
                                                        ))}
                                                    </div>
                                                    <span className="shrink-0 text-sm font-extrabold text-[var(--color-academy-ink)]">{formatKRW(history.paymentAmount)}</span>
                                                    <SymbolIcon name="chevron_right" size={18} className="shrink-0 text-[var(--color-academy-faint)] transition-transform group-open:rotate-90" />
                                                </summary>
                                                <div className="space-y-2.5 border-t border-dashed border-[var(--color-academy-line)] p-3.5">
                                                    <div className="grid gap-3 sm:grid-cols-2">
                                                        <div>
                                                            <p className="text-xs font-bold uppercase tracking-wide text-[var(--color-academy-faint)]">반</p>
                                                            <p className="mt-1 text-xs text-[var(--color-academy-muted)]">
                                                                {history.classes.length > 0 ? history.classes.map(formatClassLabel).join(" · ") : "반 정보 없음"}
                                                            </p>
                                                            <p className="mt-0.5 text-xs text-[var(--color-academy-faint)]">원장 {history.rowCount}줄{history.grade ? ` · ${history.grade}` : ""}</p>
                                                        </div>
                                                        <div>
                                                            <p className="text-xs font-bold uppercase tracking-wide text-[var(--color-academy-faint)]">수납</p>
                                                            <p className="mt-1 flex items-center gap-1.5 text-xs text-[var(--color-academy-muted)]">
                                                                납부 {formatKRW(history.paymentAmount)} / 청구 {formatKRW(history.tuitionAmount)}
                                                                <span className={`rounded px-2 py-0.5 text-xs font-bold ${paymentInfo.className}`}>{paymentInfo.label}</span>
                                                            </p>
                                                            <p className="mt-0.5 text-xs text-[var(--color-academy-faint)]">
                                                                {history.paymentMethods.length > 0 ? history.paymentMethods.join(" · ") : "결제수단 없음"}
                                                                {history.shuttleFee > 0 ? ` · 셔틀 ${formatKRW(history.shuttleFee)}` : ""}
                                                                {history.carryOverAmount > 0 ? ` · 이월 ${formatKRW(history.carryOverAmount)}` : ""}
                                                            </p>
                                                        </div>
                                                    </div>
                                                    {history.changes.length > 0 && (
                                                        <div className="space-y-1.5">
                                                            {history.changes.slice(0, 3).map((change, index) => (
                                                                <p key={`${history.id}-change-${index}`} className="border-l-2 border-[var(--color-academy-primary)] pl-2.5 text-xs text-[var(--color-academy-muted)]">
                                                                    {change.summary || change.note}
                                                                    {change.occurredAt ? ` · ${toDateStr(change.occurredAt)}` : ""}
                                                                </p>
                                                            ))}
                                                        </div>
                                                    )}
                                                </div>
                                            </details>
                                        );
                                    })}
                                </div>
                            )}
                        </div>
                    )}

                    {/* ===== 사진 탭 ===== */}
                    {activeTab === "photo" && (
                        <div className={CARD_CLASS}>
                            <SectionTitle
                                icon="image"
                                title="수업 사진"
                                right={<span className="text-xs text-[var(--color-academy-faint)]">최근 {galleryPosts.length}건</span>}
                            />
                            {galleryPosts.length === 0 ? (
                                <EmptyState text="등록된 수업 사진이 없습니다." />
                            ) : (
                                <div className="grid grid-cols-3 gap-2">
                                    {galleryPosts.map((g) => {
                                        let media: MediaItem[] = [];
                                        try { media = JSON.parse(g.mediaJSON); } catch {}
                                        const first = media[0];
                                        if (!first) return null;
                                        return (
                                            <div key={g.id} className="aspect-square overflow-hidden rounded-xl bg-[var(--color-academy-soft)]">
                                                {first.type === "image" ? (
                                                    <img src={first.url} alt={g.title || ""} className="h-full w-full object-cover" />
                                                ) : (
                                                    <video src={first.url} className="h-full w-full object-cover" muted />
                                                )}
                                            </div>
                                        );
                                    })}
                                </div>
                            )}
                        </div>
                    )}
                </section>
            </div>

            {statusChange && (
                <AdminModal
                    titleId="enrollment-status-change-title"
                    panelClassName="max-w-md p-6"
                    onClose={() => { if (!statusUpdatingId) setStatusChange(null); }}
                    closeOnBackdrop={!statusUpdatingId}
                >
                    <form onSubmit={(event) => void submitEnrollmentStatusChange(event)} className="space-y-4">
                        <h2 id="enrollment-status-change-title" className="text-xl font-extrabold text-[var(--color-academy-ink)]">
                            수강 상태 변경
                        </h2>
                        <p className="text-sm text-[var(--color-academy-muted)]">
                            {statusChange.className} · {getClassEnrollmentStatusInfo(statusChange.currentStatus).label} → {getClassEnrollmentStatusInfo(statusChange.nextStatus).label}
                        </p>
                        <label className="block text-sm font-bold text-[var(--color-academy-muted)]">
                            효력일
                            <input
                                type="date"
                                name="effectiveFrom"
                                required
                                max={todayKst()}
                                value={statusChange.effectiveFrom}
                                onChange={(event) => setStatusChange((current) => current && ({ ...current, effectiveFrom: event.target.value }))}
                                data-admin-modal-initial-focus="true"
                                className="mt-1 min-h-11 w-full rounded-xl border border-[var(--color-academy-line)] bg-white px-3 text-[var(--color-academy-ink)]"
                            />
                        </label>
                        <label className="block text-sm font-bold text-[var(--color-academy-muted)]">
                            변경 사유 (선택)
                            <textarea
                                name="reason"
                                value={statusChange.reason}
                                onChange={(event) => setStatusChange((current) => current && ({ ...current, reason: event.target.value }))}
                                rows={3}
                                className="mt-1 w-full rounded-xl border border-[var(--color-academy-line)] bg-white p-3 text-[var(--color-academy-ink)]"
                            />
                        </label>
                        {statusFormError && <p role="alert" className="text-sm font-bold text-[var(--color-academy-danger)]">{statusFormError}</p>}
                        <div className="flex justify-end gap-2">
                            <button type="button" onClick={() => setStatusChange(null)} disabled={Boolean(statusUpdatingId)} className="min-h-11 rounded-xl border border-[var(--color-academy-line)] px-4 font-bold disabled:opacity-60">취소</button>
                            <button type="submit" disabled={Boolean(statusUpdatingId)} className="min-h-11 rounded-xl bg-[var(--color-academy-primary)] px-5 font-black text-white disabled:opacity-60">
                                {statusUpdatingId ? "저장 중…" : "변경 저장"}
                            </button>
                        </div>
                    </form>
                </AdminModal>
            )}

            {/* 반 이동 창 · 삭제 빨간 확인 창 */}
            {moveSource && (
                <EnrollmentMoveModal
                    studentName={student.name}
                    source={moveSource}
                    onClose={() => setMoveSource(null)}
                    onMoved={(message) => {
                        setMoveSource(null);
                        void loadData();
                        setStatusFeedback({ type: "success", message });
                        window.setTimeout(() => setStatusFeedback(null), 3000);
                    }}
                />
            )}
            {dangerConfirmDialog}

            {/* 배차용 셔틀 위치 지도 선택 모달 — 핀(좌표) 확정 시에만 저장(서버가 좌표 필수 검증) */}
            {pickerKind && (
                <LocationPickerModal
                    title={`셔틀 ${pickerKind === "PICKUP" ? "승차" : "하차"} 위치`}
                    initialValue={(() => {
                        const loc = pickerKind === "PICKUP" ? pickupLoc : dropoffLoc;
                        return loc && loc.latitude != null && loc.longitude != null
                            ? { address: loc.roadAddress || loc.address || "", placeName: loc.name ?? undefined, latitude: loc.latitude, longitude: loc.longitude, source: "MAP_PIN" as const }
                            : undefined;
                    })()}
                    // 장소명 필수 — 아이가 타는 곳 이름이 셔틀 명단 정류장 이름이 된다(원생 등록·학부모 링크와 같은 규칙).
                    requirePlaceName
                    confirmPending={shuttleSaving}
                    onConfirm={(loc) => void saveShuttleLocation(pickerKind, loc)}
                    onClose={() => setPickerKind(null)}
                />
            )}
        </div>
    );
}
