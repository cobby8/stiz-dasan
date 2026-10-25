import { requireAuth } from "@/lib/auth-guard";
import { resolveAccountViews } from "@/lib/account-views";
import { effectiveRoles, type RoleGrantRow } from "@/lib/account/roles";
import { prisma } from "@/lib/prisma";
import { getPublicAccountRole } from "@/lib/public-account";

/** 학부모 가드와 같은 직접 인증 연결만 인정하며 이메일 일치로 자녀 권한을 열지 않습니다. */
export async function getParentViewAccessForAuthUser(user: { id: string }) {
  const rows = await prisma.$queryRawUnsafe<Array<{
    id: string; role: string; username: string | null; phoneVerifiedAt: Date | null; hasOwnChildren: boolean;
  }>>(
    `SELECT u.id, u.role::text AS role, u.username, u."phoneVerifiedAt",
            EXISTS (SELECT 1 FROM "Student" s WHERE s."parentId" = u.id) AS "hasOwnChildren"
       FROM "User" u
      WHERE (u."authUserId" = $1 OR (u."authUserId" IS NULL AND u.id = $1))
      ORDER BY CASE WHEN u."authUserId" = $1 THEN 0 ELSE 1 END
      LIMIT 1`, user.id,
  );
  const account = rows[0];
  const hasOwnChildren = Boolean(account?.hasOwnChildren);
  const canUseParentView = Boolean(account && (account.role === "PARENT"
    ? account.phoneVerifiedAt || account.username === null
    : hasOwnChildren));
  const appUserId = account?.id ?? null;
  // 로그인 직후 목적지를 정할 때 쓰는 열린 화면 묶음(주 역할 + 승인된 추가 역할).
  // 계정이 없으면 null — 그때 호출부는 예전처럼 주 역할 하나로 판정한다.
  const grants = await getActiveGrantsForViews(appUserId);
  const effective = account ? effectiveRoles({ primaryRole: account.role, grants, hasStudents: hasOwnChildren }) : null;
  const roles = effective ? { admin: effective.admin, teacher: effective.teacher, driver: effective.driver } : undefined;
  return { hasOwnChildren, canUseParentView, appUserId, grants, roles };
}

/**
 * 승인된(ACTIVE) 추가 역할. 화면 전환 메뉴용이라 실패하면 「없음」 —
 * 메뉴가 덜 보일 뿐 권한은 각 화면의 가드(requireStaff 등)가 따로 확인한다.
 */
async function getActiveGrantsForViews(appUserId: string | null): Promise<RoleGrantRow[]> {
  if (!appUserId) return [];
  try {
    return await prisma.$queryRawUnsafe<RoleGrantRow[]>(
      `SELECT role, status FROM "UserRoleGrant" WHERE "userId" = $1 AND status = 'ACTIVE'`,
      appUserId,
    );
  } catch {
    return [];
  }
}

/** 화면명과 안전한 고정 주소만 공개하며 계정 ID나 자녀 정보는 전달하지 않습니다. */
export async function getAccountViewAccess() {
  try {
    const user = await requireAuth();
    const [role, parent] = await Promise.all([getPublicAccountRole(), getParentViewAccessForAuthUser(user)]);
    return { role, views: resolveAccountViews(role, parent.canUseParentView, parent.grants) };
  } catch {
    // 인증이나 DB 확인에 실패하면 전환 메뉴를 숨기고 기존 접근 제한을 유지합니다.
    return { role: null, views: [] };
  }
}
