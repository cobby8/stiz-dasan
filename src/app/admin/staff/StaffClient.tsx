"use client";
import { adminErrorText } from "@/components/admin/adminDisplayText";

/**
 * 스태프 관리 클라이언트 컴포넌트
 * - 한 사람 = 한 줄 목록(초대 대기 · 스태프 계정 · 계정 없는 코치 프로필을 한 표로 합침, 2026-11-12)
 * - 역할 변경 + 코치 연결(원장만), 대기 초대 ⚡(가입 링크 복사·재발송·취소)
 * - 머리줄: 제목 + 주 버튼 «새 스태프 초대» + ⋯ 더보기(앱 설치 링크·직접 추가·중단된 초대 복구)
 */

import { useCallback, useEffect, useState, useTransition } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
    updateUserRole,
    linkCoachToUser,
    cancelInvitation,
    resendInvitation,
} from "@/app/actions/admin";
import AdminQuickActionMenu, { type AdminQuickAction } from "@/components/admin/AdminQuickActionMenu";
import AdminPanelActions from "@/components/admin/AdminPanelActions";
import ListDetailPanel from "@/components/admin/list/ListDetailPanel";
import { kstLabel } from "@/lib/datetime/kst";
import { buildStaffRoster, type RosterRow } from "@/lib/staff/staffRoster";

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
    /** SIGNUP = 새 직원 가입 · PASSWORD_RESET = 가입된 직원 비밀번호 재설정 */
    purpose?: "SIGNUP" | "PASSWORD_RESET";
}

type StaffPayload = {
    staffUsers: StaffUser[];
    coaches: CoachItem[];
    invitations: Invitation[];
};

type Row = RosterRow<StaffUser, CoachItem, Invitation>;

function errorMessage(error: unknown, fallback: string): string {
    return adminErrorText(error, fallback);
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
// 2026-11-12: 가입 진행·멈춤 상태(PROCESSING·RECOVERY_REQUIRED·RECOVERING)가 표에 없어서 이력에 «대기 중»으로 잘못 보였다.
const STATUS_CONFIG: Record<string, { label: string; color: string }> = {
    PENDING: { label: "대기 중", color: "bg-[var(--color-academy-warning-soft)] text-[var(--color-academy-warning)]" },
    ACCEPTED: { label: "수락 완료", color: "bg-[var(--color-academy-success-soft)] text-[var(--color-academy-success)]" },
    CANCELLED: { label: "취소됨", color: "bg-[var(--color-academy-soft)] text-[var(--color-academy-muted)]" },
    EXPIRED: { label: "만료됨", color: "bg-[var(--color-academy-danger-soft)] text-[var(--color-academy-danger)]" },
    PROCESSING: { label: "가입 처리 중", color: "bg-[var(--color-academy-primary-soft)] text-[var(--color-academy-primary)]" },
    RECOVERY_REQUIRED: { label: "복구 필요", color: "bg-[var(--color-academy-danger-soft)] text-[var(--color-academy-danger)]" },
    RECOVERING: { label: "복구 중", color: "bg-[var(--color-academy-warning-soft)] text-[var(--color-academy-warning)]" },
};

// 칩 공통 모양(한 줄, 줄바꿈 없음)
const CHIP = "inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-bold";
const CHIP_WAIT = `${CHIP} bg-[var(--color-academy-warning-soft)] text-[var(--color-academy-warning)]`;
const CHIP_OK = `${CHIP} bg-[var(--color-academy-success-soft)] text-[var(--color-academy-success)]`;
const CHIP_MUTED = `${CHIP} bg-[var(--color-academy-soft)] text-[var(--color-academy-muted)]`;

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

// 코치 연결 선택칸을 쓰는 역할 — 서버 linkCoachToUser 의 COACH_LINKABLE_ROLES 와 같은 집합
function isCoachLinkable(role: string): boolean {
    return role === "ADMIN" || role === "VICE_ADMIN" || role === "INSTRUCTOR";
}

function StaffLoadingFallback() {
    return (
        <div className="space-y-2">
            <div className="flex min-h-11 items-center justify-between gap-4">
                <div className="h-6 w-32 rounded bg-[var(--color-academy-line)] animate-pulse" />
                <div className="h-10 w-36 rounded-lg bg-[var(--color-academy-line)] animate-pulse" />
            </div>
            <div className="overflow-hidden rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)]">
                {Array.from({ length: 8 }).map((_, index) => (
                    <div key={index} className="grid h-12 grid-cols-4 items-center gap-4 border-b border-[var(--color-academy-line)] px-3 last:border-0">
                        <div className="h-4 rounded bg-[var(--color-academy-soft)] animate-pulse" />
                        <div className="h-4 rounded bg-[var(--color-academy-soft)] animate-pulse" />
                        <div className="h-4 rounded bg-[var(--color-academy-soft)] animate-pulse" />
                        <div className="h-4 rounded bg-[var(--color-academy-soft)] animate-pulse" />
                    </div>
                ))}
            </div>
        </div>
    );
}

function StaffErrorState({ onRetry }: { onRetry: () => void }) {
    return (
        <div className="rounded-2xl border border-[var(--color-academy-danger)] bg-[var(--color-academy-surface)] p-8 text-center shadow-sm">
            <span className="material-symbols-outlined mb-3 text-4xl text-[var(--color-academy-danger)]">error</span>
            <p className="font-bold text-[var(--color-academy-ink)]">스태프 정보를 불러오지 못했습니다.</p>
            <button
                type="button"
                onClick={onRetry}
                className="mt-4 rounded-xl bg-[var(--color-academy-primary)] px-4 py-2 text-sm font-bold text-white transition hover:bg-[var(--color-academy-primary-hover)]"
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
    canManage = false,
}: {
    staffUsers?: StaffUser[];
    coaches?: CoachItem[];
    invitations?: Invitation[];
    /** 원장(ADMIN)인가 — 아니면 보기 전용(서버 작업도 requireOwner 로 막혀 있다) */
    canManage?: boolean;
}) {
    const router = useRouter();
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

    // 화면 목록 조립 — 대기 초대·스태프·코치 프로필을 «한 사람 = 한 줄»로(데이터는 그대로, 보이는 방식만)
    const { rows, pendingInvitations, pastInvitations, recoveryCount } = buildStaffRoster({
        staffUsers,
        coaches,
        invitations,
        nowMs: Date.now(),
    });
    const unlinkedCoachCount = rows.filter((row) => row.kind === "coach" && !row.linkedElsewhere).length;

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
    // 재발송·취소는 원장 전용(서버 requireOwner) — 부원장에게는 링크 복사만 보인다.
    function buildInvitationActions(inv: Invitation): AdminQuickAction[] {
        const actions: AdminQuickAction[] = [
            { key: "copy", label: "가입 링크 복사", icon: "content_copy", onSelect: () => void handleCopyInvitationLink(inv.token, inv.name) },
            { key: "resend", label: "재발송", icon: "refresh", disabled: isPending, onSelect: () => handleResendInvitation(inv.id, inv.name) },
            { key: "cancel", label: "취소", icon: "close", tone: "danger", disabled: isPending, onSelect: () => handleCancelInvitation(inv.id, inv.name) },
        ];
        return canManage ? actions : actions.filter((action) => action.key === "copy");
    }

    // 머리줄 ⋯ 더보기 — 예전 머리줄 보조 버튼 3개(앱 설치 링크·직접 추가·중단된 초대 복구)를 한 메뉴로
    const moreActions: AdminQuickAction[] = [
        { key: "install", label: "스태프용 앱 설치 링크 복사", icon: "content_copy", onSelect: () => void handleCopyStaffInstallLink() },
        ...(canManage
            ? [
                { key: "add", label: "직접 추가", icon: "person_add", onSelect: () => setShowModal("add") },
                {
                    key: "recovery",
                    label: recoveryCount > 0 ? `중단된 초대 복구 (${recoveryCount})` : "중단된 초대 복구",
                    icon: "build",
                    onSelect: () => router.push("/admin/staff/recovery"),
                },
            ] satisfies AdminQuickAction[]
            : []),
    ];

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

    // ── 칸 부품 — 표(PC)와 한 줄 카드(휴대폰)가 같은 부품을 쓴다 ──────────────
    function roleChip(role: string) {
        const rc = ROLE_CONFIG[role] || ROLE_CONFIG.PARENT;
        return <span className={`${CHIP} ${rc.color}`}>{rc.label}</span>;
    }

    // 역할 선택칸(원장만) — 예전 행 안 선택칸과 같은 함수·같은 확인창
    function roleSelect(user: StaffUser) {
        const rc = ROLE_CONFIG[user.role] || ROLE_CONFIG.PARENT;
        return (
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
        );
    }

    // 코치 연결 선택칸(원장만). 코치 역할이 아니어도 예전 연결이 남아 있으면 «해제»할 수 있게 보인다.
    function coachSelect(user: StaffUser) {
        return (
            <select
                value={user.coachId || ""}
                onChange={(e) => handleCoachLink(user.id, e.target.value)}
                disabled={isPending}
                aria-label={`${user.name} 코치 연결`}
                className="min-h-11 rounded-lg border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] px-3 text-sm text-[var(--color-academy-ink)] focus:ring-2 focus:ring-[var(--color-academy-primary)]"
            >
                <option value="">코치 프로필 미연결</option>
                {coaches.map((c) => {
                    const linkedToOther = c.userId && c.userId !== user.id;
                    // 코치 역할이 아니면 새로 연결은 못 하고 해제만(서버도 같은 기준으로 막는다)
                    const blocked = !!linkedToOther || (!isCoachLinkable(user.role) && c.id !== user.coachId);
                    return (
                        <option key={c.id} value={c.id} disabled={blocked}>
                            {c.name} ({c.role}){linkedToOther ? " [연결됨]" : ""}
                        </option>
                    );
                })}
            </select>
        );
    }

    // 스태프 줄의 «연결» 칸 — 원장은 선택칸, 그 외는 글자
    function userLinkCell(user: StaffUser) {
        const showSelect = canManage && (isCoachLinkable(user.role) || Boolean(user.coachId));
        if (showSelect) return coachSelect(user);
        if (user.coachName) return <span className="text-xs text-[var(--color-academy-muted)]">코치 프로필 {user.coachName}</span>;
        return <span className="text-xs text-[var(--color-academy-muted)]">-</span>;
    }

    function inviteStatusChip(row: Extract<Row, { kind: "invite" }>) {
        const label = row.invite.purpose === "PASSWORD_RESET" ? "재설정 대기" : "초대 대기";
        return <span className={CHIP_WAIT}>{label} · {row.daysLeft}일 남음</span>;
    }

    // 비밀번호 재설정 초대 표시(main 455fb2c2 기능 보존)
    function resetChip(inv: Invitation) {
        return inv.purpose === "PASSWORD_RESET"
            ? <span className={CHIP_WAIT}>비밀번호 재설정</span>
            : null;
    }

    // 가입하면 자동 연결될 코치 프로필 — 어느 코치인지(이름·전화 끝 4자리) 보이고, 이름으로만 맞았으면 «이름 일치»로 구분
    // (동명이인이면 엉뚱한 프로필이 붙을 수 있어 원장이 확인할 수 있게)
    function inviteCoachNote(row: Extract<Row, { kind: "invite" }>) {
        if (!row.coach) return null;
        const last4 = (row.coach.phone || "").replace(/\D/g, "").slice(-4);
        return (
            <span className="whitespace-nowrap text-xs text-[var(--color-academy-muted)]">
                코치 프로필 {row.coach.name}{last4 ? `(${last4})` : ""} 연결 예정
                {row.matchedBy === "name" && <span className="ml-1 font-bold text-[var(--color-academy-warning)]">· 이름 일치</span>}
            </span>
        );
    }

    function coachStatusChip(row: Extract<Row, { kind: "coach" }>) {
        return row.linkedElsewhere
            ? <span className={CHIP_OK}>앱 연결됨</span>
            : <span className={CHIP_WAIT}>앱 미연결</span>;
    }

    function rowName(row: Row): string {
        if (row.kind === "invite") return row.invite.name;
        if (row.kind === "user") return row.user.name;
        return row.coach.name;
    }

    function rowPhone(row: Row): string {
        if (row.kind === "invite") return formatPhone(row.invite.phone);
        if (row.kind === "user") return row.user.phone ? formatPhone(row.user.phone) : "-";
        return row.coach.phone ? formatPhone(row.coach.phone) : "-";
    }

    function openRow(row: Row) {
        if (row.kind === "invite") setDetail({ kind: "invite", id: row.invite.id });
        if (row.kind === "user") setDetail({ kind: "user", id: row.user.id });
    }

    return (
        <div className="space-y-2">
            {/* 머리줄 한 줄 — 제목 · 요약 숫자 · (복구 필요 알림) · ⋯ 더보기 · 주 버튼 «새 스태프 초대» */}
            <div className="flex min-h-11 items-center gap-2">
                <h1 className="whitespace-nowrap text-lg font-black text-[var(--color-academy-ink)]">스태프 관리</h1>
                <p className="hidden whitespace-nowrap text-xs tabular-nums text-[var(--color-academy-muted)] sm:block">
                    계정 {staffUsers.length} · 초대 대기 {pendingInvitations.length}
                    {unlinkedCoachCount > 0 ? ` · 앱 미연결 코치 ${unlinkedCoachCount}` : ""}
                </p>
                {!canManage && <span className={CHIP_MUTED}>보기 전용</span>}
                <div className="ml-auto flex items-center gap-2">
                    {canManage && recoveryCount > 0 && (
                        <Link
                            href="/admin/staff/recovery"
                            className="inline-flex min-h-11 items-center gap-1 whitespace-nowrap rounded-lg px-2 text-xs font-bold text-[var(--color-academy-danger)] hover:bg-[var(--color-academy-danger-soft)]"
                        >
                            <span className="material-symbols-outlined text-[18px]" aria-hidden="true">warning</span>
                            {/* 375px 에서 머리줄이 넘치지 않게 휴대폰은 아이콘 + 숫자만(글자는 화면 읽기용으로 남긴다) */}
                            <span className="hidden sm:inline">가입 멈춤</span>
                            <span className="sr-only sm:hidden">가입 멈춤</span>
                            <span className="tabular-nums">{recoveryCount}</span>
                        </Link>
                    )}
                    <AdminQuickActionMenu label="스태프 관리 더보기" icon="more_horiz" actions={moreActions} />
                    {canManage && (
                        <button
                            type="button"
                            onClick={() => setShowModal("invite")}
                            className="inline-flex min-h-11 items-center gap-1.5 whitespace-nowrap rounded-lg bg-[var(--color-academy-primary)] px-3 text-sm font-bold text-[var(--color-academy-on-primary)] transition-colors hover:bg-[var(--color-academy-primary-hover)]"
                        >
                            <span className="material-symbols-outlined text-[20px]" aria-hidden="true">send</span>
                            새 스태프 초대
                        </button>
                    )}
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

            {rows.length === 0 ? (
                <p className="rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] px-3 py-4 text-center text-sm text-[var(--color-academy-muted)]">
                    등록된 스태프가 없습니다.
                </p>
            ) : (
                <>
                    {/* PC·태블릿: 한 줄 표. 칸 폭은 내용만큼, 남는 폭은 마지막 «연결 상태» 칸이 받아 전화·상태가 이름 가까이 붙는다. */}
                    <div className="hidden overflow-x-auto rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] sm:block">
                        <table className="admin-list-table w-full border-collapse text-sm">
                            <thead className={headClass}>
                                <tr>
                                    <th className="px-3 py-2">이름</th>
                                    <th className="px-3 py-2">역할</th>
                                    <th className="admin-cell-num px-3 py-2">전화번호</th>
                                    <th className="w-full px-3 py-2">연결 상태</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-[var(--color-academy-line)]">
                                {rows.map((row) => {
                                    if (row.kind === "invite") {
                                        const inv = row.invite;
                                        return (
                                            <tr key={row.key} tabIndex={0} aria-label={`${inv.name} 초대 상세 보기`} onClick={() => openRow(row)} onKeyDown={(event) => handleRowKeyDown(event, { kind: "invite", id: inv.id })} className={rowClass}>
                                                <td className="px-3 py-1.5 font-bold text-[var(--color-academy-ink)]">{inv.name}</td>
                                                <td className="px-3 py-1.5"><span className="flex items-center gap-1">{roleChip(inv.role)}{resetChip(inv)}</span></td>
                                                <td className="admin-cell-num px-3 py-1.5 text-[var(--color-academy-muted)]">{rowPhone(row)}</td>
                                                {/* 상태 + ⚡(복사·재발송·취소). ⚡ 를 눌러도 행 클릭(패널)이 같이 일어나지 않게 ⚡ 둘레만 전파 차단 */}
                                                <td className="px-3 py-1.5">
                                                    <span className="flex items-center gap-2">
                                                        {inviteStatusChip(row)}
                                                        {/* 같은 사람의 코치 프로필(가입하면 자동 연결될 것)은 따로 줄을 만들지 않고 여기 한 마디로 */}
                                                        {inviteCoachNote(row)}
                                                        <span className="inline-flex" onClick={(event) => event.stopPropagation()}>
                                                            <AdminQuickActionMenu label={`${inv.name} 초대 빠른 작업`} actions={buildInvitationActions(inv)} />
                                                        </span>
                                                    </span>
                                                </td>
                                            </tr>
                                        );
                                    }
                                    if (row.kind === "user") {
                                        const user = row.user;
                                        return (
                                            <tr key={row.key} tabIndex={0} aria-label={`${user.name} 스태프 상세 보기`} onClick={() => openRow(row)} onKeyDown={(event) => handleRowKeyDown(event, { kind: "user", id: user.id })} className={rowClass}>
                                                {/* 이름은 말줄임 없이 전체 */}
                                                <td className="px-3 py-1.5 font-bold text-[var(--color-academy-ink)]">{user.name}</td>
                                                {/* 선택칸을 눌러도 행 클릭(패널)이 같이 일어나지 않게 전파 차단 */}
                                                <td className="px-3 py-1" onClick={(event) => event.stopPropagation()}>
                                                    {canManage ? roleSelect(user) : roleChip(user.role)}
                                                </td>
                                                <td className="admin-cell-num px-3 py-1.5 text-[var(--color-academy-muted)]">{rowPhone(row)}</td>
                                                {/* 남는 폭을 받는 칸이라 선택칸 둘레만 전파 차단(빈 곳을 누르면 패널이 열린다) */}
                                                <td className="px-3 py-1">
                                                    <span className="inline-flex" onClick={(event) => event.stopPropagation()}>
                                                        {userLinkCell(user)}
                                                    </span>
                                                </td>
                                            </tr>
                                        );
                                    }
                                    // 계정 없는 코치 프로필(문자 발송·시간표 배정용) — 작업이 없어 패널도 없다
                                    return (
                                        <tr key={row.key}>
                                            <td className="px-3 py-1.5 font-bold text-[var(--color-academy-ink)]">{row.coach.name}</td>
                                            <td className="px-3 py-1.5 text-xs text-[var(--color-academy-muted)]">코치 프로필 · {row.coach.role}</td>
                                            <td className="admin-cell-num px-3 py-1.5 text-[var(--color-academy-muted)]">{rowPhone(row)}</td>
                                            <td className="px-3 py-1.5">{coachStatusChip(row)}</td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>

                    {/* 휴대폰(375px): 표 대신 한 줄 카드 — 이름 · 역할 · 상태 · 전화(· ⚡). 역할·코치 연결은 줄을 눌러 패널에서. */}
                    <ul className="divide-y divide-[var(--color-academy-line)] overflow-hidden rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] sm:hidden">
                        {rows.map((row) => {
                            const clickable = row.kind !== "coach";
                            return (
                                <li
                                    key={row.key}
                                    data-admin-row
                                    {...(clickable
                                        ? {
                                            tabIndex: 0,
                                            "aria-label": `${rowName(row)} 상세 보기`,
                                            onClick: () => openRow(row),
                                            onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => {
                                                if (row.kind === "invite") handleRowKeyDown(event, { kind: "invite", id: row.invite.id });
                                                if (row.kind === "user") handleRowKeyDown(event, { kind: "user", id: row.user.id });
                                            },
                                        }
                                        : {})}
                                    className={`flex min-h-12 flex-wrap items-center gap-x-2 gap-y-0.5 px-3 py-1.5 text-sm ${clickable ? rowClass : ""}`}
                                >
                                    <span className="font-bold text-[var(--color-academy-ink)]">{rowName(row)}</span>
                                    {row.kind === "invite" && <>{roleChip(row.invite.role)}{resetChip(row.invite)}{inviteStatusChip(row)}{inviteCoachNote(row)}</>}
                                    {row.kind === "user" && <>{roleChip(row.user.role)}{row.user.coachName && <span className="text-xs text-[var(--color-academy-muted)]">코치 {row.user.coachName}</span>}</>}
                                    {row.kind === "coach" && <><span className="text-xs text-[var(--color-academy-muted)]">{row.coach.role}</span>{coachStatusChip(row)}</>}
                                    <span className="ml-auto text-xs tabular-nums text-[var(--color-academy-muted)]">{rowPhone(row)}</span>
                                    {row.kind === "invite" && (
                                        <span onClick={(event) => event.stopPropagation()}>
                                            <AdminQuickActionMenu label={`${row.invite.name} 초대 빠른 작업`} actions={buildInvitationActions(row.invite)} />
                                        </span>
                                    )}
                                </li>
                            );
                        })}
                    </ul>
                </>
            )}

            {/* 아래쪽 접힘 두 줄 — 초대 이력 · 역할별 권한 안내(평소엔 한 줄씩만 차지) */}
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
                                <div key={inv.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-1.5 text-sm">
                                    <span className="font-bold text-[var(--color-academy-ink)]">{inv.name}</span>
                                    <span className={`rounded-full px-2 py-0.5 text-xs ${rc.color}`}>{rc.label}</span>
                                    {inv.purpose === "PASSWORD_RESET" && <span className="text-xs font-bold text-[var(--color-academy-warning)]">비밀번호 재설정</span>}
                                    <span className="tabular-nums text-[var(--color-academy-muted)]">{formatPhone(inv.phone)}</span>
                                    <span className="ml-auto flex items-center gap-2">
                                        <span className={`rounded-full px-2 py-0.5 text-xs font-bold ${sc.color}`}>
                                            {sc.label}
                                        </span>
                                        {/* 만료된 초대는 재발송하면 7일 연장(서버 resendInvitation) — 원장만 */}
                                        {canManage && inv.status === "PENDING" && (
                                            <button
                                                type="button"
                                                onClick={() => handleResendInvitation(inv.id, inv.name)}
                                                disabled={isPending}
                                                className="min-h-11 rounded-lg px-3 text-xs font-bold text-[var(--color-academy-primary)] transition-colors hover:bg-[var(--color-academy-primary-soft)] disabled:opacity-50"
                                            >
                                                재발송
                                            </button>
                                        )}
                                        {/* 가입이 멈춘 초대는 복구 화면으로 */}
                                        {canManage && inv.status === "RECOVERY_REQUIRED" && (
                                            <Link href="/admin/staff/recovery" className="inline-flex min-h-11 items-center rounded-lg px-3 text-xs font-bold text-[var(--color-academy-primary)] hover:bg-[var(--color-academy-primary-soft)]">
                                                복구
                                            </Link>
                                        )}
                                    </span>
                                </div>
                            );
                        })}
                    </div>
                </details>
            )}

            {/* 역할별 권한 안내 — 예전 큰 카드 4개(항상 펼침)를 접힘 한 줄로. 내용은 그대로 */}
            <details className="overflow-hidden rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)]">
                <summary className="flex min-h-11 cursor-pointer items-center gap-1.5 px-4 text-sm font-bold text-[var(--color-academy-ink)] hover:bg-[var(--color-academy-soft)]">
                    <span className="material-symbols-outlined text-[18px] text-[var(--color-academy-muted)]" aria-hidden="true">info</span>
                    역할별 권한 안내
                </summary>
                <dl className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-3 gap-y-1.5 border-t border-[var(--color-academy-line)] px-4 py-3 text-xs">
                    <dt>{roleChip("ADMIN")}</dt>
                    <dd className="text-[var(--color-academy-ink)]">모든 관리 기능 사용 가능 · 스태프 추가/역할 변경 가능 · 시스템 설정 변경 가능</dd>
                    <dt>{roleChip("VICE_ADMIN")}</dt>
                    <dd className="text-[var(--color-academy-ink)]">원장과 동일한 관리 권한 · 스태프 관리 불가 (역할 변경 등) · 관리자 알림 수신</dd>
                    <dt>{roleChip("INSTRUCTOR")}</dt>
                    <dd className="text-[var(--color-academy-ink)]">출결/리포트 작성 가능 · 코치 프로필과 연결 시 시간표 배정 · 담당 반 SMS 수신</dd>
                    <dt>{roleChip("DRIVER")}</dt>
                    <dd className="text-[var(--color-academy-ink)]">셔틀 운행 화면 접근 · 오늘 운행 노선 확인</dd>
                </dl>
            </details>

            {/* 행 클릭 상세 패널(스태프) — 표에 없는 이메일·가입일까지. 휴대폰에서는 역할·코치 연결도 여기서 바꾼다 */}
            {detailUser && (
                <ListDetailPanel onClose={() => setDetail(null)} titleId="staff-detail-panel-title" panelClassName="p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))]">
                    <div className="mb-4 flex items-center gap-2">
                        <h3 id="staff-detail-panel-title" className="min-w-0 break-keep text-lg font-black text-[var(--color-academy-ink)]">{detailUser.name}</h3>
                        {roleChip(detailUser.role)}
                        <button type="button" onClick={() => setDetail(null)} aria-label="닫기" className="ml-auto inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-lg text-[var(--color-academy-muted)] hover:bg-[var(--color-academy-soft)]">
                            <span className="material-symbols-outlined" aria-hidden="true">close</span>
                        </button>
                    </div>
                    <dl className="grid grid-cols-[5rem_minmax(0,1fr)] items-center gap-x-3 gap-y-2 text-sm">
                        <dt className="font-bold text-[var(--color-academy-muted)]">이메일</dt>
                        <dd className="break-all text-[var(--color-academy-ink)]">{detailUser.email || "-"}</dd>
                        <dt className="font-bold text-[var(--color-academy-muted)]">전화번호</dt>
                        <dd className="tabular-nums text-[var(--color-academy-ink)]">
                            {detailUser.phone ? <a href={`tel:${detailUser.phone.replace(/\D/g, "")}`} className="underline-offset-2 hover:underline">{formatPhone(detailUser.phone)}</a> : "-"}
                        </dd>
                        <dt className="font-bold text-[var(--color-academy-muted)]">역할</dt>
                        <dd>{canManage ? roleSelect(detailUser) : roleChip(detailUser.role)}</dd>
                        <dt className="font-bold text-[var(--color-academy-muted)]">코치 연결</dt>
                        <dd className="text-[var(--color-academy-ink)]">{userLinkCell(detailUser)}</dd>
                        <dt className="font-bold text-[var(--color-academy-muted)]">가입일</dt>
                        <dd className="tabular-nums text-[var(--color-academy-ink)]">{kstLabel(detailUser.createdAt) || "-"}</dd>
                    </dl>
                    {!canManage && <p className="mt-4 text-xs text-[var(--color-academy-muted)]">역할·코치 연결은 원장만 바꿀 수 있습니다.</p>}
                </ListDetailPanel>
            )}

            {/* 행 클릭 상세 패널(대기 중 초대) — 작업 버튼은 ⚡ 와 같은 목록 */}
            {detailInvite && (
                <ListDetailPanel onClose={() => setDetail(null)} titleId="staff-invite-detail-panel-title" panelClassName="p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))]">
                    <div className="mb-4 flex items-center gap-2">
                        <h3 id="staff-invite-detail-panel-title" className="min-w-0 break-keep text-lg font-black text-[var(--color-academy-ink)]">{detailInvite.name}</h3>
                        {roleChip(detailInvite.role)}
                        <button type="button" onClick={() => setDetail(null)} aria-label="닫기" className="ml-auto inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-lg text-[var(--color-academy-muted)] hover:bg-[var(--color-academy-soft)]">
                            <span className="material-symbols-outlined" aria-hidden="true">close</span>
                        </button>
                    </div>
                    <dl className="grid grid-cols-[5rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm">
                        <dt className="font-bold text-[var(--color-academy-muted)]">전화번호</dt>
                        <dd className="tabular-nums text-[var(--color-academy-ink)]">
                            <a href={`tel:${detailInvite.phone.replace(/\D/g, "")}`} className="underline-offset-2 hover:underline">{formatPhone(detailInvite.phone)}</a>
                        </dd>
                        <dt className="font-bold text-[var(--color-academy-muted)]">초대일</dt>
                        <dd className="tabular-nums text-[var(--color-academy-ink)]">{kstLabel(detailInvite.createdAt) || "-"}</dd>
                        <dt className="font-bold text-[var(--color-academy-muted)]">만료일</dt>
                        <dd className="tabular-nums text-[var(--color-academy-ink)]">{kstLabel(detailInvite.expiresAt) || "-"}</dd>
                    </dl>
                    {/* 공용 패널 버튼 줄 — ⚡ 와 같은 목록·같은 함수, 위험 작업은 오른쪽 끝으로 떨어진다 */}
                    <AdminPanelActions actions={buildInvitationActions(detailInvite)} onBeforeSelect={() => setDetail(null)} />
                </ListDetailPanel>
            )}

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
