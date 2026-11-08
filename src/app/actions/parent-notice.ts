"use server";

/**
 * 학부모 공지 «미리보기 → 원장 승인 → 대량 접수» 서버 동작(/admin/sms «수동 발송» 탭, 2026-11-09).
 *
 * 흐름은 «학부모 가입 안내»(customer-notice.ts)와 같다:
 *   1) prepareParentNotice = 받는 사람(재원생 학부모)·문구·채널을 서버가 계산해 보여 준다. 아직 안 보낸다.
 *   2) sendParentNotice    = 원장이 «보내기»를 누른 미리보기만, 보내기 직전에 다시 계산해 같을 때만 접수한다.
 * 실제 발송은 기존 대량 발송 큐(reserveManualMessageQueue → 매분 크론)라 발송 장부에 그대로 남는다.
 *
 * 채널
 *   - 카톡 틀(휴무·행사·월 안내): 템플릿 id(ALIMTALK_TPL_NOTICE_*)가 있으면 알림톡, 없으면 같은 본문을 문자로.
 *   - 자유 공지: 스위치(ALIMTALK_BMS_FREE_NOTICE=on)가 켜져 있으면 브랜드 메시지(광고성·08:00~20:50),
 *     꺼져 있으면 지금처럼 «[스티즈농구교실] 본문» 문자.
 *
 * 안전장치: 관리자만 · 화면은 번호를 보내지 않는다(받는 사람은 서버가 정한다) · 미리보기 10분 유효 ·
 * 같은 미리보기는 한 번만 · 같은 문구는 30분 안에 다시 접수 못 함 · 감사 기록에는 지문(해시)만.
 */

import { requireAdmin } from "@/lib/auth-guard";
import { prisma } from "@/lib/prisma";
import { notMergedStudent } from "@/lib/studentVisibility";
import { isAlimtalkConfigured } from "@/lib/message-channel-policy";
import { getSmsMessageType } from "@/lib/sms";
import {
  hashMessageBody,
  hashMessageRecipientPhone,
  reserveManualMessageQueue,
  type ManualQueueItem,
} from "@/lib/message-ledger";
import { BULK_MANUAL_MESSAGE_RECIPIENT_LIMIT } from "@/lib/manual-message-service";
import { alimtalkTemplateIdForEnv, isBrandFreeNoticeEnabled } from "@/lib/messaging/alimtalk-config";
import {
  DEFAULT_NOTICE_PATH,
  NOTICE_ALIMTALK_TEMPLATES,
  isNoticeAlimtalkKind,
} from "@/lib/messaging/parent-alimtalk-templates";
import {
  BMS_QUEUE_MARGIN_MINUTES,
  BMS_SEND_END_HM,
  BMS_SEND_START_HM,
  NOTICE_KIND_LABEL,
  brandMessageWindow,
  buildFreeNoticeBrandText,
  buildFreeNoticeSmsText,
  buildNoticeAlimtalkItems,
  isParentNoticeKind,
  normalizeNoticeFields,
  noticeContentKey,
  selectNoticeRecipients,
  BMS_NOT_DELIVERED_PREFIX,
  type ParentNoticeKind,
} from "@/lib/messaging/parent-notice";
import { maskPersonName, maskPhone } from "@/lib/customer-notice/templates";

const PREVIEW_TTL_MINUTES = 10;
const DUPLICATE_WINDOW_MINUTES = 30;
const PREVIEW_SAMPLE = 5;
/** 대량 발송 묶음 요청 id 앞머리(장부 stableEventKey = manual:bulk:<관리자>:<이 값>) */
const REQUEST_PREFIX = "parent-notice-";
/** 자유 공지 본문 한도 — 기존 수동 발송 입력칸과 같다 */
const FREE_MESSAGE_MAX = 1000;

export type ParentNoticeChannel = "ALIMTALK" | "BMS" | "SMS";

export type ParentNoticeInput = {
  kind: ParentNoticeKind;
  /** 카톡 틀의 변수 칸 값(학생명·학원전화는 서버가 채운다) */
  fields?: Record<string, string>;
  /** 자유 공지 본문 */
  message?: string;
  /** «공지 자세히 보기» 버튼이 열 공지(비우면 공지 목록) */
  noticeId?: string | null;
};

export type ParentNoticeOptions = {
  ok: true;
  /** 버튼으로 연결할 수 있는 공개 공지(최근 20건) */
  notices: Array<{ id: string; title: string }>;
  /** 카톡 틀별 알림톡 준비 여부(템플릿 id 있음) — 없으면 문자로 나간다 */
  alimtalkReady: Record<string, boolean>;
  /** 자유 공지가 브랜드 메시지로 나가는지(스위치 + 카카오 채널 설정) */
  brandMessageEnabled: boolean;
  /** 지금 브랜드 메시지를 접수할 수 있는 시간인지(KST) */
  brandWindowOpen: boolean;
  brandWindowLabel: string;
  /** 최근 3일 브랜드 메시지 공지 결과 — 카톡으로 못 받은 학부모를 정보성 문자로 다시 보낼지 고르는 곳 */
  brandResults: ParentNoticeBrandResult[];
};

export type ParentNoticeBrandResult = {
  batchId: string;
  /** 접수 시각(ISO) */
  createdAt: string;
  total: number;
  /** 카톡으로 못 받은 학부모(채널 친구 아님·카톡 미사용·마감 지남 등) */
  notDelivered: number;
  /** 아직 결과 확인 중 */
  pending: number;
  /** 이미 정보성 문자로 다시 보냈는지(한 묶음당 한 번만) */
  resent: boolean;
};

export type ParentNoticePreview = {
  ok: true;
  approvalId: string;
  title: string;
  channel: ParentNoticeChannel;
  channelNote: string;
  recipientCount: number;
  invalidPhoneCount: number;
  /** 학생 이름이 비어 빠진 번호 수 */
  noNameCount: number;
  /** 처음 몇 명 — 이름 가림 + 끝 4자리 */
  sample: string[];
  /** 첫 번째 받는 분의 문구(학생 이름은 가림) */
  message: string;
  messageType: "SMS" | "LMS" | "ALIMTALK" | "BMS";
  expiresAt: string;
};

export type ParentNoticeFailure = { ok: false; message: string };

export type ParentNoticeSendResult = { ok: boolean; status: "QUEUED" | "HELD"; message: string; batchId?: string };

class NoticeProblem extends Error {}

function problemText(error: unknown, fallback: string) {
  if (error instanceof NoticeProblem) return error.message;
  // 순수 모듈(입력 검사)이 던지는 문장은 사람이 읽도록 쓴 것이라 그대로 보여 준다
  if (error instanceof Error && /칸을|자 이내|써 주세요|쓸 수 없어요|줄바꿈/.test(error.message)) return error.message;
  return fallback;
}

/** 카카오(솔라피) 발송 설정이 다 있는지 — 알림톡과 같은 조건(키·발신번호·채널 id). 템플릿 자리에는 표시용 값을 넣는다 */
function kakaoChannelReady() {
  return isAlimtalkConfigured("BMS_FREE");
}

function brandWindowLabel() {
  return `${BMS_SEND_START_HM}~${BMS_SEND_END_HM}(마감 ${BMS_QUEUE_MARGIN_MINUTES}분 전 접수 마감)`;
}

async function academyPhone() {
  const rows = await prisma.$queryRawUnsafe<Array<{ contactPhone: string | null }>>(
    `SELECT "contactPhone" FROM "AcademySettings" WHERE id = 'singleton' LIMIT 1`,
  ).catch(() => [] as Array<{ contactPhone: string | null }>);
  return String(rows[0]?.contactPhone ?? "").trim();
}

/** 버튼이 열 공지 경로 — 공개(전체 대상) 공지만. 못 찾으면 공지 목록 */
async function noticePathOf(noticeId: string | null | undefined) {
  const id = typeof noticeId === "string" ? noticeId.trim() : "";
  if (!id) return DEFAULT_NOTICE_PATH;
  if (id.length > 100 || !/^[A-Za-z0-9_-]+$/.test(id)) throw new NoticeProblem("연결할 공지를 다시 골라 주세요.");
  const rows = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
    `SELECT id FROM "Notice" WHERE id = $1 AND "targetType" = 'ALL' LIMIT 1`, id,
  );
  if (!rows[0]) throw new NoticeProblem("연결할 공지를 찾지 못했습니다. 공개 공지만 연결할 수 있어요.");
  return `notices/${rows[0].id}`;
}

/** 화면 준비용: 공지 목록·채널 준비 상태 */
export async function getParentNoticeOptions(): Promise<ParentNoticeOptions | ParentNoticeFailure> {
  await requireAdmin();
  try {
    const notices = await prisma.$queryRawUnsafe<Array<{ id: string; title: string }>>(
      `SELECT id, title FROM "Notice" WHERE "targetType" = 'ALL' ORDER BY "isPinned" DESC, "createdAt" DESC LIMIT 20`,
    );
    const alimtalkReady: Record<string, boolean> = {};
    for (const [kind, spec] of Object.entries(NOTICE_ALIMTALK_TEMPLATES)) {
      alimtalkReady[kind] = isAlimtalkConfigured(alimtalkTemplateIdForEnv(spec.envKey));
    }
    return {
      ok: true,
      notices: notices.map((row) => ({ id: row.id, title: row.title })),
      alimtalkReady,
      brandMessageEnabled: isBrandFreeNoticeEnabled() && kakaoChannelReady(),
      brandWindowOpen: brandMessageWindow(Date.now(), BMS_QUEUE_MARGIN_MINUTES).open,
      brandWindowLabel: brandWindowLabel(),
      // 결과 조회가 실패해도 공지 보내기 화면은 열린다
      brandResults: await loadBrandResults(null).catch((error: unknown) => {
        console.error("[parent-notice] 브랜드 메시지 결과 조회 실패", error);
        return [] as ParentNoticeBrandResult[];
      }),
    };
  } catch (error) {
    console.error("[parent-notice] 화면 준비 실패", error);
    return { ok: false, message: "공지 보내기 화면을 준비하지 못했습니다. 잠시 후 다시 시도해 주세요." };
  }
}

/** 받는 사람·문구·채널을 서버에서 직접 계산한다. 미리보기와 보내기 직전에 두 번 똑같이 부른다. */
async function resolveParentNotice(input: ParentNoticeInput) {
  if (!input || !isParentNoticeKind(input.kind)) throw new NoticeProblem("보낼 공지 종류를 다시 골라 주세요.");
  const kind = input.kind;

  // 재원생(수강 ACTIVE·병합 안 된 학생)의 대표 학부모. 탈퇴 계정은 뺀다. 학생 한 명당 한 줄.
  const rows = await prisma.$queryRawUnsafe<Array<{ studentName: string; phone: string | null }>>(
    `SELECT DISTINCT ON (s.id) s.name AS "studentName", u.phone
       FROM "Enrollment" e
       JOIN "Student" s ON s.id = e."studentId" AND ${notMergedStudent("s")}
       JOIN "User" u ON u.id = s."parentId" AND u."withdrawnAt" IS NULL
      WHERE e.status = 'ACTIVE'
      ORDER BY s.id`,
  );
  const { recipients, invalidPhoneCount, noNameCount } = selectNoticeRecipients(rows);
  if (recipients.length === 0) throw new NoticeProblem("보낼 학부모가 없습니다. (재원생 학부모 휴대폰 번호를 확인해 주세요)");
  if (recipients.length > BULK_MANUAL_MESSAGE_RECIPIENT_LIMIT) {
    throw new NoticeProblem(`한 번에 ${BULK_MANUAL_MESSAGE_RECIPIENT_LIMIT}명까지만 보낼 수 있습니다.`);
  }

  let channel: ParentNoticeChannel;
  let commonBody: string;
  let items: ManualQueueItem[] | undefined;
  let channelNote: string;
  let previewBody: string;
  let fieldsForBinding: Record<string, string> | null = null;
  const noticePath = await noticePathOf(input.noticeId);

  if (kind === "FREE") {
    const message = typeof input.message === "string" ? input.message.trim() : "";
    if (!message) throw new NoticeProblem("보낼 내용을 입력해 주세요.");
    if ([...message].length > FREE_MESSAGE_MAX) throw new NoticeProblem(`내용은 ${FREE_MESSAGE_MAX}자 이내로 써 주세요.`);
    if (isBrandFreeNoticeEnabled() && kakaoChannelReady()) {
      // 브랜드 메시지 = 광고성. 밤(20:50~08:00)에는 접수하지 않는다 — 크론이 늦게 돌아도 마감 뒤에는 안 나가게 마감 시각을 같이 싣는다
      const window = brandMessageWindow(Date.now(), BMS_QUEUE_MARGIN_MINUTES);
      if (!window.open) {
        throw new NoticeProblem(`브랜드 메시지(광고성)는 ${brandWindowLabel()}에만 보낼 수 있어요. 지금(${window.nowHm})은 보낼 수 없습니다. 내일 ${BMS_SEND_START_HM} 이후 다시 보내 주세요.`);
      }
      channel = "BMS";
      commonBody = buildFreeNoticeBrandText(message);
      const notAfter = new Date(window.endMs).toISOString();
      items = recipients.map((item) => ({ recipient: item.phone, body: commonBody, kakao: { kind: "BMS_FREE", notAfter } }));
      // 문자 대체 없음(검수 (나)안) — 못 받은 분은 결과 화면에서 원장이 정보성 문자로 다시 보낼지 고른다
      channelNote = "카카오 브랜드 메시지(채널 친구에게만 카톡 · 광고 표시 포함 · 문자로 자동 대체하지 않음)";
    } else {
      // 지금처럼 문자 — 모두 같은 본문이라 기존 묶음 발송 그대로(items 없음)
      channel = "SMS";
      commonBody = buildFreeNoticeSmsText(message);
      channelNote = "문자(브랜드 메시지 스위치가 꺼져 있어요)";
    }
    previewBody = commonBody;
    fieldsForBinding = { message };
  } else if (isNoticeAlimtalkKind(kind)) {
    const fields = normalizeNoticeFields(kind, input.fields);
    fieldsForBinding = fields;
    const built = buildNoticeAlimtalkItems(kind, fields, recipients, { academyPhone: await academyPhone(), noticePath });
    const templateId = alimtalkTemplateIdForEnv(NOTICE_ALIMTALK_TEMPLATES[kind].envKey);
    const ready = isAlimtalkConfigured(templateId);
    for (const item of built) {
      if ([...item.body].length > 1000) throw new NoticeProblem("알림톡 본문은 1,000자 이내여야 합니다. 내용을 줄여 주세요.");
      if (Buffer.byteLength(item.smsBody, "utf8") > 3000) throw new NoticeProblem("문자로 보내기에는 내용이 너무 깁니다. 내용을 줄여 주세요.");
    }
    channel = ready ? "ALIMTALK" : "SMS";
    items = built.map((item) => ready
      ? {
        recipient: item.phone,
        body: item.body,
        kakao: {
          kind: "ALIMTALK",
          templateId,
          variables: item.variables,
          buttons: [item.button],
          smsBody: item.smsBody,
        },
      }
      : { recipient: item.phone, body: item.smsBody });
    // 묶음 지문용 대표 본문: 틀 원문만 쓰면 다른 공지도 같은 지문이 되므로 입력값·버튼 경로를 붙인다
    commonBody = `${NOTICE_ALIMTALK_TEMPLATES[kind].body}\n\n${noticeContentKey(kind, fields, noticePath)}`;
    channelNote = ready
      ? "카카오 알림톡(실패하면 같은 내용을 문자로)"
      : "문자(알림톡 템플릿 id 가 아직 없어요 — 같은 내용을 문자로 보냅니다)";
    // 미리보기: 첫 번째 받는 분의 문구, 학생 이름은 가린다
    const first = built[0];
    const firstNames = recipients[0].studentNames.join("·");
    const masked = recipients[0].studentNames.map(maskPersonName).join("·");
    previewBody = (ready ? first.body : first.smsBody).split(firstNames).join(masked);
  } else {
    throw new NoticeProblem("지원하지 않는 공지입니다. 새로고침해 주세요.");
  }

  const bodies = items ? items.map((item) => item.body) : [commonBody];
  // 30분 중복 차단 지문 — 종류 + 입력값 + 버튼 경로(받는 사람이 바뀌어도 같은 공지면 같은 값)
  const contentHash = hashMessageBody(noticeContentKey(kind, fieldsForBinding ?? {}, noticePath));
  const binding = {
    kind: "PARENT_NOTICE" as const,
    noticeKind: kind,
    channel,
    noticePath,
    recipientCount: recipients.length,
    // 받는 번호 묶음·문구 묶음의 지문 — 미리보기 뒤에 한 명·한 글자라도 바뀌면 보내기를 멈춘다
    recipientSetHash: hashMessageBody(recipients.map((item) => hashMessageRecipientPhone(item.phone)).join(",")),
    bodyHash: hashMessageBody(bodies.join("\u0000")),
    contentHash,
  };
  return { kind, channel, channelNote, recipients, invalidPhoneCount, noNameCount, commonBody, items, previewBody, binding, fieldsForBinding };
}

/** 1) 미리보기만 만든다. 이 단계에서는 절대 보내지 않는다. */
export async function prepareParentNotice(input: ParentNoticeInput): Promise<ParentNoticePreview | ParentNoticeFailure> {
  const admin = await requireAdmin();
  try {
    const notice = await resolveParentNotice(input);
    // 보내기 때 같은 입력으로 다시 계산하도록 입력값을 승인 기록에 같이 둔다(공지 문구라 개인정보 아님)
    const rows = await prisma.$queryRawUnsafe<Array<{ id: string; expiresAt: string }>>(
      `INSERT INTO "OperationsAuditLog" (id, action, "actorType", "actorUserId", "detailsJson")
       VALUES (gen_random_uuid()::text, 'PARENT_NOTICE_PREVIEW', 'ADMIN', $1, $2::jsonb)
       RETURNING id, to_char((now() + make_interval(mins => $3::int)) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "expiresAt"`,
      admin.appUserId,
      JSON.stringify({ ...notice.binding, input: { kind: notice.kind, fields: notice.fieldsForBinding, noticeId: input.noticeId ?? null } }),
      PREVIEW_TTL_MINUTES,
    );
    return {
      ok: true,
      approvalId: rows[0].id,
      title: NOTICE_KIND_LABEL[notice.kind],
      channel: notice.channel,
      channelNote: notice.channelNote,
      recipientCount: notice.recipients.length,
      invalidPhoneCount: notice.invalidPhoneCount,
      noNameCount: notice.noNameCount,
      sample: notice.recipients.slice(0, PREVIEW_SAMPLE).map((item) => `${item.studentNames.map(maskPersonName).join("·")} 학생 학부모 · ${maskPhone(item.phone)}`),
      message: notice.previewBody,
      messageType: notice.channel === "ALIMTALK" ? "ALIMTALK" : notice.channel === "BMS" ? "BMS" : getSmsMessageType(notice.previewBody),
      expiresAt: rows[0].expiresAt,
    };
  } catch (error) {
    if (!(error instanceof NoticeProblem)) console.error("[parent-notice] 미리보기 실패", error);
    return { ok: false, message: problemText(error, "미리보기를 준비하지 못했습니다. 잠시 후 다시 시도해 주세요.") };
  }
}

/** 2) 원장이 승인한 미리보기 그대로 대량 발송 큐에 접수한다(실제 발송은 매분 크론). */
export async function sendParentNotice(input: { approvalId: string; approved: boolean }): Promise<ParentNoticeSendResult> {
  const admin = await requireAdmin();
  if (input?.approved !== true) return { ok: false, status: "HELD", message: "미리보기를 확인하고 «보내기»를 눌러 주세요." };

  let claimId: string | null = null;
  let notice: Awaited<ReturnType<typeof resolveParentNotice>>;
  let approvalId: string;
  try {
    approvalId = typeof input.approvalId === "string" ? input.approvalId.trim() : "";
    if (!approvalId || approvalId.length > 100) throw new NoticeProblem("미리보기를 다시 열어 주세요.");
    // 내가 만든, 아직 유효한 공지 미리보기만 인정한다
    const approvals = await prisma.$queryRawUnsafe<Array<{ detailsJson: Record<string, unknown> | null }>>(
      `SELECT "detailsJson" FROM "OperationsAuditLog"
        WHERE id = $1 AND action = 'PARENT_NOTICE_PREVIEW' AND "actorUserId" = $2
          AND "createdAt" > now() - make_interval(mins => $3::int) LIMIT 1`,
      approvalId, admin.appUserId, PREVIEW_TTL_MINUTES,
    );
    const approved = approvals[0]?.detailsJson;
    if (!approved) throw new NoticeProblem("미리보기 시간이 지났습니다. 미리보기를 다시 열어 주세요.");
    const saved = (approved.input ?? {}) as { kind?: ParentNoticeKind; fields?: Record<string, string> | null; noticeId?: string | null };
    const savedKind = saved.kind as ParentNoticeKind;
    // 보내기 직전에 받는 사람·문구·채널을 다시 계산한다 — 그새 학생·번호·설정이 바뀌면 멈춘다
    notice = await resolveParentNotice({
      kind: savedKind,
      fields: savedKind === "FREE" ? undefined : saved.fields ?? undefined,
      message: savedKind === "FREE" ? saved.fields?.message : undefined,
      noticeId: saved.noticeId ?? null,
    });
    const binding = notice.binding;
    const same = (Object.keys(binding) as Array<keyof typeof binding>).every((key) => (approved[key] ?? null) === (binding[key] ?? null));
    if (!same) throw new NoticeProblem("받는 사람이나 문구·보내는 방법이 미리보기 때와 달라졌습니다. 미리보기를 다시 열어 주세요.");

    // 잠금을 걸고 «이 미리보기로 이미 보냈나 / 30분 안에 같은 공지를 접수했나»를 본다(두 번 눌러도, 두 사람이 눌러도 한 번만)
    const claimed = await prisma.$transaction(async (tx) => {
      await tx.$queryRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext($1))`, "parent-notice");
      const recent = await tx.$queryRawUnsafe<Array<{ reason: string }>>(
        `SELECT CASE WHEN "detailsJson"->>'approvalId' = $1 THEN 'SAME_APPROVAL' ELSE 'WINDOW' END AS reason
           FROM "OperationsAuditLog"
          WHERE action = 'PARENT_NOTICE_CLAIMED'
            AND ("detailsJson"->>'approvalId' = $1
                 OR ("detailsJson"->>'contentHash' = $2 AND "createdAt" > now() - make_interval(mins => $3::int)))
          ORDER BY ("detailsJson"->>'approvalId' = $1) DESC
          LIMIT 1`,
        approvalId, binding.contentHash, DUPLICATE_WINDOW_MINUTES,
      );
      if (recent[0]) return recent[0].reason;
      const inserted = await tx.$queryRawUnsafe<Array<{ id: string }>>(
        `INSERT INTO "OperationsAuditLog" (id, action, "actorType", "actorUserId", "detailsJson")
         VALUES (gen_random_uuid()::text, 'PARENT_NOTICE_CLAIMED', 'ADMIN', $1, $2::jsonb) RETURNING id`,
        admin.appUserId, JSON.stringify({ ...binding, approvalId }),
      );
      claimId = inserted[0]?.id ?? null;
      return "OK";
    });
    if (claimed === "SAME_APPROVAL") return { ok: false, status: "HELD", message: "이 미리보기는 이미 접수했습니다. 중복으로 보내지 않았습니다." };
    if (claimed === "WINDOW") {
      return { ok: false, status: "HELD", message: `${DUPLICATE_WINDOW_MINUTES}분 안에 같은 공지를 이미 접수했습니다. 발송 이력을 먼저 확인해 주세요.` };
    }
  } catch (error) {
    if (!(error instanceof NoticeProblem)) console.error("[parent-notice] 접수 준비 실패", error);
    return { ok: false, status: "HELD", message: problemText(error, "발송을 준비하지 못했습니다. 공지는 보내지 않았습니다.") };
  }

  try {
    const queued = await reserveManualMessageQueue({
      requestId: `${REQUEST_PREFIX}${approvalId}`,
      actorUserId: admin.appUserId,
      actorName: admin.appUserName,
      purpose: `학부모 공지 · ${NOTICE_KIND_LABEL[notice.kind]}`,
      reason: "원장 미리보기 승인 후 재원생 학부모에게 대량 접수",
      audienceScope: "EXTERNAL",
      body: notice.commonBody,
      recipients: notice.recipients.map((item) => item.phone),
      ...(notice.items ? { items: notice.items } : {}),
      requestedChannel: notice.channel,
    });
    await prisma.$executeRawUnsafe(
      `INSERT INTO "OperationsAuditLog" (id, action, "actorType", "actorUserId", "detailsJson")
       VALUES (gen_random_uuid()::text, 'PARENT_NOTICE_RESULT', 'ADMIN', $1, $2::jsonb)`,
      admin.appUserId, JSON.stringify({ approvalId, kind: "PARENT_NOTICE", channel: notice.channel, batchId: queued.batchId, queued: notice.recipients.length }),
    ).catch(() => undefined);
    return {
      ok: true,
      status: "QUEUED",
      batchId: queued.batchId,
      message: `${notice.recipients.length}명에게 보내도록 접수했습니다. 1~2분 안에 차례로 나가고, 결과는 «발송 이력» 탭에서 볼 수 있어요.`,
    };
  } catch (error) {
    console.error("[parent-notice] 큐 접수 실패", error);
    // 큐에 못 넣었으니(아무것도 안 나감) 자리 잡기를 풀어 바로 다시 시도할 수 있게 한다
    if (claimId) {
      await prisma.$executeRawUnsafe(
        `UPDATE "OperationsAuditLog" SET action = 'PARENT_NOTICE_ABORTED' WHERE id = $1 AND action = 'PARENT_NOTICE_CLAIMED'`, claimId,
      ).catch(() => undefined);
    }
    return { ok: false, status: "HELD", message: "발송 접수를 하지 못해 공지를 보내지 않았습니다. 잠시 후 미리보기부터 다시 해 주세요." };
  }
}

// ═════════════════════ 브랜드 메시지를 못 받은 학부모 → 정보성 문자로 다시 보내기(검수 (나)안) ═════════════════════
//
// 브랜드 메시지는 광고성이라 문자 대체를 끄고 보낸다(수신 동의 없는 광고 문자 0건). 채널 친구가 아니거나 카톡을 안 써서
// 못 받은 학부모는 장부에 «실패(BMS_NOT_DELIVERED:…)»로 남는다. 원장이 원하면 같은 내용을 «광고 표시 없는 일반 문자»
// («[스티즈농구교실] 내용», 기존 수동 문자와 같은 모양)로 다시 보낸다 — 별도 미리보기·승인, 기존 대량 문자 큐 그대로.
// 한 묶음당 한 번만, 묶음의 결과 확인이 다 끝난 뒤에만(확인 중인 사람이 나중에 실패로 바뀌어 빠지지 않게).

const RESEND_REQUEST_PREFIX = "parent-notice-resend-";
const BRAND_RESULT_DAYS = 3;
/** 묶음 장부 열쇠 `manual:bulk:<관리자>:parent-notice-<미리보기 id>` 에서 미리보기 id 를 꺼낸다 */
function approvalIdOfBatchKey(stableEventKey: string) {
  const marker = `:${REQUEST_PREFIX}`;
  const index = stableEventKey.lastIndexOf(marker);
  return index >= 0 ? stableEventKey.slice(index + marker.length) : "";
}

/** 최근 브랜드 메시지 공지 묶음의 결과(batchId 를 주면 그 묶음만) */
async function loadBrandResults(batchId: string | null): Promise<ParentNoticeBrandResult[]> {
  const rows = await prisma.$queryRawUnsafe<Array<{
    batchId: string; createdAt: Date; total: number; notDelivered: number; pending: number; resent: boolean;
  }>>(
    `SELECT b.id AS "batchId", b."createdAt",
            COUNT(d.id)::int AS total,
            (COUNT(d.id) FILTER (WHERE d.status = 'FAILED' AND d."errorCode" LIKE $1))::int AS "notDelivered",
            (COUNT(d.id) FILTER (WHERE d.status IN ('PENDING', 'SENDING')))::int AS pending,
            EXISTS (SELECT 1 FROM "OperationsAuditLog" a
                     WHERE a.action = 'PARENT_NOTICE_RESEND_CLAIMED' AND a."detailsJson"->>'sourceBatchId' = b.id) AS resent
       FROM "MessageDeliveryBatch" b
       JOIN "NotificationDelivery" d ON d."batchId" = b.id
      WHERE b.source = 'MANUAL' AND b."requestedChannel" = 'BMS'
        AND b."stableEventKey" LIKE $2
        AND b."createdAt" > now() - make_interval(days => $3::int)
        AND ($4::text IS NULL OR b.id = $4)
      GROUP BY b.id
      ORDER BY b."createdAt" DESC
      LIMIT 5`,
    `${BMS_NOT_DELIVERED_PREFIX}%`, `manual:bulk:%:${REQUEST_PREFIX}%`, BRAND_RESULT_DAYS, batchId,
  );
  return rows.map((row) => ({
    batchId: row.batchId,
    createdAt: new Date(row.createdAt).toISOString(),
    total: Number(row.total),
    notDelivered: Number(row.notDelivered),
    pending: Number(row.pending),
    resent: row.resent === true,
  }));
}

export type ParentNoticeResendPreview = {
  ok: true;
  approvalId: string;
  sourceBatchId: string;
  recipientCount: number;
  /** 못 받은 건 중 지금 재원생 학부모 번호와 맞지 않아 빠진 수(퇴원·번호 변경) */
  droppedCount: number;
  sample: string[];
  message: string;
  messageType: "SMS" | "LMS";
  expiresAt: string;
};

/** 다시 보낼 받는 사람·문구를 서버에서 계산한다(미리보기·보내기 직전 두 번) */
async function resolveResend(sourceBatchId: string) {
  const id = typeof sourceBatchId === "string" ? sourceBatchId.trim() : "";
  if (!id || id.length > 100) throw new NoticeProblem("다시 보낼 공지를 다시 골라 주세요.");
  const [result] = await loadBrandResults(id);
  if (!result) throw new NoticeProblem(`최근 ${BRAND_RESULT_DAYS}일 안의 브랜드 메시지 공지만 다시 보낼 수 있어요.`);
  if (result.resent) throw new NoticeProblem("이 공지는 이미 정보성 문자로 다시 보냈습니다.");
  if (result.pending > 0) throw new NoticeProblem(`아직 결과를 확인 중인 학부모가 ${result.pending}명 있어요. 잠시 뒤 다시 확인해 주세요.`);
  if (result.notDelivered === 0) throw new NoticeProblem("카톡으로 못 받은 학부모가 없습니다.");

  // 원래 공지 내용 = 그 묶음을 만든 미리보기의 입력값(자유 공지 본문)
  const batches = await prisma.$queryRawUnsafe<Array<{ stableEventKey: string }>>(
    `SELECT "stableEventKey" FROM "MessageDeliveryBatch" WHERE id = $1 LIMIT 1`, id,
  );
  const approvalId = approvalIdOfBatchKey(batches[0]?.stableEventKey ?? "");
  const previews = await prisma.$queryRawUnsafe<Array<{ message: string | null }>>(
    `SELECT "detailsJson"->'input'->'fields'->>'message' AS message FROM "OperationsAuditLog"
      WHERE id = $1 AND action = 'PARENT_NOTICE_PREVIEW' AND "detailsJson"->>'channel' = 'BMS' LIMIT 1`,
    approvalId,
  );
  const message = String(previews[0]?.message ?? "").trim();
  if (!message) throw new NoticeProblem("원래 공지 내용을 찾지 못했습니다. «자유 공지»로 새로 보내 주세요.");
  // 광고 표시 없는 일반 문자 — 기존 수동 문자와 같은 «[스티즈농구교실] 내용»
  const body = buildFreeNoticeSmsText(message);

  // 못 받은 번호는 장부에 지문(HMAC)만 있다 → 지금 재원생 학부모 번호의 지문과 맞춰 찾는다
  const failed = await prisma.$queryRawUnsafe<Array<{ phoneHash: string }>>(
    `SELECT DISTINCT "recipientPhoneHash" AS "phoneHash" FROM "NotificationDelivery"
      WHERE "batchId" = $1 AND status = 'FAILED' AND "errorCode" LIKE $2 AND "recipientPhoneHash" IS NOT NULL`,
    id, `${BMS_NOT_DELIVERED_PREFIX}%`,
  );
  const failedHashes = new Set(failed.map((row) => row.phoneHash));
  const rows = await prisma.$queryRawUnsafe<Array<{ studentName: string; phone: string | null }>>(
    `SELECT DISTINCT ON (s.id) s.name AS "studentName", u.phone
       FROM "Enrollment" e
       JOIN "Student" s ON s.id = e."studentId" AND ${notMergedStudent("s")}
       JOIN "User" u ON u.id = s."parentId" AND u."withdrawnAt" IS NULL
      WHERE e.status = 'ACTIVE'
      ORDER BY s.id`,
  );
  const recipients = selectNoticeRecipients(rows).recipients
    .filter((item) => failedHashes.has(hashMessageRecipientPhone(item.phone)));
  const binding = {
    kind: "PARENT_NOTICE_SMS_RESEND" as const,
    sourceBatchId: id,
    recipientCount: recipients.length,
    recipientSetHash: hashMessageBody(recipients.map((item) => hashMessageRecipientPhone(item.phone)).join(",")),
    bodyHash: hashMessageBody(body),
    channel: "SMS",
  };
  return { sourceBatchId: id, recipients, droppedCount: Math.max(0, failedHashes.size - recipients.length), body, binding };
}

/** 정보성 문자 다시 보내기 — 1) 미리보기(아직 안 보냄) */
export async function prepareParentNoticeSmsResend(input: { batchId: string }): Promise<ParentNoticeResendPreview | ParentNoticeFailure> {
  const admin = await requireAdmin();
  try {
    const resend = await resolveResend(input?.batchId);
    if (resend.recipients.length === 0) throw new NoticeProblem("다시 보낼 학부모가 없습니다. (못 받은 분이 퇴원했거나 번호가 바뀌었어요)");
    const rows = await prisma.$queryRawUnsafe<Array<{ id: string; expiresAt: string }>>(
      `INSERT INTO "OperationsAuditLog" (id, action, "actorType", "actorUserId", "detailsJson")
       VALUES (gen_random_uuid()::text, 'PARENT_NOTICE_RESEND_PREVIEW', 'ADMIN', $1, $2::jsonb)
       RETURNING id, to_char((now() + make_interval(mins => $3::int)) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "expiresAt"`,
      admin.appUserId, JSON.stringify(resend.binding), PREVIEW_TTL_MINUTES,
    );
    return {
      ok: true,
      approvalId: rows[0].id,
      sourceBatchId: resend.sourceBatchId,
      recipientCount: resend.recipients.length,
      droppedCount: resend.droppedCount,
      sample: resend.recipients.slice(0, PREVIEW_SAMPLE).map((item) => `${item.studentNames.map(maskPersonName).join("·")} 학생 학부모 · ${maskPhone(item.phone)}`),
      message: resend.body,
      messageType: getSmsMessageType(resend.body),
      expiresAt: rows[0].expiresAt,
    };
  } catch (error) {
    if (!(error instanceof NoticeProblem)) console.error("[parent-notice] 문자 다시 보내기 미리보기 실패", error);
    return { ok: false, message: problemText(error, "미리보기를 준비하지 못했습니다. 잠시 후 다시 시도해 주세요.") };
  }
}

/** 정보성 문자 다시 보내기 — 2) 원장이 승인한 미리보기 그대로 대량 문자 큐에 접수 */
export async function sendParentNoticeSmsResend(input: { approvalId: string; approved: boolean }): Promise<ParentNoticeSendResult> {
  const admin = await requireAdmin();
  if (input?.approved !== true) return { ok: false, status: "HELD", message: "미리보기를 확인하고 «보내기»를 눌러 주세요." };
  let claimId: string | null = null;
  let resend: Awaited<ReturnType<typeof resolveResend>>;
  let approvalId: string;
  try {
    approvalId = typeof input.approvalId === "string" ? input.approvalId.trim() : "";
    if (!approvalId || approvalId.length > 100) throw new NoticeProblem("미리보기를 다시 열어 주세요.");
    const approvals = await prisma.$queryRawUnsafe<Array<{ detailsJson: Record<string, unknown> | null }>>(
      `SELECT "detailsJson" FROM "OperationsAuditLog"
        WHERE id = $1 AND action = 'PARENT_NOTICE_RESEND_PREVIEW' AND "actorUserId" = $2
          AND "createdAt" > now() - make_interval(mins => $3::int) LIMIT 1`,
      approvalId, admin.appUserId, PREVIEW_TTL_MINUTES,
    );
    const approved = approvals[0]?.detailsJson;
    if (!approved) throw new NoticeProblem("미리보기 시간이 지났습니다. 미리보기를 다시 열어 주세요.");
    resend = await resolveResend(String(approved.sourceBatchId ?? ""));
    const binding = resend.binding;
    const same = (Object.keys(binding) as Array<keyof typeof binding>).every((key) => (approved[key] ?? null) === (binding[key] ?? null));
    if (!same || resend.recipients.length === 0) throw new NoticeProblem("받는 사람이나 문구가 미리보기 때와 달라졌습니다. 미리보기를 다시 열어 주세요.");
    // 한 묶음당 한 번만 — 잠금을 걸고 같은 원래 묶음으로 이미 접수했는지 본다
    const claimed = await prisma.$transaction(async (tx) => {
      await tx.$queryRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext($1))`, "parent-notice-resend");
      const recent = await tx.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT id FROM "OperationsAuditLog"
          WHERE action = 'PARENT_NOTICE_RESEND_CLAIMED'
            AND ("detailsJson"->>'approvalId' = $1 OR "detailsJson"->>'sourceBatchId' = $2) LIMIT 1`,
        approvalId, binding.sourceBatchId,
      );
      if (recent[0]) return "DONE";
      const inserted = await tx.$queryRawUnsafe<Array<{ id: string }>>(
        `INSERT INTO "OperationsAuditLog" (id, action, "actorType", "actorUserId", "detailsJson")
         VALUES (gen_random_uuid()::text, 'PARENT_NOTICE_RESEND_CLAIMED', 'ADMIN', $1, $2::jsonb) RETURNING id`,
        admin.appUserId, JSON.stringify({ ...binding, approvalId }),
      );
      claimId = inserted[0]?.id ?? null;
      return "OK";
    });
    if (claimed === "DONE") return { ok: false, status: "HELD", message: "이 공지는 이미 정보성 문자로 다시 보냈습니다. 중복으로 보내지 않았습니다." };
  } catch (error) {
    if (!(error instanceof NoticeProblem)) console.error("[parent-notice] 문자 다시 보내기 준비 실패", error);
    return { ok: false, status: "HELD", message: problemText(error, "발송을 준비하지 못했습니다. 문자는 보내지 않았습니다.") };
  }

  try {
    // 기존 수동 대량 문자 큐 그대로(모두 같은 본문 = items 없음)
    const queued = await reserveManualMessageQueue({
      requestId: `${RESEND_REQUEST_PREFIX}${approvalId}`,
      actorUserId: admin.appUserId,
      actorName: admin.appUserName,
      purpose: "학부모 공지 · 카톡 못 받은 분께 정보성 문자",
      reason: "브랜드 메시지를 받지 못한 재원생 학부모에게 원장 승인 후 광고 표시 없는 문자로 재발송",
      audienceScope: "EXTERNAL",
      body: resend.body,
      recipients: resend.recipients.map((item) => item.phone),
    });
    return {
      ok: true,
      status: "QUEUED",
      batchId: queued.batchId,
      message: `${resend.recipients.length}명에게 문자로 보내도록 접수했습니다. 결과는 «발송 이력» 탭에서 볼 수 있어요.`,
    };
  } catch (error) {
    console.error("[parent-notice] 문자 다시 보내기 큐 접수 실패", error);
    if (claimId) {
      await prisma.$executeRawUnsafe(
        `UPDATE "OperationsAuditLog" SET action = 'PARENT_NOTICE_RESEND_ABORTED' WHERE id = $1 AND action = 'PARENT_NOTICE_RESEND_CLAIMED'`, claimId,
      ).catch(() => undefined);
    }
    return { ok: false, status: "HELD", message: "발송 접수를 하지 못해 문자를 보내지 않았습니다. 잠시 후 미리보기부터 다시 해 주세요." };
  }
}

/** 화면 «결과 다시 확인» — 최근 브랜드 메시지 공지 결과만 다시 읽는다 */
export async function getParentNoticeBrandResults(): Promise<{ ok: true; brandResults: ParentNoticeBrandResult[] } | ParentNoticeFailure> {
  await requireAdmin();
  try {
    return { ok: true, brandResults: await loadBrandResults(null) };
  } catch (error) {
    console.error("[parent-notice] 브랜드 메시지 결과 조회 실패", error);
    return { ok: false, message: "결과를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요." };
  }
}
