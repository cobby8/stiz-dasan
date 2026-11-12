// 스태프 역할 변경 창(2026-11-12 원장 지시 «선택칸 대신 버튼 + 모달») — 고를 수 있는 역할과 «바뀌는 것» 미리보기.
// 순수 모듈(의존성 0) — tests/staff-owner-login-link.test.mjs 가 실제로 실행해 검증한다.
// 고를 수 있는 역할 목록은 서버 updateUserRole 의 STAFF_ROLE_VALUES, 코치 연결 역할은 COACH_LINKABLE_ROLES 와
// 같은 집합이어야 한다(같은 테스트가 admin.ts 소스와 비교한다).

export type RoleChangeValue = "ADMIN" | "VICE_ADMIN" | "INSTRUCTOR" | "DRIVER" | "PARENT";

export type RoleChangeOption = {
    value: RoleChangeValue;
    label: string;
    /** 버튼 아래 한 줄 — 이 역할이면 무엇을 할 수 있는지 */
    description: string;
    icon: string; // Material Symbols 이름
};

export const ROLE_CHANGE_OPTIONS: readonly RoleChangeOption[] = [
    { value: "ADMIN", label: "원장", description: "모든 관리 기능 · 스태프 관리", icon: "shield_person" },
    { value: "VICE_ADMIN", label: "부원장", description: "관리 화면 사용 · 스태프 관리는 보기만", icon: "admin_panel_settings" },
    { value: "INSTRUCTOR", label: "코치/강사", description: "선생님 앱 · 담당 반 출결·수업", icon: "sports_basketball" },
    { value: "DRIVER", label: "셔틀 기사", description: "셔틀 운행 화면", icon: "directions_bus" },
    { value: "PARENT", label: "학부모 (직원 해제)", description: "스태프 목록에서 빠져요 · 퇴사는 [퇴사 처리]로", icon: "person_off" },
];

/** 코치 프로필을 연결해 쓰는 역할 — 서버 updateUserRole 의 COACH_LINKABLE_ROLES 와 같은 집합(테스트가 비교) */
export const ROLE_CHANGE_COACH_LINKABLE: readonly string[] = ["ADMIN", "VICE_ADMIN", "INSTRUCTOR"];

export function roleChangeLabel(role: string): string {
    if (role === "PARENT") return "학부모";
    return ROLE_CHANGE_OPTIONS.find((option) => option.value === role)?.label ?? role;
}

/**
 * 고른 역할로 바꾸면 무엇이 달라지는지(창 안 미리보기). danger = 되돌리기 번거로운 변화(목록에서 빠짐·코치 연결 해제).
 * 서버 updateUserRole 이 같은 거래에서 하는 일과 «같은 조건»으로만 문구를 낸다(2026-11-12 정확성 검수 3):
 *  - 코치 연결 해제 = 지금 코치 프로필이 연결돼 있고 · 새 역할이 코치 연결 역할이 아니고 · 승인된 선생님 추가 역할이 없을 때
 *  - 대기 링크 취소 = 이 사람을 향한 대기 링크(가입 전환·로그인 연결·비밀번호 재설정)가 있고 역할이 실제로 바뀔 때
 */
export function roleChangePreview(input: {
    currentRole: string;
    nextRole: string;
    coachName?: string | null;
    hasInstructorGrant?: boolean;
    hasPendingLink?: boolean;
}): { lines: string[]; danger: boolean } {
    const lines = [`${roleChangeLabel(input.currentRole)} → ${roleChangeLabel(input.nextRole)}`];
    const dropsCoach = Boolean(input.coachName)
        && !ROLE_CHANGE_COACH_LINKABLE.includes(input.nextRole)
        && !input.hasInstructorGrant;
    if (input.nextRole === "PARENT") lines.push("학부모로 바꾸면 스태프 목록에서 빠져요.");
    if (dropsCoach) lines.push(`코치 프로필 «${input.coachName}» 연결이 풀려요.`);
    if (input.nextRole === "ADMIN") lines.push("모든 관리 기능과 스태프 관리를 쓸 수 있게 돼요.");
    if (input.nextRole === "VICE_ADMIN") lines.push("관리 화면을 쓸 수 있게 돼요.");
    if (input.hasPendingLink && input.currentRole !== input.nextRole) lines.push("대기 중인 가입·재설정 링크는 취소돼요.");
    return { lines, danger: input.nextRole === "PARENT" || dropsCoach };
}
