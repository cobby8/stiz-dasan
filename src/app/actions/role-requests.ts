"use server";

import { revalidatePath } from "next/cache";
import { requireVerifiedParent } from "@/lib/auth-guard";
import {
  GRANTABLE_ROLES,
  ROLE_LABELS,
  effectiveRoles,
  isGrantableRole,
  type GrantableRole,
} from "@/lib/account/roles";
import { notifyAdmins } from "@/lib/notification";
import { prisma } from "@/lib/prisma";

// 직원 역할(선생님·기사님) 승인 신청 — 학부모 쪽에서 쓰는 액션.
//
// 스토어에서 앱을 받은 사람이 가입할 때 「선생님」을 고를 수 있다(원장 결정 2026-10-25).
// 고르기만 해서 열리면 아무나 모든 학생의 개인정보를 본다 — 그래서 여기서는 **PENDING 으로만**
// 쌓는다. 화면이 열리는 것은 원장이 승인해 ACTIVE 가 됐을 때뿐이다(4단계 원장 화면).
//
// 휴대폰 인증까지 끝난 계정만 신청할 수 있다(requireVerifiedParent) — 원장이 누가 신청했는지
// 전화번호로 확인할 수 있어야 승인 판단을 할 수 있다.

type GrantStatusRow = { role: string; status: string };

async function readMyRoleState(appUserId: string) {
  const [userRows, grantRows] = await Promise.all([
    prisma.$queryRawUnsafe<Array<{ role: string; name: string; phone: string | null }>>(
      `SELECT role::text AS role, name, phone FROM "User" WHERE id = $1 LIMIT 1`,
      appUserId,
    ),
    prisma.$queryRawUnsafe<GrantStatusRow[]>(
      `SELECT role, status FROM "UserRoleGrant"
        WHERE "userId" = $1 AND status IN ('PENDING', 'ACTIVE')`,
      appUserId,
    ),
  ]);
  const user = userRows[0];
  if (!user) throw new Error("계정을 찾을 수 없습니다.");
  const roles = effectiveRoles({ primaryRole: user.role, grants: grantRows, hasStudents: false });
  const pending = new Set(
    grantRows.filter((row) => row.status === "PENDING" && isGrantableRole(row.role)).map((row) => row.role as GrantableRole),
  );
  return { user, roles, pending };
}

/** 각 직원 역할이 지금 어떤 상태인지 — 열림 / 신청 중 / 없음. */
export async function getMyRoleRequests() {
  const parent = await requireVerifiedParent();
  const { roles, pending } = await readMyRoleState(parent.appUserId);
  return GRANTABLE_ROLES.map((role) => ({
    role,
    label: ROLE_LABELS[role],
    state: (role === "INSTRUCTOR" ? roles.teacher : roles.driver)
      ? ("ACTIVE" as const)
      : pending.has(role)
        ? ("PENDING" as const)
        : ("NONE" as const),
  }));
}

/**
 * 선생님·기사님 역할을 신청한다. 이미 열려 있거나 신청 중인 역할은 건너뛴다.
 * 같은 사람·역할에 살아 있는 건은 하나뿐이다(DB 부분 유니크) — 두 번 눌러도 하나만 남는다.
 */
export async function requestStaffRoles(requested: unknown) {
  const parent = await requireVerifiedParent();

  // 화면이 보낸 값은 아는 역할만 받는다. 관리자·학부모·오타는 조용히 버리지 않고 거절한다 —
  // 화면과 서버가 어긋났다는 신호라 그대로 넘기면 원인을 못 찾는다.
  const list = Array.isArray(requested) ? requested : [];
  if (list.length === 0) return { error: "신청할 역할을 골라주세요." };
  if (!list.every(isGrantableRole)) return { error: "신청할 수 없는 역할이 포함돼 있습니다." };
  const wanted = [...new Set(list as GrantableRole[])];

  const { user, roles, pending } = await readMyRoleState(parent.appUserId);
  const toCreate = wanted.filter(
    (role) => !(role === "INSTRUCTOR" ? roles.teacher : roles.driver) && !pending.has(role),
  );
  if (toCreate.length === 0) {
    return { ok: true, created: [] as GrantableRole[], message: "이미 열려 있거나 신청 중인 역할입니다." };
  }

  const created: GrantableRole[] = [];
  for (const role of toCreate) {
    // 부분 유니크 인덱스 UserRoleGrant_live_unique 가 동시에 두 번 누른 경우를 막는다.
    const affected = await prisma.$executeRawUnsafe(
      `INSERT INTO "UserRoleGrant" ("userId", role, status, source)
       VALUES ($1, $2, 'PENDING', 'REQUEST')
       ON CONFLICT ("userId", role) WHERE status IN ('PENDING', 'ACTIVE') DO NOTHING`,
      parent.appUserId,
      role,
    );
    if (affected === 1) created.push(role);
  }

  if (created.length > 0) {
    // 알림이 실패해도 신청은 이미 접수됐다. 원장 화면 목록에서 보인다.
    try {
      await notifyAdmins(
        "ROLE_REQUEST",
        "직원 역할 신청",
        `${user.name}님이 ${created.map((role) => ROLE_LABELS[role]).join("·")} 역할을 신청했습니다. 확인 후 승인해 주세요.`,
        "/admin/role-requests",
        { notifyCoaches: false, eventId: `role-request:${parent.appUserId}:${created.join(",")}` },
      );
    } catch (error) {
      console.error("[requestStaffRoles] 원장 알림 실패:", error);
    }
  }

  revalidatePath("/mypage/roles");
  return { ok: true, created };
}

/** 신청을 취소한다. 이미 승인된(ACTIVE) 역할은 여기서 못 내린다 — 원장에게 요청해야 한다. */
export async function cancelStaffRoleRequest(role: unknown) {
  const parent = await requireVerifiedParent();
  if (!isGrantableRole(role)) return { error: "취소할 수 없는 역할입니다." };

  const affected = await prisma.$executeRawUnsafe(
    `UPDATE "UserRoleGrant"
        SET status = 'REVOKED', "decidedAt" = NOW(), note = '본인 취소', "updatedAt" = NOW()
      WHERE "userId" = $1 AND role = $2 AND status = 'PENDING'`,
    parent.appUserId,
    role,
  );
  if (affected !== 1) return { error: "취소할 신청이 없습니다." };

  revalidatePath("/mypage/roles");
  return { ok: true };
}
