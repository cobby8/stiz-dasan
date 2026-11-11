"use server";

import { revalidatePath, revalidateTag } from "next/cache";
import { Prisma } from "@prisma/client";
import { requireAdmin, requireOwner } from "@/lib/auth-guard";
import { prisma } from "@/lib/prisma";
import { createNotificationRecord } from "@/lib/notification";
import { isUsablePhoneKey, parentPhoneDigits } from "@/lib/enrollment/parentIdentity";
import { ROLE_LABELS, type GrantableRole } from "@/lib/account/roles";

// 직원 역할(선생님·기사님) 신청 — 원장 확인·처리 (다중 역할 4단계, 2026-10-25).
//
// 누가 무엇을 할 수 있나 — 기존 규칙과 같게 맞췄다:
//   목록 보기      : 원장·부원장(requireAdmin)
//   승인·반려·회수 : **원장만**(requireOwner) — 직원 역할 변경(updateUserRole)이 원장 전용이라서.
//                    선생님 역할은 모든 학생의 개인정보를 연다. 승인 권한을 넓히면 그만큼 새는 길이 늘어난다.
// 상태 전이는 모두 «지금 상태»를 조건에 걸어 한 줄만 바꾼다(목록이 낡았을 때의 오조작 방지).

export type RoleGrantAdminRow = {
  id: string;
  userId: string;
  role: "INSTRUCTOR" | "DRIVER";
  status: "PENDING" | "ACTIVE";
  source: string;
  requestedAt: Date | string;
  decidedAt: Date | string | null;
  name: string;
  phone: string | null;
  primaryRole: string;
  /** 누구의 보호자인지 — 원장이 판단할 근거. 병합된 유령 학생은 뺀다. */
  childNames: string;
};

export async function getRoleGrantsForAdmin() {
  const admin = await requireAdmin();

  const rows = await prisma.$queryRawUnsafe<RoleGrantAdminRow[]>(
    `SELECT g.id, g."userId", g.role, g.status, g.source, g."requestedAt", g."decidedAt",
            u.name, u.phone, u.role::text AS "primaryRole",
            COALESCE(
              (SELECT STRING_AGG(s.name, ', ' ORDER BY s.name)
                 FROM "Student" s
                WHERE s."parentId" = u.id AND s."mergedIntoStudentId" IS NULL),
              ''
            ) AS "childNames"
       FROM "UserRoleGrant" g
       JOIN "User" u ON u.id = g."userId"
      WHERE g.status IN ('PENDING', 'ACTIVE')
        AND u."withdrawnAt" IS NULL
      ORDER BY CASE g.status WHEN 'PENDING' THEN 0 ELSE 1 END, g."requestedAt" ASC`,
  );

  return {
    pending: rows.filter((row) => row.status === "PENDING"),
    active: rows.filter((row) => row.status === "ACTIVE"),
    // 화면이 버튼을 보일지 정하는 데만 쓴다. 실제 권한은 각 액션의 requireOwner 가 다시 확인한다.
    canDecide: admin.appUserRole === "ADMIN",
  };
}

async function transition(
  grantId: unknown,
  from: "PENDING" | "ACTIVE",
  to: "ACTIVE" | "REJECTED" | "REVOKED",
  note: string | null,
) {
  const owner = await requireOwner();
  const id = String(grantId ?? "").trim();
  if (!id) return { error: "대상이 지정되지 않았습니다." };

  // RETURNING — 바꾼 그 한 줄에서 알림 받을 사람을 꺼낸다(따로 다시 읽으면 그 사이 바뀔 수 있다).
  const changed = await prisma.$queryRawUnsafe<Array<{ userId: string; role: GrantableRole }>>(
    `UPDATE "UserRoleGrant"
        SET status = $2, "decidedAt" = NOW(), "decidedBy" = $3,
            note = COALESCE($4, note), "updatedAt" = NOW()
      WHERE id = $1 AND status = $5
      RETURNING "userId", role::text AS role`,
    id,
    to,
    owner.appUserId,
    note,
    from,
  );
  const affected = changed.length;
  if (affected !== 1) {
    return { error: from === "PENDING" ? "이미 처리된 신청입니다. 목록을 새로고침해 주세요." : "이미 회수된 역할입니다." };
  }

  await announceRoleTransition(changed[0], to);
  return { ok: true };
}

async function announceRoleTransition(
  { userId, role }: { userId: string; role: GrantableRole },
  to: "ACTIVE" | "REJECTED" | "REVOKED",
) {
  // 신청자에게 결과를 알린다(앱 알림 + 푸시, 문자 없음). 실패해도 처리는 이미 끝났다 — createNotificationRecord 가 오류를 삼킨다.
  const label = ROLE_LABELS[role];
  const notice =
    to === "ACTIVE"
      ? { title: `${label} 역할 승인`, message: `${label} 화면을 쓸 수 있습니다. 앱에서 화면 전환으로 열어 보세요.`, linkUrl: role === "DRIVER" ? "/staff/shuttle" : "/staff" }
      : to === "REJECTED"
        ? { title: `${label} 역할 신청 결과`, message: `${label} 역할 신청이 반려되었습니다. 궁금한 점은 학원으로 문의해 주세요.`, linkUrl: "/mypage/roles" }
        : { title: `${label} 역할 해제`, message: `${label} 역할이 해제되었습니다. 학부모 화면은 그대로 쓸 수 있습니다.`, linkUrl: "/mypage/roles" };
  await createNotificationRecord({ userId, type: "ROLE_REQUEST", ...notice });

  revalidatePath("/admin/role-requests");
  revalidatePath("/admin/inbox");
  revalidatePath("/admin");
}

/** 신청을 승인한다 — 이 순간부터 그 사람에게 선생님·기사님 화면이 열린다. */
export async function approveRoleRequest(grantId: unknown) {
  return transition(grantId, "PENDING", "ACTIVE", "원장 승인");
}

/** 신청을 반려한다. 계정과 학부모 화면은 그대로다. */
export async function rejectRoleRequest(grantId: unknown, reason?: unknown) {
  const note = typeof reason === "string" && reason.trim() ? reason.trim().slice(0, 200) : "원장 반려";
  return transition(grantId, "PENDING", "REJECTED", note);
}

/**
 * 부여했던 역할을 회수한다. 추가 역할은 캐시하지 않으므로 다음 요청부터 바로 막힌다.
 * (주 역할 캐시는 5분이지만 그건 이 표와 무관하다 — 추가 역할은 매번 읽는다.)
 */
export async function revokeRoleGrant(grantId: unknown) {
  return transition(grantId, "ACTIVE", "REVOKED", "원장 회수");
}

/** 신청 상세를 열 때 연결 가능한 코치를 조회한다. 연락처는 끝 네 자리만 돌려준다. */
export async function getRoleRequestCoachOptions(grantId: string) {
  const admin = await requireAdmin();
  const grant = await prisma.userRoleGrant.findFirst({
    where: { id: grantId, role: "INSTRUCTOR", status: { in: ["PENDING", "ACTIVE"] }, user: { withdrawnAt: null } },
    select: { userId: true, user: { select: { name: true, phone: true } } },
  });
  if (!grant) return { error: "처리할 수 없는 선생님 신청입니다." };

  const linked = await prisma.coach.findUnique({ where: { userId: grant.userId }, select: { id: true, name: true, role: true } });
  const canConnect = admin.appUserRole === "ADMIN";
  const coaches = canConnect && !linked
    ? await prisma.coach.findMany({
        where: { userId: null },
        select: { id: true, name: true, role: true, phone: true },
        orderBy: [{ order: "asc" }, { name: "asc" }],
      })
    : [];
  const digits = parentPhoneDigits(grant.user.phone);
  const options = coaches.map(({ id, name, role, phone }) => {
    const coachDigits = parentPhoneDigits(phone);
    return {
      id, name, role,
      phoneLast4: coachDigits.slice(-4),
      matches: name.trim() === grant.user.name?.trim() && isUsablePhoneKey(digits) && coachDigits === digits,
    };
  });
  options.sort((a, b) => Number(b.matches) - Number(a.matches));
  return { linked, options, canConnect, phoneLast4: digits.slice(-4) };
}

/** 승인과 연결을 같은 트랜잭션에서 처리한다. 기존 연결은 다른 계정으로 옮기지 않는다. */
export async function connectRoleRequestCoach(grantId: string, coachId: string, expectedStatus: "PENDING" | "ACTIVE") {
  const owner = await requireOwner();
  if (!grantId || !coachId || !["PENDING", "ACTIVE"].includes(expectedStatus)) {
    return { error: "연결할 코치와 신청을 확인해 주세요." };
  }

  const result = await prisma.$transaction(async (tx) => {
    const [grant] = await tx.$queryRaw<Array<{ userId: string }>>(
      Prisma.sql`SELECT g."userId"
        FROM "UserRoleGrant" g JOIN "User" u ON u.id = g."userId"
        WHERE g.id = ${grantId} AND g.role = 'INSTRUCTOR' AND g.status = ${expectedStatus}
          AND u."withdrawnAt" IS NULL
        FOR UPDATE OF g, u`,
    );
    if (!grant) return { error: "신청 상태가 바뀌었습니다. 신청함을 새로고침해 주세요." };

    const linked = await tx.coach.findUnique({ where: { userId: grant.userId }, select: { id: true } });
    if (linked && linked.id !== coachId) {
      return { error: "이미 다른 코치가 연결된 계정입니다. 기존 연결을 확인해 주세요." };
    }
    if (!linked) {
      const changed = await tx.coach.updateMany({
        where: { id: coachId, userId: null },
        data: { userId: grant.userId },
      });
      if (changed.count !== 1) return { error: "이 코치는 연결할 수 없습니다. 다른 계정에 연결됐는지 확인해 주세요." };
    }
    if (expectedStatus === "PENDING") {
      await tx.userRoleGrant.update({
        where: { id: grantId },
        data: { status: "ACTIVE", decidedAt: new Date(), decidedBy: owner.appUserId, note: "원장 승인 및 코치 연결" },
      });
    }
    return { userId: grant.userId };
  }).catch((error: unknown) => {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return { error: "계정에 이미 코치가 연결돼 있습니다. 새로고침 후 확인해 주세요." };
    }
    throw error;
  });

  if ("error" in result) return { error: result.error };
  if (expectedStatus === "PENDING") {
    await announceRoleTransition({ userId: result.userId, role: "INSTRUCTOR" }, "ACTIVE");
  } else {
    revalidatePath("/admin/inbox");
  }
  revalidateTag("admin-staff", { expire: 0 });
  revalidateTag("admin-coaches", { expire: 0 });
  revalidatePath("/admin/staff");
  return { ok: true };
}
