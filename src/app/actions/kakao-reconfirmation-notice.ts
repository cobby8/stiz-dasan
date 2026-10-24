"use server";

import { requireAdmin } from "@/lib/auth-guard";
import { prisma } from "@/lib/prisma";
import { issuePendingReconfirmationLink } from "@/lib/kakao-parent-chatbot";
import { getKakaoParentReconfirmationPreview } from "@/app/actions/kakao-parent-reconfirmation";
import { hashMessageBody, hashMessageRecipientPhone, normalizeMessagePhone } from "@/lib/message-ledger";
import { kakaoReconfirmationTokenHash } from "@/lib/kakao-parent-reconfirmation";
import { reserveFailClosedSmsDelivery, dispatchReservedSmsDelivery, finalizeReservedSmsWithoutDispatch } from "@/lib/notification";

function noticeMessage(studentName: string, url: string) {
  return `안녕하세요 어머니~ ${studentName} 학생 요청 내용을 확인해 정리했습니다. 아래 링크에서 날짜와 수업 등 내용을 확인해 주세요.\n${url}\n확인 후 원장 승인과 처리 결과 확인을 거쳐 반영됩니다. 링크의 표시된 만료시간 전에 확인해 주세요.`;
}

function bindingHash(value: unknown) {
  const record = value as Record<string, unknown>;
  return hashMessageBody(JSON.stringify(Object.keys(record).sort().map(key => [key, record[key]])));
}

async function currentNotice(intakeId: string, url: string) {
  const parsed = new URL(url);
  const expectedOrigin = new URL(process.env.NEXT_PUBLIC_SITE_URL || "https://www.stiz-dasan.kr").origin;
  if (parsed.origin !== expectedOrigin || !/^\/request\/reconfirm\/[A-Za-z0-9_-]+$/.test(parsed.pathname)) throw new Error("잘못된 안내 링크입니다.");
  const token = parsed.pathname.split("/").at(-1)!;
  const preview = await getKakaoParentReconfirmationPreview(token);
  if (preview.status !== "ACTIVE" || new Date(preview.expiresAt).getTime() - Date.now() < 60_000) throw new Error("링크가 변경·만료되었거나 재확인이 끝났습니다. 다시 준비해 주세요.");
  const rows = await prisma.$queryRawUnsafe<Array<{ linkId: string; identityId: string; studentId: string; parentId: string; phone: string | null }>>(
    `SELECT l.id AS "linkId",k.id AS "identityId",l."studentId",s."parentId",u.phone
       FROM "ParentOperationsRequestLink" l
       JOIN "OperationsAuditLog" a ON a."linkId"=l.id AND a.action='KAKAO_RECONFIRMATION_LINK_ISSUED'
       JOIN "KakaoParentIntake" i ON i.id=a."detailsJson"->>'intakeId'
       JOIN "KakaoParentIdentity" k ON k.id=i."identityId"
       JOIN "Student" s ON s.id=l."studentId" AND s.id=i."studentId" AND s."parentId"=k."parentUserId"
       JOIN "User" u ON u.id=s."parentId"
      WHERE i.id=$1 AND l."tokenHash"=$2 AND l."revokedAt" IS NULL AND l."expiresAt">now()
        AND l."lastUsedAt" IS NULL AND k.status='ACTIVE' AND i.status='APPROVED' LIMIT 1`, intakeId, kakaoReconfirmationTokenHash(token),
  );
  const row = rows[0];
  const phone = normalizeMessagePhone(row?.phone || "");
  if (!row || !/^01\d{8,9}$/.test(phone)) throw new Error("인증 보호자의 문자 수신 번호를 확인해 주세요.");
  const message = noticeMessage(preview.studentName, url);
  const binding = { intakeId, identityId: row.identityId, linkId: row.linkId, studentId: row.studentId, parentId: row.parentId,
    phoneHash: hashMessageRecipientPhone(phone), bodyHash: hashMessageBody(message),
    tokenHash: kakaoReconfirmationTokenHash(token), expiresAt: preview.expiresAt, channel: "SMS" };
  return { binding, message, phone, studentName: preview.studentName };
}

/** 관리자 미리보기만 생성한다. 링크 생성은 발송 승인이나 발송 완료가 아니다. */
export async function prepareKakaoReconfirmationNotice(intakeId: string) {
  const admin = await requireAdmin();
  if (typeof intakeId !== "string" || !intakeId.trim() || intakeId.length > 100) throw new Error("요청을 선택해 주세요.");
  const rows = await prisma.$queryRawUnsafe<Array<{ id: string; parentUserId: string; status: string }>>(
    `SELECT i.id,i."parentUserId",i.status FROM "KakaoParentIdentity" i
      JOIN "KakaoParentIntake" r ON r."identityId"=i.id
      WHERE r.id=$1 AND r.status='APPROVED' AND i.status='ACTIVE' AND i."parentUserId" IS NOT NULL`, intakeId,
  );
  if (!rows[0]) throw new Error("인증된 학부모의 이관 요청만 안내를 준비할 수 있습니다.");
  const link = await issuePendingReconfirmationLink(rows[0], intakeId, admin.appUserId);
  if (!link) throw new Error("재확인이 필요 없거나 요청 내용이 변경되었습니다. 새로고침해 주세요.");
  const current = await currentNotice(intakeId, link.url);
  const approval = await prisma.operationsAuditLog.create({ data: {
    linkId: current.binding.linkId, actorType: "ADMIN", actorUserId: admin.appUserId,
    action: "KAKAO_RECONFIRMATION_SMS_PREVIEW", detailsJson: current.binding,
  }});
  return {
    ...link,
    status: "HELD" as const,
    sent: false as const,
    approvalId: approval.id, channel: "SMS" as const,
    maskedRecipient: `***-****-${current.phone.slice(-4)}`,
    message: current.message,
  };
}

/** 명시 승인된 미리보기 1건만 직접 발송한다. 재시도/예약 자동발송은 하지 않는다. */
export async function sendKakaoReconfirmationNotice(input: { approvalId: string; intakeId: string; url: string; channel: "SMS"; approved: boolean }) {
  const admin = await requireAdmin();
  if (!input.approved || input.channel !== "SMS" || input.url.length > 1000) throw new Error("SMS 미리보기 승인이 필요합니다.");
  const approval = await prisma.operationsAuditLog.findUnique({ where: { id: input.approvalId } });
  if (!approval || approval.action !== "KAKAO_RECONFIRMATION_SMS_PREVIEW" || approval.actorUserId !== admin.appUserId) throw new Error("미리보기를 다시 준비해 주세요.");
  const current = await currentNotice(input.intakeId, input.url);
  if (bindingHash(approval.detailsJson) !== bindingHash(current.binding)) throw new Error("수신자 또는 안내 내용이 바뀌었습니다. 다시 승인해 주세요.");
  await prisma.operationsAuditLog.create({ data: { linkId: current.binding.linkId, actorType: "ADMIN", actorUserId: admin.appUserId,
    action: "KAKAO_RECONFIRMATION_SMS_APPROVED", detailsJson: { ...current.binding, approvalId: approval.id } } });
  const reserved = await prisma.$transaction(async tx => {
    // 링크 재발급과 전달 예약이 같은 학부모 잠금을 공유한다.
    await tx.$queryRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext($1))`, `kakao-reconfirm:${current.binding.identityId}`);
    return reserveFailClosedSmsDelivery(tx, { eventType: "KAKAO_RECONFIRMATION", eventId: current.binding.linkId,
    recipientPhone: current.phone, recipientUserId: current.binding.parentId, recipientRole: "PARENT",
    requestedChannel: "SMS", audienceScope: "EXTERNAL", source: "MANUAL", forceSms: true });
  });
  if (reserved.status !== "PENDING" || !reserved.deliveryId) return { status: "HELD", message: "이미 처리되었거나 결과 확인이 필요한 발송입니다. 중복 전송하지 않았습니다." };
  try {
    const latest = await currentNotice(input.intakeId, input.url);
    if (bindingHash(latest.binding) !== bindingHash(current.binding)) throw new Error("STALE_PREVIEW");
  } catch {
    await finalizeReservedSmsWithoutDispatch({ deliveryId: reserved.deliveryId, status: "SKIPPED", errorCode: "RECONFIRMATION_PREVIEW_CHANGED" });
    return { status: "HELD", message: "발송 직전 링크 또는 수신자가 변경되어 중단했습니다." };
  }
  const result = await dispatchReservedSmsDelivery({ deliveryId: reserved.deliveryId, recipientPhone: current.phone, body: current.message });
  await prisma.operationsAuditLog.create({ data: { linkId: current.binding.linkId, actorType: "ADMIN", actorUserId: admin.appUserId,
    action: "KAKAO_RECONFIRMATION_SMS_RESULT", detailsJson: { approvalId: approval.id, deliveryId: reserved.deliveryId, status: result.status } } });
  return { status: result.status, message: result.ok ? "문자 공급자 접수 완료입니다. 최종 수신 여부는 발송 장부에서 확인해 주세요." : "발송 실패 또는 결과 불확실입니다. 발송 장부 확인 전 재전송하지 마세요." };
}
