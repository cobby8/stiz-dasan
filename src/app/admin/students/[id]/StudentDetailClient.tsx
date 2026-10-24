"use client";

import { useCallback, useEffect, useState, useTransition, type FormEvent } from "react";
import Link from "next/link";
import { updateEnrollmentStatus, updateStudentMemo, updateStudent, updatePaymentStatus, enrollStudent } from "@/app/actions/admin";
import { todayKst } from "@/lib/datetime/kst";
import LocationPickerModal, { type MapLocationData } from "@/components/maps/LocationPickerModal";
import AdminModal from "@/components/admin/AdminModal";
import ParentRequestLinkPanel from "./ParentRequestLinkPanel";
import GuardianPanel from "./GuardianPanel";

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
const ATT_STATUS: Record<string, { label: string; color: string }> = {
    PRESENT: { label: "출석", color: "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200 dark:bg-emerald-300/10 dark:text-emerald-100 dark:ring-emerald-300/20" },
    ABSENT: { label: "결석", color: "bg-red-50 text-red-700 ring-1 ring-red-200 dark:bg-red-300/10 dark:text-red-100 dark:ring-red-300/20" },
    LATE: { label: "지각", color: "bg-amber-50 text-amber-700 ring-1 ring-amber-200 dark:bg-amber-300/10 dark:text-amber-100 dark:ring-amber-300/20" },
    EXCUSED: { label: "사유결석", color: "bg-sky-50 text-sky-700 ring-1 ring-sky-200 dark:bg-sky-300/10 dark:text-sky-100 dark:ring-sky-300/20" },
};
const PAY_STATUS: Record<string, { label: string; color: string }> = {
    PENDING: { label: "미납", color: "bg-amber-50 text-amber-700 ring-1 ring-amber-200 dark:bg-amber-300/10 dark:text-amber-100 dark:ring-amber-300/20" },
    PAID: { label: "납부완료", color: "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200 dark:bg-emerald-300/10 dark:text-emerald-100 dark:ring-emerald-300/20" },
    OVERDUE: { label: "연체", color: "bg-red-50 text-red-700 ring-1 ring-red-200 dark:bg-red-300/10 dark:text-red-100 dark:ring-red-300/20" },
    CANCELED: { label: "취소/이월", color: "bg-gray-50 text-gray-600 ring-1 ring-gray-200 dark:bg-gray-900 dark:text-gray-300 dark:ring-gray-700" },
};
const INVOICE_STATUS: Record<string, { label: string; color: string }> = {
    ISSUED: { label: "발행", color: "bg-sky-50 text-sky-700 ring-1 ring-sky-200 dark:bg-sky-300/10 dark:text-sky-100 dark:ring-sky-300/20" },
    SENT: { label: "발송", color: "bg-indigo-50 text-indigo-700 ring-1 ring-indigo-200 dark:bg-indigo-300/10 dark:text-indigo-100 dark:ring-indigo-300/20" },
    OVERDUE: { label: "연체", color: "bg-red-50 text-red-700 ring-1 ring-red-200 dark:bg-red-300/10 dark:text-red-100 dark:ring-red-300/20" },
    PAID: { label: "납부", color: "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200 dark:bg-emerald-300/10 dark:text-emerald-100 dark:ring-emerald-300/20" },
    CANCELED: { label: "취소", color: "bg-gray-50 text-gray-600 ring-1 ring-gray-200 dark:bg-gray-900 dark:text-gray-300 dark:ring-gray-700" },
};
const ENROLLMENT_STATUS: Record<string, { label: string; color: string }> = {
    ACTIVE: { label: "수강 중", color: "bg-lime-100 text-lime-800 ring-1 ring-lime-200 dark:bg-lime-300/15 dark:text-lime-100 dark:ring-lime-300/25" },
    PAUSED: { label: "휴원", color: "bg-amber-50 text-amber-700 ring-1 ring-amber-200 dark:bg-amber-300/10 dark:text-amber-100 dark:ring-amber-300/20" },
    WITHDRAWN: { label: "퇴원", color: "bg-red-50 text-red-700 ring-1 ring-red-200 dark:bg-red-300/10 dark:text-red-100 dark:ring-red-300/20" },
    NONE: { label: "미배정", color: "bg-gray-50 text-gray-600 ring-1 ring-gray-200 dark:bg-gray-900 dark:text-gray-300 dark:ring-gray-700" },
};
const ENROLLMENT_STATUS_OPTIONS = [
    { value: "ACTIVE", label: "수강 중" },
    { value: "PAUSED", label: "휴원" },
    { value: "WITHDRAWN", label: "퇴원" },
] as const;

// 상태변경 세그먼트 버튼: 선택된 상태를 의미색(성공/경고/위험)으로 채워 시각적으로 구분한다
const ENROLLMENT_SEG_SELECTED: Record<string, string> = {
    ACTIVE: "bg-emerald-600 text-white dark:bg-emerald-500 dark:text-white",
    PAUSED: "bg-amber-500 text-white dark:bg-amber-500 dark:text-white",
    WITHDRAWN: "bg-red-600 text-white dark:bg-red-500 dark:text-white",
};

// 결제 상태 변경 옵션(완납/대기/연체/취소) — 서버 updatePaymentStatus 가 받는 status 값과 1:1
const PAY_STATUS_OPTIONS = [
    { value: "PAID", label: "완납" },
    { value: "PENDING", label: "대기" },
    { value: "OVERDUE", label: "연체" },
    { value: "CANCELED", label: "취소" },
] as const;

// 결제 상태 세그먼트: 선택된 상태를 의미색(완납=성공/대기=경고/연체·취소=위험·중립)으로 채운다
const PAY_SEG_SELECTED: Record<string, string> = {
    PAID: "bg-emerald-600 text-white dark:bg-emerald-500 dark:text-white",
    PENDING: "bg-amber-500 text-white dark:bg-amber-500 dark:text-white",
    OVERDUE: "bg-red-600 text-white dark:bg-red-500 dark:text-white",
    CANCELED: "bg-gray-600 text-white dark:bg-gray-500 dark:text-white",
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
const EDIT_INPUT_CLASS = "w-full rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-sm text-gray-900 focus:ring-2 focus:ring-[var(--color-academy-primary)] dark:border-gray-700 dark:bg-gray-900 dark:text-white dark:focus:ring-brand-neon-lime";

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
    return error instanceof Error ? error.message : fallback;
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
function MiniDonut({ rate, className = "text-emerald-500 dark:text-emerald-400" }: { rate: number; className?: string }) {
    const dash = Math.max(0, Math.min(100, rate)); // 0~100 범위로 보정
    return (
        <svg viewBox="0 0 36 36" className="h-12 w-12 flex-none" aria-hidden="true">
            {/* 배경 트랙 (회색) */}
            <circle cx="18" cy="18" r="15.9155" fill="none" strokeWidth="4" stroke="currentColor" className="text-gray-200 dark:text-gray-700" />
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
        parent: { name: string | null; phone: string | null; email: string | null };
    };
    enrollments: {
        id: string; classId: string; status: string; createdAt: Date | string;
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

function getInvoiceStatusInfo(status: string | null | undefined) {
    return status ? INVOICE_STATUS[status] ?? INVOICE_STATUS.ISSUED : null;
}

function getRepresentativeEnrollmentStatus(enrollments: StudentActivityData["enrollments"]) {
    if (enrollments.length === 0) return null;
    if (enrollments.some((enrollment) => enrollment.status === "ACTIVE")) return "ACTIVE";

    return [...enrollments].sort((a, b) => {
        const bTime = new Date(b.createdAt).getTime();
        const aTime = new Date(a.createdAt).getTime();
        return bTime - aTime;
    })[0]?.status ?? null;
}

function sortEnrollments(enrollments: StudentActivityData["enrollments"]) {
    const statusOrder: Record<string, number> = { ACTIVE: 0, PAUSED: 1, WITHDRAWN: 2 };

    return [...enrollments].sort((a, b) => {
        const statusDiff = (statusOrder[a.status] ?? 9) - (statusOrder[b.status] ?? 9);
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
            className: "bg-red-50 text-red-700 ring-1 ring-red-200 dark:bg-red-300/10 dark:text-red-100 dark:ring-red-300/20",
        };
    }

    if (history.paymentAmount > 0) {
        return {
            label: "납부 완료",
            className: "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200 dark:bg-emerald-300/10 dark:text-emerald-100 dark:ring-emerald-300/20",
        };
    }

    return {
        label: "수납 정보 없음",
        className: "bg-gray-50 text-gray-600 ring-1 ring-gray-200 dark:bg-gray-900 dark:text-gray-300 dark:ring-gray-700",
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
            <h3 className="flex items-center gap-2 text-sm font-extrabold text-gray-900 dark:text-white">
                <SymbolIcon name={icon} size={17} className="text-[var(--color-academy-primary)] dark:text-brand-neon-lime" />
                {title}
            </h3>
            {right}
        </div>
    );
}

// 빈 상태 — 섹션이 사라지지 않고 점선 카드로 "아직 없습니다"를 안내한다
function EmptyState({ text }: { text: string }) {
    return (
        <div className="rounded-xl border border-dashed border-gray-200 px-4 py-6 text-center text-sm text-gray-400 dark:border-gray-700 dark:text-gray-500">
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
        <div className="rounded-xl border border-gray-100 p-3 dark:border-gray-700">
            <div className="mb-1.5 flex items-center justify-between gap-2">
                <span className="inline-flex items-center gap-1.5 text-[13px] font-bold text-gray-900 dark:text-gray-100">
                    <span className="grid h-6 w-6 shrink-0 place-items-center rounded-lg bg-[var(--color-academy-primary-soft)] text-[var(--color-academy-primary)] dark:bg-brand-neon-lime/10 dark:text-brand-neon-lime">
                        <SymbolIcon name={icon} size={14} />
                    </span>
                    {label}
                </span>
                <button
                    onClick={onEdit}
                    disabled={disabled}
                    className="inline-flex items-center gap-1 rounded-lg border border-gray-200 px-2 py-1 text-[11px] font-bold text-gray-700 transition hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
                >
                    <SymbolIcon name={hasCoord ? "edit_location" : "add_location_alt"} size={13} />
                    {hasCoord ? "위치 수정" : "위치 설정"}
                </button>
            </div>
            {hasCoord ? (
                <div className="space-y-0.5 pl-8">
                    <p className="text-[13px] text-gray-800 dark:text-gray-100">{addr || "주소 미상"}</p>
                    <p className="text-[11px] text-gray-400">
                        📍 {loc!.latitude!.toFixed(6)}, {loc!.longitude!.toFixed(6)}
                        {loc!.confirmedAt ? ` · ${formatShuttleConfirmedAt(loc!.confirmedAt)} 확정` : ""}
                    </p>
                </div>
            ) : (
                <p className="pl-8 text-[12px] text-gray-400">{label} 위치 미설정</p>
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
}: {
    data?: StudentActivityData;
    studentId?: string;
    // 반 추가 선택지 — page.tsx가 getClasses()로 조회해 전달(신규 prop, 기본 빈 배열로 안전)
    classes?: ClassOption[];
    // 배차용 실제 셔틀 위치 — page.tsx가 getStudentShuttleLocations로 전달(신규 prop)
    shuttleLocations?: ShuttleLocationRow[];
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

    // ── 배차용 셔틀 위치 편집 상태 (E4) ──────────────────────────────
    // shuttleLocs: PICKUP/DROPOFF 로컬 상태(저장 성공 시 응답으로 그 카드만 즉시 갱신)
    // pickerKind: 지도 모달을 연 종류 / shuttleSaving: 저장 중(disabled) / shuttleError: 실패 사유
    const [shuttleLocs, setShuttleLocs] = useState<ShuttleLocationRow[]>(shuttleLocations);
    const [pickerKind, setPickerKind] = useState<null | "PICKUP" | "DROPOFF">(null);
    const [shuttleSaving, setShuttleSaving] = useState(false);
    const [shuttleError, setShuttleError] = useState<string | null>(null);

    // 종류별 현재 위치를 꺼내는 헬퍼
    const pickupLoc = shuttleLocs.find(l => l.kind === "PICKUP") ?? null;
    const dropoffLoc = shuttleLocs.find(l => l.kind === "DROPOFF") ?? null;

    // 지도 모달 확정 → /api/admin/shuttle(studentLocation·confirmLocation)로 저장
    // 서버 updateStudentShuttleLocation은 좌표·주소 필수(없으면 400). 성공 시 응답 location으로 로컬만 갱신.
    async function saveShuttleLocation(kind: "PICKUP" | "DROPOFF", value: MapLocationData) {
        if (!studentId) return;
        setShuttleSaving(true);
        setShuttleError(null);
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
                        name: value.roadAddress || value.address,
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
        } catch (e) {
            setShuttleError(e instanceof Error ? e.message : "위치를 저장하지 못했습니다.");
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
                    <div className="h-10 w-10 rounded-lg bg-gray-200 animate-pulse dark:bg-gray-700" />
                    <div>
                        <div className="h-8 w-40 rounded bg-gray-200 animate-pulse dark:bg-gray-700" />
                        <div className="mt-2 h-4 w-80 max-w-full rounded bg-gray-100 animate-pulse dark:bg-gray-800" />
                    </div>
                </div>

                <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
                    {Array.from({ length: 4 }).map((_, index) => (
                        <div
                            key={index}
                            className="rounded-2xl border border-gray-100 bg-white p-4 shadow-sm dark:border-gray-800 dark:bg-gray-800"
                        >
                            <div className="h-4 w-20 rounded bg-gray-100 animate-pulse dark:bg-gray-700" />
                            <div className="mt-3 h-8 w-24 rounded bg-gray-200 animate-pulse dark:bg-gray-700" />
                            <div className="mt-2 h-3 w-16 rounded bg-gray-100 animate-pulse dark:bg-gray-700" />
                        </div>
                    ))}
                </div>

                <div className="grid grid-cols-1 gap-6 lg:grid-cols-[320px_1fr]">
                    <div className="space-y-4">
                        {Array.from({ length: 3 }).map((_, index) => (
                            <div
                                key={index}
                                className="rounded-2xl border border-gray-100 bg-white p-5 shadow-sm dark:border-gray-800 dark:bg-gray-800"
                            >
                                <div className="h-5 w-32 rounded bg-gray-200 animate-pulse dark:bg-gray-700" />
                                <div className="mt-4 space-y-3">
                                    {Array.from({ length: 3 }).map((__, rowIndex) => (
                                        <div key={rowIndex} className="h-4 rounded bg-gray-100 animate-pulse dark:bg-gray-700" />
                                    ))}
                                </div>
                            </div>
                        ))}
                    </div>

                    <div className="space-y-4">
                        {Array.from({ length: 2 }).map((_, sectionIndex) => (
                            <div
                                key={sectionIndex}
                                className="rounded-2xl border border-gray-100 bg-white p-5 shadow-sm dark:border-gray-800 dark:bg-gray-800"
                            >
                                <div className="h-5 w-32 rounded bg-gray-200 animate-pulse dark:bg-gray-700" />
                                <div className="mt-4 space-y-3">
                                    {Array.from({ length: 6 }).map((__, rowIndex) => (
                                        <div key={rowIndex} className="h-10 rounded bg-gray-100 animate-pulse dark:bg-gray-700" />
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
            <div className="mx-auto max-w-6xl rounded-xl border border-red-200 bg-red-50 p-8 text-center dark:border-red-900/50 dark:bg-red-950/20">
                <p className="font-bold text-red-700 dark:text-red-200">{error}</p>
                <button
                    type="button"
                    onClick={() => void loadData()}
                    className="mt-4 rounded-lg bg-[var(--color-academy-primary)] px-4 py-2 text-sm font-bold text-white transition hover:bg-[var(--color-academy-primary-hover)] dark:bg-brand-neon-lime dark:text-brand-navy-900"
                >
                    다시 불러오기
                </button>
                <div className="mt-4">
                    <Link href="/admin/students" prefetch={false} className="text-sm font-medium text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white">
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
                await updateStudent(student.id, {
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
                        className="inline-flex items-center gap-1 rounded-lg bg-[var(--color-academy-primary)] px-2.5 py-1.5 text-xs font-bold text-white transition hover:bg-[var(--color-academy-primary-hover)] disabled:opacity-50 dark:bg-brand-neon-lime dark:text-brand-navy-900 dark:hover:bg-lime-200"
                    >
                        <SymbolIcon name="check" size={14} /> {saving ? "저장 중…" : "저장"}
                    </button>
                    <button
                        type="button"
                        onClick={cancelEditSection}
                        disabled={saving}
                        className="inline-flex items-center gap-1 rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-xs font-bold text-gray-600 transition hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700"
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
                className="grid h-8 w-8 place-items-center rounded-lg border border-gray-200 bg-white text-gray-500 transition hover:bg-gray-50 hover:text-gray-900 disabled:opacity-40 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400 dark:hover:bg-gray-700 dark:hover:text-white"
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

    // 수강 반 한 줄 카드 — 반명/상태칩 + 세그먼트 상태변경 버튼(수강중/휴원/퇴원)
    function renderEnrollmentRow(enrollment: StudentActivityData["enrollments"][number]) {
        const info = getEnrollmentStatusInfo(enrollment.status);
        const isUpdating = statusUpdatingId === enrollment.id;

        return (
            <div
                key={enrollment.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-gray-100 bg-gray-50 p-3.5 dark:border-gray-700 dark:bg-gray-900/60"
            >
                <div className="min-w-0">
                    <p className="flex items-center gap-1.5 text-sm font-extrabold text-gray-900 dark:text-white">
                        {enrollment.className}
                        <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold ${info.color}`}>{info.label}</span>
                    </p>
                    <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                        {DAY_LABELS[enrollment.dayOfWeek] || enrollment.dayOfWeek} {enrollment.startTime}~{enrollment.endTime} · {enrollment.programName}
                    </p>
                </div>
                {/* 우측: 상태 세그먼트. 퇴원도 이력을 보존하는 상태 변경으로 처리한다. */}
                <div className="flex items-center gap-2">
                {/* 세그먼트 버튼: 입력 양식에서 반·효력일·사유를 확인한 뒤 저장한다. */}
                <div className="inline-flex overflow-hidden rounded-lg border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-950">
                    {ENROLLMENT_STATUS_OPTIONS.map((option) => {
                        const selected = enrollment.status === option.value;
                        return (
                            <button
                                key={option.value}
                                type="button"
                                onClick={() => changeEnrollmentStatus(enrollment, option.value)}
                                disabled={Boolean(statusUpdatingId)}
                                className={`px-3 py-1.5 text-xs font-bold transition disabled:cursor-not-allowed disabled:opacity-60 ${
                                    selected
                                        ? ENROLLMENT_SEG_SELECTED[option.value] ?? "bg-gray-900 text-white dark:bg-brand-neon-lime dark:text-brand-navy-900"
                                        : "text-gray-500 hover:bg-gray-100 hover:text-gray-900 dark:text-gray-300 dark:hover:bg-gray-800 dark:hover:text-white"
                                }`}
                            >
                                {isUpdating && selected ? "저장 중" : option.label}
                            </button>
                        );
                    })}
                </div>
                </div>
            </div>
        );
    }

    const sortedEnrollments = sortEnrollments(enrollments);
    const activeEnrollments = sortedEnrollments.filter(e => e.status === "ACTIVE");
    const inactiveEnrollments = sortedEnrollments.filter(e => e.status !== "ACTIVE");
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
        { key: "present", label: "출석", value: attendanceStats.present, bar: "bg-emerald-500", text: "text-emerald-600 dark:text-emerald-300" },
        { key: "late", label: "지각", value: attendanceStats.late, bar: "bg-amber-500", text: "text-amber-600 dark:text-amber-300" },
        { key: "absent", label: "결석", value: attendanceStats.absent, bar: "bg-red-500", text: "text-red-600 dark:text-red-300" },
        { key: "excused", label: "사유", value: attendanceStats.excused, bar: "bg-sky-500", text: "text-sky-600 dark:text-sky-300" },
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
            {/* 학생의 맥락을 라벤더 헤더로 묶고 기존 편집 기능은 유지한다. */}
            <div className="academy-hero flex flex-wrap items-start gap-4 p-5 md:p-6">
                <Link href="/admin/students" prefetch={false} className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-gray-100 bg-white text-gray-500 shadow-sm transition hover:bg-gray-50 dark:border-gray-800 dark:bg-gray-800 dark:text-gray-400 dark:hover:bg-gray-700">
                    <SymbolIcon name="arrow_back" size={20} />
                </Link>
                <div className="min-w-0 basis-60 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                        <h1 className="academy-heading">
                            {student.name}
                            <span className="ml-1.5 text-lg font-normal text-gray-400">학생</span>
                        </h1>
                        <span className={`rounded-full px-2.5 py-0.5 text-xs font-bold ${representativeStatusInfo.color}`}>
                            {representativeStatusInfo.label}
                        </span>
                        {activeEnrollments.length > 0 && (
                            <span className="rounded-full bg-[var(--color-academy-primary-soft)] px-2.5 py-0.5 text-xs font-bold text-[var(--color-academy-primary)] dark:bg-brand-neon-lime/10 dark:text-brand-neon-lime">
                                {activeEnrollments.length}개 반
                            </span>
                        )}
                        {sectionSaved === "header" && <span className="text-xs font-medium text-green-600 dark:text-lime-200">저장됨</span>}
                    </div>
                    {editSection === "header" ? (
                        // (A) 편집 폼: 이름·학년·학교·생년월일·성별·등록일
                        <div className="mt-3 grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
                            <label className="block">
                                <span className="mb-1 block text-[11px] font-bold text-gray-400">이름</span>
                                <input type="text" value={editForm.name} onChange={(e) => setField("name", e.target.value)} className={EDIT_INPUT_CLASS} />
                            </label>
                            <label className="block">
                                <span className="mb-1 block text-[11px] font-bold text-gray-400">학년</span>
                                <input type="text" value={editForm.grade} onChange={(e) => setField("grade", e.target.value)} className={EDIT_INPUT_CLASS} />
                            </label>
                            <label className="block">
                                <span className="mb-1 block text-[11px] font-bold text-gray-400">학교</span>
                                <input type="text" value={editForm.school} onChange={(e) => setField("school", e.target.value)} className={EDIT_INPUT_CLASS} />
                            </label>
                            <label className="block">
                                <span className="mb-1 block text-[11px] font-bold text-gray-400">생년월일</span>
                                <input type="date" value={editForm.birthDate} onChange={(e) => setField("birthDate", e.target.value)} className={EDIT_INPUT_CLASS} />
                            </label>
                            <label className="block">
                                <span className="mb-1 block text-[11px] font-bold text-gray-400">성별</span>
                                <select value={editForm.gender} onChange={(e) => setField("gender", e.target.value)} className={EDIT_INPUT_CLASS}>
                                    <option value="">미지정</option>
                                    <option value="남">남</option>
                                    <option value="여">여</option>
                                </select>
                            </label>
                            <label className="block">
                                <span className="mb-1 block text-[11px] font-bold text-gray-400">등록일</span>
                                <input type="date" value={editForm.enrollDate} onChange={(e) => setField("enrollDate", e.target.value)} className={EDIT_INPUT_CLASS} />
                            </label>
                            {sectionError && <p className="text-xs font-medium text-red-600 dark:text-red-300 sm:col-span-2 lg:col-span-3">{sectionError}</p>}
                        </div>
                    ) : (
                        // 한 줄 사실: 학년·학교·성별·나이(생년월일)·등록일
                        <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-gray-500 dark:text-gray-400">
                            {student.grade && <span>{student.grade}</span>}
                            {student.school && <><span className="text-gray-300 dark:text-gray-600">·</span><span>{student.school}</span></>}
                            <span className="text-gray-300 dark:text-gray-600">·</span>
                            <span>
                                {student.gender ? `${student.gender} · ` : ""}만 {calcAge(student.birthDate)}세 ({toDateStr(student.birthDate)})
                            </span>
                            <span className="text-gray-300 dark:text-gray-600">·</span>
                            <span>등록 {toDateStr(student.enrollDate ?? student.createdAt)}</span>
                        </p>
                    )}
                </div>
                {/* 우측 액션: 기본정보 편집(연필) + 사진 사용 동의 (media-consent 라우트 유지) */}
                <div className="flex items-center gap-2">
                    {renderEditControls("header")}
                    <Link
                        href={mediaConsentHref}
                        className="inline-flex items-center gap-1.5 rounded-xl border border-gray-200 bg-white px-3.5 py-2 text-sm font-bold text-gray-700 shadow-sm transition hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100 dark:hover:bg-gray-700"
                    >
                        <SymbolIcon name="photo_camera" size={16} className="text-gray-400" />
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
                        <p className="text-[11px] font-bold uppercase tracking-wide text-gray-400">출석률</p>
                        <p className="text-2xl font-extrabold text-gray-900 dark:text-white">
                            {attendanceStats.rate}<span className="text-base">%</span>
                        </p>
                        <p className="truncate text-xs text-gray-400">{attendanceStats.present}/{attendanceStats.total}회 출석</p>
                    </div>
                </div>

                {/* 수강 중 반 수 */}
                <div className="academy-panel flex items-center gap-3 p-4">
                    <div className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-[var(--color-academy-primary-soft)] text-[var(--color-academy-primary)] dark:bg-brand-neon-lime/10 dark:text-brand-neon-lime">
                        <SymbolIcon name="sports_basketball" size={22} />
                    </div>
                    <div className="min-w-0">
                        <p className="text-[11px] font-bold uppercase tracking-wide text-gray-400">수강 중</p>
                        <p className="text-2xl font-extrabold text-gray-900 dark:text-white">
                            {activeEnrollments.length}<span className="text-base"> 개 반</span>
                        </p>
                        <p className="truncate text-xs text-gray-400">이전/휴원 {inactiveEnrollments.length}개</p>
                    </div>
                </div>

                {/* 이번 달 수납 */}
                <div className="academy-panel flex items-center gap-3 p-4">
                    <div className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-sky-50 text-sky-600 dark:bg-sky-500/10 dark:text-sky-300">
                        <SymbolIcon name="account_balance_wallet" size={22} />
                    </div>
                    <div className="min-w-0">
                        <p className="text-[11px] font-bold uppercase tracking-wide text-gray-400">이번 달 수납</p>
                        {currentMonthHistory ? (
                            <>
                                <p className="flex items-center gap-1.5 text-lg font-extrabold text-gray-900 dark:text-white">
                                    <span className={`rounded-full px-2 py-0.5 text-xs ${currentMonthPaymentInfo?.className ?? PAY_STATUS.PENDING.color}`}>
                                        {currentMonthPaymentInfo?.label ?? "정보 없음"}
                                    </span>
                                </p>
                                <p className="mt-0.5 truncate text-xs text-gray-400">
                                    {formatMonthLabel(currentMonthHistory)} · {formatKRW(currentMonthHistory.paymentAmount)}
                                </p>
                            </>
                        ) : (
                            <p className="text-lg font-extrabold text-gray-400">이력 없음</p>
                        )}
                    </div>
                </div>

                {/* 미납 */}
                <div className="academy-panel flex items-center gap-3 p-4">
                    <div className={`grid h-11 w-11 shrink-0 place-items-center rounded-xl ${unpaid.length > 0 ? "bg-red-50 text-red-600 dark:bg-red-500/10 dark:text-red-300" : "bg-gray-100 text-gray-400 dark:bg-gray-900 dark:text-gray-500"}`}>
                        <SymbolIcon name={unpaid.length > 0 ? "error" : "check_circle"} size={22} />
                    </div>
                    <div className="min-w-0">
                        <p className="text-[11px] font-bold uppercase tracking-wide text-gray-400">미납</p>
                        <p className="text-2xl font-extrabold text-gray-900 dark:text-white">
                            {unpaid.length}<span className="text-base"> 건</span>
                        </p>
                        <p className="truncate text-xs text-gray-400">누적 납부 {formatKRW(totalPaid)}</p>
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
                                    {sectionSaved === "profile" && <span className="text-xs font-medium text-green-600 dark:text-lime-200">저장됨</span>}
                                    {renderEditControls("profile")}
                                </div>
                            }
                        />
                        {editSection === "profile" ? (
                            // (B) 편집 폼: 학생 전화·학부모 이름·학부모 전화·학부모 이메일·주소
                            <div className="space-y-2.5">
                                <label className="block">
                                    <span className="mb-1 block text-[11px] font-bold text-gray-400">학생 전화</span>
                                    <input type="tel" value={editForm.phone} onChange={(e) => setField("phone", e.target.value)} className={EDIT_INPUT_CLASS} />
                                </label>
                                <label className="block">
                                    <span className="mb-1 block text-[11px] font-bold text-gray-400">학부모 이름</span>
                                    <input type="text" value={editForm.parentName} onChange={(e) => setField("parentName", e.target.value)} className={EDIT_INPUT_CLASS} />
                                </label>
                                <label className="block">
                                    <span className="mb-1 block text-[11px] font-bold text-gray-400">학부모 전화</span>
                                    <input type="tel" value={editForm.parentPhone} onChange={(e) => setField("parentPhone", e.target.value)} className={EDIT_INPUT_CLASS} />
                                </label>
                                <label className="block">
                                    <span className="mb-1 block text-[11px] font-bold text-gray-400">학부모 이메일</span>
                                    <input type="email" value={editForm.parentEmail} onChange={(e) => setField("parentEmail", e.target.value)} className={EDIT_INPUT_CLASS} />
                                </label>
                                <label className="block">
                                    <span className="mb-1 block text-[11px] font-bold text-gray-400">주소</span>
                                    <input type="text" value={editForm.address} onChange={(e) => setField("address", e.target.value)} className={EDIT_INPUT_CLASS} />
                                </label>
                                {sectionError && <p className="text-xs font-medium text-red-600 dark:text-red-300">{sectionError}</p>}
                            </div>
                        ) : (
                            <div className="space-y-2.5 text-sm">
                                <div className="flex gap-3">
                                    <span className="w-14 shrink-0 text-xs font-bold text-gray-400">학생</span>
                                    <span className="font-medium text-gray-800 dark:text-gray-100">{student.phone || "-"}</span>
                                </div>
                                <div className="flex gap-3">
                                    <span className="w-14 shrink-0 text-xs font-bold text-gray-400">학부모</span>
                                    <span className="font-medium text-gray-800 dark:text-gray-100">
                                        {student.parent.name || "-"}
                                        {student.parent.phone && (
                                            <>
                                                {" · "}
                                                <a href={`tel:${student.parent.phone}`} className="text-[var(--color-academy-primary)] hover:underline dark:text-brand-neon-lime">
                                                    {student.parent.phone}
                                                </a>
                                            </>
                                        )}
                                    </span>
                                </div>
                                <div className="flex gap-3">
                                    <span className="w-14 shrink-0 text-xs font-bold text-gray-400">이메일</span>
                                    <span className="break-all font-medium text-gray-800 dark:text-gray-100">{student.parent.email || "-"}</span>
                                </div>
                                <div className="flex gap-3">
                                    <span className="w-14 shrink-0 text-xs font-bold text-gray-400">주소</span>
                                    <span className="font-medium text-gray-800 dark:text-gray-100">{student.address || "-"}</span>
                                </div>
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
                                    <span className="rounded-full px-2 py-0.5 text-[11px] font-bold text-emerald-700 ring-1 ring-emerald-200 dark:text-emerald-100 dark:ring-emerald-300/20">설정됨</span>
                                ) : (
                                    <span className="rounded-full px-2 py-0.5 text-[11px] font-bold text-gray-500 ring-1 ring-gray-200 dark:text-gray-400 dark:ring-gray-700">미설정</span>
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
                            <p className="mt-2 text-[11px] font-semibold text-red-600 dark:text-red-400">{shuttleError}</p>
                        )}
                        {/* 신청서 희망 셔틀(시트 장부)은 참고용 작은 줄로만 남긴다(혼동 방지) */}
                        {currentMonthHistory?.shuttle.needed && (
                            <p className="mt-2 border-t border-gray-100 pt-2 text-[11px] text-gray-400 dark:border-gray-700">
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
                                    className="inline-flex items-center gap-1 rounded-lg bg-[var(--color-academy-primary)] px-3 py-1.5 text-xs font-bold text-white transition hover:bg-[var(--color-academy-primary-hover)] disabled:opacity-50 dark:bg-brand-neon-lime dark:text-brand-navy-900 dark:hover:bg-lime-200"
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
                            className="w-full resize-none rounded-xl border border-gray-200 bg-white px-3 py-2.5 text-sm text-gray-900 focus:ring-2 focus:ring-[var(--color-academy-primary)] dark:border-gray-700 dark:bg-gray-900 dark:text-white dark:placeholder:text-gray-500 dark:focus:ring-brand-neon-lime"
                        />
                        {memoSaved && <p className="mt-2 text-xs font-medium text-green-600 dark:text-lime-200">저장됨</p>}
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
                                            ? "bg-white text-gray-900 shadow-sm dark:bg-gray-800 dark:text-white"
                                            : "text-gray-500 hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-200"
                                    }`}
                                >
                                    {tab.label}
                                    {tab.count != null && <span className="text-[11px] font-extrabold text-gray-400">{tab.count}</span>}
                                </button>
                            );
                        })}
                    </div>

                    {/* ===== 개요 탭 ===== */}
                    {activeTab === "overview" && (
                        <div className="space-y-4">
                            <div className={CARD_CLASS}>
                                <SectionTitle
                                    icon="menu_book"
                                    title="현재 수강 반"
                                    right={
                                        <button
                                            type="button"
                                            onClick={() => { setShowClassPicker((v) => !v); setEnrollError(null); }}
                                            className="inline-flex items-center gap-1 rounded-lg border border-[var(--color-academy-line)] bg-[var(--color-academy-primary-soft)] px-2.5 py-1 text-xs font-bold text-[var(--color-academy-primary)] transition hover:bg-[var(--color-academy-primary-soft)] dark:border-brand-neon-lime/30 dark:bg-brand-neon-lime/10 dark:text-brand-neon-lime dark:hover:bg-brand-neon-lime/20"
                                        >
                                            <SymbolIcon name={showClassPicker ? "close" : "add"} size={15} />
                                            {showClassPicker ? "닫기" : "반 추가"}
                                        </button>
                                    }
                                />
                                {statusFeedback && (
                                    <p className={`mb-3 rounded-lg px-3 py-2 text-xs font-bold ${
                                        statusFeedback.type === "success"
                                            ? "bg-lime-50 text-lime-700 dark:bg-lime-300/10 dark:text-lime-100"
                                            : "bg-red-50 text-red-700 dark:bg-red-950/30 dark:text-red-200"
                                    }`}>
                                        {statusFeedback.message}
                                    </p>
                                )}
                                {enrollError && (
                                    <p className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-xs font-bold text-red-700 dark:bg-red-950/30 dark:text-red-200">
                                        {enrollError}
                                    </p>
                                )}
                                {/* 반 추가 선택 UI — 이미 수강 중인 반은 제외하고 프로그램별로 묶어 보여준다 */}
                                {showClassPicker && (() => {
                                    const enrolledClassIds = new Set(enrollments.map((e) => e.classId));
                                    const selectable = classes.filter((c) => !enrolledClassIds.has(c.id));
                                    return (
                                        <div className="mb-3 rounded-xl border border-gray-100 bg-gray-50 p-3 dark:border-gray-700 dark:bg-gray-900/60">
                                            {selectable.length === 0 ? (
                                                <p className="py-2 text-center text-xs text-gray-400">추가할 수 있는 반이 없습니다.</p>
                                            ) : (
                                                <div className="max-h-72 space-y-3 overflow-y-auto">
                                                    {groupClassesByProgram(selectable).map((group) => (
                                                        <div key={group.programName}>
                                                            <p className="mb-1.5 rounded-md bg-gray-100 px-2.5 py-1 text-xs font-bold text-gray-600 dark:bg-gray-800 dark:text-gray-200">
                                                                {group.programName} <span className="text-gray-400">({group.classes.length})</span>
                                                            </p>
                                                            <div className="space-y-1">
                                                                {group.classes.map((c) => (
                                                                    <button
                                                                        key={c.id}
                                                                        type="button"
                                                                        onClick={() => void addEnrollment(c.id)}
                                                                        disabled={Boolean(enrollingClassId)}
                                                                        className="flex w-full items-center justify-between gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2 text-left transition hover:border-[var(--color-academy-primary)] hover:bg-[var(--color-academy-primary-soft)] disabled:opacity-50 dark:border-gray-700 dark:bg-gray-950 dark:hover:border-brand-neon-lime/40 dark:hover:bg-brand-neon-lime/5"
                                                                    >
                                                                        <span className="min-w-0 truncate text-sm font-bold text-gray-900 dark:text-white">{c.name}</span>
                                                                        <span className="shrink-0 text-xs text-gray-400">
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
                                    <div className="mt-4 border-t border-gray-100 pt-4 dark:border-gray-700">
                                        <p className="mb-2 text-xs font-bold text-gray-500 dark:text-gray-400">이전/휴원 이력</p>
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
                                    right={currentMonthHistory && <span className="text-xs font-bold text-gray-400">{formatMonthLabel(currentMonthHistory)}</span>}
                                />
                                {currentMonthHistory ? (
                                    <div className="grid gap-3 sm:grid-cols-2">
                                        <div className="rounded-xl border border-gray-100 bg-gray-50 p-3.5 dark:border-gray-700 dark:bg-gray-900/60">
                                            <p className="mb-1.5 text-[11px] font-bold uppercase tracking-wide text-gray-400">수납</p>
                                            <p className="flex items-center gap-1.5 text-lg font-extrabold text-gray-900 dark:text-white">
                                                {formatKRW(currentMonthHistory.paymentAmount)}
                                                <span className={`rounded-full px-2 py-0.5 text-[11px] ${currentMonthPaymentInfo?.className ?? PAY_STATUS.PENDING.color}`}>
                                                    {currentMonthPaymentInfo?.label ?? "정보 없음"}
                                                </span>
                                            </p>
                                            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                                                수강 {formatKRW(currentMonthHistory.tuitionAmount)}
                                                {currentMonthHistory.shuttleFee > 0 ? ` + 셔틀 ${formatKRW(currentMonthHistory.shuttleFee)}` : ""}
                                                {currentMonthHistory.paymentMethods.length > 0 ? ` · ${currentMonthHistory.paymentMethods.join(" · ")}` : ""}
                                                {currentMonthHistory.paymentDate ? ` · ${toDateStr(currentMonthHistory.paymentDate)}` : ""}
                                            </p>
                                        </div>
                                        <div className="rounded-xl border border-gray-100 bg-gray-50 p-3.5 dark:border-gray-700 dark:bg-gray-900/60">
                                            <p className="mb-1.5 text-[11px] font-bold uppercase tracking-wide text-gray-400">변동 기록</p>
                                            {currentMonthHistory.changes.length > 0 ? (
                                                <ul className="space-y-1.5">
                                                    {currentMonthHistory.changes.slice(0, 3).map((change, index) => (
                                                        <li key={`cm-change-${index}`} className="border-l-2 border-brand-orange-500 pl-2.5 text-xs text-gray-600 dark:border-brand-neon-lime dark:text-gray-300">
                                                            {change.summary || change.note}
                                                            {change.occurredAt ? ` · ${toDateStr(change.occurredAt)}` : ""}
                                                        </li>
                                                    ))}
                                                </ul>
                                            ) : (
                                                <p className="text-xs text-gray-400">변동 기록이 없습니다.</p>
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
                            <div className={CARD_CLASS}>
                                <SectionTitle
                                    icon="bar_chart"
                                    title="출석 통계"
                                    right={<span className="text-xs text-gray-400">전체 {attendanceStats.total}회</span>}
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
                                                    <div className="h-2 flex-1 overflow-hidden rounded-full bg-gray-100 dark:bg-gray-900">
                                                        <span className={`block h-full rounded-full ${b.bar}`} style={{ width: `${pct}%` }} />
                                                    </div>
                                                    <span className="w-8 shrink-0 text-right font-medium text-gray-500 dark:text-gray-400">{b.value}</span>
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
                                    right={<span className="text-xs text-gray-400">최근 50건</span>}
                                />
                                {attendances.length === 0 ? (
                                    <EmptyState text="출결 기록이 없습니다." />
                                ) : (
                                    <div className="divide-y divide-gray-100 dark:divide-gray-700/70">
                                        {attendances.map((a) => {
                                            const info = ATT_STATUS[a.status] || ATT_STATUS.PRESENT;
                                            return (
                                                <div key={a.id} className="flex items-center gap-3 py-2.5">
                                                    <span className="w-16 shrink-0 text-xs font-bold text-gray-500 dark:text-gray-400">{toDateStr(a.date)}</span>
                                                    <span className="min-w-0 flex-1 truncate text-sm text-gray-800 dark:text-gray-100">{a.className}</span>
                                                    <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold ${info.color}`}>{info.label}</span>
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
                                    right={<span className="rounded-full bg-sky-50 px-2 py-0.5 text-[11px] font-bold text-sky-700 dark:bg-sky-500/10 dark:text-sky-300">시스템</span>}
                                />
                                {payments.length === 0 ? (
                                    <EmptyState text="청구·납부 내역이 없습니다." />
                                ) : (
                                    <div className="divide-y divide-gray-100 dark:divide-gray-700/70">
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
                                                    <span className="w-16 shrink-0 pt-0.5 text-xs font-bold text-gray-500 dark:text-gray-400">{toDateStr(p.dueDate)}</span>
                                                    <div className="min-w-0 flex-1">
                                                        <p className="flex flex-wrap items-center gap-1.5 text-sm font-medium text-gray-900 dark:text-white">
                                                            {p.description || "수강료"}
                                                            {p.invoiceNo && <span className="text-xs font-bold text-gray-500 dark:text-gray-400">· {p.invoiceNo}</span>}
                                                            {invoiceInfo && (
                                                                <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${invoiceInfo.color}`}>{invoiceInfo.label}</span>
                                                            )}
                                                        </p>
                                                        <p className="mt-0.5 text-xs text-gray-400">
                                                            {p.method ? `${p.method} · ` : ""}
                                                            {p.paidDate ? `${toDateStr(p.paidDate)} 납부` : "미납부"}
                                                        </p>
                                                        {p.invoiceCheckoutUrl && (
                                                            <a
                                                                href={p.invoiceCheckoutUrl}
                                                                target="_blank"
                                                                rel="noreferrer"
                                                                className="mt-1 inline-flex text-xs font-bold text-[var(--color-academy-primary)] hover:underline dark:text-brand-neon-lime"
                                                            >
                                                                납부 링크 열기 ↗
                                                            </a>
                                                        )}
                                                    </div>
                                                    <div className="shrink-0 text-right">
                                                        <p className="text-sm font-extrabold text-gray-900 dark:text-white">{formatKRW(p.amount)}</p>
                                                        {/* 상태 칩 + 상태변경 연필 버튼(+ 변경됨 표시) */}
                                                        <div className="mt-1 flex items-center justify-end gap-1.5">
                                                            {changed && <span className="text-[11px] font-bold text-emerald-600 dark:text-lime-200">변경됨</span>}
                                                            <span className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-bold ${info.color}`}>{info.label}</span>
                                                            <button
                                                                type="button"
                                                                onClick={() => { setPayError(null); setPayEditingId(editing ? null : p.id); }}
                                                                disabled={updating}
                                                                aria-label="결제 상태 변경"
                                                                className="grid h-6 w-6 place-items-center rounded-md border border-gray-200 bg-white text-gray-500 transition hover:bg-gray-50 hover:text-gray-900 disabled:opacity-40 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-white"
                                                            >
                                                                <SymbolIcon name={editing ? "close" : "edit"} size={13} />
                                                            </button>
                                                        </div>
                                                    </div>
                                                  </div>
                                                  {/* 상태 선택 세그먼트(펼쳤을 때만) — 선택 즉시 changePaymentStatus 호출 */}
                                                  {editing && (
                                                    <div className="mt-2.5 pl-[76px]">
                                                        <div className="inline-flex overflow-hidden rounded-lg border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-950">
                                                            {PAY_STATUS_OPTIONS.map((option) => {
                                                                const selected = p.status === option.value;
                                                                return (
                                                                    <button
                                                                        key={option.value}
                                                                        type="button"
                                                                        onClick={() => void changePaymentStatus(p.id, p.status, option.value)}
                                                                        disabled={updating || selected}
                                                                        className={`px-2.5 py-1 text-[11px] font-bold transition disabled:cursor-default ${
                                                                            selected
                                                                                ? PAY_SEG_SELECTED[option.value]
                                                                                : "text-gray-600 hover:bg-gray-50 disabled:opacity-60 dark:text-gray-300 dark:hover:bg-gray-800"
                                                                        }`}
                                                                    >
                                                                        {option.label}
                                                                    </button>
                                                                );
                                                            })}
                                                        </div>
                                                        {updating && <span className="ml-2 text-[11px] font-medium text-gray-400">변경 중…</span>}
                                                    </div>
                                                  )}
                                                  {/* 실패 사유(권한 없음 등) 표면화 — 조용한 실패 금지 */}
                                                  {rowError && (
                                                    <p className="mt-2 pl-[76px] text-[11px] font-medium text-red-600 dark:text-red-300">{rowError}</p>
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
                                    right={<span className="rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-bold text-gray-600 dark:bg-gray-900 dark:text-gray-300">시트 원장</span>}
                                />
                                {ledgerHistory.length === 0 ? (
                                    <EmptyState text="시트 원장에서 이관된 수납 기록이 없습니다." />
                                ) : (
                                    <div className="divide-y divide-gray-100 dark:divide-gray-700/70">
                                        {ledgerHistory.map((h) => (
                                            <div key={h.id} className="flex items-start gap-3 py-3">
                                                <span className="w-16 shrink-0 pt-0.5 text-xs font-bold text-gray-500 dark:text-gray-400">{formatMonthLabel(h)}</span>
                                                <div className="min-w-0 flex-1">
                                                    <p className="text-sm font-medium text-gray-900 dark:text-white">
                                                        수강 {formatKRW(h.tuitionAmount)}
                                                        {h.shuttleFee > 0 ? ` · 셔틀 ${formatKRW(h.shuttleFee)}` : ""}
                                                    </p>
                                                    <p className="mt-0.5 text-xs text-gray-400">
                                                        {h.paymentMethods.length > 0 ? h.paymentMethods.join(" · ") : "결제수단 없음"}
                                                        {h.carryOverAmount > 0 ? ` · 이월 ${formatKRW(h.carryOverAmount)}` : ""}
                                                        {h.paymentDate ? ` · ${toDateStr(h.paymentDate)}` : ""}
                                                    </p>
                                                </div>
                                                <p className="shrink-0 text-right text-sm font-extrabold text-gray-900 dark:text-white">{formatKRW(h.paymentAmount)}</p>
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
                                                className="group overflow-hidden rounded-xl border border-gray-100 bg-gray-50 dark:border-gray-700 dark:bg-gray-900/60"
                                            >
                                                <summary className="flex cursor-pointer list-none items-center gap-3 p-3.5 [&::-webkit-details-marker]:hidden">
                                                    <span className="w-20 shrink-0 text-sm font-extrabold text-gray-900 dark:text-white">{formatMonthLabel(history)}</span>
                                                    <div className="flex min-w-0 flex-1 flex-wrap gap-1.5">
                                                        <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${statusInfo.color}`}>{statusInfo.label}</span>
                                                        {/* 반 뱃지 전체 노출 (기존 +N 숨김 개선) */}
                                                        {history.classes.map((c) => (
                                                            <span key={c.slotKey} className="rounded-full bg-[var(--color-academy-primary-soft)] px-2 py-0.5 text-[11px] font-bold text-[var(--color-academy-primary)] dark:bg-brand-neon-lime/10 dark:text-brand-neon-lime">
                                                                {c.className}
                                                            </span>
                                                        ))}
                                                    </div>
                                                    <span className="shrink-0 text-sm font-extrabold text-gray-900 dark:text-white">{formatKRW(history.paymentAmount)}</span>
                                                    <SymbolIcon name="chevron_right" size={18} className="shrink-0 text-gray-400 transition-transform group-open:rotate-90" />
                                                </summary>
                                                <div className="space-y-2.5 border-t border-dashed border-gray-200 p-3.5 dark:border-gray-700">
                                                    <div className="grid gap-3 sm:grid-cols-2">
                                                        <div>
                                                            <p className="text-[11px] font-bold uppercase tracking-wide text-gray-400">반</p>
                                                            <p className="mt-1 text-xs text-gray-700 dark:text-gray-200">
                                                                {history.classes.length > 0 ? history.classes.map(formatClassLabel).join(" · ") : "반 정보 없음"}
                                                            </p>
                                                            <p className="mt-0.5 text-[11px] text-gray-400">원장 {history.rowCount}줄{history.grade ? ` · ${history.grade}` : ""}</p>
                                                        </div>
                                                        <div>
                                                            <p className="text-[11px] font-bold uppercase tracking-wide text-gray-400">수납</p>
                                                            <p className="mt-1 flex items-center gap-1.5 text-xs text-gray-700 dark:text-gray-200">
                                                                납부 {formatKRW(history.paymentAmount)} / 청구 {formatKRW(history.tuitionAmount)}
                                                                <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${paymentInfo.className}`}>{paymentInfo.label}</span>
                                                            </p>
                                                            <p className="mt-0.5 text-[11px] text-gray-400">
                                                                {history.paymentMethods.length > 0 ? history.paymentMethods.join(" · ") : "결제수단 없음"}
                                                                {history.shuttleFee > 0 ? ` · 셔틀 ${formatKRW(history.shuttleFee)}` : ""}
                                                                {history.carryOverAmount > 0 ? ` · 이월 ${formatKRW(history.carryOverAmount)}` : ""}
                                                            </p>
                                                        </div>
                                                    </div>
                                                    {history.changes.length > 0 && (
                                                        <div className="space-y-1.5">
                                                            {history.changes.slice(0, 3).map((change, index) => (
                                                                <p key={`${history.id}-change-${index}`} className="border-l-2 border-brand-orange-500 pl-2.5 text-xs text-gray-600 dark:border-brand-neon-lime dark:text-gray-300">
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
                                right={<span className="text-xs text-gray-400">최근 {galleryPosts.length}건</span>}
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
                                            <div key={g.id} className="aspect-square overflow-hidden rounded-xl bg-gray-100 dark:bg-gray-900">
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
                        <h2 id="enrollment-status-change-title" className="text-xl font-extrabold text-gray-900 dark:text-white">
                            수강 상태 변경
                        </h2>
                        <p className="text-sm text-gray-600 dark:text-gray-300">
                            {statusChange.className} · {getEnrollmentStatusInfo(statusChange.currentStatus).label} → {getEnrollmentStatusInfo(statusChange.nextStatus).label}
                        </p>
                        <label className="block text-sm font-bold text-gray-700 dark:text-gray-200">
                            효력일
                            <input
                                type="date"
                                name="effectiveFrom"
                                required
                                max={todayKst()}
                                value={statusChange.effectiveFrom}
                                onChange={(event) => setStatusChange((current) => current && ({ ...current, effectiveFrom: event.target.value }))}
                                data-admin-modal-initial-focus="true"
                                className="mt-1 min-h-11 w-full rounded-xl border border-gray-200 bg-white px-3 text-gray-950 dark:border-gray-700 dark:bg-gray-800 dark:text-white"
                            />
                        </label>
                        <label className="block text-sm font-bold text-gray-700 dark:text-gray-200">
                            변경 사유 (선택)
                            <textarea
                                name="reason"
                                value={statusChange.reason}
                                onChange={(event) => setStatusChange((current) => current && ({ ...current, reason: event.target.value }))}
                                rows={3}
                                className="mt-1 w-full rounded-xl border border-gray-200 bg-white p-3 text-gray-950 dark:border-gray-700 dark:bg-gray-800 dark:text-white"
                            />
                        </label>
                        {statusFormError && <p role="alert" className="text-sm font-bold text-red-600">{statusFormError}</p>}
                        <div className="flex justify-end gap-2">
                            <button type="button" onClick={() => setStatusChange(null)} disabled={Boolean(statusUpdatingId)} className="min-h-11 rounded-xl border border-gray-200 px-4 font-bold disabled:opacity-60 dark:border-gray-700">취소</button>
                            <button type="submit" disabled={Boolean(statusUpdatingId)} className="min-h-11 rounded-xl bg-[var(--color-academy-primary)] px-5 font-black text-white disabled:opacity-60">
                                {statusUpdatingId ? "저장 중…" : "변경 저장"}
                            </button>
                        </div>
                    </form>
                </AdminModal>
            )}

            {/* 배차용 셔틀 위치 지도 선택 모달 — 핀(좌표) 확정 시에만 저장(서버가 좌표 필수 검증) */}
            {pickerKind && (
                <LocationPickerModal
                    title={`셔틀 ${pickerKind === "PICKUP" ? "승차" : "하차"} 위치`}
                    initialValue={(() => {
                        const loc = pickerKind === "PICKUP" ? pickupLoc : dropoffLoc;
                        return loc && loc.latitude != null && loc.longitude != null
                            ? { address: loc.roadAddress || loc.address || "", latitude: loc.latitude, longitude: loc.longitude, source: "MAP_PIN" as const }
                            : undefined;
                    })()}
                    confirmPending={shuttleSaving}
                    onConfirm={(loc) => void saveShuttleLocation(pickerKind, loc)}
                    onClose={() => setPickerKind(null)}
                />
            )}
        </div>
    );
}
