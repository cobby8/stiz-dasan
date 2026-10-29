"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import {
    createStudent,
    updateStudent,
    deleteStudent,
    enrollStudent,
} from "@/app/actions/admin";
import AdminModal from "@/components/admin/AdminModal";
import AdminQuickActionMenu from "@/components/admin/AdminQuickActionMenu";
import CompactListFilters from "@/components/academy/CompactListFilters";

const ExcelUploadModal = dynamic(() => import("./ExcelUploadModal"), {
    ssr: false,
    loading: () => null,
});

type Student = {
    id: string;
    name: string;
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
        if (enrollment.status === "ACTIVE") return "ACTIVE";

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
    if (status === "ACTIVE") return "bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-300/10 dark:text-emerald-100 dark:ring-emerald-300/20";
    if (status === "PAUSED") return "bg-amber-50 text-amber-700 ring-amber-200 dark:bg-amber-300/10 dark:text-amber-100 dark:ring-amber-300/20";
    if (status === "WITHDRAWN") return "bg-red-50 text-red-700 ring-red-200 dark:bg-red-300/10 dark:text-red-100 dark:ring-red-300/20";
    return "bg-gray-50 text-gray-500 ring-gray-200 dark:bg-gray-900 dark:text-gray-300 dark:ring-gray-700";
}

function getActiveEnrollments(enrollments: Student["enrollments"]) {
    return (enrollments ?? []).filter((enrollment) => enrollment.status === "ACTIVE");
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
const STUDENT_VIEW_STORAGE_KEY = "admin-students-view-mode";

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
        const active = getActiveEnrollments(student.enrollments);
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
    const [showForm, setShowForm] = useState(false);
    const [editingId, setEditingId] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [search, setSearch] = useState("");
    const [enrollModal, setEnrollModal] = useState<string | null>(null);
    // 엑셀 업로드 모달 열기/닫기 상태
    const [showExcelUpload, setShowExcelUpload] = useState(false);

    // 필터 상태: 반/학년/학교/수강상태
    const [filterClass, setFilterClass] = useState("");
    const [filterGrade, setFilterGrade] = useState("");
    const [filterSchool, setFilterSchool] = useState("");

    // 보기 방식: "list"(기존 표) / "class"(반별 묶음). 마지막 선택을 브라우저에 기억한다.
    const [viewMode, setViewMode] = useState<"list" | "class">("list");
    // 반별 보기에서 접어 둔 반 id 목록
    const [collapsedClassKeys, setCollapsedClassKeys] = useState<Set<string>>(() => new Set());

    // 서버 화면과 첫 화면을 맞추려고(hydration) 처음엔 "list"로 그린 뒤, 저장된 값을 읽어 바꾼다.
    useEffect(() => {
        try {
            if (window.localStorage.getItem(STUDENT_VIEW_STORAGE_KEY) === "class") setViewMode("class");
        } catch {
            // 사생활 보호 모드 등에서 저장소 접근이 막혀도 기본 보기로 동작
        }
    }, []);

    const changeViewMode = (mode: "list" | "class") => {
        setViewMode(mode);
        try {
            window.localStorage.setItem(STUDENT_VIEW_STORAGE_KEY, mode);
        } catch {
            // 저장 실패는 무시(다음 방문 때 기본 보기)
        }
    };

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
    const [filterStatus, setFilterStatus] = useState("ACTIVE");
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
    const [parentEmail, setParentEmail] = useState("");
    // 개인정보보호법 준수: 보호자 동의 확인 체크박스 (미성년자 개인정보 수집 시 필수)
    const [guardianConsent, setGuardianConsent] = useState(false);

    function resetForm() {
        setName("");
        setBirthDate("");
        setGender("");
        setParentName("");
        setParentPhone("");
        setParentEmail("");
        setGuardianConsent(false);
        setShowForm(false);
        setEditingId(null);
    }

    function startEdit(s: Student) {
        setName(s.name);
        setBirthDate(toDateStr(s.birthDate));
        setGender(s.gender || "");
        setParentName(s.parent.name || "");
        setParentPhone(s.parent.phone || "");
        setParentEmail(s.parent.email || "");
        setEditingId(s.id);
        setShowForm(true);
    }

    async function handleSubmit(e: React.FormEvent) {
        e.preventDefault();
        if (!name.trim() || !birthDate || !parentName.trim()) return;
        // 신규 등록 시 보호자 동의 필수 (개인정보보호법: 미성년자 정보 수집 시 법정대리인 동의)
        if (!editingId && !guardianConsent) {
            alert("보호자 개인정보 수집 동의를 확인해주세요.");
            return;
        }
        setBusy(true);
        try {
            if (editingId) {
                await updateStudent(editingId, {
                    name: name.trim(),
                    birthDate,
                    gender: gender || null,
                    parentName: parentName.trim(),
                    parentPhone: parentPhone.trim() || null,
                });
            } else {
                await createStudent({
                    name: name.trim(),
                    birthDate,
                    gender: gender || null,
                    parentName: parentName.trim(),
                    parentPhone: parentPhone.trim() || null,
                    parentEmail: parentEmail.trim() || null,
                });
            }
            resetForm();
            await loadData();
        } catch (err: unknown) {
            alert(err instanceof Error ? err.message : "저장 실패");
        } finally {
            setBusy(false);
        }
    }

    async function handleDelete(id: string) {
        setBusy(true);
        try {
            await deleteStudent(id);
            await loadData();
        } catch (err: unknown) {
            alert(err instanceof Error ? err.message : "삭제 실패");
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
            alert(err instanceof Error ? err.message : "수강 등록 실패");
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
    const statusCounts = sheetImportSummary?.studentStatusCounts ?? loadedStatusCounts;

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
                const hasClass = s.enrollments?.some((e) => e.classId === filterClass && e.status === "ACTIVE");
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
    const activeFilterCount = [Boolean(filterClass), Boolean(filterGrade), Boolean(filterSchool), filterStatus !== "ACTIVE"].filter(Boolean).length;
    const filterSummary = [
        filterStatus ? getStatusLabel(filterStatus === "NONE" ? null : filterStatus) : "전체 상태",
        filterClass && (classes.find((item) => item.id === filterClass)?.name ?? "선택한 반"),
        filterGrade,
        filterSchool,
        search.trim() && `검색: ${search.trim()}`,
    ].filter(Boolean).join(" · ");
    const emptyStudentsMessage = !allStudentsLoaded && hasAnyFilter
        ? "전체 원생 목록을 동기화하는 중입니다. 잠시 후 자동으로 결과가 갱신됩니다."
        : hasAnyFilter
            ? "조건에 맞는 원생이 없습니다."
            : "등록된 원생이 없습니다. \"원생 등록\" 버튼으로 새 원생을 등록하세요.";

    if (dataLoading && students.length === 0) {
        return (
            <div className="max-w-5xl mx-auto space-y-6">
                <div className="flex items-center justify-between">
                    <div className="space-y-2">
                        <div className="h-7 w-36 rounded bg-gray-200 animate-pulse dark:bg-gray-700" />
                        <div className="h-4 w-48 rounded bg-gray-100 animate-pulse dark:bg-gray-800" />
                    </div>
                    <div className="h-10 w-28 rounded-lg bg-gray-200 animate-pulse dark:bg-gray-700" />
                </div>
                <div className="h-11 w-full max-w-md rounded-lg bg-gray-100 animate-pulse dark:bg-gray-800" />
                <div className="overflow-hidden rounded-xl border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800">
                    {Array.from({ length: 8 }).map((_, index) => (
                        <div
                            key={index}
                            className="h-12 border-b border-gray-100 bg-gray-50/60 animate-pulse last:border-b-0 dark:border-gray-700 dark:bg-gray-900/40"
                        />
                    ))}
                </div>
            </div>
        );
    }

    if (dataError && students.length === 0) {
        return (
            <div className="mx-auto max-w-5xl rounded-xl border border-red-200 bg-red-50 p-8 text-center dark:border-red-900/50 dark:bg-red-950/20">
                <p className="font-bold text-red-700 dark:text-red-200">{dataError}</p>
                <button
                    type="button"
                    onClick={() => void loadData()}
                    className="mt-4 rounded-lg bg-brand-orange-500 px-4 py-2 text-sm font-bold text-white transition hover:bg-orange-600 dark:bg-brand-neon-lime dark:text-brand-navy-900"
                >
                    다시 불러오기
                </button>
            </div>
        );
    }

    return (
        <div className="max-w-5xl mx-auto">
            <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <h1 className="text-2xl font-extrabold text-gray-900 dark:text-white">원생 관리</h1>
                <p className="text-xs text-[var(--color-academy-muted)]">
                    {sheetImportSummary?.studentStatusCounts ? "전체" : allStudentsLoaded ? "전체 목록" : "불러온 목록"} {statusCounts.total}명
                    {" · "}활성 {statusCounts.active} · 휴원 {statusCounts.paused} · 퇴원 {statusCounts.withdrawn} · 미배정 {statusCounts.noEnrollment}
                </p>
            </div>

            <CompactListFilters
                activeCount={activeFilterCount}
                summary={filterSummary}
                resultCount={`${filtered.length}명${!allStudentsLoaded ? " · 전체 동기화 중" : ""}`}
                onReset={() => {
                    setFilterClass("");
                    setFilterGrade("");
                    setFilterSchool("");
                    setFilterStatus("ACTIVE");
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
                        className="min-h-11 w-full min-w-0 rounded-lg border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] px-3 py-2 text-[17px] text-[var(--color-academy-ink)] focus:ring-2 focus:ring-[var(--color-academy-primary)]"
                    />
                }
                actions={
                    <div className="flex flex-wrap items-center gap-2">
                        {!allStudentsLoaded && (
                            <button
                                type="button"
                                onClick={() => void loadData({ background: true })}
                                disabled={backgroundLoading}
                                className="min-h-11 rounded-lg border border-gray-300 px-3 py-2 text-sm font-bold text-gray-700 transition hover:bg-gray-50 disabled:cursor-wait disabled:opacity-60 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-800"
                            >
                                {backgroundLoading ? "전체 불러오는 중" : "전체 목록 불러오기"}
                            </button>
                        )}
                        {/* 엑셀 일괄 업로드 버튼 — 랠리즈 다운로드 파일용 */}
                        <button
                            onClick={() => setShowExcelUpload(true)}
                            className="min-h-11 bg-emerald-600 text-white px-3 py-2 rounded-lg font-bold hover:bg-emerald-700 transition"
                        >
                            엑셀 업로드
                        </button>
                        {/* 기존 1명씩 수동 등록 버튼 */}
                        <button
                            onClick={() => { resetForm(); setShowForm(true); }}
                            className="bg-brand-orange-500 dark:bg-brand-neon-lime dark:text-brand-navy-900 text-white min-h-11 px-3 py-2 rounded-lg font-bold hover:bg-orange-600 transition"
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
                        className="min-h-11 w-full min-w-0 rounded-lg border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] px-3 py-2 text-[17px] text-[var(--color-academy-ink)] focus:ring-2 focus:ring-[var(--color-academy-primary)]"
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
                        className="min-h-11 w-full min-w-0 rounded-lg border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] px-3 py-2 text-[17px] text-[var(--color-academy-ink)] focus:ring-2 focus:ring-[var(--color-academy-primary)]"
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
                        className="min-h-11 w-full min-w-0 rounded-lg border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] px-3 py-2 text-[17px] text-[var(--color-academy-ink)] focus:ring-2 focus:ring-[var(--color-academy-primary)]"
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
                        className="min-h-11 w-full min-w-0 rounded-lg border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] px-3 py-2 text-[17px] text-[var(--color-academy-ink)] focus:ring-2 focus:ring-[var(--color-academy-primary)]"
                    >
                        <option value="">전체 상태</option>
                        <option value="ACTIVE">활성</option>
                        <option value="PAUSED">휴원</option>
                        <option value="WITHDRAWN">퇴원</option>
                        <option value="NONE">미배정</option>
                    </select>

                </div>
            </CompactListFilters>
            {showForm && (
                <form onSubmit={handleSubmit} className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-6 mb-6 shadow-sm space-y-4">
                    <h3 className="font-bold text-lg text-gray-900 dark:text-white">{editingId ? "원생 수정" : "새 원생 등록"}</h3>

                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                        <div>
                            <label className="block text-sm font-bold text-gray-700 dark:text-gray-200 mb-1">이름 *</label>
                            <input
                                value={name}
                                onChange={(e) => setName(e.target.value)}
                                required
                                placeholder="홍길동"
                                className="w-full border border-gray-300 dark:border-gray-600 rounded-lg p-2.5 text-sm dark:bg-gray-800 dark:text-white focus:ring-2 focus:ring-brand-orange-500 dark:focus:ring-brand-neon-lime"
                            />
                        </div>
                        <div>
                            <label className="block text-sm font-bold text-gray-700 dark:text-gray-200 mb-1">생년월일 *</label>
                            <input
                                type="text"
                                inputMode="numeric"
                                placeholder="YYYY-MM-DD"
                                pattern="\d{4}-\d{2}-\d{2}"
                                title="YYYY-MM-DD 형식으로 입력해주세요."
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
                                className="w-full border border-gray-300 dark:border-gray-600 rounded-lg p-2.5 text-sm dark:bg-gray-800 dark:text-white focus:ring-2 focus:ring-brand-orange-500 dark:focus:ring-brand-neon-lime"
                            />
                        </div>
                        <div>
                            <label className="block text-sm font-bold text-gray-700 dark:text-gray-200 mb-1">성별</label>
                            <select
                                value={gender}
                                onChange={(e) => setGender(e.target.value)}
                                className="w-full border border-gray-300 dark:border-gray-600 rounded-lg p-2.5 text-sm dark:bg-gray-800 dark:text-white focus:ring-2 focus:ring-brand-orange-500 dark:focus:ring-brand-neon-lime"
                            >
                                <option value="">선택 안함</option>
                                <option value="남">남</option>
                                <option value="여">여</option>
                            </select>
                        </div>
                        <div>
                            <label className="block text-sm font-bold text-gray-700 dark:text-gray-200 mb-1">학부모 이름 *</label>
                            <input
                                value={parentName}
                                onChange={(e) => setParentName(e.target.value)}
                                required
                                placeholder="보호자 이름"
                                className="w-full border border-gray-300 dark:border-gray-600 rounded-lg p-2.5 text-sm dark:bg-gray-800 dark:text-white focus:ring-2 focus:ring-brand-orange-500 dark:focus:ring-brand-neon-lime"
                            />
                        </div>
                        <div>
                            <label className="block text-sm font-bold text-gray-700 dark:text-gray-200 mb-1">학부모 연락처</label>
                            <input
                                value={parentPhone}
                                onChange={(e) => setParentPhone(e.target.value)}
                                placeholder="010-0000-0000"
                                className="w-full border border-gray-300 dark:border-gray-600 rounded-lg p-2.5 text-sm dark:bg-gray-800 dark:text-white focus:ring-2 focus:ring-brand-orange-500 dark:focus:ring-brand-neon-lime"
                            />
                        </div>
                        {!editingId && (
                            <div>
                                <label className="block text-sm font-bold text-gray-700 dark:text-gray-200 mb-1">학부모 이메일</label>
                                <input
                                    type="email"
                                    value={parentEmail}
                                    onChange={(e) => setParentEmail(e.target.value)}
                                    placeholder="parent@email.com"
                                    className="w-full border border-gray-300 dark:border-gray-600 rounded-lg p-2.5 text-sm dark:bg-gray-800 dark:text-white focus:ring-2 focus:ring-brand-orange-500 dark:focus:ring-brand-neon-lime"
                                />
                            </div>
                        )}
                    </div>

                    {/* 신규 등록 시에만 보호자 동의 확인 체크박스 표시 (수정 시에는 불필요) */}
                    {!editingId && (
                        <div className="border-t border-gray-100 dark:border-gray-800 pt-4">
                            <label className="flex items-start gap-2 cursor-pointer">
                                <input
                                    type="checkbox"
                                    checked={guardianConsent}
                                    onChange={(e) => setGuardianConsent(e.target.checked)}
                                    className="mt-0.5 w-4 h-4 rounded border-gray-300 text-brand-orange-500 dark:text-brand-neon-lime focus:ring-brand-orange-500 dark:focus:ring-brand-neon-lime"
                                />
                                <span className="text-sm text-gray-700 dark:text-gray-200">
                                    보호자로부터 <strong>개인정보 수집 및 이용 동의</strong>를 받았음을 확인합니다
                                    <span className="text-red-500 ml-1">(필수)</span>
                                </span>
                            </label>
                            <p className="text-xs text-gray-400 mt-1 ml-6">
                                미성년자 개인정보 수집 시 법정대리인(보호자)의 동의가 필요합니다.
                            </p>
                        </div>
                    )}

                    <div className="flex gap-2 justify-end">
                        <button type="button" onClick={resetForm} className="px-4 py-2 text-sm text-gray-600 hover:text-gray-900 dark:text-white dark:hover:text-white">
                            취소
                        </button>
                        <button
                            type="submit"
                            disabled={busy || (!editingId && !guardianConsent)}
                            className="bg-brand-orange-500 dark:bg-brand-neon-lime dark:text-brand-navy-900 text-white px-6 py-2 rounded-lg font-bold hover:bg-orange-600 transition disabled:opacity-50"
                        >
                            {busy ? "저장 중..." : editingId ? "수정" : "등록"}
                        </button>
                    </div>
                </form>
            )}

            {/* 보기 전환: 목록(표) | 반별(반마다 명단). 버튼 하나짜리 토글이라 필터 모달 밖에 둔다 */}
            <div className="mb-2 flex items-center justify-between gap-2">
                <div
                    role="group"
                    aria-label="보기 방식"
                    className="inline-flex rounded-lg border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] p-0.5"
                >
                    {([
                        { mode: "list", label: "목록", icon: "view_list" },
                        { mode: "class", label: "반별", icon: "groups" },
                    ] as const).map((item) => {
                        const selected = viewMode === item.mode;
                        return (
                            <button
                                key={item.mode}
                                type="button"
                                aria-pressed={selected}
                                onClick={() => {
                                    changeViewMode(item.mode);
                                    // 반별은 페이지 나눔 없이 전체를 묶으므로, 일부만 불러온 상태면 전체를 불러온다
                                    if (item.mode === "class") requestFullStudentLoad();
                                }}
                                className={`inline-flex min-h-11 items-center gap-1 rounded-md px-3 text-sm font-bold transition ${
                                    selected
                                        ? "bg-[var(--color-academy-primary)] text-[var(--color-academy-on-primary)]"
                                        : "text-[var(--color-academy-muted)] hover:text-[var(--color-academy-ink)]"
                                }`}
                            >
                                <span className="material-symbols-outlined text-lg" aria-hidden="true">{item.icon}</span>
                                {item.label}
                            </button>
                        );
                    })}
                </div>
                {viewMode === "class" && classGroups.length > 0 && (
                    <span className="text-xs text-[var(--color-academy-muted)]">
                        {classGroups.filter((group) => group.key !== NO_CLASS_KEY).length}개 반 · {filtered.length}명
                        {!allStudentsLoaded && " · 전체 동기화 중"}
                    </span>
                )}
            </div>

            {/* Student list */}
            {filtered.length === 0 ? (
                <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-12 text-center text-gray-400">
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
                                    <span className="font-extrabold text-[var(--color-academy-ink)]">{group.label}</span>
                                    {group.startTime && (
                                        <span className="text-xs text-[var(--color-academy-muted)]">{group.startTime}</span>
                                    )}
                                    <span className="ml-auto text-xs font-bold text-[var(--color-academy-ink)]">{group.students.length}명</span>
                                    <span className="material-symbols-outlined text-lg text-[var(--color-academy-muted)]" aria-hidden="true">
                                        {collapsed ? "expand_more" : "expand_less"}
                                    </span>
                                </button>
                                {/* 학생 한 줄 행: 이름 · 학년 · 학교 · 학부모 연락처 */}
                                {!collapsed && (
                                    <ul className="divide-y divide-[var(--color-academy-line)]">
                                        {group.students.map((s) => (
                                            <li
                                                key={`${group.key}-${s.id}`}
                                                className="grid min-h-11 grid-cols-[minmax(0,5.5rem)_2.5rem_minmax(0,1fr)_auto] items-center gap-2 px-3 text-sm"
                                            >
                                                <Link
                                                    href={`/admin/students/${s.id}`}
                                                    prefetch={false}
                                                    className="block truncate leading-[2.75rem] font-bold text-[var(--color-academy-ink)] hover:text-[var(--color-academy-primary)]"
                                                >
                                                    {s.name}
                                                </Link>
                                                <span className="text-[var(--color-academy-muted)]">{shortenGrade(s.grade)}</span>
                                                <span className="truncate text-[var(--color-academy-muted)]" title={s.school ?? undefined}>
                                                    {s.school || "-"}
                                                </span>
                                                <span className="whitespace-nowrap text-xs tabular-nums text-[var(--color-academy-muted)]">
                                                    {formatPhone(s.parent.phone)}
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
                <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden shadow-sm">
                    <div className="overflow-x-auto">
                        <table className="min-w-full divide-y divide-gray-200 max-sm:!table-auto max-sm:[&_th]:whitespace-nowrap">
                            <thead className="bg-gray-50 dark:bg-gray-900">
                                <tr>
                                    <th className="px-4 py-2.5 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">이름</th>
                                    <th className="px-4 py-2.5 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">학년</th>
                                    {/* 학교/학부모/연락처: 모바일에서 숨김 */}
                                    <th className="px-4 py-2.5 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase hidden md:table-cell">학교</th>
                                    <th className="px-4 py-2.5 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">수강 반</th>
                                    <th className="px-4 py-2.5 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase hidden md:table-cell">학부모</th>
                                    <th className="px-4 py-2.5 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase hidden md:table-cell">연락처</th>
                                    <th className="px-4 py-2.5 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">관리</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-100">
                                {visibleStudents.map((s) => (
                                    <tr key={s.id} className="hover:bg-gray-50 dark:bg-gray-900 transition-colors">
                                        {/* 이름: 항상 표시, 클릭하면 상세 페이지로 이동 */}
                                        <td className="whitespace-nowrap px-4 py-2">
                                            <Link
                                                href={`/admin/students/${s.id}`}
                                                prefetch={false}
                                                className="font-bold text-gray-900 hover:text-brand-orange-500 dark:text-brand-neon-lime transition-colors text-sm"
                                            >
                                                {s.name}
                                            </Link>
                                        </td>
                                        {/* 학년: 항상 표시, shortenGrade로 "초4" 형태 */}
                                        <td className="whitespace-nowrap px-4 py-2 text-sm text-gray-600 dark:text-gray-300">
                                            {shortenGrade(s.grade)}
                                        </td>
                                        {/* 학교: 모바일 숨김 */}
                                        <td className="px-4 py-2 text-sm text-gray-600 dark:text-gray-300 hidden md:table-cell">
                                            {s.school || "-"}
                                        </td>
                                        {/* 수강 반: 활성 수강반만 우선 표시 */}
                                        <td className="px-4 py-2 text-sm text-gray-600 dark:text-gray-300">
                                            {(() => {
                                                const activeEnrollments = getActiveEnrollments(s.enrollments);
                                                if (activeEnrollments.length > 0) {
                                                    return [...activeEnrollments]
                                                        .sort((a, b) => (DAY_ORDER[a.dayOfWeek] ?? 99) - (DAY_ORDER[b.dayOfWeek] ?? 99) || a.startTime.localeCompare(b.startTime))
                                                        .map((e) => shortenClassName(e)).join(", ");
                                                }

                                                const status = studentStatusById.get(s.id) ?? null;
                                                return (
                                                    <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-bold ring-1 ${getStatusPillClass(status)}`}>
                                                        {getStatusLabel(status)}
                                                    </span>
                                                );
                                            })()}
                                        </td>
                                        {/* 학부모: 모바일 숨김, shortenParentName으로 간결화 */}
                                        <td className="px-4 py-2 text-sm text-gray-600 dark:text-gray-300 hidden md:table-cell">
                                            {shortenParentName(s.parent.name)}
                                        </td>
                                        {/* 연락처: 모바일 숨김, formatPhone으로 하이픈 포맷 */}
                                        <td className="px-4 py-2 text-sm text-gray-600 dark:text-gray-300 hidden md:table-cell">
                                            {formatPhone(s.parent.phone)}
                                        </td>
                                        {/* 관리: 반복 액션은 번개 메뉴 안에 묶어 표를 한 줄로 유지 */}
                                        <td className="px-4 py-2 text-right">
                                            <AdminQuickActionMenu
                                                label={`${s.name} 빠른 작업`}
                                                actions={[
                                                    {
                                                        key: "enroll",
                                                        label: "수강등록",
                                                        icon: "how_to_reg",
                                                        tone: "primary",
                                                        onSelect: () => setEnrollModal(s.id),
                                                    },
                                                    {
                                                        key: "edit",
                                                        label: "수정",
                                                        icon: "edit",
                                                        onSelect: () => startEdit(s),
                                                    },
                                                    {
                                                        key: "delete",
                                                        label: "삭제",
                                                        icon: "delete",
                                                        tone: "danger",
                                                        disabled: busy,
                                                        onSelect: () => {
                                                            if (window.confirm(`"${s.name}" 원생을 삭제할까요?`)) {
                                                                void handleDelete(s.id);
                                                            }
                                                        },
                                                    },
                                                ]}
                                            />
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                    <div className="flex flex-col gap-3 border-t border-gray-100 px-4 py-3 text-sm text-gray-500 dark:border-gray-700 dark:text-gray-400 sm:flex-row sm:items-center sm:justify-between">
                        <span>
                            {filtered.length}명 중 {visibleStudents.length}명 표시
                            {!allStudentsLoaded && " · 전체 동기화 중"}
                        </span>
                        {hasMoreStudents && (
                            <button
                                type="button"
                                onClick={() => setVisibleLimit((current) => current + STUDENT_PAGE_SIZE)}
                                className="rounded-lg border border-gray-200 px-4 py-2 font-bold text-gray-700 transition hover:bg-gray-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-900"
                            >
                                50명 더 보기
                            </button>
                        )}
                    </div>
                </div>
            )}

            {/* 엑셀 업로드 모달 — 파일 선택 -> 미리보기 -> 일괄 등록 */}
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

            {/* 수강 등록 모달 — 프로그램별 그룹화 + 요일/시간 표시 */}
            {enrollModal && (
                <AdminModal onClose={() => setEnrollModal(null)} titleId="student-enroll-title" panelClassName="max-w-lg p-6">
                        <h3 id="student-enroll-title" className="font-bold text-lg text-gray-900 dark:text-white mb-4">
                            수강 등록 — {students.find(s => s.id === enrollModal)?.name}
                        </h3>
                        {classes.length === 0 ? (
                            <p className="text-gray-500 dark:text-gray-400 text-sm">개설된 반이 없습니다. 먼저 반을 개설하세요.</p>
                        ) : (
                            <div className="max-h-[60vh] overflow-y-auto space-y-4">
                                {/* 프로그램별 그룹으로 표시 */}
                                {groupClassesByProgram(classes).map((group) => (
                                    <div key={group.programName}>
                                        {/* 프로그램명 헤더 */}
                                        <div className="bg-gray-100 dark:bg-gray-800 rounded-lg px-3 py-1.5 mb-2">
                                            <span className="text-sm font-bold text-gray-700 dark:text-gray-200">
                                                {group.programName}
                                            </span>
                                            <span className="text-xs text-gray-400 ml-2">
                                                ({group.classes.length}개 반)
                                            </span>
                                        </div>
                                        {/* 해당 프로그램의 클래스 목록 */}
                                        <div className="space-y-1 pl-2">
                                            {group.classes.map((c) => (
                                                <button
                                                    key={c.id}
                                                    onClick={() => handleEnroll(enrollModal!, c.id)}
                                                    disabled={busy}
                                                    className="w-full text-left px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 hover:border-brand-orange-400 hover:bg-orange-50 transition disabled:opacity-50"
                                                >
                                                    {/* 요일 + 교시명 + 시간 표시 */}
                                                    <div className="flex items-center justify-between">
                                                        <span className="font-medium text-gray-900 dark:text-white text-sm">
                                                            {c.name}
                                                        </span>
                                                        <span className="text-xs text-gray-400">
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
                                onClick={() => setEnrollModal(null)}
                                className="px-4 py-2 text-sm text-gray-600 hover:text-gray-900 dark:text-white dark:hover:text-white"
                            >
                                닫기
                            </button>
                        </div>
                </AdminModal>
            )}
        </div>
    );
}
