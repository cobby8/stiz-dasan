// 스태프 관리 화면의 «한 사람 = 한 줄» 목록 조립 (2026-11-12 원장 점검: «중복 정보·빈 공간»).
//
// 예전 화면은 같은 사람이 세 표에 따로 나왔다 — 대기 중인 초대 표 · 코치 프로필 표(«앱 미연결») · 스태프 계정 표.
// 이병하·박찬이처럼 초대를 보낸 코치는 위 표에서 «대기 중», 아래 표에서 «앱 미연결»로 두 번 보였다.
// 이 모듈은 데이터를 바꾸지 않고 «화면에 어떻게 합쳐 보일지»만 정한다(서버 조회·작업 함수는 그대로).
//
// 합치는 기준은 가입 시 실제로 코치 프로필을 자동 연결하는 규칙(src/lib/staff-coach-link.ts)과 같다 —
// 코치/강사 초대만, 아직 계정이 연결되지 않은 코치 중 전화번호(숫자만)가 같은 사람을 먼저, 없으면 이름이 같은 사람.
// 그래야 «초대 대기 줄에 붙어 보인 코치 = 가입하면 실제로 연결될 코치»가 된다.

export type RosterStaffUser = {
    id: string;
    name: string;
    phone: string | null;
    role: string;
    coachId: string | null;
};

export type RosterCoach = {
    id: string;
    name: string;
    role: string;
    phone: string | null;
    userId: string | null;
};

export type RosterInvitation = {
    id: string;
    name: string;
    phone: string;
    role: string;
    status: string;
    expiresAt: string;
    /** SIGNUP = 새 직원 가입 · PASSWORD_RESET = 이미 가입된 직원의 비밀번호 재설정(계정이 이미 있어 코치와 짝짓지 않는다) */
    purpose?: "SIGNUP" | "PASSWORD_RESET";
};

/** 초대 ↔ 코치 프로필을 무엇으로 짝지었나 — 전화번호(확실) / 이름만(동명이인 가능, 화면에 구분 표시) */
export type CoachMatchBy = "phone" | "name";

export type RosterRow<U, C, I> =
    | { kind: "invite"; key: string; invite: I; coach: C | null; matchedBy: CoachMatchBy | null; daysLeft: number }
    | { kind: "user"; key: string; user: U }
    | { kind: "coach"; key: string; coach: C; linkedElsewhere: boolean };

/** 가입이 진행 중이거나 멈춘 초대 — «중단된 초대 복구» 화면에서 다루는 상태(staff-invite-recovery.ts 와 같은 집합). */
export const STAFF_INVITE_RECOVERY_STATUSES = ["PROCESSING", "RECOVERY_REQUIRED", "RECOVERING"] as const;

const DAY_MS = 24 * 60 * 60 * 1000;

function phoneDigits(value: string | null | undefined): string {
    return (value || "").replace(/\D/g, "");
}

function nameKey(value: string | null | undefined): string {
    return (value || "").trim().toLowerCase();
}

/** 아직 유효한 대기 초대인가 — PENDING 이고 만료 시각 전(시각 비교라 시간대와 무관). */
export function isLivePendingInvitation(inv: { status: string; expiresAt: string }, nowMs: number): boolean {
    return inv.status === "PENDING" && new Date(inv.expiresAt).getTime() > nowMs;
}

/** 남은 기간(일) — 예전 화면과 같은 계산(남은 시간을 하루 단위로 올림). 달력 날짜가 아니라 경과 시간이다. */
export function invitationDaysLeft(expiresAt: string, nowMs: number): number {
    return Math.max(0, Math.ceil((new Date(expiresAt).getTime() - nowMs) / DAY_MS));
}

/**
 * 화면 목록 조립. 순서 = 초대 대기(할 일) → 계정 있는 스태프(서버가 준 역할순 그대로) → 계정 없는 코치 프로필.
 * - 계정에 연결된 코치 프로필은 그 스태프 줄의 «코치 연결» 칸에 이미 보이므로 따로 줄을 만들지 않는다.
 * - 계정에 연결됐지만 그 계정이 스태프 목록에 없는 코치(예: 학부모 계정 + 승인된 선생님 역할)는
 *   사라지지 않게 코치 줄로 남기고 «앱 연결됨»으로 표시한다(linkedElsewhere).
 */
export function buildStaffRoster<U extends RosterStaffUser, C extends RosterCoach, I extends RosterInvitation>(input: {
    staffUsers: U[];
    coaches: C[];
    invitations: I[];
    nowMs: number;
}): {
    rows: RosterRow<U, C, I>[];
    pendingInvitations: I[];
    pastInvitations: I[];
    recoveryCount: number;
} {
    const { staffUsers, coaches, invitations, nowMs } = input;
    const pendingInvitations = invitations.filter((inv) => isLivePendingInvitation(inv, nowMs));
    const pastInvitations = invitations.filter((inv) => !isLivePendingInvitation(inv, nowMs));
    const recoveryCount = invitations.filter((inv) =>
        (STAFF_INVITE_RECOVERY_STATUSES as readonly string[]).includes(inv.status),
    ).length;

    // 초대 ↔ 코치 짝짓기 — 한 코치는 한 초대에만 붙인다.
    const usedCoachIds = new Set<string>();
    const freeCoaches = coaches.filter((coach) => !coach.userId);
    const inviteRows: RosterRow<U, C, I>[] = pendingInvitations.map((invite) => {
        let coach: C | null = null;
        let matchedBy: CoachMatchBy | null = null;
        // 비밀번호 재설정 초대는 계정이 이미 있어 가입 시 자동 연결이 일어나지 않는다 → 짝짓지 않는다
        if (invite.role === "INSTRUCTOR" && invite.purpose !== "PASSWORD_RESET") {
            const digits = phoneDigits(invite.phone);
            const name = nameKey(invite.name);
            const candidates = freeCoaches.filter((candidate) => !usedCoachIds.has(candidate.id));
            const byPhone = digits ? candidates.find((candidate) => phoneDigits(candidate.phone) === digits) : undefined;
            const byName = !byPhone && name ? candidates.find((candidate) => nameKey(candidate.name) === name) : undefined;
            coach = byPhone ?? byName ?? null;
            matchedBy = byPhone ? "phone" : byName ? "name" : null;
            if (coach) usedCoachIds.add(coach.id);
        }
        return { kind: "invite", key: `invite:${invite.id}`, invite, coach, matchedBy, daysLeft: invitationDaysLeft(invite.expiresAt, nowMs) };
    });

    const userRows: RosterRow<U, C, I>[] = staffUsers.map((user) => ({ kind: "user", key: `user:${user.id}`, user }));

    const staffIds = new Set(staffUsers.map((user) => user.id));
    const coachRows: RosterRow<U, C, I>[] = coaches
        .filter((coach) => !usedCoachIds.has(coach.id) && !(coach.userId && staffIds.has(coach.userId)))
        .map((coach) => ({ kind: "coach", key: `coach:${coach.id}`, coach, linkedElsewhere: Boolean(coach.userId) }));

    return { rows: [...inviteRows, ...userRows, ...coachRows], pendingInvitations, pastInvitations, recoveryCount };
}
