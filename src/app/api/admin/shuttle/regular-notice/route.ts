import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth-guard";
import { prisma } from "@/lib/prisma";
import { sendTrackedSms } from "@/lib/notification";
import { hashMessageBody, normalizeMessagePhone } from "@/lib/message-ledger";
import { diffRegularShuttleMonths, regularShuttleChangeMessage } from "@/lib/regular/regularShuttleDiff";
import { isServiceMonth } from "@/lib/regular/serviceMonth";
import { getRegularShuttleStops } from "@/lib/shuttle/regularImport";

export const dynamic = "force-dynamic";

const ACTIONS = new Set(["PREPARE", "APPROVE", "SEND"] as const);
type NoticeAction = "PREPARE" | "APPROVE" | "SEND";
type NoticeBody = { action?: string; serviceMonth?: string; compareMonth?: string; change?: { key?: string }; payloadHash?: string };

async function canonicalPayload(body: NoticeBody) {
  const serviceMonth = body.serviceMonth?.trim();
  const compareMonth = body.compareMonth?.trim();
  const changeKey = body.change?.key?.trim();
  if (!isServiceMonth(serviceMonth) || !isServiceMonth(compareMonth) || compareMonth >= serviceMonth) {
    throw new Error("확인 월과 이전 비교 월을 다시 선택해 주세요.");
  }
  if (!changeKey?.startsWith("student:")) throw new Error("학생 식별값이 확정된 차량 변동만 안내할 수 있습니다.");

  const [before, after] = await Promise.all([getRegularShuttleStops(compareMonth), getRegularShuttleStops(serviceMonth)]);
  if (before.serviceMonth !== compareMonth || after.serviceMonth !== serviceMonth) throw new Error("비교할 월별 차량표를 찾지 못했습니다.");
  const change = diffRegularShuttleMonths(before.stops, after.stops).find((item) => item.key === changeKey);
  if (!change || change.kind === "REMOVED" || !change.after) throw new Error("현재 차량표에서 발송 가능한 변동을 찾지 못했습니다.");
  const recipientPhone = normalizeMessagePhone(change.parentPhone ?? "");
  if (recipientPhone.length < 10 || recipientPhone.length > 11) throw new Error("현재 차량표의 학부모 연락처를 확인해 주세요.");
  const messageBody = regularShuttleChangeMessage(change, serviceMonth);
  if (!messageBody) throw new Error("현재 차량표에서 문자 본문을 만들 수 없습니다.");
  const studentId = changeKey.slice("student:".length);
  const stableEventKey = `regular-shuttle:${compareMonth}:${serviceMonth}:${changeKey}`;
  const payloadHash = hashMessageBody(JSON.stringify({ stableEventKey, recipientPhone, messageBody }));
  return { serviceMonth, compareMonth, change, studentId, recipientPhone, messageBody, stableEventKey, payloadHash };
}

/** 서버 canonical 월 비교 → HELD → APPROVED → SENDING → SENT 순서만 허용한다. */
export async function POST(request: Request) {
  let sendingBatchId: string | null = null;
  try {
    const admin = await requireAdmin();
    const body = (await request.json().catch(() => null)) as NoticeBody | null;
    if (!body || !ACTIONS.has(body.action as NoticeAction)) return NextResponse.json({ error: "허용되지 않은 처리 종류입니다." }, { status: 400 });
    const action = body.action as NoticeAction;
    const payload = await canonicalPayload(body);
    if (action !== "PREPARE" && body.payloadHash !== payload.payloadHash) {
      return NextResponse.json({ error: "차량표가 변경되어 승인이 무효화됐습니다. 다시 확인해 주세요." }, { status: 409 });
    }

    if (action === "PREPARE") {
      await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          `UPDATE "RegularShuttleNoticeBatch" SET status='CANCELLED', "errorCode"='PAYLOAD_CHANGED', "updatedAt"=now()
            WHERE "stableEventKey"=$1 AND status IN ('HELD','APPROVED') AND "payloadHash"<>$2`, payload.stableEventKey, payload.payloadHash,
        );
        await tx.$executeRawUnsafe(
          `INSERT INTO "RegularShuttleNoticeBatch"
            (id,"serviceMonth","compareMonth","stableEventKey","payloadHash","studentId","studentName","recipientPhone","messageBody","beforeText","afterText",status,"createdByUserId")
           VALUES (gen_random_uuid()::text,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'HELD',$11)
           ON CONFLICT ("payloadHash") DO NOTHING`,
          payload.serviceMonth, payload.compareMonth, payload.stableEventKey, payload.payloadHash,
          payload.studentId, payload.change.studentName, payload.recipientPhone, payload.messageBody,
          payload.change.before, payload.change.after, admin.appUserId,
        );
      });
    } else if (action === "APPROVE") {
      const changed = await prisma.$executeRawUnsafe(
        `UPDATE "RegularShuttleNoticeBatch" SET status='APPROVED', "approvedByUserId"=$2, "approvedAt"=now(), "updatedAt"=now()
          WHERE "payloadHash"=$1 AND status='HELD'`, payload.payloadHash, admin.appUserId,
      );
      if (changed !== 1) return NextResponse.json({ error: "최신 HELD 미리보기만 승인할 수 있습니다." }, { status: 409 });
    } else {
      const rows = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
        `UPDATE "RegularShuttleNoticeBatch" SET status='SENDING', "lockedAt"=now(), "updatedAt"=now()
          WHERE "payloadHash"=$1 AND status='APPROVED' RETURNING id`, payload.payloadHash,
      );
      if (!rows[0]) return NextResponse.json({ error: "승인된 최신 미리보기만 발송할 수 있습니다." }, { status: 409 });
      sendingBatchId = rows[0].id;
      const result = await sendTrackedSms({
        eventType: "REGULAR_SHUTTLE_CHANGE", trigger: "REGULAR_SHUTTLE_CHANGE",
        recipientRole: "PARENT", recipientPhone: payload.recipientPhone, body: payload.messageBody,
        eventId: payload.payloadHash, source: "MANUAL", audienceScope: "EXTERNAL",
      });
      if (!result.ok) {
        await prisma.$executeRawUnsafe(
          `UPDATE "RegularShuttleNoticeBatch" SET status='UNCERTAIN', "errorCode"=$2, "updatedAt"=now()
            WHERE id=$1 AND status='SENDING'`, sendingBatchId, String(result.reason ?? "FAILED_DELIVERY_UNCERTAIN").slice(0, 200),
        );
        sendingBatchId = null;
        return NextResponse.json({ error: "발송 결과를 확정할 수 없어 잠갔습니다. 문자 이력을 확인해 주세요." }, { status: 409 });
      }
      await prisma.$executeRawUnsafe(
        `UPDATE "RegularShuttleNoticeBatch" SET status='SENT', "sentAt"=now(), "lockedAt"=NULL, "errorCode"=NULL, "updatedAt"=now()
          WHERE id=$1 AND status='SENDING'`, sendingBatchId,
      );
      sendingBatchId = null;
    }

    const rows = await prisma.$queryRawUnsafe<Array<{ status: string; sentAt: Date | null }>>(
      `SELECT status,"sentAt" FROM "RegularShuttleNoticeBatch" WHERE "payloadHash"=$1 LIMIT 1`, payload.payloadHash,
    );
    return NextResponse.json({ ok: true, status: rows[0]?.status ?? "HELD", payloadHash: payload.payloadHash, sentAt: rows[0]?.sentAt?.toISOString() ?? null });
  } catch (error) {
    if (sendingBatchId) {
      await prisma.$executeRawUnsafe(
        `UPDATE "RegularShuttleNoticeBatch" SET status='UNCERTAIN', "errorCode"='FAILED_DELIVERY_UNCERTAIN', "updatedAt"=now()
          WHERE id=$1 AND status='SENDING'`, sendingBatchId,
      ).catch(() => undefined);
    }
    console.error("[regular-notice POST]", error);
    const message = error instanceof Error ? error.message : "문자 처리에 실패했습니다.";
    const status = /권한|로그인|인증|Unauthorized|Forbidden/i.test(message) ? 403 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
