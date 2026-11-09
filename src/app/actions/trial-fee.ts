"use server";

// 체험비 온라인 결제·안내 미리보기 — 관리자 서버 액션.
// ⚠️ 안내 자동 발송 스위치(trialGuideAutoSend·enrollGuideAutoSend)는 여기서 바꾸지 않는다 — 원장 문구 승인 전(미리보기만).

import { revalidatePath, revalidateTag } from "next/cache";
import { requireAdmin } from "@/lib/auth-guard";
import { prisma } from "@/lib/prisma";
import { getPaymentProviderConfig } from "@/lib/payment-ledger";
import { getTrialFeeSettings } from "@/lib/trial-fee/trialFeeSettings";
import { refundTrialFeeByAdmin, type TrialFeeRefundResult } from "@/lib/trial-fee/trialFeePaymentService";
import { previewEnrollGuideForStudent, previewEnrollGuideForTrialLead, previewTrialGuide, type GuidePreview } from "@/lib/trial-fee/guideSender";
import { MAX_TRIAL_FEE_AMOUNT, MIN_TRIAL_FEE_AMOUNT, formatTrialFeeAmount } from "@/lib/trial-fee/trialFeeRules";
import { toKstYmd } from "@/lib/datetime/kst";
import { notMergedStudent } from "@/lib/studentVisibility";

/** 환불·결제 설정은 원장(ADMIN)만 — 수납 «선택 항목 환불»과 같은 재무 권한 */
async function requireFinanceOwner() {
    const admin = await requireAdmin();
    if (admin.appUserRole !== "ADMIN") throw new Error("원장 권한이 필요합니다.");
    return admin;
}

export type TrialFeeAdminState = {
    amount: number;
    amountLabel: string;
    onlinePaymentEnabled: boolean;
    /** 토스 키 한 쌍이 준비됐는가(설정을 켜도 키가 없으면 결제창이 열리지 않는다) */
    providerReady: boolean;
    trialGuideAutoSend: boolean;
    enrollGuideAutoSend: boolean;
    /** 미리보기 대상 고르기용 최근 체험 신청 20건 */
    recentLeads: Array<{ id: string; label: string }>;
    /** 미리보기 대상 고르기용 최근 등록 원생 20명 */
    recentStudents: Array<{ id: string; label: string }>;
};

export async function getTrialFeeAdminState(): Promise<TrialFeeAdminState> {
    await requireAdmin();
    const settings = await getTrialFeeSettings();
    const config = getPaymentProviderConfig();
    const leads = await prisma.$queryRawUnsafe<Array<{ id: string; childName: string; status: string; createdAt: Date }>>(
        `SELECT id, "childName", status, "createdAt" FROM "TrialLead" ORDER BY "createdAt" DESC LIMIT 20`,
    );
    const students = await prisma.$queryRawUnsafe<Array<{ id: string; name: string; createdAt: Date }>>(
        `SELECT DISTINCT s.id, s.name, s."createdAt" FROM "Student" s JOIN "Enrollment" e ON e."studentId" = s.id AND e.status = 'ACTIVE'
          WHERE ${notMergedStudent("s")}
          ORDER BY s."createdAt" DESC LIMIT 20`,
    );
    return {
        amount: settings.amount,
        amountLabel: formatTrialFeeAmount(settings.amount),
        onlinePaymentEnabled: settings.onlinePaymentEnabled,
        providerReady: config.keyPairReady && config.provider === "TOSS",
        trialGuideAutoSend: settings.trialGuideAutoSend,
        enrollGuideAutoSend: settings.enrollGuideAutoSend,
        recentLeads: leads.map((lead) => ({ id: lead.id, label: `${lead.childName} · ${toKstYmd(lead.createdAt).slice(5)} 신청 · ${lead.status}` })),
        recentStudents: students.map((student) => ({ id: student.id, label: `${student.name} · ${toKstYmd(student.createdAt).slice(5)} 등록` })),
    };
}

/** 체험비 금액·온라인 결제 켜기(원장만). 안내 자동 발송 스위치는 바꾸지 않는다. */
export async function updateTrialFeePaymentSettings(input: { amount: number; onlinePaymentEnabled: boolean }) {
    await requireFinanceOwner();
    const amount = Number(input.amount);
    if (!Number.isInteger(amount) || amount < MIN_TRIAL_FEE_AMOUNT || amount > MAX_TRIAL_FEE_AMOUNT) {
        throw new Error(`체험비는 ${formatTrialFeeAmount(MIN_TRIAL_FEE_AMOUNT)}~${formatTrialFeeAmount(MAX_TRIAL_FEE_AMOUNT)} 사이로 넣어 주세요.`);
    }
    await prisma.$executeRawUnsafe(
        `UPDATE "AcademySettings" SET "trialFeeAmount" = $1, "trialOnlinePaymentEnabled" = $2, "updatedAt" = NOW() WHERE id = 'singleton'`,
        amount,
        input.onlinePaymentEnabled === true,
    );
    revalidatePath("/apply/trial");
    revalidatePath("/admin/apply");
    revalidateTag("academy-settings", { expire: 0 });
    return { ok: true as const };
}

export type GuidePreviewSet = {
    trial: GuidePreview | null;
    enrollFromTrial: GuidePreview | null;
    enrollFromStudent: GuidePreview | null;
};

/** 안내 미리보기 — 발송하지 않는다. 받는 번호는 가려서 돌려준다. */
export async function previewTrialGuides(input: { trialLeadId?: string | null; studentId?: string | null }): Promise<GuidePreviewSet> {
    await requireAdmin();
    const strip = <T extends GuidePreview & { phone?: string | null }>(preview: T | null): GuidePreview | null =>
        preview ? { recipientMasked: preview.recipientMasked, body: preview.body, subject: preview.subject } : null;
    const trialLeadId = input.trialLeadId?.trim() || null;
    const studentId = input.studentId?.trim() || null;
    return {
        trial: trialLeadId ? strip(await previewTrialGuide(trialLeadId)) : null,
        enrollFromTrial: trialLeadId ? strip(await previewEnrollGuideForTrialLead(trialLeadId)) : null,
        enrollFromStudent: studentId ? strip(await previewEnrollGuideForStudent(studentId)) : null,
    };
}

/** 체험비 환불(토스 전액 취소) — 원장만. 체험 신청 상태(취소 등)는 바꾸지 않는다. */
export async function refundTrialFee(trialLeadId: string): Promise<TrialFeeRefundResult> {
    const admin = await requireFinanceOwner();
    const result = await refundTrialFeeByAdmin({ trialLeadId, adminUserId: admin.appUserId, adminName: admin.appUserName });
    if (result.ok) {
        revalidatePath("/admin/apply");
        revalidatePath("/admin/trial");
    }
    return result;
}
