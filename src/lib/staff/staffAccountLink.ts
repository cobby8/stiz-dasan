// 직원 기록(User)과 로그인 계정(Supabase Auth)의 연결 상태 판정 — 순수 함수(2026-11-12 원장 결정).
//
// 직원 기록이 만들어지는 길은 셋이다.
//   1) «직접 추가»(옛 메뉴, 이제 없음): 전화번호@staff.local · 로그인 계정 없음 → 앱을 못 쓴다.
//   2) 초대 가입: 전화번호@staff.stiz.kr · 로그인 계정 있음(authUserId, 옛 방식은 User.id = 로그인 id).
//   3) 학부모 계정 등 일반 로그인에 역할만 붙은 경우.
// 이 판정 하나를 «초대로 전환»·«퇴사 처리»·초대 수락이 같이 쓴다(경로마다 따로 만들면 한쪽만 고쳐진다).

/** 직접 추가 기록의 가짜 이메일 끝 — createStaffUser 가 `${전화번호}@staff.local` 로 만든다. */
export const DIRECT_ADDED_EMAIL_SUFFIX = "@staff.local";
/** 초대 가입 로그인 아이디 끝 — acceptInvitation 이 `${전화번호}@staff.stiz.kr` 로 만든다. */
export const STAFF_LOGIN_EMAIL_SUFFIX = "@staff.stiz.kr";

export type StaffLoginKind =
    /** 로그인 계정이 없다(직접 추가 기록) — 초대로 전환해야 앱을 쓸 수 있다 */
    | "none"
    /** 직원 전용 로그인(초대 가입) — 퇴사하면 로그인 자체를 막아도 된다 */
    | "staffLogin"
    /** 학부모 등 일반 로그인 — 퇴사해도 로그인은 그대로(학부모 화면은 계속 쓴다) */
    | "other";

export type StaffAccountRow = {
    id: string;
    email: string | null;
    authUserId: string | null;
};

function lowerEmail(email: string | null | undefined): string {
    return (email || "").trim().toLowerCase();
}

/** 이 직원 기록의 로그인 종류. */
export function staffLoginKind(row: StaffAccountRow): StaffLoginKind {
    const email = lowerEmail(row.email);
    if (!row.authUserId && email.endsWith(DIRECT_ADDED_EMAIL_SUFFIX)) return "none";
    if (email.endsWith(STAFF_LOGIN_EMAIL_SUFFIX)) return "staffLogin";
    return "other";
}

/**
 * 로그인 계정 id — authUserId 가 있으면 그것, 없으면 옛 초대 가입 방식(User.id = 로그인 id).
 * 로그인이 없는 기록(none)은 null.
 */
export function staffAuthId(row: StaffAccountRow): string | null {
    if (staffLoginKind(row) === "none") return null;
    return row.authUserId || row.id || null;
}

/** 초대로 전환할 수 있는 역할 — 초대 수락이 받는 역할(코치/강사·셔틀 기사)과 같은 집합. */
export const CONVERTIBLE_STAFF_ROLES = ["INSTRUCTOR", "DRIVER"] as const;

export function isConvertibleStaffRole(role: string): role is (typeof CONVERTIBLE_STAFF_ROLES)[number] {
    return (CONVERTIBLE_STAFF_ROLES as readonly string[]).includes(role);
}

/**
 * 원장 권한 직원의 «로그인 연결» 대상 역할(2026-11-12 원장 지시 — 권혜미 대표원장).
 * 직접 추가된 원장·부원장 기록(로그인 없음)에 그 사람 전용 초대로 로그인을 붙인다. 역할은 바꾸지 않는다.
 */
export const LOGIN_LINK_ROLES = ["ADMIN", "VICE_ADMIN"] as const;

export function isLoginLinkRole(role: string): role is (typeof LOGIN_LINK_ROLES)[number] {
    return (LOGIN_LINK_ROLES as readonly string[]).includes(role);
}

// 초대 링크가 받는 역할 판정(invitationRoleAccepted)은 inviteAuthFailure.ts 에 있다(의존성 0 모듈 유지).

/**
 * 기존 직원 기록에 로그인을 붙이는 가입이 허용되는가(대상의 «지금» 역할 기준).
 * - 코치/강사·셔틀 기사: 초대·대상 모두 그 집합이면(예전 규칙 그대로)
 * - 원장·부원장: 초대 역할과 대상의 지금 역할이 «정확히 같을 때만» — 가입 경로가 역할을 올리는 길이 되지 않게
 */
export function targetedSignupAllowed(input: { inviteRole: string; targetRole: string }): boolean {
    if (isConvertibleStaffRole(input.inviteRole) && isConvertibleStaffRole(input.targetRole)) return true;
    return isLoginLinkRole(input.inviteRole) && input.inviteRole === input.targetRole;
}

/** 퇴사 처리 때 로그인을 막아도 되는가 — 직원 전용 로그인이고, 자기 자녀(학부모 화면)가 없을 때만. */
export function shouldBlockLoginOnRetire(input: { kind: StaffLoginKind; hasOwnChildren: boolean }): boolean {
    return input.kind === "staffLogin" && !input.hasOwnChildren;
}

/**
 * 퇴사 뒤 같은 번호로 새 초대를 만들 때 옛 직원 기록을 어떻게 할지(2026-11-12 검수).
 * - 옛 기록이 하나이고 직원 전용 로그인이 있었고 이름까지 같으면 → attach(그 로그인을 다시 연다)
 * - 이름이 다르고 옛 기록이 직원 전용 로그인(@staff.stiz.kr)이면 → reject: 같은 아이디로 새 로그인을 만들 수 없어
 *   가입이 반드시 막힌다. 같은 사람이면 이름을 맞춰 다시 초대하게 안내한다.
 * - 그 밖(이름이 다른 로그인 없는 기록, 둘 이상) → notice: 연결하지 않고 새로 초대하되 «이전 직원 기록이 있어요» 안내
 * 번호만 같은 다른 사람(번호 재사용)에게 옛 기록·권한이 붙지 않게 하는 것이 목적이다.
 */
export type RetiredReinviteDecision =
    | { kind: "none" }
    | { kind: "attach"; userId: string }
    | { kind: "reject"; previousName: string }
    | { kind: "notice"; previousName: string };

function nameKey(value: string | null | undefined): string {
    return (value || "").trim().replace(/\s+/g, "").toLowerCase();
}

export function decideRetiredReinvite(
    records: Array<{ id: string; name: string; email: string | null }>,
    inviteName: string,
): RetiredReinviteDecision {
    if (records.length === 0) return { kind: "none" };
    const first = records[0];
    const firstHasStaffLogin = lowerEmail(first.email).endsWith(STAFF_LOGIN_EMAIL_SUFFIX);
    // 다시 여는 것은 직원 전용 로그인이 있던 기록만(재입사 경로). 로그인 없던 기록(직접 추가 후 퇴사)은
    // 전환 경로로 붙이면 학부모→직원으로 역할을 올리는 길이 되므로 붙이지 않는다(2026-11-12 재검수).
    if (records.length === 1 && firstHasStaffLogin && nameKey(first.name) === nameKey(inviteName)) return { kind: "attach", userId: first.id };
    if (records.length === 1 && firstHasStaffLogin) {
        return { kind: "reject", previousName: first.name };
    }
    return { kind: "notice", previousName: first.name };
}

/** Supabase 로그인 차단 기간 — 사실상 영구(100년). 다시 초대 가입하면 풀린다(acceptInvitation). */
export const RETIRED_LOGIN_BAN_DURATION = "876000h";
