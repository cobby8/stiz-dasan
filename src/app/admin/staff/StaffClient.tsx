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
import AdminQuickActionMenu, { type AdminQuickAction } from "@/components/admin/AdminQuickActionMenu";
import ListDetailPanel from "@/components/admin/list/ListDetailPanel";
import { kstLabel } from "@/lib/datetime/kst";

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

// 역할별 한국어 라벨 + 색상(화면 토큰)
const ROLE_CONFIG: Record<string, { label: string; color: string }> = {
    ADMIN: { label: "원장", color: "bg-[var(--color-academy-danger-soft)] text-[var(--color-academy-danger)]" },
    VICE_ADMIN: { label: "부원장", color: "bg-[var(--color-academy-warning-soft)] text-[var(--color-academy-warning)]" },
    INSTRUCTOR: { label: "코치/강사", color: "bg-[var(--color-academy-primary-soft)] text-[var(--color-academy-primary)]" },
    DRIVER: { label: "셔틀 기사", color: "bg-[var(--color-academy-success-soft)] text-[var(--color-academy-success)]" },
    PARENT: { label: "학부모", color: "bg-[var(--color-academy-soft)] text-[var(--color-academy-muted)]" },
};

// 초대 상태별 라벨 + 색상(화면 토큰)
const STATUS_CONFIG: Record<string, { label: string; color: string }> = {
    PENDING: { label: "대기 중", color: "bg-[var(--color-academy-warning-soft)] text-[var(--color-academy-warning)]" },
    ACCEPTED: { label: "수락 완료", color: "bg-[var(--color-academy-success-soft)] text-[var(--color-academy-success)]" },
    CANCELLED: { label: "취소됨", color: "bg-[var(--color-academy-soft)] text-[var(--color-academy-muted)]" },
    EXPIRED: { label: "만료됨", color: "bg-[var(--color-academy-danger-soft)] text-[var(--color-academy-danger)]" },
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
    // 행 클릭 상세 패널 대상 — 스태프 행 / 대기 중 초대 행
    const [detail, setDetail] = useState<{ kind: "user" | "invite"; id: string } | null>(null);

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

    // 대기 중 초대의 ⚡·패널 작업 — 예전 행의 «가입 링크 복사 / 재발송 / 취소» 버튼과 같은 함수·인자(확인창 그대로)
    function buildInvitationActions(inv: Invitation): AdminQuickAction[] {
        return [
            { key: "copy", label: "가입 링크 복사", icon: "content_copy", onSelect: () => void handleCopyInvitationLink(inv.token, inv.name) },
            { key: "resend", label: "재발송", icon: "refresh", disabled: isPending, onSelect: () => handleResendInvitation(inv.id, inv.name) },
            { key: "cancel", label: "취소", icon: "close", tone: "danger", disabled: isPending, onSelect: () => handleCancelInvitation(inv.id, inv.name) },
        ];
    }

    // 행 키보드(Enter·Space) = 상세 패널. 행 안의 선택칸·⚡ 에서 누른 키는 가로채지 않는다.
    function handleRowKeyDown(event: React.KeyboardEvent<HTMLElement>, next: { kind: "user" | "invite"; id: string }) {
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            setDetail(next);
        }
    }

    if (loading && !hasAnyData) {
        return <StaffLoadingFallback />;
    }

    if (loadError && !hasAnyData) {
        return <StaffErrorState onRetry={loadStaffData} />;
    }

    const rowClass =
        "cursor-pointer transition-colors hover:bg-[var(--color-academy-soft)] focus:bg-[var(--color-academy-primary-soft)] focus:outline-none";
    const headClass = "bg-[var(--color-academy-soft)] text-xs font-black text-[var(--color-academy-muted)]";
    const detailUser = detail?.kind === "user" ? staffUsers.find((user) => user.id === detail.id) ?? null : null;
    const detailInvite = detail?.kind === "invite" ? pendingInvitations.find((inv) => inv.id === detail.id) ?? null : null;

    return (
        <div className="space-y-4">
            {/* 페이지 헤더 */}
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex flex-wrap items-baseline gap-x-2">
                    <h1 className="text-lg font-black text-[var(--color-academy-ink)]">스태프 관리</h1>
                    {/* 역할 나열 설명은 제거하고 권한 고지만 유지 */}
                    <p className="text-xs text-[var(--color-academy-muted)]">
                        (원장만 변경 가능)
                    </p>
                </div>
                <div className="flex flex-wrap gap-2">
                    <button
                        type="button"
                        onClick={() => void handleCopyStaffInstallLink()}
                        className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-[var(--color-academy-line)] px-3 text-sm font-bold text-[var(--color-academy-ink)] transition-colors hover:bg-[var(--color-academy-soft)]"
                    >
                        <span className="material-symbols-outlined text-[20px]" aria-hidden="true">content_copy</span>
                        스태프용 앱 설치 링크
                    </button>
                    {/* 초대 링크 버튼 (메인) */}
                    <button
                        onClick={() => setShowModal("invite")}
                        className="inline-flex min-h-11 items-center gap-1.5 rounded-lg bg-[var(--color-academy-primary)] px-3 text-sm font-bold text-[var(--color-academy-on-primary)] transition-colors hover:bg-[var(--color-academy-primary-hover)]"
                    >
                        <span className="material-symbols-outlined text-[20px]" aria-hidden="true">send</span>
                        새 스태프 초대·가입
                    </button>
                    {/* 직접 추가 버튼 (보조) */}
                    <button
                        onClick={() => setShowModal("add")}
                        className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-[var(--color-academy-line)] px-3 text-sm font-bold text-[var(--color-academy-ink)] transition-colors hover:bg-[var(--color-academy-soft)]"
                    >
                        <span className="material-symbols-outlined text-[20px]" aria-hidden="true">person_add</span>
                        직접 추가
                    </button>
                </div>
            </div>

            {/* 상태 메시지 */}
            {message && (
                <div
                    role="status"
                    aria-live="polite"
                    className={`rounded-lg border px-4 py-2 text-sm font-bold ${message.ok ? "border-[var(--color-academy-success)] bg-[var(--color-academy-success-soft)] text-[var(--color-academy-success)]" : "border-[var(--color-academy-danger)] bg-[var(--color-academy-danger-soft)] text-[var(--color-academy-danger)]"}`}
                >
                    {message.text}
                </div>
            )}

            {/* 대기 중인 초대 목록 — 예전 두 줄(이름·역할 / 전화 | 남은 일) 행을 한 줄 표로 */}
            {pendingInvitations.length > 0 && (
                <section>
                    <h2 className="mb-1.5 flex items-center gap-1.5 text-sm font-black text-[var(--color-academy-warning)]">
                        <span className="material-symbols-outlined text-[20px]" aria-hidden="true">mail</span>
                        대기 중인 초대 (<span className="tabular-nums">{pendingInvitations.length}</span>건)
                    </h2>
                    <div className="overflow-x-auto rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)]">
                        <table className="admin-list-table w-full border-collapse text-sm">
                            <thead className={headClass}>
                                <tr>
                                    <th className="px-2 py-2">이름</th>
                                    <th className="px-2 py-2">역할</th>
                                    <th className="admin-cell-num px-2 py-2">전화번호</th>
                                    <th className="admin-cell-num px-2 py-2">남은 기간</th>
                                    <th className="admin-cell-center px-2 py-2">관리</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-[var(--color-academy-line)]">
                                {pendingInvitations.map((inv) => {
                                    const rc = ROLE_CONFIG[inv.role] || ROLE_CONFIG.INSTRUCTOR;
                                    const expiresDate = new Date(inv.expiresAt);
                                    // 남은 일수 계산
                                    const daysLeft = Math.max(0, Math.ceil((expiresDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24)));
                                    return (
                                        <tr key={inv.id} tabIndex={0} aria-label={`${inv.name} 초대 상세 보기`} onClick={() => setDetail({ kind: "invite", id: inv.id })} onKeyDown={(event) => handleRowKeyDown(event, { kind: "invite", id: inv.id })} className={rowClass}>
                                            <td className="px-2 py-1.5 font-bold text-[var(--color-academy-ink)]">{inv.name}</td>
                                            <td className="px-2 py-1.5"><span className={`rounded-full px-2 py-0.5 text-xs font-bold ${rc.color}`}>{rc.label}</span></td>
                                            <td className="admin-cell-num px-2 py-1.5 text-[var(--color-academy-muted)]">{formatPhone(inv.phone)}</td>
                                            <td className="admin-cell-num px-2 py-1.5 text-[var(--color-academy-ink)]">{daysLeft}일 남음</td>
                                            {/* 관리: ⚡(복사·재발송·취소). 눌러도 행 클릭(패널)이 같이 일어나지 않게 전파 차단 */}
                                            <td className="admin-cell-center px-2 py-1.5" onClick={(event) => event.stopPropagation()}>
                                                <AdminQuickActionMenu label={`${inv.name} 초대 빠른 작업`} actions={buildInvitationActions(inv)} />
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                </section>
            )}

            {/* 코치 프로필 — 예전 카드 격자를 한 줄 표로(작업 없는 요약이라 패널 없음) */}
            {coaches.length > 0 && (
                <section>
                    <div className="mb-1.5 flex flex-wrap items-center gap-2">
                        <h2 className="text-sm font-black text-[var(--color-academy-ink)]">코치 프로필</h2>
                        <span className="rounded-full bg-[var(--color-academy-success-soft)] px-2 py-0.5 text-xs font-bold tabular-nums text-[var(--color-academy-success)]">연결 {linkedCoachCount}</span>
                        <span className="rounded-full bg-[var(--color-academy-warning-soft)] px-2 py-0.5 text-xs font-bold tabular-nums text-[var(--color-academy-warning)]">미연결 {unlinkedCoachCount}</span>
                        <p className="w-full text-xs text-[var(--color-academy-muted)]">
                            문자 발송과 시간표 배정에 쓰는 코치 목록입니다. 앱 사용은 스태프 계정 연결이 필요합니다.
                        </p>
                    </div>
                    <div className="overflow-x-auto rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)]">
                        <table className="admin-list-table w-full border-collapse text-sm">
                            <thead className={headClass}>
                                <tr>
                                    <th className="px-2 py-2">이름</th>
                                    <th className="px-2 py-2">역할</th>
                                    <th className="admin-cell-num px-2 py-2">전화번호</th>
                                    <th className="px-2 py-2">앱</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-[var(--color-academy-line)]">
                                {coaches.map((coach) => (
                                    <tr key={coach.id}>
                                        <td className="px-2 py-1.5 font-bold text-[var(--color-academy-ink)]">{coach.name}</td>
                                        <td className="px-2 py-1.5 text-xs font-bold text-[var(--color-academy-primary)]">{coach.role}</td>
                                        <td className="admin-cell-num px-2 py-1.5 text-[var(--color-academy-muted)]">{coach.phone ? formatPhone(coach.phone) : "전화번호 없음"}</td>
                                        <td className="px-2 py-1.5">
                                            <span className={`rounded-full px-2 py-0.5 text-xs font-bold ${coach.userId ? "bg-[var(--color-academy-success-soft)] text-[var(--color-academy-success)]" : "bg-[var(--color-academy-warning-soft)] text-[var(--color-academy-warning)]"}`}>
                                                {coach.userId ? "앱 연결됨" : "앱 미연결"}
                                            </span>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </section>
            )}

            {/* 스태프 목록 테이블 — 한 줄 행, 역할·코치 연결 선택칸은 예전처럼 행 안에서 바로 바꾼다 */}
            <div className="overflow-x-auto rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)]">
                <table className="admin-list-table w-full border-collapse text-sm">
                    <thead className={headClass}>
                        <tr>
                            <th className="px-2 py-2">이름</th>
                            <th className="admin-cell-num px-2 py-2">전화번호</th>
                            <th className="px-2 py-2">역할</th>
                            <th className="px-2 py-2">코치 연결</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-[var(--color-academy-line)]">
                        {staffUsers.length === 0 ? (
                            <tr>
                                <td colSpan={4} className="px-2 py-4 text-center text-sm text-[var(--color-academy-muted)]">
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
                                    <tr key={user.id} tabIndex={0} aria-label={`${user.name} 스태프 상세 보기`} onClick={() => setDetail({ kind: "user", id: user.id })} onKeyDown={(event) => handleRowKeyDown(event, { kind: "user", id: user.id })} className={rowClass}>
                                        {/* 이름은 말줄임 없이 전체(예전 폭 제한·말줄임 제거) */}
                                        <td className="px-2 py-1.5 font-bold text-[var(--color-academy-ink)]">{user.name}</td>
                                        <td className="admin-cell-num px-2 py-1.5 text-[var(--color-academy-muted)]">
                                            {user.phone ? formatPhone(user.phone) : "-"}
                                        </td>
                                        {/* 선택칸을 눌러도 행 클릭(패널)이 같이 일어나지 않게 전파 차단 */}
                                        <td className="px-2 py-1" onClick={(event) => event.stopPropagation()}>
                                            <select
                                                value={user.role}
                                                onChange={(e) => handleRoleChange(user.id, e.target.value)}
                                                disabled={isPending}
                                                aria-label={`${user.name} 역할`}
                                                className={`min-h-11 cursor-pointer rounded-full border-0 px-3 text-xs font-bold ${rc.color} focus:ring-2 focus:ring-[var(--color-academy-primary)]`}
                                            >
                                                <option value="ADMIN">원장</option>
                                                <option value="VICE_ADMIN">부원장</option>
                                                <option value="INSTRUCTOR">코치/강사</option>
                                                <option value="DRIVER">셔틀 기사</option>
                                                <option value="PARENT">학부모</option>
                                            </select>
                                        </td>
                                        <td className="px-2 py-1" onClick={(event) => event.stopPropagation()}>
                                            {canLinkCoach ? (
                                                <select
                                                    value={user.coachId || ""}
                                                    onChange={(e) => handleCoachLink(user.id, e.target.value)}
                                                    disabled={isPending}
                                                    aria-label={`${user.name} 코치 연결`}
                                                    className="min-h-11 rounded-lg border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] px-3 text-sm text-[var(--color-academy-ink)] focus:ring-2 focus:ring-[var(--color-academy-primary)]"
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
                                                <span className="text-xs text-[var(--color-academy-muted)]">-</span>
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
                <details className="overflow-hidden rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)]">
                    <summary className="flex min-h-11 cursor-pointer items-center px-4 text-sm font-bold text-[var(--color-academy-ink)] hover:bg-[var(--color-academy-soft)]">
                        초대 이력 (<span className="tabular-nums">{pastInvitations.length}</span>건)
                    </summary>
                    <div className="divide-y divide-[var(--color-academy-line)] border-t border-[var(--color-academy-line)]">
                        {pastInvitations.slice(0, 20).map((inv) => {
                            const rc = ROLE_CONFIG[inv.role] || ROLE_CONFIG.INSTRUCTOR;
                            const isExpired = inv.status === "PENDING" && new Date(inv.expiresAt) < new Date();
                            const sc = isExpired ? STATUS_CONFIG.EXPIRED : (STATUS_CONFIG[inv.status] || STATUS_CONFIG.PENDING);
                            return (
                                <div key={inv.id} className="flex items-center justify-between gap-2 px-4 py-1.5 text-sm">
                                    <div className="flex items-center gap-3">
                                        <span className="font-bold text-[var(--color-academy-ink)]">{inv.name}</span>
                                        <span className={`rounded-full px-2 py-0.5 text-xs ${rc.color}`}>{rc.label}</span>
                                        <span className="tabular-nums text-[var(--color-academy-muted)]">{formatPhone(inv.phone)}</span>
                                    </div>
                                    <div className="flex items-center gap-2">
                                        <span className={`rounded-full px-2 py-0.5 text-xs font-bold ${sc.color}`}>
                                            {sc.label}
                                        </span>
                                        {inv.status === "PENDING" && (
                                            <button
                                                type="button"
                                                onClick={() => handleResendInvitation(inv.id, inv.name)}
                                                disabled={isPending}
                                                className="min-h-11 rounded-lg px-3 text-xs font-bold text-[var(--color-academy-primary)] transition-colors hover:bg-[var(--color-academy-primary-soft)] disabled:opacity-50"
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

            {/* 행 클릭 상세 패널(스태프) — 표에 없는 이메일·가입일까지. 역할·코치 연결은 표의 선택칸에서 */}
            {detailUser && (
                <ListDetailPanel onClose={() => setDetail(null)} titleId="staff-detail-panel-title" panelClassName="p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))]">
                    <div className="mb-4 flex items-center gap-2">
                        <h3 id="staff-detail-panel-title" className="min-w-0 break-keep text-lg font-black text-[var(--color-academy-ink)]">{detailUser.name}</h3>
                        <span className={`rounded-full px-2 py-0.5 text-xs font-bold ${(ROLE_CONFIG[detailUser.role] || ROLE_CONFIG.PARENT).color}`}>{(ROLE_CONFIG[detailUser.role] || ROLE_CONFIG.PARENT).label}</span>
                        <button type="button" onClick={() => setDetail(null)} aria-label="닫기" className="ml-auto inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-lg text-[var(--color-academy-muted)] hover:bg-[var(--color-academy-soft)]">
                            <span className="material-symbols-outlined" aria-hidden="true">close</span>
                        </button>
                    </div>
                    <dl className="grid grid-cols-[5rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm">
                        <dt className="font-bold text-[var(--color-academy-muted)]">이메일</dt>
                        <dd className="break-all text-[var(--color-academy-ink)]">{detailUser.email || "-"}</dd>
                        <dt className="font-bold text-[var(--color-academy-muted)]">전화번호</dt>
                        <dd className="tabular-nums text-[var(--color-academy-ink)]">{detailUser.phone ? formatPhone(detailUser.phone) : "-"}</dd>
                        <dt className="font-bold text-[var(--color-academy-muted)]">코치 연결</dt>
                        <dd className="text-[var(--color-academy-ink)]">{detailUser.coachName || "미연결"}</dd>
                        <dt className="font-bold text-[var(--color-academy-muted)]">가입일</dt>
                        <dd className="tabular-nums text-[var(--color-academy-ink)]">{kstLabel(detailUser.createdAt) || "-"}</dd>
                    </dl>
                    <p className="mt-4 text-xs text-[var(--color-academy-muted)]">역할·코치 연결은 목록의 선택칸에서 바꿉니다(원장만 변경 가능).</p>
                </ListDetailPanel>
            )}

            {/* 행 클릭 상세 패널(대기 중 초대) — 작업 버튼은 ⚡ 와 같은 목록 */}
            {detailInvite && (
                <ListDetailPanel onClose={() => setDetail(null)} titleId="staff-invite-detail-panel-title" panelClassName="p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))]">
                    <div className="mb-4 flex items-center gap-2">
                        <h3 id="staff-invite-detail-panel-title" className="min-w-0 break-keep text-lg font-black text-[var(--color-academy-ink)]">{detailInvite.name}</h3>
                        <span className={`rounded-full px-2 py-0.5 text-xs font-bold ${(ROLE_CONFIG[detailInvite.role] || ROLE_CONFIG.INSTRUCTOR).color}`}>{(ROLE_CONFIG[detailInvite.role] || ROLE_CONFIG.INSTRUCTOR).label}</span>
                        <button type="button" onClick={() => setDetail(null)} aria-label="닫기" className="ml-auto inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-lg text-[var(--color-academy-muted)] hover:bg-[var(--color-academy-soft)]">
                            <span className="material-symbols-outlined" aria-hidden="true">close</span>
                        </button>
                    </div>
                    <dl className="grid grid-cols-[5rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm">
                        <dt className="font-bold text-[var(--color-academy-muted)]">전화번호</dt>
                        <dd className="tabular-nums text-[var(--color-academy-ink)]">{formatPhone(detailInvite.phone)}</dd>
                        <dt className="font-bold text-[var(--color-academy-muted)]">초대일</dt>
                        <dd className="tabular-nums text-[var(--color-academy-ink)]">{kstLabel(detailInvite.createdAt) || "-"}</dd>
                        <dt className="font-bold text-[var(--color-academy-muted)]">만료일</dt>
                        <dd className="tabular-nums text-[var(--color-academy-ink)]">{kstLabel(detailInvite.expiresAt) || "-"}</dd>
                    </dl>
                    <div className="mt-5 flex flex-wrap gap-2">
                        {buildInvitationActions(detailInvite).map((action) => (
                            <button
                                key={action.key}
                                type="button"
                                disabled={action.disabled}
                                onClick={() => { setDetail(null); void action.onSelect(); }}
                                className={`inline-flex min-h-11 items-center gap-1 rounded-lg border px-4 text-sm font-bold disabled:opacity-50 ${
                                    action.tone === "danger"
                                        ? "border-[var(--color-academy-danger)] text-[var(--color-academy-danger)] hover:bg-[var(--color-academy-danger-soft)]"
                                        : "border-[var(--color-academy-line)] text-[var(--color-academy-ink)] hover:bg-[var(--color-academy-soft)]"
                                }`}
                            >
                                <span className="material-symbols-outlined text-lg" aria-hidden="true">{action.icon}</span>
                                {action.label}
                            </button>
                        ))}
                    </div>
                </ListDetailPanel>
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
