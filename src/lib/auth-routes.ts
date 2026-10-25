export type AppRole = "ADMIN" | "VICE_ADMIN" | "INSTRUCTOR" | "DRIVER" | "PARENT";

export function parseAppRole(value: unknown): AppRole | null {
  if (value === "ADMIN" || value === "VICE_ADMIN" || value === "INSTRUCTOR" || value === "DRIVER" || value === "PARENT") {
    return value;
  }
  return null;
}

export function normalizeAppRole(value: unknown): AppRole {
  return parseAppRole(value) ?? "PARENT";
}

export function defaultPathForRole(role: AppRole) {
  if (role === "ADMIN" || role === "VICE_ADMIN") return "/admin";
  if (role === "INSTRUCTOR") return "/staff";
  if (role === "DRIVER") return "/staff/shuttle";
  return "/mypage";
}

export function isSafeInternalPath(path?: string | null) {
  if (!path || !path.startsWith("/") || path.startsWith("//")) return false;
  if (/[\\\u0000-\u001f\u007f]/.test(path)) return false;

  try {
    const decoded = decodeURIComponent(path);
    if (!decoded.startsWith("/") || decoded.startsWith("//") || decoded.includes("\\")) return false;
    const parsed = new URL(path, "https://stiz.internal");
    return parsed.origin === "https://stiz.internal" && !parsed.pathname.startsWith("/login");
  } catch {
    return false;
  }
}

/**
 * 열린 화면 묶음(다중 역할, 2026-10-25) — 주 역할 + 승인된 추가 역할로 계산한 값.
 * 이 파일은 import 없이 단독으로 읽히는 곳이 있어(테스트·mypage-access) 타입을 여기 직접 둔다.
 * 반드시 서버가 effectiveRoles 로 계산한 값만 넘긴다 — 화면에서 받은 값을 넣으면 안 된다.
 */
export type AccessRoles = { admin: boolean; teacher: boolean; driver: boolean };

export function canRoleAccessPath(
  role: AppRole,
  path?: string | null,
  options?: { hasOwnChildren?: boolean; roles?: AccessRoles },
) {
  if (!isSafeInternalPath(path)) return false;
  const target = new URL(path as string, "https://stiz.internal").pathname;
  // roles 를 넘기지 않으면 예전과 똑같이 주 역할 하나로 판정한다.
  // 넘기더라도 추가 역할이 없으면 결과가 같다(같은 주 역할 → 같은 묶음).
  const roles = options?.roles;

  if (target === "/admin" || target.startsWith("/admin/")) {
    // 관리자 권한은 추가 역할로 줄 수 없다 — roles.admin 도 주 역할에서만 나온다.
    return roles ? roles.admin : role === "ADMIN" || role === "VICE_ADMIN";
  }
  if (target === "/staff" || target.startsWith("/staff/")) {
    // 셔틀 화면과 오늘 운행표(/staff/run, 2026-10-25)는 관리자·기사님 것이다.
    if (
      target === "/staff/shuttle" || target.startsWith("/staff/shuttle/")
      || target === "/staff/run" || target.startsWith("/staff/run/")
    ) {
      return roles ? roles.admin || roles.driver : role === "ADMIN" || role === "VICE_ADMIN" || role === "DRIVER";
    }
    return roles ? roles.admin || roles.teacher : role === "ADMIN" || role === "VICE_ADMIN" || role === "INSTRUCTOR";
  }
  if (target === "/mypage" || target.startsWith("/mypage/")) {
    // 학원 관계자의 자녀도 이 학원에 다닐 수 있다(원장 자녀 등).
    // 자기 앞으로 등록된 학생이 있으면 학부모 화면을 연다. 화면·API 는 모두
    // 본인 계정 기준으로 범위를 좁히므로 남의 자녀는 보이지 않는다.
    return role === "PARENT" || Boolean(options?.hasOwnChildren);
  }

  return true;
}

/** 설치된 선생님 앱의 영역(manifest scope)인 /staff 안쪽인지. */
export function isStaffScopePath(path?: string | null) {
  if (!isSafeInternalPath(path)) return false;
  const target = new URL(path as string, "https://stiz.internal").pathname;
  return target === "/staff" || target.startsWith("/staff/");
}

export function resolveRedirectForRole(
  role: AppRole,
  requestedPath?: string | null,
  options?: { preferRoleHome?: boolean; stayInStaffApp?: boolean; hasOwnChildren?: boolean; roles?: AccessRoles },
) {
  const access = { hasOwnChildren: options?.hasOwnChildren, roles: options?.roles };
  // 설치된 선생님 앱에서 로그인한 경우. 앱의 영역은 /staff 라 여기서 벗어나면
  // 앱이 브라우저로 튕긴다. 원장(ADMIN)도 앱 안에서는 선생님 화면을 연다 —
  // 관리자 화면은 앱 메뉴의 바로가기로 따로 나간다.
  if (options?.stayInStaffApp) {
    if (isStaffScopePath(requestedPath) && canRoleAccessPath(role, requestedPath, access)) {
      return requestedPath as string;
    }
    const roleHome = defaultPathForRole(role);
    // 선생님·기사님은 역할 기본 화면이 이미 /staff 안이다.
    if (isStaffScopePath(roleHome)) return roleHome;
    // 관리자는 /admin 이 기본이지만 앱 안에서는 /staff 로 연다.
    if (canRoleAccessPath(role, "/staff", access)) return "/staff";
    // 학부모로 가입한 뒤 기사님 승인을 받은 사람은 셔틀 화면으로(앱 영역 /staff 안).
    if (canRoleAccessPath(role, "/staff/shuttle", access)) return "/staff/shuttle";
    // 학부모가 선생님 앱으로 로그인한 경우처럼 /staff 를 못 쓰면 제 화면으로 보낸다.
    return roleHome;
  }
  if (options?.preferRoleHome) return defaultPathForRole(role);
  if (canRoleAccessPath(role, requestedPath, access)) return requestedPath as string;
  return defaultPathForRole(role);
}
