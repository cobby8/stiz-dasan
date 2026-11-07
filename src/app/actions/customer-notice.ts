"use server";

/**
 * 고객 안내 문자 «미리보기 → 원장 승인 → 발송» 공용 서버 동작.
 *
 * 흐름(택배로 비유하면):
 *   1) prepareCustomerNotice  = 포장해서 원장님께 보여 드리기(문구·받는 사람 확인). 아직 안 보낸다.
 *   2) sendCustomerNotice     = 원장님이 «보내기»를 누른 그 포장만 발송.
 *      보내기 직전에 받는 사람·문구를 다시 만들어, 미리보기 때와 한 글자라도 다르면 멈춘다.
 *
 * 안전장치
 *   - 관리자만(requireAdmin). 화면에는 번호 끝 4자리만 돌려준다(전체 번호를 다시 내보내지 않음).
 *   - 학부모 번호는 «학생 id / 카카오 접수 id» 로만 찾는다 — 화면이 보낸 학부모 id·번호를 믿지 않는다.
 *   - 같은 번호에 같은 안내는 30분 안에 다시 못 보낸다(접수 결과는 같은 결과를 한 번만).
 *   - 자동 발송·재시도 없음. 발송 장부(MessageDeliveryBatch / NotificationDelivery)에 남긴다.
 *   - 감사 기록(OperationsAuditLog)에는 번호·문구 원문 대신 지문(해시)과 끝 4자리만 둔다.
 */

import { requireAdmin } from "@/lib/auth-guard";
import { prisma } from "@/lib/prisma";
import { getAcademySettings } from "@/lib/queries";
import { sendSmsDetailed } from "@/lib/sms";
import {
  claimMessageDelivery,
  finalizeMessageDelivery,
  finalizeMessageDeliveryBatch,
  hashMessageBody,
  hashMessageRecipientPhone,
  reserveMessageDelivery,
  reserveMessageDeliveryBatch,
} from "@/lib/message-ledger";
import {
  CUSTOMER_NOTICE_DUPLICATE_WINDOW_MINUTES,
  CUSTOMER_NOTICE_LABEL,
  CUSTOMER_NOTICE_PREVIEW_TTL_MINUTES,
  buildIntakeResultMessage,
  buildKakaoChannelInviteMessage,
  buildRentalGuideMessage,
  cleanExtraLine,
  isIntakeResultStatus,
  maskPhone,
  normalizeMobilePhone,
  type CustomerNoticeKind,
} from "@/lib/customer-notice/templates";

/** 무엇을 누구에게 보낼지 — 화면이 넘기는 값은 «대상 id» 뿐이다(번호는 대관 직접 입력만) */
export type CustomerNoticeRequest =
  | { kind: "KAKAO_INTAKE_RESULT"; intakeId: string; extraLine?: string }
  | { kind: "KAKAO_CHANNEL_INVITE"; studentId: string }
  | { kind: "RENTAL_GUIDE"; phone: string };

export type CustomerNoticePreview = {
  ok: true;
  approvalId: string;
  kind: CustomerNoticeKind;
  title: string;
  recipientLabel: string;
  maskedRecipient: string;
  message: string;
  expiresAt: string;
};

export type CustomerNoticeFailure = { ok: false; message: string };

export type CustomerNoticeSendResult = {
  ok: boolean;
  status: "SENT" | "FAILED" | "HELD";
  message: string;
};

type ResolvedNotice = {
  kind: CustomerNoticeKind;
  /** 감사 기록용 대상 표시(학생·접수 id 등). 번호는 넣지 않는다 */
  targetRef: string;
  recipientLabel: string;
  recipientUserId: string | null;
  phone: string;
  body: string;
  /** 같은 일로 한 번만 보낼 안내의 열쇠(접수 결과 = 접수+상태). 없으면 30분 창만 본다 */
  onceKey: string | null;
  /** 카카오 접수 결과 안내면 접수 이력에도 «안내 보냄»을 남기기 위한 값 */
  intakeAudit?: { intakeId: string; status: string };
};

class NoticeProblem extends Error {}

function idOf(value: unknown) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text.length > 100) throw new NoticeProblem("대상을 다시 선택해 주세요.");
  return text;
}

/** 대상 → 받는 번호·문구를 서버에서 직접 만든다. 미리보기와 보내기 직전에 두 번 똑같이 부른다. */
async function resolveNotice(request: CustomerNoticeRequest): Promise<ResolvedNotice> {
  if (!request || typeof request !== "object") throw new NoticeProblem("보낼 안내를 다시 선택해 주세요.");

  if (request.kind === "KAKAO_INTAKE_RESULT") {
    const intakeId = idOf(request.intakeId);
    // 접수 → 인증된 보호자 계정 → 그 계정 번호. 학생의 보호자와 인증 보호자가 같아야만 보낸다.
    const rows = await prisma.$queryRawUnsafe<Array<{
      status: string; kind: string; studentName: string | null; parentUserId: string | null; phone: string | null;
    }>>(
      `SELECT r.status, r.kind, s.name AS "studentName", k."parentUserId", u.phone
         FROM "KakaoParentIntake" r
         JOIN "KakaoParentIdentity" k ON k.id = r."identityId" AND k.status = 'ACTIVE'
         JOIN "Student" s ON s.id = r."studentId" AND s."mergedIntoStudentId" IS NULL AND s."parentId" = k."parentUserId"
         JOIN "User" u ON u.id = k."parentUserId" AND u."withdrawnAt" IS NULL
        WHERE r.id = $1 LIMIT 1`,
      intakeId,
    );
    const row = rows[0];
    if (!row || !row.studentName || !row.parentUserId) throw new NoticeProblem("인증된 보호자와 연결된 접수만 결과를 안내할 수 있습니다.");
    if (!isIntakeResultStatus(row.status)) throw new NoticeProblem("처리를 마친 접수만 결과를 안내할 수 있습니다.");
    const phone = normalizeMobilePhone(row.phone);
    if (!phone) throw new NoticeProblem("보호자 계정에 휴대폰 번호가 없습니다. 학생 상세에서 연락처를 확인해 주세요.");
    return {
      kind: "KAKAO_INTAKE_RESULT",
      targetRef: `intake:${intakeId}`,
      recipientLabel: `${row.studentName} 학생 보호자`,
      recipientUserId: row.parentUserId,
      phone,
      body: buildIntakeResultMessage({ studentName: row.studentName, intakeKind: row.kind, status: row.status, extraLine: request.extraLine }),
      onceKey: `intake:${intakeId}:${row.status}`,
      intakeAudit: { intakeId, status: row.status },
    };
  }

  if (request.kind === "KAKAO_CHANNEL_INVITE") {
    const studentId = idOf(request.studentId);
    // 학생 id 로만 보호자를 찾는다 — 화면이 보낸 학부모 id 로 남의 번호를 꺼낼 수 없게.
    const rows = await prisma.$queryRawUnsafe<Array<{ studentName: string; parentId: string; phone: string | null }>>(
      `SELECT s.name AS "studentName", s."parentId", u.phone
         FROM "Student" s JOIN "User" u ON u.id = s."parentId" AND u."withdrawnAt" IS NULL
        WHERE s.id = $1 AND s."mergedIntoStudentId" IS NULL LIMIT 1`,
      studentId,
    );
    const row = rows[0];
    if (!row) throw new NoticeProblem("학생 정보를 찾지 못했습니다. 새로고침해 주세요.");
    const phone = normalizeMobilePhone(row.phone);
    if (!phone) throw new NoticeProblem("학부모 계정에 휴대폰 번호가 없습니다. 연락처를 먼저 확인해 주세요.");
    const settings = await getAcademySettings();
    return {
      kind: "KAKAO_CHANNEL_INVITE",
      targetRef: `student:${studentId}`,
      recipientLabel: `${row.studentName} 학생 학부모`,
      recipientUserId: row.parentId,
      phone,
      body: buildKakaoChannelInviteMessage({ studentName: row.studentName, channelSettingUrl: settings?.kakaoChannelUrl }),
      onceKey: null,
    };
  }

  if (request.kind === "RENTAL_GUIDE") {
    const phone = normalizeMobilePhone(typeof request.phone === "string" ? request.phone : "");
    if (!phone) throw new NoticeProblem("휴대폰 번호를 정확히 입력해 주세요. (예: 010-1234-5678)");
    return {
      kind: "RENTAL_GUIDE",
      targetRef: "direct",
      recipientLabel: "대관 문의자",
      recipientUserId: null,
      phone,
      body: buildRentalGuideMessage(),
      onceKey: null,
    };
  }

  throw new NoticeProblem("지원하지 않는 안내입니다. 새로고침해 주세요.");
}

/** 미리보기 승인 기록에 묶는 값(번호·문구 원문 없이 지문만) */
function bindingOf(notice: ResolvedNotice) {
  return {
    kind: notice.kind,
    targetRef: notice.targetRef,
    recipientUserId: notice.recipientUserId,
    phoneHash: hashMessageRecipientPhone(notice.phone),
    phoneLast4: notice.phone.slice(-4),
    bodyHash: hashMessageBody(notice.body),
    onceKey: notice.onceKey,
    channel: "SMS",
  };
}

function problemText(error: unknown, fallback: string) {
  return error instanceof NoticeProblem ? error.message : fallback;
}

/** 1) 미리보기만 만든다. 이 단계에서는 절대 보내지 않는다. */
export async function prepareCustomerNotice(request: CustomerNoticeRequest): Promise<CustomerNoticePreview | CustomerNoticeFailure> {
  const admin = await requireAdmin();
  try {
    const notice = await resolveNotice(request);
    const binding = bindingOf(notice);
    const rows = await prisma.$queryRawUnsafe<Array<{ id: string; expiresAt: string }>>(
      `INSERT INTO "OperationsAuditLog" (id, action, "actorType", "actorUserId", "detailsJson")
       VALUES (gen_random_uuid()::text, 'CUSTOMER_NOTICE_PREVIEW', 'ADMIN', $1, $2::jsonb)
       RETURNING id, to_char((now() + make_interval(mins => $3::int)) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "expiresAt"`,
      admin.appUserId, JSON.stringify(binding), CUSTOMER_NOTICE_PREVIEW_TTL_MINUTES,
    );
    return {
      ok: true,
      approvalId: rows[0].id,
      kind: notice.kind,
      title: CUSTOMER_NOTICE_LABEL[notice.kind],
      recipientLabel: notice.recipientLabel,
      maskedRecipient: maskPhone(notice.phone),
      message: notice.body,
      expiresAt: rows[0].expiresAt,
    };
  } catch (error) {
    if (!(error instanceof NoticeProblem)) console.error("[customer-notice] 미리보기 준비 실패", error);
    return { ok: false, message: problemText(error, "미리보기를 준비하지 못했습니다. 잠시 후 다시 시도해 주세요.") };
  }
}

/** 2) 원장이 승인한 미리보기 1건만 보낸다. 재시도·예약 발송은 하지 않는다. */
export async function sendCustomerNotice(input: {
  approvalId: string;
  request: CustomerNoticeRequest;
  approved: boolean;
}): Promise<CustomerNoticeSendResult> {
  const admin = await requireAdmin();
  if (input?.approved !== true) return { ok: false, status: "HELD", message: "미리보기를 확인하고 «보내기»를 눌러 주세요." };

  let notice: ResolvedNotice;
  let binding: ReturnType<typeof bindingOf>;
  // 이번 발송 «자리 잡기» 기록 id — 공급자 호출 전에 실패하면 풀어 줘서 다시 보낼 수 있게 한다
  let claimId: string | null = null;
  try {
    const approvalId = idOf(input.approvalId);
    // 내가 만든, 아직 유효한 미리보기만 인정한다.
    const approvals = await prisma.$queryRawUnsafe<Array<{ detailsJson: Record<string, unknown> | null }>>(
      `SELECT "detailsJson" FROM "OperationsAuditLog"
        WHERE id = $1 AND action = 'CUSTOMER_NOTICE_PREVIEW' AND "actorUserId" = $2
          AND "createdAt" > now() - make_interval(mins => $3::int) LIMIT 1`,
      approvalId, admin.appUserId, CUSTOMER_NOTICE_PREVIEW_TTL_MINUTES,
    );
    const approved = approvals[0]?.detailsJson;
    if (!approved) throw new NoticeProblem("미리보기 시간이 지났습니다. 미리보기를 다시 열어 주세요.");
    // 보내기 직전에 받는 사람·문구를 다시 만든다 — 그새 번호·상태·설정이 바뀌면 멈춘다.
    notice = await resolveNotice(input.request);
    binding = bindingOf(notice);
    const same = (Object.keys(binding) as Array<keyof typeof binding>).every((key) => (approved[key] ?? null) === (binding[key] ?? null));
    if (!same) throw new NoticeProblem("받는 사람이나 문구가 미리보기 때와 달라졌습니다. 미리보기를 다시 열어 주세요.");

    // 같은 번호·같은 안내는 잠금을 걸고 한 번에 한 명만 검사·기록한다(두 번 눌러도 한 번만).
    const claimed = await prisma.$transaction(async (tx) => {
      await tx.$queryRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext($1))`, `customer-notice:${binding.kind}:${binding.phoneHash}`);
      const recent = await tx.$queryRawUnsafe<Array<{ reason: string }>>(
        `SELECT CASE WHEN "detailsJson"->>'approvalId' = $1 THEN 'SAME_APPROVAL'
                     WHEN $4::text IS NOT NULL AND "detailsJson"->>'onceKey' = $4 THEN 'ONCE'
                     ELSE 'WINDOW' END AS reason
           FROM "OperationsAuditLog"
          WHERE action = 'CUSTOMER_NOTICE_CLAIMED'
            AND ("detailsJson"->>'approvalId' = $1
                 OR ($4::text IS NOT NULL AND "detailsJson"->>'onceKey' = $4)
                 OR ("detailsJson"->>'kind' = $2 AND "detailsJson"->>'phoneHash' = $3
                     AND "createdAt" > now() - make_interval(mins => $5::int)))
          LIMIT 1`,
        approvalId, binding.kind, binding.phoneHash, binding.onceKey, CUSTOMER_NOTICE_DUPLICATE_WINDOW_MINUTES,
      );
      if (recent[0]) return recent[0].reason;
      const inserted = await tx.$queryRawUnsafe<Array<{ id: string }>>(
        `INSERT INTO "OperationsAuditLog" (id, action, "actorType", "actorUserId", "detailsJson")
         VALUES (gen_random_uuid()::text, 'CUSTOMER_NOTICE_CLAIMED', 'ADMIN', $1, $2::jsonb) RETURNING id`,
        admin.appUserId, JSON.stringify({ ...binding, approvalId }),
      );
      claimId = inserted[0]?.id ?? null;
      return "OK";
    });
    if (claimed === "SAME_APPROVAL") return { ok: false, status: "HELD", message: "이 미리보기는 이미 보냈습니다. 중복으로 보내지 않았습니다." };
    if (claimed === "ONCE") return { ok: false, status: "HELD", message: "이 결과 안내는 이미 보냈습니다. 발송 이력을 확인해 주세요." };
    if (claimed === "WINDOW") {
      return { ok: false, status: "HELD", message: `같은 번호로 ${CUSTOMER_NOTICE_DUPLICATE_WINDOW_MINUTES}분 안에 같은 안내를 이미 보냈습니다. 중복으로 보내지 않았습니다.` };
    }
  } catch (error) {
    if (!(error instanceof NoticeProblem)) console.error("[customer-notice] 발송 준비 실패", error);
    return { ok: false, status: "HELD", message: problemText(error, "발송을 준비하지 못했습니다. 문자는 보내지 않았습니다.") };
  }

  // 여기부터는 발송 장부에 남기며 보낸다(관리자 수동 문자와 같은 경로).
  const stableEventKey = `customer-notice:${input.approvalId}`;
  let deliveryId: string | null = null;
  let batchId: string | null = null;
  try {
    batchId = await reserveMessageDeliveryBatch({
      source: "MANUAL", stableEventKey, audienceScope: "EXTERNAL", trigger: "MANUAL_MESSAGE",
      actorUserId: admin.appUserId, actorName: admin.appUserName,
      purpose: CUSTOMER_NOTICE_LABEL[notice.kind], reason: "원장 미리보기 승인 후 1건 발송",
      body: notice.body, requestedChannel: "SMS",
    });
    if (!batchId) throw new Error("batch");
    const reserved = await reserveMessageDelivery({
      batchId, source: "MANUAL", stableEventKey, eventType: notice.kind, trigger: "MANUAL_MESSAGE",
      audienceScope: "EXTERNAL", recipientUserId: notice.recipientUserId, recipientPhone: notice.phone,
      body: notice.body, requestedChannel: "SMS",
    });
    deliveryId = reserved.deliveryId;
  } catch (error) {
    console.error("[customer-notice] 발송 장부 준비 실패", error);
    // 아직 공급자를 부르지 않았으니 자리 잡기를 풀어 둔다(접수 결과 «한 번만» 잠금이 영영 걸리지 않게)
    if (claimId) {
      await prisma.$executeRawUnsafe(
        `UPDATE "OperationsAuditLog" SET action = 'CUSTOMER_NOTICE_ABORTED' WHERE id = $1 AND action = 'CUSTOMER_NOTICE_CLAIMED'`, claimId,
      ).catch(() => undefined);
    }
    return { ok: false, status: "HELD", message: "발송 기록을 만들지 못해 문자를 보내지 않았습니다. 잠시 후 미리보기부터 다시 해 주세요." };
  }
  if (!deliveryId) return { ok: false, status: "HELD", message: "이미 처리된 발송입니다. 중복으로 보내지 않았습니다." };
  const claim = await claimMessageDelivery(deliveryId).catch(() => ({ claimed: false }));
  if (!claim.claimed) return { ok: false, status: "HELD", message: "이미 처리 중인 발송입니다. 중복으로 보내지 않았습니다." };

  const sent = await sendSmsDetailed(notice.phone, notice.body);
  let ledgerOk = true;
  try {
    await finalizeMessageDelivery({
      deliveryId, ok: sent.ok, provider: sent.provider, requestedChannel: "SMS", actualChannel: "SMS",
      messageType: sent.messageType || "SMS", providerGroupId: sent.groupId, providerMessageId: sent.messageId,
      providerStatus: sent.ok ? "ACCEPTED" : "FAILED", errorCode: sent.ok ? null : (sent.reason ?? "SMS_FAILED").slice(0, 500),
    });
    await finalizeMessageDeliveryBatch(batchId);
  } catch (error) {
    // ⚠️ 문자는 이미 공급자에게 넘어갔다. 장부 실패를 «발송 실패»로 알리면 다시 눌러 중복 발송된다.
    ledgerOk = false;
    console.error("[customer-notice] 장부 마무리 실패(발송 판정은 공급자 응답 기준)", error);
  }
  await prisma.$executeRawUnsafe(
    `INSERT INTO "OperationsAuditLog" (id, action, "actorType", "actorUserId", "detailsJson")
     VALUES (gen_random_uuid()::text, 'CUSTOMER_NOTICE_RESULT', 'ADMIN', $1, $2::jsonb)`,
    admin.appUserId, JSON.stringify({ approvalId: input.approvalId, kind: notice.kind, deliveryId, sent: sent.ok, ledgerOk }),
  ).catch(() => undefined);
  // 카카오 접수 이력에도 «결과 안내 문자 보냄/실패»를 남긴다(상태는 바꾸지 않는다)
  if (notice.intakeAudit) {
    await prisma.$executeRawUnsafe(
      `INSERT INTO "KakaoParentIntakeAudit" (id, "intakeId", action, "actorUserId", "fromStatus", "toStatus", note, "detailsJson")
       VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $4, NULL, $5::jsonb)`,
      notice.intakeAudit.intakeId, sent.ok ? "RESULT_NOTICE_SENT" : "RESULT_NOTICE_FAILED", admin.appUserId,
      notice.intakeAudit.status, JSON.stringify({ approvalId: input.approvalId, deliveryId, channel: "SMS", externalMessageSent: sent.ok }),
    ).catch(() => undefined);
  }

  if (sent.ok) {
    return { ok: true, status: "SENT", message: ledgerOk
      ? "문자를 보냈습니다. 실제 받았는지는 문자 발송 이력에서 확인할 수 있어요."
      : "문자를 보냈습니다. (발송 기록 저장만 실패했어요 — 다시 보내지 마세요)" };
  }
  return { ok: false, status: "FAILED", message: "문자 발송에 실패했습니다. 문자 발송 이력을 확인한 뒤, 필요하면 카카오채널로 직접 안내해 주세요." };
}
