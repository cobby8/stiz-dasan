// 체험비·안내 자동 발송 설정 읽기 — 서버 전용.
//
// AcademySettings 에 새로 붙는 칸(마이그레이션 20261110150000):
//   trialFeeAmount(체험비, 기본 10000) · trialOnlinePaymentEnabled(온라인 결제 켜기, 기본 false)
//   trialGuideAutoSend · enrollGuideAutoSend(안내 자동 발송, 원장 문구 승인 전이라 기본 false)
// SELECT * 로 읽고 칸이 없으면 기본값 — 마이그레이션 적용 전에 배포돼도 공개 신청 화면이 죽지 않게(계좌 안내로 동작).

import { prisma } from "@/lib/prisma";
import { normalizeTrialFeeAmount } from "@/lib/trial-fee/trialFeeRules";

export type TrialFeeSettings = {
    amount: number;
    onlinePaymentEnabled: boolean;
    trialGuideAutoSend: boolean;
    enrollGuideAutoSend: boolean;
    contactPhone: string | null;
};

export async function getTrialFeeSettings(): Promise<TrialFeeSettings> {
    try {
        const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
            `SELECT * FROM "AcademySettings" WHERE id = 'singleton' LIMIT 1`,
        );
        const row = rows[0] ?? {};
        return {
            amount: normalizeTrialFeeAmount(row.trialFeeAmount),
            onlinePaymentEnabled: row.trialOnlinePaymentEnabled === true,
            trialGuideAutoSend: row.trialGuideAutoSend === true,
            enrollGuideAutoSend: row.enrollGuideAutoSend === true,
            contactPhone: typeof row.contactPhone === "string" && row.contactPhone.trim() ? row.contactPhone.trim() : null,
        };
    } catch (error) {
        console.error("[trial-fee] 설정을 읽지 못해 기본값(온라인 결제 꺼짐)으로 동작합니다:", error instanceof Error ? error.message : error);
        return { amount: normalizeTrialFeeAmount(null), onlinePaymentEnabled: false, trialGuideAutoSend: false, enrollGuideAutoSend: false, contactPhone: null };
    }
}
