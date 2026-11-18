"use server";

/**
 * 체험 취소 환불(학부모가 남긴 계좌로 송금) — 관리자 «환불 완료» 표시.
 * 돈은 원장이 은행 앱에서 직접 보낸다. 여기서는 송금을 마쳤다는 기록만 남긴다(토스 결제 취소와 별개).
 */

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth-guard";
import { ensureApplicationContactLogInfrastructure } from "@/lib/application-contact-logs";
import { formatWon, maskRefundAccount } from "@/lib/trial-self-service/rules";

export type TrialRefundDoneResult = { ok: true; message: string } | { ok: false; message: string };

export async function markTrialRefundDone(trialLeadId: string): Promise<TrialRefundDoneResult> {
    const admin = await requireAdmin();
    const id = typeof trialLeadId === "string" ? trialLeadId.trim() : "";
    if (!id) return { ok: false, message: "체험 신청을 찾지 못했습니다. 목록을 새로고침해 주세요." };
    await ensureApplicationContactLogInfrastructure();
    const updated = await prisma.$queryRawUnsafe<Array<{ amount: number; refundBank: string; refundAccount: string }>>(
        `UPDATE "TrialRefundRequest"
            SET status = 'DONE', "completedAt" = NOW(), "completedByName" = $2, "updatedAt" = NOW()
          WHERE "trialLeadId" = $1 AND status = 'PENDING'
          RETURNING amount, "refundBank", "refundAccount"`,
        id,
        admin.appUserName ?? null,
    );
    const row = updated[0];
    if (!row) return { ok: false, message: "환불 대기 중인 요청이 없습니다. 목록을 새로고침해 주세요." };
    await prisma.$executeRawUnsafe(
        `INSERT INTO "ApplicationContactLog" (id, "targetType", "trialLeadId", action, note, "createdByUserId", "createdByName", "createdAt", "updatedAt")
         VALUES (gen_random_uuid()::text, 'TRIAL', $1, 'UPDATED', $2, $3, $4, NOW(), NOW())`,
        id,
        `체험비 환불 완료(계좌 송금 ${row.refundBank} ${maskRefundAccount(row.refundAccount)}, ${formatWon(Number(row.amount))})`,
        admin.appUserId ?? null,
        admin.appUserName ?? null,
    ).catch((error) => console.warn("[trial-refund] history log failed:", (error as Error).message));
    revalidatePath("/admin/trial");
    return { ok: true, message: `환불 완료로 표시했습니다(${formatWon(Number(row.amount))}).` };
}
