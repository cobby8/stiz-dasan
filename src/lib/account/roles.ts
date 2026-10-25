/**
 * 다중 역할 판정 — DB 에 붙지 않은 순수 모듈.
 *
 * 한 사람이 여러 역할을 맡는다(선생님 + 기사님, 기사님 + 학부모, 원장 + 학부모 …).
 * 「이 사람에게 어떤 화면이 열리는가」는 권한 그 자체라, 눈으로 읽어서 맞다고 넘기면 안 된다.
 * 그래서 판정을 여기 모으고 실행 테스트로 못박는다.
 *
 * 원천 셋:
 *   1) User.role          — 주 역할(기존 칸, 73곳이 이 값을 직접 본다)
 *   2) UserRoleGrant      — 추가 역할. **status=ACTIVE 인 것만** 센다(PENDING 은 신청일 뿐)
 *   3) 등록된 자녀 유무    — 자녀가 있으면 학부모 화면(기존 규칙 그대로)
 */

export type PrimaryRole = "ADMIN" | "VICE_ADMIN" | "INSTRUCTOR" | "DRIVER" | "PARENT";

/** 추가로 줄 수 있는 역할. 관리자는 여기 없다 — 신청 표로 관리자 권한이 새면 사고다. */
export const GRANTABLE_ROLES = ["INSTRUCTOR", "DRIVER"] as const;
export type GrantableRole = (typeof GRANTABLE_ROLES)[number];

export type RoleGrantRow = { role: string; status: string };

/** 열리는 화면. 화면 전환 버튼과 권한 가드가 같은 값을 본다. */
export type EffectiveRoles = {
  admin: boolean; // 관리자 화면(/admin)
  teacher: boolean; // 선생님 화면(/staff)
  driver: boolean; // 기사님 화면(/driver)
  parent: boolean; // 학부모 화면(/mypage)
};

const PRIMARY_ROLES: readonly PrimaryRole[] = ["ADMIN", "VICE_ADMIN", "INSTRUCTOR", "DRIVER", "PARENT"];

export function parsePrimaryRole(value: unknown): PrimaryRole | null {
  return PRIMARY_ROLES.includes(value as PrimaryRole) ? (value as PrimaryRole) : null;
}

export function isGrantableRole(value: unknown): value is GrantableRole {
  return (GRANTABLE_ROLES as readonly string[]).includes(value as string);
}

/**
 * 부여된(ACTIVE) 추가 역할만 고른다.
 * ⚠️ PENDING 을 세면 «선생님을 고르기만 해도» 학생 개인정보가 열린다 — 이 표를 만든 이유가 사라진다.
 * DB CHECK 가 막고 있어도 관리자·학부모·모르는 값은 여기서 한 번 더 버린다.
 */
export function activeGrantedRoles(grants: readonly RoleGrantRow[] | null | undefined): Set<GrantableRole> {
  const roles = new Set<GrantableRole>();
  for (const grant of grants ?? []) {
    if (grant?.status === "ACTIVE" && isGrantableRole(grant.role)) roles.add(grant.role);
  }
  return roles;
}

export function effectiveRoles(input: {
  primaryRole: unknown;
  grants?: readonly RoleGrantRow[] | null;
  hasStudents: boolean;
}): EffectiveRoles {
  const primary = parsePrimaryRole(input.primaryRole);
  const granted = activeGrantedRoles(input.grants);

  const admin = primary === "ADMIN" || primary === "VICE_ADMIN";
  return {
    admin,
    // 원장·부원장은 원래 선생님 화면도 쓴다(기존 resolveAccountViews 와 같다).
    teacher: admin || primary === "INSTRUCTOR" || granted.has("INSTRUCTOR"),
    driver: primary === "DRIVER" || granted.has("DRIVER"),
    // 학부모로 가입했으면 자녀 연결 전에도 학부모 화면이 열려야 자녀를 등록할 수 있다.
    parent: primary === "PARENT" || input.hasStudents === true,
  };
}

/** 하나라도 열린 화면이 있는가. 없으면 가입이 덜 끝난 계정이다. */
export function hasAnyRole(roles: EffectiveRoles): boolean {
  return roles.admin || roles.teacher || roles.driver || roles.parent;
}
