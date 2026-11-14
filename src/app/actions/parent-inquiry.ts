"use server";

// 학부모 문의 «이어 쓰기»·환불 문의 서버 동작 (2026-11-14 원장 결정표 c3·c11).
//
// ★ 보안: 누구의 문의·청구인지는 화면이 정하지 않는다. requireVerifiedParent() 가 확인한 로그인 사용자(appUserId)와
//   화면이 보낸 id 를 같은 SQL 에서 묶어 다시 확인한다(lib/requests/inquiry-thread — 남의 것이면 0행).
//   관리자 동작은 첫 줄에서 requireAdmin()(원장·부원장).
// ★ 고객 발송(문자·알림톡)은 하지 않는다 — «앱 안 알림»(Notification + 푸시)만 만든다.
//   학부모 → 학원: 처음 문의(createParentRequest)와 같은 REQUEST 알림 경로(원장 계정마다 createNotificationRecord).
//   학원 → 학부모: 답 1건에 알림 1건.

import { revalidatePath, revalidateTag } from "next/cache";
import { requireAdmin, requireVerifiedParent } from "@/lib/auth-guard";
import { prisma } from "@/lib/prisma";
import { createNotificationRecord } from "@/lib/notification";
import {
  addAdminInquiryReply,
  addParentInquiryMessage,
  createRefundInquiry,
  getInquiryThreadForAdmin,
} from "@/lib/requests/inquiry-thread";
import type { InquiryBubble } from "@/lib/requests/inquiryThreadRules";

type ParentResult = { ok: true; requestId: string; notice?: string } | { ok: false; error: string };

const SIGN_IN_AGAIN = "다시 로그인해 주세요.";

function cleanId(value: unknown): string {
  const id = typeof value === "string" ? value.trim() : "";
  return id && id.length <= 100 ? id : "";
}

/** 관리자 요청함·대시보드의 문의 목록 캐시를 지운다(admin.ts 의 revalidateRequestAdminCaches 와 같은 태그) */
function refreshRequestViews(requestId?: string) {
  revalidateTag("admin-requests", { expire: 0 });
  revalidateTag("admin-dashboard", { expire: 0 });
  revalidatePath("/admin/requests");
  revalidatePath("/admin");
  revalidatePath("/mypage");
  revalidatePath("/mypage/requests");
  if (requestId) revalidatePath(`/mypage/requests/${requestId}`);
}

/** 원장 계정에 앱 안 알림 — 처음 문의와 같은 대상(role = ADMIN)·같은 종류(REQUEST). 실패해도 접수는 유지한다 */
async function notifyAdminsOfInquiry(title: string, message: string) {
  try {
    const admins = await prisma.$queryRawUnsafe<{ id: string }[]>(`SELECT id FROM "User" WHERE role = 'ADMIN'`);
    for (const admin of admins) {
      await createNotificationRecord({ userId: admin.id, type: "REQUEST", title, message, linkUrl: "/admin/requests" });
    }
  } catch (error) {
    console.error("[parent-inquiry] 관리자 알림 실패(접수는 완료):", error);
  }
}

/** 학부모: 보낸 문의에 글을 이어 쓴다 */
export async function sendInquiryFollowUp(requestIdRaw: string, body: string): Promise<ParentResult> {
  const parent = await requireVerifiedParent().catch(() => null);
  if (!parent) return { ok: false, error: SIGN_IN_AGAIN };
  const requestId = cleanId(requestIdRaw);
  if (!requestId) return { ok: false, error: "문의를 찾을 수 없어요. 목록에서 다시 열어 주세요." };
  const result = await addParentInquiryMessage(prisma, parent.appUserId, requestId, body);
  if (!result.ok) return result;
  await notifyAdminsOfInquiry("문의 추가 글", `${result.studentName ?? "원생"} - ${result.title}`);
  refreshRequestViews(requestId);
  return { ok: true, requestId };
}

/** 학부모: 납부 완료 청구에 대한 환불 문의를 접수한다(실제 환불은 관리자 기존 기능) */
export async function sendRefundInquiry(paymentIdRaw: string, reason: string): Promise<ParentResult> {
  const parent = await requireVerifiedParent().catch(() => null);
  if (!parent) return { ok: false, error: SIGN_IN_AGAIN };
  const paymentId = cleanId(paymentIdRaw);
  if (!paymentId) return { ok: false, error: "청구를 찾을 수 없어요. 청구 화면을 새로 열어 주세요." };
  const result = await createRefundInquiry(prisma, parent.appUserId, paymentId, reason);
  if (!result.ok) return result;
  // 이미 열려 있던 문의로 안내한 경우에는 알림을 다시 만들지 않는다
  if (!result.existing) {
    await notifyAdminsOfInquiry("환불 문의 접수", `${result.studentName} - ${result.title}`);
    refreshRequestViews(result.requestId);
  }
  return { ok: true, requestId: result.requestId, notice: result.existing ? "이미 보낸 환불 문의가 있어요." : undefined };
}

// ── 관리자 ───────────────────────────────────────────────────────────────────

/** 관리자 요청함 상세: 문의 한 건의 대화 */
export async function getParentRequestThreadForAdmin(requestIdRaw: string): Promise<{ bubbles: InquiryBubble[]; canReply: boolean } | null> {
  await requireAdmin();
  const requestId = cleanId(requestIdRaw);
  if (!requestId) return null;
  return getInquiryThreadForAdmin(prisma, requestId);
}

export type AdminInquiryReplyResult =
  | { saved: true; status: string; notification: "REGISTERED" | "UNKNOWN" }
  | { saved: false; error: string };

/**
 * 관리자: 문의에 답을 이어 쓴다. 상태를 같이 넘기면 그 상태로(답 + 상태 변경에 학부모 알림은 1건).
 * 상태만 바꾸는 기존 동작(updateRequestStatus)은 그대로 둔다.
 */
export async function replyToParentRequest(requestIdRaw: string, body: string, status?: string): Promise<AdminInquiryReplyResult> {
  const admin = await requireAdmin();
  const requestId = cleanId(requestIdRaw);
  if (!requestId) return { saved: false, error: "요청을 찾을 수 없습니다. 목록을 다시 확인해 주세요." };
  const result = await addAdminInquiryReply(prisma, admin.appUserId, requestId, body, status ?? null);
  if (!result.ok) return { saved: false, error: result.error };
  refreshRequestViews(requestId);

  // 학부모 앱 안 알림 1건 — 누르면 그 문의 대화로
  let notification: "REGISTERED" | "UNKNOWN" = "UNKNOWN";
  const linkUrl = `/mypage/requests/${requestId}`;
  try {
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Notification" (id, "userId", type, title, message, "linkUrl", "isRead", "createdAt")
       VALUES (gen_random_uuid()::text, $1, 'REQUEST', '학원 답변이 도착했어요', $2, $3, false, NOW())`,
      result.parentUserId, `"${result.title}" 문의에 답변이 달렸어요.`, linkUrl,
    );
    notification = "REGISTERED";
  } catch {
    // 응답 유실 시 실제 등록됐을 수 있으므로 자동 재발송하지 않는다(updateRequestStatus 와 같은 원칙)
    notification = "UNKNOWN";
  }
  if (notification === "REGISTERED") {
    try {
      const { sendPushToUser } = await import("@/lib/pushNotification");
      await sendPushToUser(result.parentUserId, { title: "학원 답변이 도착했어요", body: "보낸 문의에서 확인해 주세요.", url: linkUrl, tag: "REQUEST" });
    } catch {
      // 푸시 실패는 답변 저장 결과를 바꾸지 않는다(앱 안 알림은 이미 등록됨)
    }
  }
  return { saved: true, status: result.status, notification };
}
