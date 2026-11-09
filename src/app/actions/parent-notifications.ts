"use server";

import { revalidatePath } from "next/cache";
import { requireVerifiedParent } from "@/lib/auth-guard";
import { prisma } from "@/lib/prisma";

// 학부모 알림 «읽음»·«모두 읽음» 서버 동작 (2026-11-10).
//
// 예전엔 학부모 홈이 관리자용 markNotificationRead/markAllNotificationsRead(actions/admin.ts)를 불러
// requireAdmin() 에 막혀 «관리자 권한이 필요합니다»로 실패했다(운영 로그 확인).
//
// ★ 보안: 누구의 알림인지는 화면이 정하지 않는다. requireVerifiedParent() 가 확인한 로그인 사용자(appUserId)만
//   UPDATE 조건에 들어간다 — 남의 알림 id 를 보내도 "userId" 가 달라 0건이 바뀐다(IDOR 방지).

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** 알림 한 건 읽음 — 내 알림일 때만 바뀐다 */
export async function markMyNotificationRead(id: string): Promise<{ ok: boolean }> {
  const parent = await requireVerifiedParent().catch(() => null);
  if (!parent) return { ok: false };
  if (typeof id !== "string" || !ID_RE.test(id)) return { ok: false };
  try {
    await prisma.$executeRawUnsafe(
      `UPDATE "Notification" SET "isRead" = true WHERE id = $1 AND "userId" = $2 AND "isRead" = false`,
      id,
      parent.appUserId,
    );
  } catch (e) {
    console.error("[markMyNotificationRead] failed:", e);
    return { ok: false };
  }
  // 머리줄 🔔 배지는 모든 /mypage 화면의 layout 이 그린다 → layout 단위로 새로 그린다
  revalidatePath("/mypage", "layout");
  return { ok: true };
}

/** 내 알림 모두 읽음 — 인자 없음(대상은 로그인 사용자) */
export async function markAllMyNotificationsRead(): Promise<{ ok: boolean }> {
  const parent = await requireVerifiedParent().catch(() => null);
  if (!parent) return { ok: false };
  try {
    await prisma.$executeRawUnsafe(
      `UPDATE "Notification" SET "isRead" = true WHERE "userId" = $1 AND "isRead" = false`,
      parent.appUserId,
    );
  } catch (e) {
    console.error("[markAllMyNotificationsRead] failed:", e);
    return { ok: false };
  }
  // 머리줄 🔔 배지는 모든 /mypage 화면의 layout 이 그린다 → layout 단위로 새로 그린다
  revalidatePath("/mypage", "layout");
  return { ok: true };
}
