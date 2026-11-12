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

/** 퇴사 처리 때 로그인을 막아도 되는가 — 직원 전용 로그인이고, 자기 자녀(학부모 화면)가 없을 때만. */
export function shouldBlockLoginOnRetire(input: { kind: StaffLoginKind; hasOwnChildren: boolean }): boolean {
    return input.kind === "staffLogin" && !input.hasOwnChildren;
}

/** Supabase 로그인 차단 기간 — 사실상 영구(100년). 다시 초대 가입하면 풀린다(acceptInvitation). */
export const RETIRED_LOGIN_BAN_DURATION = "876000h";
