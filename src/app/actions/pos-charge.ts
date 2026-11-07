"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth-guard";
import {
    ChargeRequestError,
    cancelChargeRequestByAdmin,
    createChargeRequestByAdmin,
    getChargeCancelForPayment,
    getChargeRequestForPayment,
    getChargeRequestForPayments,
    requestChargeCancelByAdmin,
    type AdminChargeCancelView,
    type AdminChargeRequestView,
} from "@/lib/pos/chargeRequestService";
import {
    issuePosPluginToken,
    listPosPluginTokens,
    revokePosPluginToken,
    type PosPluginTokenRow,
} from "@/lib/pos/pluginAuth";

/**
 * 토스 POS «현장 결제» · «POS 연결(토큰)» 관리자 동작.
 *
 * Server Action 은 브라우저에서 직접 POST 로 부를 수 있으므로 **첫 줄에서 권한을 다시 확인**한다.
 * 권한 = 원장(ADMIN)만 — 기존 «단말기 결제 반영»(markTerminalPaymentPaid)과 같은 재무 권한 기준.
 * 오류는 throw 대신 { ok:false, message } 로 돌려준다(배포 환경은 throw 한 문구를 화면에 숨긴다).
 */

export type ActionResult<T> = ({ ok: true } & T) | { ok: false; message: string };

async function requireFinanceOwner() {
    const admin = await requireAdmin();
    if (admin.appUserRole !== "ADMIN") throw new ChargeRequestError("NOT_ELIGIBLE", "원장만 현장 결제·POS 연결을 다룰 수 있습니다.");
    return admin;
}

function failure(error: unknown, fallback: string): { ok: false; message: string } {
    if (error instanceof ChargeRequestError) return { ok: false, message: error.message };
    const message = String((error as Error)?.message ?? "");
    // 권한 문구(requireAdmin)는 그대로 보여 주고, 그 밖의 내부 오류는 감춘다.
    if (/권한|로그인/.test(message)) return { ok: false, message };
    console.error("[pos-charge-action]", message.slice(0, 300));
    return { ok: false, message: fallback };
}

/**
 * 브라우저가 보낸 청구 id(1건 문자열 또는 여러 건 배열) → 문자열 배열. 모양이 이상하면 빈 배열(서버가 «찾지 못함»으로 막는다).
 * 같은 학생·대상 유형·미납·금액은 서비스(createRow)가 DB 값으로 다시 확인한다 — 여기서는 모양만 본다.
 */
function paymentIdsOf(value: unknown): string[] {
    const list = Array.isArray(value) ? value : [value];
    if (list.length > 20) return [];
    // 문자열이 아니거나 빈 값이 하나라도 섞이면 통째로 거절(빈 배열 → 서버가 «찾지 못함»). 일부만 걸러 보내면
    // 사용자가 고른 것과 다른 묶음이 만들어질 수 있다.
    if (list.some((v) => typeof v !== "string" || v.trim().length === 0)) return [];
    return list as string[];
}

/** 청구서의 현재(또는 가장 최근) 현장 결제 요청. 여러 건이면 정확히 그 묶음으로 만든 요청 */
export async function loadPosChargeRequest(paymentIds: string | string[]): Promise<ActionResult<{ request: AdminChargeRequestView | null }>> {
    try {
        await requireFinanceOwner();
        const ids = paymentIdsOf(paymentIds);
        const request = ids.length > 1 ? await getChargeRequestForPayments(ids) : await getChargeRequestForPayment(ids[0] ?? "");
        return { ok: true, request };
    } catch (error) {
        return failure(error, "현장 결제 요청을 불러오지 못했습니다.");
    }
}

/**
 * «현장 결제» — 요청 만들기(이미 같은 묶음의 열린 요청이 있으면 그것을 돌려준다).
 * 여러 건 = 같은 학생의 수강료·셔틀비 미납을 POS 결제 한 번으로(2026-11-08 원장 결정). 학생이 섞이면 서버가 막는다.
 */
export async function createPosChargeRequest(paymentIds: string | string[]): Promise<ActionResult<{ request: AdminChargeRequestView; existing: boolean }>> {
    try {
        const admin = await requireFinanceOwner();
        const result = await createChargeRequestByAdmin({
            paymentIds: paymentIdsOf(paymentIds),
            adminUserId: admin.appUserId,
            adminName: admin.appUserName,
        });
        return { ok: true, ...result };
    } catch (error) {
        return failure(error, "현장 결제 요청을 만들지 못했습니다.");
    }
}

/** 요청 취소(열린 요청만, 돈은 안 움직임) */
export async function cancelPosChargeRequest(requestId: string): Promise<ActionResult<object>> {
    try {
        const admin = await requireFinanceOwner();
        await cancelChargeRequestByAdmin({ requestId: String(requestId ?? ""), adminUserId: admin.appUserId });
        return { ok: true };
    } catch (error) {
        return failure(error, "현장 결제 요청을 취소하지 못했습니다.");
    }
}

/**
 * «결제 취소» 창 — 이 청구서를 납부시킨 현장 결제의 취소 상태.
 * 청구서 id 만 받는다(요청 id 는 서버가 그 청구서에서 찾는다 — 다른 청구서의 요청을 건드리지 못하게).
 */
export async function loadPosChargeCancel(paymentId: string): Promise<ActionResult<{ cancel: AdminChargeCancelView | null }>> {
    try {
        await requireFinanceOwner();
        return { ok: true, cancel: await getChargeCancelForPayment(String(paymentId ?? "")) };
    } catch (error) {
        return failure(error, "결제 취소 상태를 불러오지 못했습니다.");
    }
}

/**
 * «결제 취소» — POS 에 결제 취소를 보낸다(요청에 «취소할 일» 표시만). 돈은 여기서 안 움직인다:
 * 청구서 환불은 POS 가 취소한 뒤 토스 웹훅 + 재조회로 확인될 때만 된다.
 */
export async function requestPosChargeCancel(paymentId: string): Promise<ActionResult<{ cancel: AdminChargeCancelView }>> {
    try {
        const admin = await requireFinanceOwner();
        const cancel = await requestChargeCancelByAdmin({ paymentId: String(paymentId ?? ""), adminUserId: admin.appUserId });
        return { ok: true, cancel };
    } catch (error) {
        return failure(error, "결제 취소를 보내지 못했습니다.");
    }
}

/** POS 연결 — 토큰 목록 */
export async function loadPosPluginTokens(): Promise<ActionResult<{ tokens: PosPluginTokenRow[] }>> {
    try {
        await requireFinanceOwner();
        return { ok: true, tokens: await listPosPluginTokens() };
    } catch (error) {
        return failure(error, "POS 연결 코드 목록을 불러오지 못했습니다.");
    }
}

/** POS 연결 — 새 토큰 발급(= 회전). 원문은 이 응답에서 한 번만 나간다. */
export async function issuePosPluginTokenAction(label: string): Promise<ActionResult<{ token: string; revokedCount: number }>> {
    try {
        const admin = await requireFinanceOwner();
        const result = await issuePosPluginToken({ label, adminUserId: admin.appUserId });
        revalidatePath("/admin/pos-plugin");
        return { ok: true, ...result };
    } catch (error) {
        return failure(error, "POS 연결 코드를 만들지 못했습니다.");
    }
}

/** POS 연결 — 토큰 끊기 */
export async function revokePosPluginTokenAction(tokenId: string): Promise<ActionResult<object>> {
    try {
        const admin = await requireFinanceOwner();
        const done = await revokePosPluginToken({ tokenId: String(tokenId ?? ""), adminUserId: admin.appUserId });
        if (!done) return { ok: false, message: "이미 끊긴 POS 연결 코드입니다." };
        revalidatePath("/admin/pos-plugin");
        return { ok: true };
    } catch (error) {
        return failure(error, "POS 연결 코드를 끊지 못했습니다.");
    }
}
