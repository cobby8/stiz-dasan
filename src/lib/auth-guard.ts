import { createClient } from "@/lib/supabase/server";
import { prisma } from "@/lib/prisma";

type AuthUser = {
  id: string;
  email?: string;
  phone?: string;
  aud?: string | string[];
  role?: string;
  app_metadata?: Record<string, any>;
  user_metadata?: Record<string, any>;
};

type AppUserRoleRow = {
  id: string;
  name: string | null;
  role: string;
};

type AdminRole = "ADMIN" | "VICE_ADMIN";

export type AdminAuthUser = AuthUser & {
  appUserId: string;
  appUserName: string;
  appUserRole: AdminRole;
};

const ROLE_CACHE_TTL_MS = 5 * 60_000;
const roleCache = new Map<string, AppUserRoleRow & { expiresAt: number }>();

function normalizeEmail(email: string | null | undefined) {
  return (email || "").trim().toLowerCase();
}

function userFromClaims(claims: any): AuthUser | null {
  if (!claims?.sub) return null;

  return {
    id: claims.sub,
    email: claims.email,
    phone: claims.phone,
    aud: claims.aud,
    role: claims.role,
    app_metadata: claims.app_metadata ?? {},
    user_metadata: claims.user_metadata ?? {},
  };
}

function userFromSupabaseUser(user: any): AuthUser {
  return {
    id: user.id,
    email: user.email ?? undefined,
    phone: user.phone ?? undefined,
    aud: user.aud,
    role: user.role,
    app_metadata: user.app_metadata ?? {},
    user_metadata: user.user_metadata ?? {},
  };
}

async function getAppUserRole(email: string): Promise<AppUserRoleRow | null> {
  const cacheKey = normalizeEmail(email);
  if (!cacheKey) return null;

  const cached = roleCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached;
  }

  const rows = await prisma.$queryRawUnsafe<AppUserRoleRow[]>(
    `SELECT id, name, role FROM "User" WHERE email = $1 LIMIT 1`,
    email,
  );

  const row = rows[0] ?? null;
  if (row) {
    roleCache.set(cacheKey, {
      ...row,
      expiresAt: Date.now() + ROLE_CACHE_TTL_MS,
    });
  } else {
    roleCache.delete(cacheKey);
  }

  return row;
}

// ── Server Action 인증 가드 ──────────────────────────────────────
// 미들웨어는 "페이지 접근"만 보호한다.
// Server Action은 직접 POST 요청으로 호출 가능하므로,
// 각 Action 함수 내부에서도 인증을 확인해야 한다.

/**
 * requireAuth: 로그인 여부만 확인
 * - 미인증이면 에러를 던진다
 * - 로그인된 사용자의 Supabase user 객체를 반환
 */
export async function requireAuth() {
  const supabase = await createClient();

  const claimsResult = await supabase.auth.getClaims();
  const claimsUser = claimsResult.data?.claims
    ? userFromClaims(claimsResult.data.claims)
    : null;

  if (!claimsResult.error && claimsUser) {
    return claimsUser;
  }

  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error || !user) {
    throw new Error("인증이 필요합니다. 로그인해주세요.");
  }

  return userFromSupabaseUser(user);
}

export type VerifiedParentAuthUser = Awaited<ReturnType<typeof requireAuth>> & {
  appUserId: string;
  appUserName: string;
  appUserRole: "PARENT";
};

/**
 * 학부모 전용 보호 경로는 Supabase 로그인만으로 통과시키지 않는다.
 * 앱 계정이 현재 Auth ID에 직접 연결되고 휴대폰 인증까지 끝난 경우만 허용한다.
 *
 * 예외 하나: 학원 관계자의 자녀도 이 학원에 다닐 수 있다(원장 자녀 등).
 * 역할이 PARENT 가 아니어도 **자기 앞으로 등록된 학생이 있으면** 통과시킨다.
 * 이건 권한을 넓히는 게 아니라 좁히는 쪽이다 — 관리자는 이미 /admin 에서 모든
 * 학생을 본다. 학부모 화면은 아래 appUserId 로 범위가 좁혀져 자기 자녀만 보인다.
 */
export async function requireVerifiedParent(): Promise<VerifiedParentAuthUser> {
  const state = await getVerifiedParentState();
  if (state.status === "OK") return state.parent;
  if (state.status === "SIGNED_OUT") throw new Error("인증이 필요합니다. 로그인해주세요.");
  throw new Error("휴대폰 인증을 완료한 학부모 계정이 필요합니다.");
}

export type VerifiedParentState =
  | { status: "OK"; parent: VerifiedParentAuthUser }
  | { status: "SIGNED_OUT" } // 로그인 안 됨
  | { status: "NO_APP_ACCOUNT" } // 로그인은 됐지만 연결된 앱 계정이 없음(간편로그인만 한 상태 등)
  | { status: "PHONE_UNVERIFIED" } // 학부모 계정이지만 휴대폰 인증이 안 끝남
  | { status: "STAFF_ACCOUNT" }; // 관리자·직원 계정(자기 자녀 없음)

/**
 * requireVerifiedParent 와 같은 판정을 하되, 거절 사유를 오류 대신 상태로 돌려준다.
 * 카카오 연결 화면처럼 "왜 안 되는지"를 쉬운 말로 안내해야 하는 곳에서 쓴다.
 */
export async function getVerifiedParentState(): Promise<VerifiedParentState> {
  let user: Awaited<ReturnType<typeof requireAuth>>;
  try {
    user = await requireAuth();
  } catch {
    return { status: "SIGNED_OUT" };
  }
  const rows = await prisma.$queryRawUnsafe<
    Array<{ id: string; name: string; role: string; username: string | null; phoneVerifiedAt: Date | null }>
  >(
    `SELECT id, name, role::text AS role, username, "phoneVerifiedAt"
       FROM "User"
      WHERE ("authUserId" = $1 OR ("authUserId" IS NULL AND id = $1))
      LIMIT 1`,
    user.id,
  );
  const appUser = rows[0];
  if (!appUser) {
    return { status: "NO_APP_ACCOUNT" };
  }

  if (appUser.role === "PARENT") {
    const isVerifiedSignup = Boolean(appUser.phoneVerifiedAt);
    const isDirectlyBoundLegacyParent = appUser.username === null;
    if (!isVerifiedSignup && !isDirectlyBoundLegacyParent) {
      return { status: "PHONE_UNVERIFIED" };
    }
  } else {
    // 직원 계정은 자기 앞으로 등록된 자녀가 있을 때만 학부모 화면을 연다.
    // 휴대폰 인증은 다시 묻지 않는다 — 직원 계정은 초대 단계에서 이미 확인했다.
    const ownChildren = await prisma.$queryRawUnsafe<Array<{ one: number }>>(
      `SELECT 1 AS one FROM "Student" WHERE "parentId" = $1 LIMIT 1`,
      appUser.id,
    );
    if (ownChildren.length === 0) {
      return { status: "STAFF_ACCOUNT" };
    }
  }
  return {
    status: "OK",
    parent: Object.assign(user, {
      appUserId: appUser.id,
      appUserName: appUser.name,
      appUserRole: "PARENT" as const,
    }),
  };
}

/**
 * requireAdmin: ADMIN 또는 VICE_ADMIN 역할 확인
 * - 부원장(VICE_ADMIN)도 대부분의 관리 작업을 수행할 수 있도록 허용
 * - 미인증이면 에러
 * - DB에서 role을 조회하여 ADMIN/VICE_ADMIN이 아니면 에러
 * - $queryRawUnsafe 사용: PgBouncer 트랜잭션 모드 호환
 */
export async function requireAdmin(): Promise<AdminAuthUser> {
  const user = await requireAuth();
  const email = normalizeEmail(user.email);

  if (!email) {
    throw new Error("관리자 권한이 필요합니다.");
  }

  // DB에서 실제 role을 조회한다 (토큰의 metadata는 조작 가능하므로 신뢰하지 않음)
  const appUser = await getAppUserRole(email);

  // ADMIN 또는 VICE_ADMIN만 통과
  if (!appUser || (appUser.role !== "ADMIN" && appUser.role !== "VICE_ADMIN")) {
    throw new Error("관리자 권한이 필요합니다.");
  }

  return Object.assign(user, {
    appUserId: appUser.id,
    appUserName: appUser.name || user.email || "STIZ Admin",
    appUserRole: appUser.role as AdminRole,
  });
}

export type StaffRole = "ADMIN" | "VICE_ADMIN" | "INSTRUCTOR" | "DRIVER";

export type StaffAuthUser = Awaited<ReturnType<typeof requireAuth>> & {
  appUserId: string;
  appUserName: string;
  appUserRole: StaffRole;
};

/**
 * requireStaff: ADMIN, VICE_ADMIN, INSTRUCTOR, DRIVER allowed.
 * This protects staff-only workflows without opening the full admin area.
 */
export async function requireStaff(): Promise<StaffAuthUser> {
  const user = await requireAuth();
  const email = normalizeEmail(user.email);

  if (!email) {
    throw new Error("Staff permission is required.");
  }

  const appUser = await getAppUserRole(email);
  if (
    !appUser ||
    (appUser.role !== "ADMIN" && appUser.role !== "VICE_ADMIN" && appUser.role !== "INSTRUCTOR" && appUser.role !== "DRIVER")
  ) {
    throw new Error("Staff permission is required.");
  }

  return Object.assign(user, {
    appUserId: appUser.id,
    appUserName: appUser.name || user.email || "STIZ Staff",
    appUserRole: appUser.role as StaffRole,
  });
}

/**
 * requireOwner: ADMIN(원장)만 허용
 * - 스태프 관리, 역할 변경 등 최고 권한이 필요한 작업용
 * - VICE_ADMIN은 차단됨 — ADMIN만 통과
 */
export async function requireOwner() {
  const user = await requireAuth();
  const email = normalizeEmail(user.email);

  if (!email) {
    throw new Error("원장 권한이 필요합니다. (ADMIN만 가능)");
  }

  const appUser = await getAppUserRole(email);

  if (!appUser || appUser.role !== "ADMIN") {
    throw new Error("원장 권한이 필요합니다. (ADMIN만 가능)");
  }

  return user;
}
