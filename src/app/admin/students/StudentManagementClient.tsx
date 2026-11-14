"use client";
import AbsencePeriodQuickCreate from "@/components/admin/AbsencePeriodQuickCreate";
import UiIcon from "@/components/common/UiIcon";
import { adminErrorText } from "@/components/admin/adminDisplayText";

import { useCallback, useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import {
    updateStudent,
    deleteStudent,
    enrollStudent,
} from "@/app/actions/admin";
import AdminModal from "@/components/admin/AdminModal";
import AdminPageHeader from "@/components/admin/AdminPageHeader";
import ProfileAvatar from "@/components/common/ProfileAvatar";
import { profilePhotoUrl } from "@/lib/profilePhoto/rules";
import type { StudentRegistered } from "./StudentRegisterModal";
import AdminQuickActionMenu from "@/components/admin/AdminQuickActionMenu";
import { useAdminConfirm } from "@/components/admin/AdminConfirmDialog";
import CompactListFilters from "@/components/academy/CompactListFilters";
// 목록 개편 공용 부품(1단계 신청·상담과 같은 모양): 상세 패널·상태 칩·보기 전환
import ListDetailPanel from "@/components/admin/list/ListDetailPanel";
import StatusCountChips from "@/components/admin/list/StatusCountChips";
import ListViewToggle, { useRememberedListView } from "@/components/admin/list/ListViewToggle";
import { isCurrentEnrollment } from "@/lib/enrollment/commencement";

const ExcelUploadModal = dynamic(() => import("./ExcelUploadModal"), {
    ssr: false,
    loading: () => null,
});
// 새 «원생 등록» 창(3단계) — 누를 때만 불러온다
const StudentRegisterModal = dynamic(() => import("./StudentRegisterModal"), {
    ssr: false,
    loading: () => null,
});

type Student = {
    id: string;
    name: string;
    /** 프로필 사진 캐시 버전(사진 없으면 null → 이름 첫 글자) */
    photoVersion?: string | null;
    birthDate: Date | string;
    gender: string | null;
    parentId: string;
    // 새 필드: 엑셀 업로드 일괄 등록용
    phone: string | null;       // 학생 휴대폰번호
    school: string | null;      // 학교명
    grade: string | null;       // 학년
    address: string | null;     // 주소
    enrollDate: Date | string | null;  // 입회일자
    createdAt: Date | string;
    currentStatus?: string | null;
    parent: {
        name: string | null;
        phone: string | null;
        email: string | null;
    };
    // 수강 정보 (getStudents 서브쿼리에서 가져옴)
    enrollments: {
        classId: string;
        className: string;
        status: string;
        displayStatus?: string;
        startsOn?: string | null;
        startsLater?: boolean;
        dayOfWeek: string;
        startTime: string;
        slotKey: string | null;
        createdAt?: string;
    }[];
};

type ClassItem = {
    id: string;
    name: string;
    dayOfWeek: string;
    startTime: string;
    endTime: string;
    slotKey: string | null; // 시간표 슬롯 키 (예: "Mon-4")
    program: { id: string; name: string } | null;
};

type ScheduleMismatch = {
    slotKey: string;
    sheetCount: number;
    dbCount: number;
    diff: number;
};

type SheetImportSummary = {
    id: string;
    status: string;
    totalRows: number;
    registrationRows: number;
    vehicleRows: number;
    changeRows: number;
    teamRows: number;
    errorRows: number;
    message: string | null;
    createdAt: string;
    completedAt: string | null;
    uniqueStudents: number;
    linkedRegistrations: number;
    studentStatusCounts?: {
        total: number;
        active: number;
        paused: number;
        withdrawn: number;
        noEnrollment: number;
    };
    scheduleMismatchCount: number;
    topScheduleMismatches: ScheduleMismatch[];
} | null;

const DAY_LABELS: Record<string, string> = {
    Mon: "월", Tue: "화", Wed: "수", Thu: "목", Fri: "금", Sat: "토", Sun: "일",
};

// 요일 정렬 순서 (월~일)
const DAY_ORDER: Record<string, number> = {
    Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6,
};

const STUDENT_PAGE_SIZE = 50;

/**
 * slotKey에서 교시 번호를 추출하는 유틸 함수
 * 예: "Mon-4" → 4, "Sat-2" → 2, "custom-xxx" → 999 (커스텀은 맨 뒤로)
 */
function getPeriodFromSlotKey(slotKey: string | null): number {
    if (!slotKey) return 999;
    const match = slotKey.match(/-(\d+)$/);
    return match ? parseInt(match[1], 10) : 999;
}

/**
 * Class 목록을 프로그램별로 그룹화하고, 각 그룹 안에서 요일+교시 순으로 정렬
 * 반환: { programName: string, classes: ClassItem[] }[]
 */
function groupClassesByProgram(classes: ClassItem[]) {
    // 프로그램별로 그룹핑
    const groups = new Map<string, { programName: string; classes: ClassItem[] }>();

    for (const c of classes) {
        const key = c.program?.id ?? "__no_program__";
        const name = c.program?.name ?? "미지정 프로그램";
        if (!groups.has(key)) {
            groups.set(key, { programName: name, classes: [] });
        }
        groups.get(key)!.classes.push(c);
    }

    // 각 그룹 안에서 요일 + 교시 순으로 정렬
    for (const group of groups.values()) {
        group.classes.sort((a, b) => {
            const dayDiff = (DAY_ORDER[a.dayOfWeek] ?? 99) - (DAY_ORDER[b.dayOfWeek] ?? 99);
            if (dayDiff !== 0) return dayDiff;
            return getPeriodFromSlotKey(a.slotKey) - getPeriodFromSlotKey(b.slotKey);
        });
    }

    return Array.from(groups.values());
}

function toDateStr(d: Date | string | null): string {
    if (!d) return "";
    const date = typeof d === "string" ? new Date(d) : d;
    return date.toISOString().split("T")[0];
}

/**
 * 학년 문자열을 간결하게 변환하는 유틸 함수
 * "2026년 초등 4학년" -> "초4", "2026년 중등 1학년" -> "중1", "성인" -> "성인"
 */
function shortenGrade(grade: string | null): string {
    if (!grade) return "-";
    if (grade === "성인") return "성인";
    // "초등 N학년" 패턴 매칭 (연도 접두사 무시)
    const elemMatch = grade.match(/초등\s*(\d)/);
    if (elemMatch) return `초${elemMatch[1]}`;
    // "중등 N학년" 패턴 매칭
    const midMatch = grade.match(/중등\s*(\d)/);
    if (midMatch) return `중${midMatch[1]}`;
    // "고등 N학년" 패턴 매칭
    const highMatch = grade.match(/고등\s*(\d)/);
    if (highMatch) return `고${highMatch[1]}`;
    // 매칭 안 되면 원본 그대로
    return grade;
}

/**
 * 수강 반 이름을 간결하게 변환: "월요일 6교시" -> "월6"
 * slotKey가 있으면 slotKey(예: "Mon-4") 활용, 없으면 className에서 추출
 */
function shortenClassName(enrollment: { dayOfWeek: string; className: string; slotKey?: string | null }): string {
    const dayLabel = DAY_LABELS[enrollment.dayOfWeek] || enrollment.dayOfWeek;
    // slotKey에서 교시 번호 추출 (예: "Mon-4" -> 4)
    if (enrollment.slotKey) {
        const match = enrollment.slotKey.match(/-(\d+)$/);
        if (match) return `${dayLabel}${match[1]}`;
    }
    // className에서 교시 번호 추출 (예: "월요일 6교시" -> 6)
    const periodMatch = enrollment.className.match(/(\d+)\s*교시/);
    if (periodMatch) return `${dayLabel}${periodMatch[1]}`;
    // 추출 실패 시 요일 + 반이름 축약
    return `${dayLabel}`;
}

/**
 * 전화번호에 하이픈 포맷 적용: "01052594903" -> "010-5259-4903"
 */
function formatPhone(phone: string | null): string {
    if (!phone) return "-";
    // 이미 하이픈이 있으면 그대로 반환
    if (phone.includes("-")) return phone;
    // 숫자만 추출
    const digits = phone.replace(/\D/g, "");
    // 010-XXXX-XXXX (11자리)
    if (digits.length === 11) return `${digits.slice(0, 3)}-${digits.slice(3, 7)}-${digits.slice(7)}`;
    // 02-XXXX-XXXX (10자리, 서울)
    if (digits.length === 10 && digits.startsWith("02")) return `${digits.slice(0, 2)}-${digits.slice(2, 6)}-${digits.slice(6)}`;
    // 0XX-XXX-XXXX (10자리, 지역번호)
    if (digits.length === 10) return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
    return phone;
}

/**
 * 학부모 이름을 간결하게 표시
 * "기타(기본 보호자)" -> "보호자", "기타(본인)" -> "본인"
 */
function shortenParentName(name: string | null): string {
    if (!name) return "-";
    if (name === "기타(기본 보호자)" || name === "기본 보호자") return "보호자";
    if (name === "기타(본인)") return "본인";
    // "기타(...)" 패턴에서 괄호 안의 내용만 추출
    const etcMatch = name.match(/^기타\((.+)\)$/);
    if (etcMatch) return etcMatch[1];
    return name;
}

/**
 * 학생의 대표 상태를 판단하는 헬퍼 함수
 * - ACTIVE가 1개라도 있으면 "ACTIVE" (활성 수강이 있으니까)
 * - 없으면 가장 최근 enrollment의 status를 사용
 */
function getLatestStatus(enrollments: Student["enrollments"]): string | null {
    if (!enrollments || enrollments.length === 0) return null;
    let latest = enrollments[0];
    let latestTime = latest.createdAt ? new Date(latest.createdAt).getTime() : 0;

    for (const enrollment of enrollments) {
        // 2026-11-09 새 기준: ACTIVE 면 개시일과 무관하게 활성(공용 판정 isCurrentEnrollment)
        if (isCurrentEnrollment(enrollment.status)) return "ACTIVE";

        const createdAt = enrollment.createdAt ? new Date(enrollment.createdAt).getTime() : 0;
        if (createdAt > latestTime) {
            latest = enrollment;
            latestTime = createdAt;
        }
    }

    return latest.status;
}

function getStatusLabel(status: string | null) {
    if (status === "ACTIVE") return "활성";
    if (status === "PAUSED") return "휴원";
    if (status === "WITHDRAWN") return "퇴원";
    return "미배정";
}

function getStatusPillClass(status: string | null) {
    if (status === "ACTIVE") return "bg-[var(--color-academy-success-soft)] text-[var(--color-academy-success)] ring-[var(--color-academy-line)]";
    if (status === "PAUSED") return "bg-[var(--color-academy-warning-soft)] text-[var(--color-academy-warning)] ring-[var(--color-academy-line)]";
    if (status === "WITHDRAWN") return "bg-[var(--color-academy-danger-soft)] text-[var(--color-academy-danger)] ring-[var(--color-academy-line)]";
    return "bg-[var(--color-academy-soft)] text-[var(--color-academy-muted)] ring-[var(--color-academy-line)]";
}

function getAssignedEnrollments(enrollments: Student["enrollments"]) {
    return (enrollments ?? []).filter((enrollment) => isCurrentEnrollment(enrollment.status));
}

// 「반별 보기」에서 쓰는 묶음 한 개(반 하나 또는 맨 끝 «반 없음»)
type ClassGroup = {
    key: string;          // 반 id, 반 없음 묶음은 "__none__"
    label: string;        // 예: "월4" / "반 없음"
    fullName: string;     // 마우스를 올리면 보일 원래 반 이름
    startTime: string;
    dayOfWeek: string;
    slotKey: string | null;
    students: Student[];
};

const NO_CLASS_KEY = "__none__";
// 기억 키는 예전 그대로 둔다(원장이 골라 둔 «반별» 보기가 개편 뒤에도 유지되게)
const STUDENT_VIEW_STORAGE_KEY = "admin-students-view-mode";
const STUDENT_VIEW_VALUES = ["list", "class"] as const;
const STUDENT_VIEW_OPTIONS = [
    { value: "list", label: "목록" },
    { value: "class", label: "반별" },
] as const;
// 상태 칩 순서와 이름. 값은 필터 모달 «수강 상태» select 의 값과 같다(칩·select 가 한 상태를 공유)
const STUDENT_STATUS_CHIPS = [
    { value: "ACTIVE", label: "활성" },
    { value: "PAUSED", label: "휴원" },
    { value: "WITHDRAWN", label: "퇴원" },
    { value: "NONE", label: "미배정" },
] as const;
// 상태 기본값 — 처음 열 때·필터 초기화·켜진 칩을 다시 누를 때 모두 이 값으로 돌아간다
const DEFAULT_STATUS_FILTER = "ACTIVE";
// 수정 폼 입력칸 공통 모양 = 테마 공용 입력칸(academy-input: 44px·입력선 테두리). 새 등록은 StudentRegisterModal(3단계 창)이 맡는다
const STUDENT_FORM_INPUT_CLASS = "academy-input min-w-0";

// 요일 → 시작시간 순으로 정렬한 활성 수강 목록(목록 칸·상세 패널이 같은 순서를 쓰게)
function sortEnrollmentsByDay(enrollments: Student["enrollments"]) {
    return [...enrollments].sort(
        (a, b) => (DAY_ORDER[a.dayOfWeek] ?? 99) - (DAY_ORDER[b.dayOfWeek] ?? 99) || a.startTime.localeCompare(b.startTime),
    );
}

/**
 * 필터가 적용된 학생 목록을 «활성 수강반» 기준으로 묶는다.
 * - 한 학생이 여러 반이면 각 반에 모두 들어간다(반마다 명단을 보려는 용도라서).
 * - 반 순서: 요일(월~일) → 시작시간 → 교시. 활성 반이 없는 학생은 맨 끝 «반 없음».
 * - 각 반 안의 학생 순서는 들어온 순서(이름 가나다순)를 그대로 유지한다.
 */
function groupStudentsByActiveClass(list: Student[]): ClassGroup[] {
    const groups = new Map<string, ClassGroup>();
    const noClass: Student[] = [];

    for (const student of list) {
        const active = getAssignedEnrollments(student.enrollments);
        if (active.length === 0) {
            noClass.push(student);
            continue;
        }
        // 같은 반에 중복 수강 기록이 있어도 한 번만 넣는다
        const seen = new Set<string>();
        for (const e of active) {
            if (seen.has(e.classId)) continue;
            seen.add(e.classId);
            let group = groups.get(e.classId);
            if (!group) {
                group = {
                    key: e.classId,
                    label: shortenClassName(e),
                    fullName: e.className,
                    startTime: e.startTime,
                    dayOfWeek: e.dayOfWeek,
                    slotKey: e.slotKey,
                    students: [],
                };
                groups.set(e.classId, group);
            }
            group.students.push(student);
        }
    }

    const sorted = Array.from(groups.values()).sort((a, b) =>
        (DAY_ORDER[a.dayOfWeek] ?? 99) - (DAY_ORDER[b.dayOfWeek] ?? 99)
        || a.startTime.localeCompare(b.startTime)
        || getPeriodFromSlotKey(a.slotKey) - getPeriodFromSlotKey(b.slotKey)
        || a.label.localeCompare(b.label, "ko"),
    );

    if (noClass.length > 0) {
        sorted.push({
            key: NO_CLASS_KEY,
            label: "반 없음",
            fullName: "활성 수강반이 없는 학생",
            startTime: "",
            dayOfWeek: "",
            slotKey: null,
            students: noClass,
        });
    }
    return sorted;
}

export default function StudentManagementClient({
    students: initialStudents,
    classes: initialClasses,
    sheetImportSummary: initialSheetImportSummary,
    partial: initialPartial = false,
}: {
    students?: Student[];
    classes?: ClassItem[];
    sheetImportSummary?: SheetImportSummary;
    partial?: boolean;
}) {
    // 삭제 확인 = 공용 확인 창(브라우저 기본 confirm 대신) — 대상 이름·위험색 확정
    const { confirm: askConfirm, confirmDialog } = useAdminConfirm();
    const hasInitialData = Boolean(initialStudents || initialClasses);
    const [students, setStudents] = useState<Student[]>(initialStudents ?? []);
    const [classes, setClasses] = useState<ClassItem[]>(initialClasses ?? []);
    // 상단 집계용 요약(옛 시트 이관 숫자). 시트 연동은 은퇴했고, 주어지지 않으면 불러온 목록으로 센다.
    const sheetImportSummary: SheetImportSummary = initialSheetImportSummary ?? null;
    const [dataLoading, setDataLoading] = useState(!hasInitialData);
    const [dataError, setDataError] = useState<string | null>(null);
    const [allStudentsLoaded, setAllStudentsLoaded] = useState(!initialPartial);
    const [backgroundLoading, setBackgroundLoading] = useState(false);
    const [autoLoadRequested, setAutoLoadRequested] = useState(false);
    // 인라인 폼은 «수정» 전용. 새 등록은 3단계 창(showRegister)
    const [showForm, setShowForm] = useState(false);
    const [showRegister, setShowRegister] = useState(false);
    const [editingId, setEditingId] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [search, setSearch] = useState("");
    const [enrollModal, setEnrollModal] = useState<string | null>(null);
    // ⚡ «기간 결석 등록»(2026-11-15) — 그 원생의 등록 창을 바로 연다
    const [absencePeriodFor, setAbsencePeriodFor] = useState<string | null>(null);
    // 엑셀 업로드 모달 열기/닫기 상태
    const [showExcelUpload, setShowExcelUpload] = useState(false);

    // 필터 상태: 반/학년/학교/수강상태
    const [filterClass, setFilterClass] = useState("");
    const [filterGrade, setFilterGrade] = useState("");
    const [filterSchool, setFilterSchool] = useState("");

    // 보기 방식: "list"(기존 표) / "class"(반별 묶음). 마지막 선택을 브라우저에 기억한다.
    // 공용 훅이 처음엔 "list"로 그린 뒤(hydration) 저장된 값을 읽어 바꾸고, 바꿀 때마다 저장한다.
    const [viewMode, changeViewMode] = useRememberedListView(STUDENT_VIEW_STORAGE_KEY, STUDENT_VIEW_VALUES, "list");
    // 반별 보기에서 접어 둔 반 id 목록
    const [collapsedClassKeys, setCollapsedClassKeys] = useState<Set<string>>(() => new Set());
    // 행을 눌러 연 상세 패널의 학생 id. 목록을 다시 불러와도 최신 값이 보이도록 id 로 들고 있다.
    const [detailStudentId, setDetailStudentId] = useState<string | null>(null);

    const toggleClassCollapsed = (key: string) => {
        setCollapsedClassKeys((current) => {
            const next = new Set(current);
            if (next.has(key)) next.delete(key);
            else next.add(key);
            return next;
        });
    };

    const loadData = useCallback(async ({ background = false }: { background?: boolean } = {}) => {
        if (background) setBackgroundLoading(true);
        else setDataLoading(true);
        setDataError(null);

        try {
            const response = await fetch("/api/admin/students", {
                cache: "no-store",
            });

            if (!response.ok) {
                throw new Error("Failed to load students.");
            }

            const data = (await response.json()) as {
                students?: Student[];
                classes?: ClassItem[];
            };

            setStudents(data.students ?? []);
            setClasses(data.classes ?? []);
            setAllStudentsLoaded(true);
        } catch (error) {
            console.error("Failed to load students:", error);
            setDataError("원생 목록을 불러오지 못했습니다.");
        } finally {
            if (background) setBackgroundLoading(false);
            else setDataLoading(false);
        }
    }, []);

    const requestFullStudentLoad = useCallback(() => {
        if (allStudentsLoaded || backgroundLoading) return;

        setAutoLoadRequested(true);
        void loadData({ background: true });
    }, [allStudentsLoaded, backgroundLoading, loadData]);

    useEffect(() => {
        if (!hasInitialData) {
            void loadData();
        }
    }, [hasInitialData, loadData]);

    useEffect(() => {
        if (!initialPartial || allStudentsLoaded || backgroundLoading || autoLoadRequested) return;

        const timer = window.setTimeout(() => {
            requestFullStudentLoad();
        }, 700);

        return () => window.clearTimeout(timer);
    }, [allStudentsLoaded, autoLoadRequested, backgroundLoading, initialPartial, requestFullStudentLoad]);
    // 기본 필터를 "활성"으로 설정 — 대부분 수강 중인 학생을 먼저 봄
    const [filterStatus, setFilterStatus] = useState<string>(DEFAULT_STATUS_FILTER);
    const [visibleLimit, setVisibleLimit] = useState(STUDENT_PAGE_SIZE);

    // 필터 선택지: 학생 데이터에서 고유값 추출 (useMemo로 캐싱)
    const gradeOptions = useMemo(() => {
        const set = new Set<string>();
        students.forEach((s) => { if (s.grade) set.add(s.grade); });
        return Array.from(set).sort((a, b) => a.localeCompare(b, "ko"));
    }, [students]);

    const schoolOptions = useMemo(() => {
        const set = new Set<string>();
        students.forEach((s) => { if (s.school) set.add(s.school); });
        return Array.from(set).sort((a, b) => a.localeCompare(b, "ko"));
    }, [students]);

    const studentStatusById = useMemo(() => {
        const statusMap = new Map<string, string | null>();
        students.forEach((student) => {
            statusMap.set(student.id, student.currentStatus ?? getLatestStatus(student.enrollments));
        });
        return statusMap;
    }, [students]);

    // Form state
    const [name, setName] = useState("");
    const [birthDate, setBirthDate] = useState("");
    const [gender, setGender] = useState("");
    const [parentName, setParentName] = useState("");
    const [parentPhone, setParentPhone] = useState("");
    // 폼 안 오류(서버가 돌려준 안내 문구) · 저장 뒤 목록 위 안내 한 줄
    const [formError, setFormError] = useState<string | null>(null);
    const [formNotice, setFormNotice] = useState<string | null>(null);

    function resetForm() {
        setName("");
        setBirthDate("");
        setGender("");
        setParentName("");
        setParentPhone("");
        setFormError(null);
        setShowForm(false);
        setEditingId(null);
    }

    function startEdit(s: Student) {
        setName(s.name);
        setBirthDate(toDateStr(s.birthDate));
        setGender(s.gender || "");
        setParentName(s.parent.name || "");
        setParentPhone(s.parent.phone || "");
        setFormError(null);
        setFormNotice(null);
        setEditingId(s.id);
        setShowForm(true);
    }

    async function handleSubmit(e: React.FormEvent) {
        e.preventDefault();
        // 인라인 폼은 «수정» 전용 — 새 등록은 3단계 창(StudentRegisterModal)
        if (!editingId || !name.trim() || !birthDate || !parentName.trim()) return;
        setBusy(true);
        setFormError(null);
        let saved: Awaited<ReturnType<typeof updateStudent>> | null = null;
        const editedStudent = students.find((item) => item.id === editingId);
        try {
            saved = await updateStudent(editingId, {
                name: name.trim(),
                birthDate,
                gender: gender || null,
                parentName: parentName.trim(),
                parentPhone: parentPhone.trim() || null,
            });
        } catch (err: unknown) {
            // 저장 실패는 폼을 닫지 않고 폼 안에 보여 준다
            setFormError(adminErrorText(err, "저장에 실패했습니다. 잠시 후 다시 시도해 주세요."));
            setBusy(false);
            return;
        }
        // 저장이 끝난 뒤에만 안내 → 폼 닫기 → 목록 새로 읽기 순서(1차 검수 권장: 예전엔 닫힌 폼에 오류를 써서 안 보였다).
        // 목록 읽기 실패는 loadData 가 목록 위(dataError)에 따로 보여 준다.
        // 로그인하는 학부모 계정·직원 계정은 이름·번호를 바꾸지 않는다 — 바꾸려 했으면 어디서 고치는지 알려 준다
        const parentChanged = editedStudent
            && (parentName.trim() !== (editedStudent.parent.name || "") || parentPhone.trim() !== (editedStudent.parent.phone || ""));
        setFormNotice(saved.parentPhoneConflict
            ? "학생 정보는 저장했습니다. 바꾸려던 휴대폰 번호는 다른 계정이 이미 쓰고 있어 그대로 두었어요 — 학생 상세의 «보호자» 카드에서 확인해 주세요."
            : !saved.parentAccountUpdated && parentChanged
                ? "학생 정보는 저장했습니다. 학부모 로그인 계정의 이름·번호는 바꾸지 않았어요 — 학생 상세의 «보호자» 카드에서 고쳐 주세요."
                : null);
        resetForm();
        setBusy(false);
        await loadData();
    }

    // 3단계 등록 창이 저장을 마치면 — 창 닫기 → 새 학생이 보이게 필터 정리 + 상세 패널 열기 → 안내 → 목록 새로 읽기
    async function handleRegistered(result: StudentRegistered) {
        setShowRegister(false);
        setSearch("");
        setFilterClass("");
        setFilterGrade("");
        setFilterSchool("");
        // 반을 골랐으면 «전체»(개시일이 미래여도 활성이지만 기존 동작 유지), 반 나중 배정이면 «미배정»
        setFilterStatus(result.classCount > 0 ? "" : "NONE");
        setDetailStudentId(result.studentId);
        setFormNotice([
            `${result.name} 학생을 등록했습니다.`,
            result.staffAccount
                ? "같은 번호의 학부모 계정이 없어 직원 계정(직원 자녀)에 연결했어요."
                : result.parentAccountCreated
                    ? "새 학부모 계정을 만들었어요(학부모가 같은 번호로 가입하면 자동 연결)."
                    : "같은 번호의 기존 학부모 계정에 연결했어요.",
            result.classCount > 0 ? "" : "반 배정은 열린 패널의 «수강등록»에서 해 주세요.",
        ].filter(Boolean).join(" "));
        await loadData();
    }

    async function handleDelete(id: string) {
        setBusy(true);
        try {
            await deleteStudent(id);
            await loadData();
        } catch (err: unknown) {
            alert(adminErrorText(err, "삭제 실패"));
        } finally {
            setBusy(false);
        }
    }

    async function handleEnroll(studentId: string, classId: string) {
        setBusy(true);
        try {
            await enrollStudent(studentId, classId);
            setEnrollModal(null);
            await loadData();
        } catch (err: unknown) {
            alert(adminErrorText(err, "수강 등록 실패"));
        } finally {
            setBusy(false);
        }
    }

    // 상태별 학생 수 집계 (상단 요약용)
    // 최신 enrollment 기준으로 학생의 대표 상태를 판단
    const loadedStatusCounts = useMemo(() => {
        let active = 0;
        let paused = 0;
        let withdrawn = 0;
        let noEnrollment = 0;

        for (const s of students) {
            const status = studentStatusById.get(s.id) ?? null;
            if (!status) {
                noEnrollment++;
            } else if (status === "ACTIVE") {
                active++;
            } else if (status === "PAUSED") {
                paused++;
            } else if (status === "WITHDRAWN") {
                withdrawn++;
            } else {
                noEnrollment++;
            }
        }

        return { active, paused, withdrawn, noEnrollment, total: students.length };
    }, [students, studentStatusById]);
    // 현재 인원은 실제 수강 등록으로 집계한다. 과거 시트 요약으로 덮어쓰지 않는다.
    const statusCounts = loadedStatusCounts;

    const applyStatusFilter = useCallback((value: string) => {
        setFilterStatus(value);
        requestFullStudentLoad();
    }, [requestFullStudentLoad]);

    // 검색 + 필터 조합 (AND 조건): useMemo로 캐싱하여 불필요한 재계산 방지
    // 결과를 이름 가나다순으로 정렬
    const filtered = useMemo(() => {
        const query = search.trim().toLowerCase();
        const result = students.filter((s) => {
            // 텍스트 검색
            if (query) {
                const matchSearch =
                    s.name.toLowerCase().includes(query) ||
                    (s.parent.name && s.parent.name.toLowerCase().includes(query)) ||
                    (s.parent.phone && s.parent.phone.includes(query)) ||
                    (s.school && s.school.toLowerCase().includes(query));
                if (!matchSearch) return false;
            }
            // 반(Class) 필터: 해당 반에 수강 중인 학생만
            if (filterClass) {
                const hasClass = s.enrollments?.some((e) => e.classId === filterClass && isCurrentEnrollment(e.status));
                if (!hasClass) return false;
            }
            // 학년 필터
            if (filterGrade && s.grade !== filterGrade) return false;
            // 학교 필터
            if (filterSchool && s.school !== filterSchool) return false;
            // 수강 상태 필터: 최신 enrollment 상태 기준으로 판단
            if (filterStatus) {
                const latestStatus = studentStatusById.get(s.id) ?? null;
                if (filterStatus === "NONE") {
                    if (latestStatus !== null) return false;
                } else {
                    if (latestStatus !== filterStatus) return false;
                }
            }
            return true;
        });
        // 이름 가나다순 정렬 (기본 정렬)
        result.sort((a, b) => a.name.localeCompare(b.name, "ko"));
        return result;
    }, [students, search, filterClass, filterGrade, filterSchool, filterStatus, studentStatusById]);

    useEffect(() => {
        setVisibleLimit(STUDENT_PAGE_SIZE);
    }, [search, filterClass, filterGrade, filterSchool, filterStatus]);

    const visibleStudents = useMemo(
        () => filtered.slice(0, visibleLimit),
        [filtered, visibleLimit],
    );
    // 반별 보기: 페이지 나눔 없이 필터 결과 전체를 반 기준으로 묶는다(반별 모드일 때만 계산)
    const classGroups = useMemo(
        () => {
            if (viewMode !== "class") return [];
            const groups = groupStudentsByActiveClass(filtered);
            // 반 필터를 걸었으면 그 반 묶음만 보인다(함께 다니는 다른 반이 «일부 인원»으로 섞여 헷갈리지 않게).
            return filterClass ? groups.filter((group) => group.key === filterClass) : groups;
        },
        [filtered, viewMode, filterClass],
    );
    const hasMoreStudents = visibleStudents.length < filtered.length;
    const hasAnyFilter = Boolean(search.trim() || filterClass || filterGrade || filterSchool || filterStatus);
    const activeFilterCount = [Boolean(filterClass), Boolean(filterGrade), Boolean(filterSchool), filterStatus !== DEFAULT_STATUS_FILTER].filter(Boolean).length;
    const filterSummary = [
        filterStatus ? getStatusLabel(filterStatus === "NONE" ? null : filterStatus) : "전체 상태",
        filterClass && (classes.find((item) => item.id === filterClass)?.name ?? "선택한 반"),
        filterGrade,
        filterSchool,
        search.trim() && `검색: ${search.trim()}`,
    ].filter(Boolean).join(" · ");
    const emptyStudentsMessage = !allStudentsLoaded && hasAnyFilter
        ? "전체 원생 목록을 불러오는 중입니다. 잠시 후 자동으로 결과가 갱신됩니다."
        : hasAnyFilter
            ? "조건에 맞는 원생이 없습니다."
            : "등록된 원생이 없습니다. \"원생 등록\" 버튼으로 새 원생을 등록하세요.";

    // 상세 패널에 보일 학생(삭제·재조회로 사라지면 자동으로 닫힌 것처럼 null)
    const detailStudent = detailStudentId ? students.find((item) => item.id === detailStudentId) ?? null : null;

    // 행(⚡ 제외)을 누르면 그 학생 요약 패널을 연다
    function openStudentDetail(id: string) {
        setDetailStudentId(id);
    }

    // 행 키보드: Enter/Space 로 패널 열기. 행 안 버튼(⚡·이름 링크)의 키 입력은 그 버튼이 처리하도록 건드리지 않는다.
    function handleRowKeyDown(event: React.KeyboardEvent<HTMLElement>, id: string) {
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            openStudentDetail(id);
        }
    }

    // ⚡ 빠른 작업 목록(기존 그대로: 수강등록·수정·삭제)
    function buildQuickActions(s: Student) {
        return [
            {
                key: "enroll",
                label: "수강등록",
                icon: "how_to_reg",
                tone: "primary" as const,
                onSelect: () => setEnrollModal(s.id),
            },
            {
                key: "edit",
                label: "수정",
                icon: "edit",
                onSelect: () => startEdit(s),
            },
            {
                // 부상·질병 등으로 며칠 쉬는 원생 — 학생 상세의 등록 창을 그대로 연다
                key: "absence-period",
                label: "기간 결석 등록",
                icon: "event_busy",
                onSelect: () => setAbsencePeriodFor(s.id),
            },
            {
                key: "delete",
                label: "삭제",
                icon: "delete",
                tone: "danger" as const,
                disabled: busy,
                onSelect: async () => {
                    if (await askConfirm({ title: `"${s.name}" 원생 삭제`, description: "원생 정보가 바로 삭제됩니다.", confirmLabel: "삭제" })) {
                        void handleDelete(s.id);
                    }
                },
            },
        ];
    }

    // 수강 반 칸: 활성 반은 «월4, 수4» 짧은 표기(말줄임 없음).
    // 활성 반이 없는데 상태가 «활성»이면 «반 없음»(약한 경고색), 그 밖엔 상태 배지(휴원·퇴원·미배정).
    function renderClassCell(s: Student) {
        const activeEnrollments = getAssignedEnrollments(s.enrollments);
        if (activeEnrollments.length > 0) {
            return sortEnrollmentsByDay(activeEnrollments).map((e) => (
                <span key={e.classId} className="mr-2 inline-block">
                    {shortenClassName(e)}{e.startsLater && <span className="ml-1 text-xs text-[var(--color-academy-ink)]">{e.startsOn} 개시</span>}
                </span>
            ));
        }
        const status = studentStatusById.get(s.id) ?? null;
        if (status === "ACTIVE") {
            return (
                <span className="inline-flex rounded-full bg-[var(--color-academy-warning-soft)] px-2 py-0.5 text-xs font-medium text-[var(--color-academy-warning)]">
                    반 없음
                </span>
            );
        }
        return (
            <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ring-1 ${getStatusPillClass(status)}`}>
                {getStatusLabel(status)}
            </span>
        );
    }

    if (dataLoading && students.length === 0) {
        return (
            <div className="max-w-5xl mx-auto space-y-6">
                <div className="flex items-center justify-between">
                    <div className="space-y-2">
                        <div className="h-7 w-36 rounded bg-[var(--color-academy-soft)] animate-pulse" />
                        <div className="h-4 w-48 rounded bg-[var(--color-academy-soft)] animate-pulse" />
                    </div>
                    <div className="h-10 w-28 rounded-lg bg-[var(--color-academy-soft)] animate-pulse" />
                </div>
                <div className="h-11 w-full max-w-md rounded-lg bg-[var(--color-academy-soft)] animate-pulse" />
                <div className="overflow-hidden rounded-xl border border-[var(--color-academy-line)] bg-white">
                    {Array.from({ length: 8 }).map((_, index) => (
                        <div
                            key={index}
                            className="h-12 border-b border-[var(--color-academy-line)] bg-[var(--color-academy-soft)]/60 animate-pulse last:border-b-0"
                        />
                    ))}
                </div>
            </div>
        );
    }

    if (dataError && students.length === 0) {
        return (
            <div className="mx-auto max-w-5xl rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-danger-soft)] p-8 text-center">
                <p className="font-semibold text-[var(--color-academy-danger)]">{dataError}</p>
                <button
                    type="button"
                    onClick={() => void loadData()}
                    className="academy-button-primary mt-4"
                >
                    다시 불러오기
                </button>
            </div>
        );
    }

    return (
        <div className="max-w-5xl mx-auto">
            {/* 페이지 제목은 공용 머리말 부품(모양 한 가지). 상태별 숫자는 아래 상태 칩으로 옮겼다(누르면 그 상태만 보기) */}
            <AdminPageHeader
                className="mb-3"
                title="원생 관리"
                description={<>{sheetImportSummary?.studentStatusCounts ? "전체" : allStudentsLoaded ? "전체 목록" : "불러온 목록"} <span className="tabular-nums">{statusCounts.total}</span>명</>}
            />

            <CompactListFilters
                activeCount={activeFilterCount}
                summary={filterSummary}
                resultCount={`${filtered.length}명${!allStudentsLoaded ? " · 전체 불러오는 중" : ""}`}
                onReset={() => {
                    setFilterClass("");
                    setFilterGrade("");
                    setFilterSchool("");
                    setFilterStatus(DEFAULT_STATUS_FILTER);
                    requestFullStudentLoad();
                }}
                search={
                    <input
                        type="search"
                        aria-label="원생 검색"
                        placeholder="이름·학부모·연락처·학교 검색"
                        value={search}
                        onChange={(e) => {
                            setSearch(e.target.value);
                            if (e.target.value.trim()) requestFullStudentLoad();
                        }}
                        className="academy-input min-w-0"
                    />
                }
                actions={
                    <div className="flex flex-wrap items-center gap-2">
                        {!allStudentsLoaded && (
                            <button
                                type="button"
                                onClick={() => void loadData({ background: true })}
                                disabled={backgroundLoading}
                                className="academy-button-secondary"
                            >
                                {backgroundLoading ? "전체 불러오는 중" : "전체 목록 불러오기"}
                            </button>
                        )}
                        {/* 엑셀 일괄 업로드 버튼 — 원생 목록 엑셀 파일용 */}
                        <button
                            type="button"
                            onClick={() => setShowExcelUpload(true)}
                            className="academy-button-secondary"
                        >
                            엑셀 업로드
                        </button>
                        {/* 기존 1명씩 수동 등록 버튼 */}
                        <button
                            type="button"
                            onClick={() => { resetForm(); setFormNotice(null); setShowRegister(true); }}
                            className="academy-button-primary"
                        >
                            + 원생 등록
                        </button>
                    </div>
                }
            >
                <div className="col-span-full grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
                    {/* 반(Class) 필터 */}
                    <select
                        aria-label="반"
                        value={filterClass}
                        onChange={(e) => {
                            setFilterClass(e.target.value);
                            if (e.target.value) requestFullStudentLoad();
                        }}
                        className="academy-input min-w-0"
                    >
                        <option value="">전체 반</option>
                        {classes.map((c) => (
                            <option key={c.id} value={c.id}>
                                {c.name} ({DAY_LABELS[c.dayOfWeek] || c.dayOfWeek} {c.startTime})
                            </option>
                        ))}
                    </select>
                    {/* 학년 필터 */}
                    <select
                        aria-label="학년"
                        value={filterGrade}
                        onChange={(e) => {
                            setFilterGrade(e.target.value);
                            if (e.target.value) requestFullStudentLoad();
                        }}
                        className="academy-input min-w-0"
                    >
                        <option value="">전체 학년</option>
                        {gradeOptions.map((g) => (
                            <option key={g} value={g}>{g}</option>
                        ))}
                    </select>
                    {/* 학교 필터 */}
                    <select
                        aria-label="학교"
                        value={filterSchool}
                        onChange={(e) => {
                            setFilterSchool(e.target.value);
                            if (e.target.value) requestFullStudentLoad();
                        }}
                        className="academy-input min-w-0"
                    >
                        <option value="">전체 학교</option>
                        {schoolOptions.map((sc) => (
                            <option key={sc} value={sc}>{sc}</option>
                        ))}
                    </select>
                    {/* 수강 상태 필터 */}
                    <select
                        aria-label="수강 상태"
                        value={filterStatus}
                        onChange={(e) => applyStatusFilter(e.target.value)}
                        className="academy-input min-w-0"
                    >
                        <option value="">전체 상태</option>
                        <option value="ACTIVE">활성</option>
                        <option value="PAUSED">휴원</option>
                        <option value="WITHDRAWN">퇴원</option>
                        <option value="NONE">미배정</option>
                    </select>

                </div>
            </CompactListFilters>
            {/* 저장 뒤 안내 한 줄(등록 결과·학부모 계정 연결 결과) */}
            {formNotice && (
                <div role="status" className="mb-2 flex items-start gap-2 rounded-lg border border-[var(--color-academy-line)] bg-[var(--color-academy-primary-soft)] px-3 py-2 text-sm text-[var(--color-academy-ink)]">
                    <p className="min-w-0 flex-1 break-keep">{formNotice}</p>
                    <button
                        type="button"
                        onClick={() => setFormNotice(null)}
                        aria-label="안내 닫기"
                        className="-my-2 -mr-2 academy-button-text academy-button-sm shrink-0"
                    >
                        닫기
                    </button>
                </div>
            )}
            {/* 인라인 폼 = «수정» 전용(목록 ⚡ 수정). 새 등록은 3단계 창 */}
            {showForm && editingId && (
                <form onSubmit={handleSubmit} className="mb-3 space-y-3 rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] p-4">
                    <h3 className="academy-section-title">원생 수정</h3>

                    {/* 학생 3칸 + 학부모 2칸 — PC 3열·태블릿 2열·모바일 1열 */}
                    <div className="grid grid-cols-1 gap-x-3 gap-y-2 sm:grid-cols-2 lg:grid-cols-3">
                        <label className="block min-w-0">
                            <span className="mb-1 block text-xs font-medium text-[var(--color-academy-muted)]">이름 *</span>
                            <input
                                value={name}
                                onChange={(e) => setName(e.target.value)}
                                required
                                placeholder="홍길동"
                                className={STUDENT_FORM_INPUT_CLASS}
                            />
                        </label>
                        <label className="block min-w-0">
                            <span className="mb-1 block text-xs font-medium text-[var(--color-academy-muted)]">생년월일 *</span>
                            <input
                                type="text"
                                inputMode="numeric"
                                placeholder="예: 2016-03-15"
                                pattern="\d{4}-\d{2}-\d{2}"
                                title="2016-03-15 처럼 연-월-일로 입력해주세요."
                                maxLength={10}
                                value={birthDate}
                                onChange={(e) => {
                                    const digits = e.target.value.replace(/\D/g, "").slice(0, 8);
                                    const formatted = [
                                        digits.slice(0, 4),
                                        digits.slice(4, 6),
                                        digits.slice(6, 8),
                                    ].filter(Boolean).join("-");
                                    setBirthDate(formatted);
                                }}
                                required
                                className={STUDENT_FORM_INPUT_CLASS}
                            />
                        </label>
                        <label className="block min-w-0">
                            <span className="mb-1 block text-xs font-medium text-[var(--color-academy-muted)]">성별</span>
                            <select
                                value={gender}
                                onChange={(e) => setGender(e.target.value)}
                                className={STUDENT_FORM_INPUT_CLASS}
                            >
                                <option value="">선택 안함</option>
                                <option value="남">남</option>
                                <option value="여">여</option>
                            </select>
                        </label>
                        <label className="block min-w-0">
                            <span className="mb-1 block text-xs font-medium text-[var(--color-academy-muted)]">학부모 이름 *</span>
                            <input
                                value={parentName}
                                onChange={(e) => setParentName(e.target.value)}
                                required
                                placeholder="보호자 이름"
                                className={STUDENT_FORM_INPUT_CLASS}
                            />
                        </label>
                        <label className="block min-w-0">
                            <span className="mb-1 block text-xs font-medium text-[var(--color-academy-muted)]">학부모 연락처</span>
                            <input
                                type="tel"
                                inputMode="tel"
                                value={parentPhone}
                                onChange={(e) => setParentPhone(e.target.value)}
                                placeholder="010-0000-0000"
                                className={STUDENT_FORM_INPUT_CLASS}
                            />
                        </label>
                    </div>
                    <p className="text-xs text-[var(--color-academy-muted)]">
                        로그인하는 학부모 계정·직원 계정의 이름·번호는 여기서 바뀌지 않아요. 보호자 연락처는 학생 상세 «보호자» 카드에서 고쳐 주세요.
                    </p>

                    {formError && (
                        <p role="alert" className="rounded-lg bg-[var(--color-academy-warning-soft)] px-3 py-2 text-sm font-medium text-[var(--color-academy-warning)]">
                            {formError}
                        </p>
                    )}

                    <div className="flex justify-end gap-2">
                        <button
                            type="button"
                            onClick={resetForm}
                            className="academy-button-secondary"
                        >
                            취소
                        </button>
                        <button
                            type="submit"
                            disabled={busy}
                            className="academy-button-primary"
                        >
                            {busy ? "저장 중..." : "수정"}
                        </button>
                    </div>
                </form>
            )}

            {/* 상태 칩(누르면 그 상태만, 켜진 칩을 다시 누르면 기본값 «활성») + 보기 전환(목록 | 반별).
                칩은 필터 모달의 «수강 상태»(filterStatus)와 같은 값을 공유한다. */}
            <div className="mb-2 flex min-w-0 flex-wrap items-center justify-between gap-2">
                <StatusCountChips
                    ariaLabel="원생 상태별 인원"
                    items={STUDENT_STATUS_CHIPS.map((chip) => ({
                        value: chip.value,
                        label: chip.label,
                        count: chip.value === "ACTIVE" ? statusCounts.active
                            : chip.value === "PAUSED" ? statusCounts.paused
                                : chip.value === "WITHDRAWN" ? statusCounts.withdrawn
                                    : statusCounts.noEnrollment,
                    }))}
                    selected={filterStatus}
                    onSelect={applyStatusFilter}
                    allValue={DEFAULT_STATUS_FILTER}
                />
                <div className="flex items-center gap-2">
                    {viewMode === "class" && classGroups.length > 0 && (
                        <span className="text-xs text-[var(--color-academy-muted)]">
                            {classGroups.filter((group) => group.key !== NO_CLASS_KEY).length}개 반 · {filtered.length}명
                            {!allStudentsLoaded && " · 전체 불러오는 중"}
                        </span>
                    )}
                    <ListViewToggle
                        value={viewMode}
                        options={STUDENT_VIEW_OPTIONS}
                        ariaLabel="원생 보기 방식"
                        onChange={(mode) => {
                            changeViewMode(mode);
                            // 반별은 페이지 나눔 없이 전체를 묶으므로, 일부만 불러온 상태면 전체를 불러온다
                            if (mode === "class") requestFullStudentLoad();
                        }}
                    />
                </div>
            </div>

            {/* Student list */}
            {filtered.length === 0 ? (
                <div className="bg-white rounded-xl border border-[var(--color-academy-line)] p-12 text-center text-[var(--color-academy-faint)]">
                    {emptyStudentsMessage}
                </div>
            ) : viewMode === "class" ? (
                // 반별 보기: 반 블록을 데스크톱에서 2~3열로 배치해 스크롤을 줄인다
                <div className="grid grid-cols-1 items-start gap-2 md:grid-cols-2 lg:grid-cols-3">
                    {classGroups.map((group) => {
                        const collapsed = collapsedClassKeys.has(group.key);
                        return (
                            <section
                                key={group.key}
                                className="overflow-hidden rounded-lg border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)]"
                            >
                                {/* 반 머리줄: 누르면 접기/펼치기 */}
                                <button
                                    type="button"
                                    onClick={() => toggleClassCollapsed(group.key)}
                                    aria-expanded={!collapsed}
                                    title={group.fullName}
                                    className="flex min-h-11 w-full items-center gap-2 bg-[var(--color-academy-soft)] px-3 text-left text-sm"
                                >
                                    <span className="font-bold text-[var(--color-academy-ink)]">{group.label}</span>
                                    {group.startTime && (
                                        <span className="text-xs text-[var(--color-academy-muted)]">{group.startTime}</span>
                                    )}
                                    <span className="ml-auto text-xs tabular-nums text-[var(--color-academy-ink)]">
                                        {`${group.students.length}명`}
                                    </span>
                                    <span className="inline-flex shrink-0 text-[var(--color-academy-muted)]"><UiIcon name={!collapsed ? "expand_less" : "expand_more"} /></span>
                                </button>
                                {/* 학생 한 줄 행: 이름 · 학년 · 학교 · 학부모 연락처. 행을 누르면 목록과 같은 상세 패널 */}
                                {!collapsed && (
                                    <ul className="divide-y divide-[var(--color-academy-line)]">
                                        {group.students.map((s) => (
                                            <li
                                                key={`${group.key}-${s.id}`}
                                                tabIndex={0}
                                                aria-label={`${s.name} 요약 보기`}
                                                onClick={() => openStudentDetail(s.id)}
                                                onKeyDown={(event) => handleRowKeyDown(event, s.id)}
                                                className="grid min-h-11 cursor-pointer grid-cols-[auto_2.5rem_minmax(0,1fr)] items-center gap-2 px-3 text-sm transition hover:bg-[var(--color-academy-soft)] focus:bg-[var(--color-academy-primary-soft)] focus:outline-none"
                                            >
                                                {/* 이름 링크는 상세 페이지로(행 클릭과 겹치지 않게 전파 차단) */}
                                                <Link
                                                    href={`/admin/students/${s.id}`}
                                                    prefetch={false}
                                                    onClick={(event) => event.stopPropagation()}
                                                    className="flex min-h-11 items-center gap-2 whitespace-nowrap font-semibold text-[var(--color-academy-ink)] hover:text-[var(--color-academy-primary)]"
                                                >
                                                    {/* 아이 사진 28px(없으면 이름 첫 글자) — 행 높이(44px) 안이라 줄이 커지지 않는다 */}
                                                    <ProfileAvatar decorative name={s.name} size={28} src={profilePhotoUrl({ kind: "student", id: s.id }, s.photoVersion ?? null, true)} />
                                                    {s.name}
                                                    {s.enrollments.some((enrollment) => enrollment.classId === group.key && enrollment.startsLater) && <span className="ml-1 text-xs font-normal text-[var(--color-academy-ink)]">개시 전</span>}
                                                </Link>
                                                <span className="whitespace-nowrap text-[var(--color-academy-muted)]">{shortenGrade(s.grade)}</span>
                                                {/* 학교+연락처: 넉넉하면 한 줄, 카드가 좁으면 연락처가 학교 아래로 내려간다(학교 이름이 한 글자씩 꺾이지 않게) */}
                                                <span className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-2 py-1 text-[var(--color-academy-muted)]">
                                                    <span className="min-w-0 break-keep [overflow-wrap:break-word]">{s.school || "-"}</span>
                                                    <span className="whitespace-nowrap text-xs tabular-nums">
                                                        {formatPhone(s.parent.phone)}
                                                    </span>
                                                </span>
                                            </li>
                                        ))}
                                    </ul>
                                )}
                            </section>
                        );
                    })}
                </div>
            ) : (
                <div className="bg-white rounded-xl border border-[var(--color-academy-line)] overflow-hidden shadow-sm">
                    <div className="overflow-x-auto">
                        {/* admin-list-table: 글자 칸 왼쪽 정렬·한 줄(말줄임 없음)·칸 폭은 내용에 맞춤(좁으면 가로 스크롤) */}
                        <table className="admin-list-table w-full border-collapse text-sm">
                            <thead className="bg-[var(--color-academy-soft)] text-xs font-semibold text-[var(--color-academy-muted)]">
                                <tr>
                                    <th className="px-2 py-2">이름</th>
                                    <th className="px-2 py-2">학년</th>
                                    {/* 학교/학부모/연락처: 모바일에서 숨김(전체는 상세 패널) */}
                                    <th className="hidden px-2 py-2 md:table-cell">학교</th>
                                    <th className="px-2 py-2">수강 반</th>
                                    <th className="hidden px-2 py-2 md:table-cell">학부모</th>
                                    <th className="hidden px-2 py-2 md:table-cell">연락처</th>
                                    <th className="admin-cell-center px-2 py-2">관리</th>
                                </tr>
                            </thead>
                            <tbody>
                                {visibleStudents.map((s) => (
                                    <tr
                                        key={s.id}
                                        tabIndex={0}
                                        onClick={() => openStudentDetail(s.id)}
                                        onKeyDown={(event) => handleRowKeyDown(event, s.id)}
                                        className="cursor-pointer transition-colors focus:bg-[var(--color-academy-primary-soft)] focus:outline-none"
                                    >
                                        {/* 이름: 누르면 상세 페이지로 이동(행 클릭=요약 패널과 겹치지 않게 전파 차단) */}
                                        <td className="px-2 py-1.5">
                                            <Link
                                                href={`/admin/students/${s.id}`}
                                                prefetch={false}
                                                onClick={(event) => event.stopPropagation()}
                                                className="inline-flex items-center gap-2 font-semibold text-[var(--color-academy-ink)] hover:text-[var(--color-academy-primary)] transition-colors"
                                            >
                                                <ProfileAvatar decorative name={s.name} size={28} src={profilePhotoUrl({ kind: "student", id: s.id }, s.photoVersion ?? null, true)} />
                                                {s.name}
                                            </Link>
                                        </td>
                                        {/* 학년: shortenGrade로 "초4" 형태 */}
                                        <td className="px-2 py-1.5 text-[var(--color-academy-muted)]">
                                            {shortenGrade(s.grade)}
                                        </td>
                                        {/* 학교: 모바일 숨김 */}
                                        <td className="hidden px-2 py-1.5 text-[var(--color-academy-muted)] md:table-cell">
                                            {s.school || "-"}
                                        </td>
                                        {/* 수강 반: «월4, 수4» / 반 없음 / 상태 배지 */}
                                        <td className="px-2 py-1.5 text-[var(--color-academy-ink)]">
                                            {renderClassCell(s)}
                                        </td>
                                        {/* 학부모: 모바일 숨김, shortenParentName으로 간결화 */}
                                        <td className="hidden px-2 py-1.5 text-[var(--color-academy-muted)] md:table-cell">
                                            {shortenParentName(s.parent.name)}
                                        </td>
                                        {/* 연락처: 숫자지만 글자 취급(왼쪽 정렬), 자릿수 폭만 맞춘다 */}
                                        <td className="hidden px-2 py-1.5 tabular-nums text-[var(--color-academy-muted)] md:table-cell">
                                            {formatPhone(s.parent.phone)}
                                        </td>
                                        {/* 관리: ⚡ 메뉴. 눌러도 행 클릭(패널 열기)이 같이 일어나지 않게 전파 차단 */}
                                        <td className="admin-cell-center px-2 py-1.5" onClick={(event) => event.stopPropagation()}>
                                            <AdminQuickActionMenu
                                                label={`${s.name} 빠른 작업`}
                                                actions={buildQuickActions(s)}
                                            />
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                    <div className="flex flex-col gap-3 border-t border-[var(--color-academy-line)] px-4 py-3 text-sm text-[var(--color-academy-muted)] sm:flex-row sm:items-center sm:justify-between">
                        <span>
                            {filtered.length}명 중 {visibleStudents.length}명 표시
                            {!allStudentsLoaded && " · 전체 불러오는 중"}
                        </span>
                        {hasMoreStudents && (
                            <button
                                type="button"
                                onClick={() => setVisibleLimit((current) => current + STUDENT_PAGE_SIZE)}
                                className="academy-button-secondary"
                            >
                                50명 더 보기
                            </button>
                        )}
                    </div>
                </div>
            )}

            {/* 엑셀 업로드 모달 — 파일 선택 -> 미리보기 -> 일괄 등록 */}
            {showRegister && (
                <StudentRegisterModal
                    onClose={() => setShowRegister(false)}
                    onRegistered={(result) => void handleRegistered(result)}
                    onOpenStudent={(id) => { setShowRegister(false); setFilterStatus(""); setSearch(""); setDetailStudentId(id); }}
                />
            )}
            {showExcelUpload && (
                <ExcelUploadModal
                    isOpen={showExcelUpload}
                    onClose={() => setShowExcelUpload(false)}
                    onComplete={() => {
                        setShowExcelUpload(false);
                        void loadData();
                    }}
                />
            )}

            {/* 행 클릭 상세 패널 — 데스크톱 오른쪽 패널 / 모바일 하단 시트. 조회는 이미 불러온 목록 값만 쓴다 */}
            {detailStudent && (() => {
                const s = detailStudent;
                const status = studentStatusById.get(s.id) ?? null;
                const activeEnrollments = sortEnrollmentsByDay(getAssignedEnrollments(s.enrollments));
                const birth = toDateStr(s.birthDate);
                // 값이 있는 줄만 보인다(빈 칸 «-» 줄을 늘어놓지 않게)
                const rows: { label: string; value: React.ReactNode }[] = [
                    { label: "상태", value: status === "ACTIVE" && activeEnrollments.length === 0 ? "활성 · 반 없음" : getStatusLabel(status) },
                    { label: "학년", value: s.grade },
                    { label: "학교", value: s.school },
                    { label: "생년월일", value: birth || null },
                    {
                        label: "수강 반",
                        value: activeEnrollments.length > 0 ? (
                            <ul className="space-y-0.5">
                                {activeEnrollments.map((e) => (
                                    <li key={`${e.classId}-${e.slotKey ?? ""}`}>
                                        {e.className}
                                        <span className="ml-1 text-[var(--color-academy-muted)]">
                                            ({DAY_LABELS[e.dayOfWeek] || e.dayOfWeek} {e.startTime})
                                            {e.startsLater && ` · ${e.startsOn} 개시`}
                                        </span>
                                    </li>
                                ))}
                            </ul>
                        ) : "반 없음",
                    },
                    { label: "학부모", value: s.parent.name },
                    { label: "연락처", value: s.parent.phone ? formatPhone(s.parent.phone) : null },
                    { label: "학생 연락처", value: s.phone ? formatPhone(s.phone) : null },
                    { label: "주소", value: s.address },
                ].filter((row) => row.value !== null && row.value !== undefined && row.value !== "");
                return (
                    <ListDetailPanel onClose={() => setDetailStudentId(null)} titleId="student-detail-panel-title" panelClassName="p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))]">
                        <div className="mb-4 flex items-center gap-2">
                            <h3 id="student-detail-panel-title" className="text-lg font-bold text-[var(--color-academy-ink)]">{s.name}</h3>
                            <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ring-1 ${getStatusPillClass(status)}`}>
                                {getStatusLabel(status)}
                            </span>
                            <button
                                type="button"
                                onClick={() => setDetailStudentId(null)}
                                aria-label="닫기"
                                className="ml-auto academy-button-text academy-button-sm shrink-0"
                            >
                                닫기
                            </button>
                        </div>
                        {/* 요약: 왼쪽 이름표 / 오른쪽 값(긴 반 이름·주소도 말줄임 없이 전부) */}
                        <dl className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm">
                            {rows.map((row) => (
                                <div key={row.label} className="contents">
                                    <dt className="font-medium text-[var(--color-academy-muted)]">{row.label}</dt>
                                    <dd className="min-w-0 break-keep text-[var(--color-academy-ink)]">{row.value}</dd>
                                </div>
                            ))}
                        </dl>
                        {/* 작업: 상세 페이지 열기 + 기존 ⚡ 작업(수강등록·수정). 패널을 닫고 기존 모달·폼을 연다 */}
                        <div className="mt-5 flex flex-wrap gap-2">
                            <Link
                                href={`/admin/students/${s.id}`}
                                prefetch={false}
                                className="academy-button-primary"
                            >
                                상세 페이지 열기
                            </Link>
                            <button
                                type="button"
                                onClick={() => {
                                    setDetailStudentId(null);
                                    setEnrollModal(s.id);
                                }}
                                className="academy-button-secondary"
                            >
                                수강등록
                            </button>
                            <button
                                type="button"
                                onClick={() => {
                                    setDetailStudentId(null);
                                    startEdit(s);
                                }}
                                className="academy-button-secondary"
                            >
                                수정
                            </button>
                        </div>
                    </ListDetailPanel>
                );
            })()}

            {/* 수강 등록 모달 — 프로그램별 그룹화 + 요일/시간 표시 */}
            {absencePeriodFor && (
                <AbsencePeriodQuickCreate
                    presetStudentId={absencePeriodFor}
                    onClose={() => setAbsencePeriodFor(null)}
                    onDone={() => setAbsencePeriodFor(null)}
                />
            )}
            {enrollModal && (
                <AdminModal onClose={() => setEnrollModal(null)} titleId="student-enroll-title" panelClassName="max-w-lg p-6">
                        <h3 id="student-enroll-title" className="font-bold text-lg text-[var(--color-academy-ink)] mb-4">
                            수강 등록 — {students.find(s => s.id === enrollModal)?.name}
                        </h3>
                        {classes.length === 0 ? (
                            <p className="text-[var(--color-academy-muted)] text-sm">개설된 반이 없습니다. 먼저 반을 개설하세요.</p>
                        ) : (
                            <div className="max-h-[60vh] overflow-y-auto space-y-4">
                                {/* 프로그램별 그룹으로 표시 */}
                                {groupClassesByProgram(classes).map((group) => (
                                    <div key={group.programName}>
                                        {/* 프로그램명 헤더 */}
                                        <div className="bg-[var(--color-academy-soft)] rounded-lg px-3 py-1.5 mb-2">
                                            <span className="text-sm font-semibold text-[var(--color-academy-muted)]">
                                                {group.programName}
                                            </span>
                                            <span className="text-xs text-[var(--color-academy-faint)] ml-2">
                                                ({group.classes.length}개 반)
                                            </span>
                                        </div>
                                        {/* 해당 프로그램의 클래스 목록 */}
                                        <div className="space-y-1 pl-2">
                                            {group.classes.map((c) => (
                                                <button
                                                    key={c.id}
                                                    type="button"
                                                    onClick={() => handleEnroll(enrollModal!, c.id)}
                                                    disabled={busy}
                                                    className="academy-button-secondary w-full"
                                                >
                                                    {/* 요일 + 교시명 + 시간 표시 */}
                                                    <div className="flex w-full items-center justify-between gap-2 text-left">
                                                        <span className="font-medium text-[var(--color-academy-ink)] text-sm">
                                                            {c.name}
                                                        </span>
                                                        <span className="whitespace-nowrap text-xs tabular-nums text-[var(--color-academy-faint)]">
                                                            {c.startTime}~{c.endTime}
                                                        </span>
                                                    </div>
                                                </button>
                                            ))}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                        <div className="mt-4 text-right">
                            <button
                                type="button"
                                onClick={() => setEnrollModal(null)}
                                className="academy-button-text"
                            >
                                닫기
                            </button>
                        </div>
                </AdminModal>
            )}
            {/* 삭제 확인 창(공용) */}
            {confirmDialog}
        </div>
    );
}
