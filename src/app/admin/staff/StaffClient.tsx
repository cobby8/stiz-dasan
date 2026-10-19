"use client";

/**
 * 스태프 관리 클라이언트 컴포넌트
 * - 스태프 목록 테이블 (역할 변경 + Coach 연결)
 * - 초대 링크 생성 모달 (이름 + 전화번호 + 역할 → 초대하기)
 * - 대기 중인 초대 목록 (재발송/취소)
 */

import { useCallback, useEffect, useState, useTransition } from "react";
import dynamic from "next/dynamic";
import {
    updateUserRole,
    linkCoachToUser,
    cancelInvitation,
    resendInvitation,
} from "@/app/actions/admin";

const AddStaffModal = dynamic(() => import("./AddStaffModal"), {
    loading: () => null,
});

const InviteStaffModal = dynamic(() => import("./InviteStaffModal"), {
    loading: () => null,
});

// ── 타입 정의 ─────────────────────────────────────────────────────
interface StaffUser {
    id: string;
    email: string;
    name: string;
    phone: string | null;
    role: string;
    createdAt: string;
    coachId: string | null;
    coachName: string | null;
}

interface CoachItem {
    id: string;
    name: string;
    role: string;
    phone: string | null;
    userId: string | null;
}

interface Invitation {
    id: string;
    token: string;
    name: string;
    phone: string;
    role: string;
    status: string;
    expiresAt: string;
    acceptedAt: string | null;
    acceptedUserId: string | null;
    createdBy: string;
    createdAt: string;
}

type StaffPayload = {
    staffUsers: StaffUser[];
    coaches: CoachItem[];
    invitations: Invitation[];
};

function errorMessage(error: unknown, fallback: string): string {
    return error instanceof Error ? error.message : fallback;
}

// 역할별 한국어 라벨 + 색상
const ROLE_CONFIG: Record<string, { label: string; color: string }> = {
    ADMIN: { label: "원장", color: "bg-red-100 text-red-800" },
    VICE_ADMIN: { label: "부원장", color: "bg-orange-100 text-orange-800" },
    INSTRUCTOR: { label: "코치/강사", color: "bg-blue-100 text-blue-800" },
    DRIVER: { label: "셔틀 기사", color: "bg-emerald-100 text-emerald-800" },
    PARENT: { label: "학부모", color: "bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300" },
};

// 초대 상태별 라벨 + 색상
const STATUS_CONFIG: Record<string, { label: string; color: string }> = {
    PENDING: { label: "대기 중", color: "bg-yellow-100 text-yellow-800" },
    ACCEPTED: { label: "수락 완료", color: "bg-green-100 text-green-800" },
    CANCELLED: { label: "취소됨", color: "bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300" },
    EXPIRED: { label: "만료됨", color: "bg-red-100 text-red-700" },
};

/**
 * 전화번호 자동 포맷팅 함수
 * 숫자만 추출 후 000-0000-0000 형태로 변환
 */
function formatPhone(raw: string): string {
    const digits = raw.replace(/\D/g, "");
    const trimmed = digits.slice(0, 11);
    if (trimmed.length <= 3) return trimmed;
    if (trimmed.length <= 7) return `${trimmed.slice(0, 3)}-${trimmed.slice(3)}`;
    return `${trimmed.slice(0, 3)}-${trimmed.slice(3, 7)}-${trimmed.slice(7)}`;
}

function StaffLoadingFallback() {
    return (
        <div className="space-y-6">
            <div className="flex items-center justify-between gap-4">
                <div>
                    <div className="h-8 w-40 rounded bg-gray-200 dark:bg-gray-700 animate-pulse" />
                    <div className="mt-2 h-4 w-96 max-w-full rounded bg-gray-100 dark:bg-gray-800 animate-pulse" />
                </div>
                <div className="flex gap-2">
                    <div className="h-10 w-32 rounded-lg bg-gray-200 dark:bg-gray-700 animate-pulse" />
                    <div className="h-10 w-24 rounded-lg bg-gray-100 dark:bg-gray-700 animate-pulse" />
                </div>
            </div>

            <div className="rounded-xl border border-yellow-200 bg-white shadow-sm dark:border-yellow-900/50 dark:bg-gray-800">
                <div className="border-b border-yellow-100 bg-yellow-50 px-6 py-4 dark:border-yellow-900/50 dark:bg-yellow-900/20">
                    <div className="h-5 w-40 rounded bg-yellow-100 dark:bg-yellow-900/50 animate-pulse" />
                </div>
                <div className="divide-y divide-gray-100 dark:divide-gray-700">
                    {Array.from({ length: 2 }).map((_, index) => (
                        <div key={index} className="flex items-center gap-4 px-6 py-4">
                            <div className="h-10 w-10 rounded-full bg-gray-100 dark:bg-gray-700 animate-pulse" />
                            <div className="min-w-0 flex-1">
                                <div className="h-4 w-32 rounded bg-gray-200 dark:bg-gray-700 animate-pulse" />
                                <div className="mt-2 h-3 w-48 max-w-full rounded bg-gray-100 dark:bg-gray-700 animate-pulse" />
                            </div>
                            <div className="h-8 w-24 rounded-lg bg-gray-100 dark:bg-gray-700 animate-pulse" />
                        </div>
                    ))}
                </div>
            </div>

            <div className="rounded-xl border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-800">
                <div className="border-b border-gray-100 px-6 py-4 dark:border-gray-700">
                    <div className="h-5 w-32 rounded bg-gray-200 dark:bg-gray-700 animate-pulse" />
                </div>
                <div className="overflow-hidden">
                    {Array.from({ length: 6 }).map((_, index) => (
                        <div key={index} className="grid grid-cols-4 gap-4 border-b border-gray-50 px-6 py-4 last:border-0 dark:border-gray-700">
                            <div className="h-4 rounded bg-gray-100 dark:bg-gray-700 animate-pulse" />
                            <div className="h-4 rounded bg-gray-100 dark:bg-gray-700 animate-pulse" />
                            <div className="h-4 rounded bg-gray-100 dark:bg-gray-700 animate-pulse" />
                            <div className="h-8 rounded-lg bg-gray-100 dark:bg-gray-700 animate-pulse" />
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
}

function StaffErrorState({ onRetry }: { onRetry: () => void }) {
    return (
        <div className="rounded-2xl border border-red-100 bg-white p-8 text-center shadow-sm dark:border-red-900/40 dark:bg-gray-800">
            <span className="material-symbols-outlined mb-3 text-4xl text-red-500">error</span>
            <p className="font-bold text-gray-900 dark:text-white">스태프 정보를 불러오지 못했습니다.</p>
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

export default function StaffClient({
    staffUsers: initialStaffUsers,
    coaches: initialCoaches,
    invitations: initialInvitations,
}: {
    staffUsers?: StaffUser[];
    coaches?: CoachItem[];
    invitations?: Invitation[];
}) {
    const hasInitialData = Boolean(initialStaffUsers && initialCoaches && initialInvitations);
    const [staffUsers, setStaffUsers] = useState<StaffUser[]>(initialStaffUsers ?? []);
    const [coaches, setCoaches] = useState<CoachItem[]>(initialCoaches ?? []);
    const [invitations, setInvitations] = useState<Invitation[]>(initialInvitations ?? []);
    const [loading, setLoading] = useState(!hasInitialData);
    const [loadError, setLoadError] = useState<string | null>(null);
    // 모달 상태: "add" = 직접 추가, "invite" = 초대 링크
    const [showModal, setShowModal] = useState<"add" | "invite" | null>(null);
    // 에러/성공 메시지
    const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null);
    // 서버 액션 pending 상태
    const [isPending, startTransition] = useTransition();

    const hasAnyData = staffUsers.length > 0 || coaches.length > 0 || invitations.length > 0;

    const loadStaffData = useCallback(async () => {
        setLoading(true);
        setLoadError(null);

        try {
            const res = await fetch("/api/admin/staff", { cache: "no-store" });
            if (!res.ok) throw new Error("Staff request failed");
            const data = (await res.json()) as StaffPayload;
            setStaffUsers(data.staffUsers);
            setCoaches(data.coaches);
            setInvitations(data.invitations);
        } catch {
            setLoadError("failed");
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        if (hasInitialData) return;
        void loadStaffData();
    }, [hasInitialData, loadStaffData]);

    // 대기 중인 초대 (PENDING만)
    const pendingInvitations = invitations.filter((inv) => {
        if (inv.status !== "PENDING") return false;
        // 만료 여부 체크
        const expired = new Date(inv.expiresAt) < new Date();
        return !expired;
    });

    // 완료/취소/만료된 초대
    const pastInvitations = invitations.filter((inv) => {
        if (inv.status !== "PENDING") return true;
        return new Date(inv.expiresAt) < new Date();
    });
    const linkedCoachCount = coaches.filter((coach) => coach.userId).length;
    const unlinkedCoachCount = coaches.length - linkedCoachCount;

    // ── 역할 변경 핸들러 ─────────────────────────────────────────────
    function handleRoleChange(userId: string, newRole: string) {
        if (!confirm(`역할을 "${ROLE_CONFIG[newRole]?.label || newRole}"(으)로 변경하시겠습니까?`)) return;
        startTransition(async () => {
            try {
                await updateUserRole(userId, newRole as "ADMIN" | "VICE_ADMIN" | "INSTRUCTOR" | "DRIVER" | "PARENT");
                setMessage({ text: "역할이 변경되었습니다.", ok: true });
                await loadStaffData();
            } catch (error: unknown) {
                setMessage({ text: errorMessage(error, "역할 변경 실패"), ok: false });
            }
        });
    }

    // ── 코치 연결 핸들러 ─────────────────────────────────────────────
    function handleCoachLink(userId: string, coachId: string) {
        const value = coachId || null;
        startTransition(async () => {
            try {
                await linkCoachToUser(userId, value);
                setMessage({ text: value ? "코치가 연결되었습니다." : "코치 연결이 해제되었습니다.", ok: true });
                await loadStaffData();
            } catch (error: unknown) {
                setMessage({ text: errorMessage(error, "코치 연결 실패"), ok: false });
            }
        });
    }

    // ── 초대 취소 핸들러 ─────────────────────────────────────────────
    function handleCancelInvitation(invId: string, name: string) {
        if (!confirm(`${name}님의 초대를 취소하시겠습니까?`)) return;
        startTransition(async () => {
            try {
                await cancelInvitation(invId);
                setMessage({ text: "초대가 취소되었습니다.", ok: true });
                await loadStaffData();
            } catch (error: unknown) {
                setMessage({ text: errorMessage(error, "초대 취소 실패"), ok: false });
            }
        });
    }

    // ── 초대 재발송 핸들러 ─────────────────────────────────────────────
    function handleResendInvitation(invId: string, name: string) {
        if (!confirm(`${name}님에게 초대 링크를 재발송하시겠습니까?`)) return;
        startTransition(async () => {
            try {
                const result = await resendInvitation(invId);
                setMessage({
                    text: result.smsSent
                        ? "초대 문자를 다시 발송했습니다."
                        : "문자는 발송되지 않았지만 개인 가입 링크는 계속 사용할 수 있습니다.",
                    ok: result.smsSent,
                });
                await loadStaffData();
            } catch (error: unknown) {
                setMessage({ text: errorMessage(error, "재발송 실패"), ok: false });
            }
        });
    }

    async function handleCopyStaffInstallLink() {
        const installUrl = new URL("/staff/install", window.location.origin).toString();

        try {
            await navigator.clipboard.writeText(installUrl);
            setMessage({ text: "스태프 앱 설치 링크를 복사했습니다.", ok: true });
        } catch {
            window.prompt("아래 스태프 앱 설치 링크를 길게 눌러 복사해주세요.", installUrl);
            setMessage({
                text: "자동 복사가 제한되어 전체 설치 링크를 복사창에 표시했습니다.",
                ok: false,
            });
        }
    }

    async function handleCopyInvitationLink(token: string, name: string) {
        const inviteUrl = new URL(`/invite/${token}`, window.location.origin).toString();

        try {
            await navigator.clipboard.writeText(inviteUrl);
            setMessage({ text: `${name}님의 개인 가입 링크를 복사했습니다.`, ok: true });
        } catch {
            window.prompt("아래 개인 가입 링크를 길게 눌러 복사해 주세요.", inviteUrl);
            setMessage({ text: "자동 복사가 제한되어 복사창에 개인 가입 링크를 표시했습니다.", ok: false });
        }
    }

    if (loading && !hasAnyData) {
        return <StaffLoadingFallback />;
    }

    if (loadError && !hasAnyData) {
        return <StaffErrorState onRetry={loadStaffData} />;
    }

    return (
        <div className="space-y-6">
            {/* 페이지 헤더 */}
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                    <h1 className="text-2xl font-bold text-gray-900 dark:text-white">스태프 관리</h1>
                    {/* 역할 나열 설명은 제거하고 권한 고지만 유지 */}
                    <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
                        (원장만 변경 가능)
                    </p>
                </div>
                <div className="flex flex-wrap gap-2">
                    <button
                        type="button"
                        onClick={() => void handleCopyStaffInstallLink()}
                        className="flex items-center gap-2 px-4 py-2.5 border border-brand-navy-200 text-brand-navy-900 dark:border-brand-navy-600 dark:text-white rounded-lg hover:bg-brand-navy-50 dark:hover:bg-brand-navy-800 transition-colors font-medium text-sm"
                    >
                        <span className="material-symbols-outlined text-[20px]">content_copy</span>
                        스태프용 앱 설치 링크
                    </button>
                    {/* 초대 링크 버튼 (메인) */}
                    <button
                        onClick={() => setShowModal("invite")}
                        className="flex items-center gap-2 px-4 py-2.5 bg-brand-navy-900 text-white rounded-lg hover:bg-brand-navy-800 transition-colors font-medium text-sm"
                    >
                        <span className="material-symbols-outlined text-[20px]">send</span>
                        새 스태프 초대·가입
                    </button>
                    {/* 직접 추가 버튼 (보조) */}
                    <button
                        onClick={() => setShowModal("add")}
                        className="flex items-center gap-2 px-4 py-2.5 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 rounded-lg hover:bg-gray-50 dark:bg-gray-900 transition-colors font-medium text-sm"
                    >
                        <span className="material-symbols-outlined text-[20px]">person_add</span>
                        직접 추가
                    </button>
                </div>
            </div>

            {/* 상태 메시지 */}
            {message && (
                <div
                    role="status"
                    aria-live="polite"
                    className={`px-4 py-3 rounded-lg text-sm font-medium ${message.ok ? "bg-green-50 text-green-700 border border-green-200" : "bg-red-50 text-red-700 border border-red-200"}`}
                >
                    {message.text}
                </div>
            )}

            {/* 대기 중인 초대 목록 */}
            {pendingInvitations.length > 0 && (
                <div className="bg-white dark:bg-gray-800 rounded-xl border border-yellow-200 overflow-hidden">
                    <div className="px-6 py-4 bg-yellow-50 border-b border-yellow-200">
                        <h3 className="font-semibold text-yellow-800 flex items-center gap-2">
                            <span className="material-symbols-outlined text-[20px]">mail</span>
                            대기 중인 초대 ({pendingInvitations.length}건)
                        </h3>
                    </div>
                    <div className="divide-y divide-gray-100">
                        {pendingInvitations.map((inv) => {
                            const rc = ROLE_CONFIG[inv.role] || ROLE_CONFIG.INSTRUCTOR;
                            const expiresDate = new Date(inv.expiresAt);
                            // 남은 일수 계산
                            const daysLeft = Math.max(0, Math.ceil((expiresDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24)));
                            return (
                                <div key={inv.id} className="px-6 py-4 flex items-center justify-between">
                                    <div className="flex items-center gap-4">
                                        {/* 이니셜 아바타 */}
                                        <div className="w-9 h-9 rounded-full flex items-center justify-center bg-yellow-100 text-yellow-700 font-bold text-sm">
                                            {inv.name.charAt(0)}
                                        </div>
                                        <div>
                                            <div className="flex items-center gap-2">
                                                <span className="font-medium text-gray-900 dark:text-white">{inv.name}</span>
                                                <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${rc.color}`}>
                                                    {rc.label}
                                                </span>
                                            </div>
                                            <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                                                {formatPhone(inv.phone)} | {daysLeft}일 남음
                                            </div>
                                        </div>
                                    </div>
                                    <div className="flex gap-2">
                                        <button
                                            type="button"
                                            onClick={() => void handleCopyInvitationLink(inv.token, inv.name)}
                                            className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-brand-navy-900 bg-brand-navy-50 rounded-lg hover:bg-brand-navy-100 transition-colors"
                                        >
                                            <span className="material-symbols-outlined text-[16px]">content_copy</span>
                                            가입 링크 복사
                                        </button>
                                        {/* 재발송 버튼 */}
                                        <button
                                            onClick={() => handleResendInvitation(inv.id, inv.name)}
                                            disabled={isPending}
                                            className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-blue-700 bg-blue-50 rounded-lg hover:bg-blue-100 transition-colors disabled:opacity-50"
                                        >
                                            <span className="material-symbols-outlined text-[16px]">refresh</span>
                                            재발송
                                        </button>
                                        {/* 취소 버튼 */}
                                        <button
                                            onClick={() => handleCancelInvitation(inv.id, inv.name)}
                                            disabled={isPending}
                                            className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-red-700 bg-red-50 rounded-lg hover:bg-red-100 transition-colors disabled:opacity-50"
                                        >
                                            <span className="material-symbols-outlined text-[16px]">close</span>
                                            취소
                                        </button>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                </div>
            )}

            {/* 스태프 목록 테이블 */}
            {coaches.length > 0 && (
                <section className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-700 dark:bg-gray-800">
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                        <div>
                            <h2 className="text-lg font-bold text-gray-900 dark:text-white">코치 프로필</h2>
                            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                                문자 발송과 시간표 배정에 쓰는 코치 목록입니다. 앱 사용은 스태프 계정 연결이 필요합니다.
                            </p>
                        </div>
                        <div className="flex flex-wrap gap-2 text-xs font-bold">
                            <span className="rounded-full bg-green-50 px-3 py-1 text-green-700">연결 {linkedCoachCount}</span>
                            <span className="rounded-full bg-amber-50 px-3 py-1 text-amber-700">미연결 {unlinkedCoachCount}</span>
                        </div>
                    </div>
                    <div className="mt-4 grid gap-2 md:grid-cols-2 xl:grid-cols-3">
                        {coaches.map((coach) => (
                            <div key={coach.id} className="flex items-center justify-between gap-3 rounded-lg border border-gray-100 bg-gray-50 px-4 py-3 dark:border-gray-700 dark:bg-gray-900">
                                <div className="min-w-0">
                                    <div className="flex items-center gap-2">
                                        <span className="truncate font-bold text-gray-900 dark:text-white">{coach.name}</span>
                                        <span className="shrink-0 rounded-full bg-blue-50 px-2 py-0.5 text-[11px] font-bold text-blue-700">{coach.role}</span>
                                    </div>
                                    <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                                        {coach.phone ? formatPhone(coach.phone) : "전화번호 없음"}
                                    </p>
                                </div>
                                <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-bold ${coach.userId ? "bg-green-100 text-green-700" : "bg-amber-100 text-amber-800"}`}>
                                    {coach.userId ? "앱 연결됨" : "앱 미연결"}
                                </span>
                            </div>
                        ))}
                    </div>
                </section>
            )}

            <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800">
                <table className="w-full min-w-[720px]">
                    <thead>
                        <tr className="bg-gray-50 dark:bg-gray-900 border-b border-gray-200 dark:border-gray-700">
                            <th className="text-left px-6 py-3 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase">이름</th>
                            <th className="text-left px-6 py-3 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase">전화번호</th>
                            <th className="text-left px-6 py-3 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase">역할</th>
                            <th className="text-left px-6 py-3 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase">코치 연결</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                        {staffUsers.length === 0 ? (
                            <tr>
                                <td colSpan={4} className="px-6 py-12 text-center text-gray-400 text-sm">
                                    등록된 스태프가 없습니다.
                                </td>
                            </tr>
                        ) : (
                            staffUsers.map((user) => {
                                const rc = ROLE_CONFIG[user.role] || ROLE_CONFIG.PARENT;
                                const canLinkCoach =
                                    user.role === "ADMIN" ||
                                    user.role === "VICE_ADMIN" ||
                                    user.role === "INSTRUCTOR";
                                return (
                                    <tr key={user.id} className="transition-colors hover:bg-gray-50 dark:hover:bg-gray-900">
                                        <td className="px-6 py-4">
                                            <div className="flex items-center gap-3">
                                                <div className={`w-9 h-9 rounded-full flex items-center justify-center text-white font-bold text-sm ${user.role === "ADMIN" ? "bg-red-500" : user.role === "VICE_ADMIN" ? "bg-orange-500" : user.role === "DRIVER" ? "bg-emerald-500" : "bg-blue-500"}`}>
                                                    {user.name.charAt(0)}
                                                </div>
                                                <span className="max-w-40 truncate font-medium text-gray-900 dark:text-white" title={user.name}>{user.name}</span>
                                            </div>
                                        </td>
                                        <td className="px-6 py-4 text-sm text-gray-600 dark:text-gray-300">
                                            {user.phone ? formatPhone(user.phone) : "-"}
                                        </td>
                                        <td className="px-6 py-4">
                                            <select
                                                value={user.role}
                                                onChange={(e) => handleRoleChange(user.id, e.target.value)}
                                                disabled={isPending}
                                                className={`text-xs font-semibold px-3 py-1.5 rounded-full border-0 cursor-pointer ${rc.color} focus:ring-2 focus:ring-brand-navy-500`}
                                            >
                                                <option value="ADMIN">원장</option>
                                                <option value="VICE_ADMIN">부원장</option>
                                                <option value="INSTRUCTOR">코치/강사</option>
                                                <option value="DRIVER">셔틀 기사</option>
                                                <option value="PARENT">학부모</option>
                                            </select>
                                        </td>
                                        <td className="px-6 py-4">
                                            {canLinkCoach ? (
                                                <select
                                                    value={user.coachId || ""}
                                                    onChange={(e) => handleCoachLink(user.id, e.target.value)}
                                                    disabled={isPending}
                                                    className="text-sm border border-gray-300 dark:border-gray-600 dark:text-white dark:bg-gray-800 rounded-lg px-3 py-1.5 focus:ring-2 focus:ring-brand-navy-500 focus:border-brand-navy-500"
                                                >
                                                    <option value="">-- 미연결 --</option>
                                                    {coaches.map((c) => {
                                                        const linkedToOther = c.userId && c.userId !== user.id;
                                                        return (
                                                            <option key={c.id} value={c.id} disabled={!!linkedToOther}>
                                                                {c.name} ({c.role}){linkedToOther ? " [연결됨]" : ""}
                                                            </option>
                                                        );
                                                    })}
                                                </select>
                                            ) : (
                                                <span className="text-xs text-gray-400">-</span>
                                            )}
                                        </td>
                                    </tr>
                                );
                            })
                        )}
                    </tbody>
                </table>
            </div>

            {/* 완료/취소/만료 초대 이력 (접이식) */}
            {pastInvitations.length > 0 && (
                <details className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
                    <summary className="px-6 py-4 cursor-pointer text-sm font-medium text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:bg-gray-900">
                        초대 이력 ({pastInvitations.length}건)
                    </summary>
                    <div className="divide-y divide-gray-100 border-t border-gray-200 dark:border-gray-700">
                        {pastInvitations.slice(0, 20).map((inv) => {
                            const rc = ROLE_CONFIG[inv.role] || ROLE_CONFIG.INSTRUCTOR;
                            const isExpired = inv.status === "PENDING" && new Date(inv.expiresAt) < new Date();
                            const sc = isExpired ? STATUS_CONFIG.EXPIRED : (STATUS_CONFIG[inv.status] || STATUS_CONFIG.PENDING);
                            return (
                                <div key={inv.id} className="px-6 py-3 flex items-center justify-between text-sm">
                                    <div className="flex items-center gap-3">
                                        <span className="font-medium text-gray-700 dark:text-gray-200">{inv.name}</span>
                                        <span className={`text-xs px-2 py-0.5 rounded-full ${rc.color}`}>{rc.label}</span>
                                        <span className="text-gray-400">{formatPhone(inv.phone)}</span>
                                    </div>
                                    <div className="flex items-center gap-2">
                                        <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${sc.color}`}>
                                            {sc.label}
                                        </span>
                                        {inv.status === "PENDING" && (
                                            <button
                                                type="button"
                                                onClick={() => handleResendInvitation(inv.id, inv.name)}
                                                disabled={isPending}
                                                className="rounded-lg bg-blue-50 px-2.5 py-1 text-xs font-bold text-blue-700 transition-colors hover:bg-blue-100 disabled:opacity-50"
                                            >
                                                재발송
                                            </button>
                                        )}
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                </details>
            )}

            {/* 역할별 권한 안내 카드 */}
            <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-6">
                <h3 className="font-semibold text-gray-800 dark:text-gray-100 mb-4 flex items-center gap-2">
                    <span className="material-symbols-outlined text-[20px]">info</span>
                    역할별 권한 안내
                </h3>
                <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                    <div className="p-4 bg-red-50 rounded-lg border border-red-100">
                        <div className="flex items-center gap-2 mb-2">
                            <span className="inline-block w-3 h-3 rounded-full bg-red-500" />
                            <span className="font-semibold text-red-800">원장</span>
                        </div>
                        <ul className="text-xs text-red-700 space-y-1">
                            <li>- 모든 관리 기능 사용 가능</li>
                            <li>- 스태프 추가/역할 변경 가능</li>
                            <li>- 시스템 설정 변경 가능</li>
                        </ul>
                    </div>
                    <div className="p-4 bg-orange-50 rounded-lg border border-orange-100">
                        <div className="flex items-center gap-2 mb-2">
                            <span className="inline-block w-3 h-3 rounded-full bg-orange-500" />
                            <span className="font-semibold text-orange-800">부원장</span>
                        </div>
                        <ul className="text-xs text-orange-700 space-y-1">
                            <li>- 원장과 동일한 관리 권한</li>
                            <li>- 스태프 관리 불가 (역할 변경 등)</li>
                            <li>- 관리자 알림 수신</li>
                        </ul>
                    </div>
                    <div className="p-4 bg-blue-50 rounded-lg border border-blue-100">
                        <div className="flex items-center gap-2 mb-2">
                            <span className="inline-block w-3 h-3 rounded-full bg-blue-500" />
                            <span className="font-semibold text-blue-800">코치/강사 (INSTRUCTOR)</span>
                        </div>
                        <ul className="text-xs text-blue-700 space-y-1">
                            <li>- 출결/리포트 작성 가능</li>
                            <li>- Coach 프로필과 연결 시 시간표 배정</li>
                            <li>- 담당 반 SMS 수신</li>
                        </ul>
                    </div>
                    <div className="p-4 bg-emerald-50 rounded-lg border border-emerald-100">
                        <div className="flex items-center gap-2 mb-2">
                            <span className="inline-block w-3 h-3 rounded-full bg-emerald-500" />
                            <span className="font-semibold text-emerald-800">셔틀 기사 (DRIVER)</span>
                        </div>
                        <ul className="text-xs text-emerald-700 space-y-1">
                            <li>- 셔틀 운행 화면 접근</li>
                            <li>- 오늘 운행 노선 확인</li>
                        </ul>
                    </div>
                </div>
            </div>

            {/* 모달: 초대 링크 발송 */}
            {showModal === "invite" && (
                <InviteStaffModal
                    onClose={() => setShowModal(null)}
                    onSuccess={() => {
                        setMessage({ text: "스태프 개인 가입 링크가 만들어졌습니다.", ok: true });
                        void loadStaffData();
                    }}
                    onError={(msg) => setMessage({ text: msg, ok: false })}
                />
            )}

            {/* 모달: 직접 추가 (기존) */}
            {showModal === "add" && (
                <AddStaffModal
                    onClose={() => setShowModal(null)}
                    onSuccess={() => {
                        setShowModal(null);
                        setMessage({ text: "스태프가 추가되었습니다.", ok: true });
                        void loadStaffData();
                    }}
                    onError={(msg) => setMessage({ text: msg, ok: false })}
                />
            )}
        </div>
    );
}
