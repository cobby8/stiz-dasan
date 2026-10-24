import { requireAuth } from "@/lib/auth-guard";
import { resolveAccountViews } from "@/lib/account-views";
import { prisma } from "@/lib/prisma";
import { getPublicAccountRole } from "@/lib/public-account";

/** 학부모 가드와 같은 직접 인증 연결만 인정하며 이메일 일치로 자녀 권한을 열지 않습니다. */
export async function getParentViewAccessForAuthUser(user: { id: string }) {
  const rows = await prisma.$queryRawUnsafe<Array<{
    role: string; username: string | null; phoneVerifiedAt: Date | null; hasOwnChildren: boolean;
  }>>(
    `SELECT u.role::text AS role, u.username, u."phoneVerifiedAt",
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
  return { hasOwnChildren, canUseParentView };
}

/** 화면명과 안전한 고정 주소만 공개하며 계정 ID나 자녀 정보는 전달하지 않습니다. */
export async function getAccountViewAccess() {
  try {
    const user = await requireAuth();
    const [role, parent] = await Promise.all([getPublicAccountRole(), getParentViewAccessForAuthUser(user)]);
    return { role, views: resolveAccountViews(role, parent.canUseParentView) };
  } catch {
    // 인증이나 DB 확인에 실패하면 전환 메뉴를 숨기고 기존 접근 제한을 유지합니다.
    return { role: null, views: [] };
  }
}
