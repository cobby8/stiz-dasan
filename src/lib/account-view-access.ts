import { cache } from "react";
import { childAccessSql, hasGrantedChildren } from "@/lib/account/child-access";
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
            EXISTS (SELECT 1 FROM "Student" s WHERE ${await childAccessSql("s", 'u."id"')}) AS "hasOwnChildren"
       FROM "User" u
      WHERE (u."authUserId" = $1 OR (u."authUserId" IS NULL AND u.id = $1))
        AND u."withdrawnAt" IS NULL
      ORDER BY CASE WHEN u."authUserId" = $1 THEN 0 ELSE 1 END
      LIMIT 1`, user.id,
  );
  const account = rows[0];
  const hasOwnChildren = Boolean(account?.hasOwnChildren);
  const canUseParentView = Boolean(account && (account.role === "PARENT"
    ? account.phoneVerifiedAt || account.username === null || await hasGrantedChildren(account.id)
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
// 한 요청 안에서는 한 번만 계산한다(레이아웃과 화면이 같이 부를 수 있다, 2026-11-14 속도 개선).
export const getAccountViewAccess = cache(readAccountViewAccess);

async function readAccountViewAccess() {
  try {
    const user = await requireAuth();
    const [role, parent] = await Promise.all([getPublicAccountRole(), getParentViewAccessForAuthUser(user)]);
    // hasOwnChildren: 이미 같은 조회에서 구한 «연결된 자녀가 있나»(2026-11-17) — 서버 page 가 «학원에 문의» 링크를
    // 자녀 연결 화면으로 바꿀지 정할 때만 쓴다(새 DB 조회 없음 · 레이아웃이 같은 요청에서 이미 불렀다).
    // 화면(클라이언트)이나 API 응답으로는 넘기지 않는다 — 넘기는 곳은 role·views 만 꺼내 쓴다.
    return { role, views: resolveAccountViews(role, parent.canUseParentView, parent.grants), hasOwnChildren: parent.hasOwnChildren };
  } catch {
    // 인증이나 DB 확인에 실패하면 전환 메뉴를 숨기고 기존 접근 제한을 유지합니다.
    return { role: null, views: [] };
  }
}
