"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth-guard";
import {
    ChargeRequestError,
    acknowledgeChargeDismissalByAdmin,
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
import { maskChargeRequestViewForRole, type ChargeViewAmountsMasked } from "@/lib/payments/financeRoleMask";
import { canSeeAllMoney } from "@/lib/auth/moneyAccess";
import { prisma } from "@/lib/prisma";

/**
 * 토스 POS «현장 결제» · «POS 연결(토큰)» 관리자 동작.
 *
 * Server Action 은 브라우저에서 직접 POST 로 부를 수 있으므로 **첫 줄에서 권한을 다시 확인**한다.
 * 권한(2026-11-14 원장 결정 — 부원장 카운터 수납):
 *   - 원장·부원장(requirePosCounter): 현장 결제 요청 만들기(1건·묶음) · 대기 요청 조회 · 결제 전 요청 취소 · POS 수동 정리 확인.
 *     요청은 «미납(PENDING·OVERDUE) 청구»로만 만들어진다(서비스 SQL 이 DB 값으로 다시 확인). 돈은 토스 결제 확인으로만 움직인다.
 *   - 원장만(requireFinanceOwner): 결제 취소(= 환불) · POS 연결 코드(토큰) 발급·목록·회수.
 *   - 부원장에게는 이미 결제된(PAID) 요청의 금액을 가린다(maskChargeRequestViewForRole).
 * 오류는 throw 대신 { ok:false, message } 로 돌려준다(배포 환경은 throw 한 문구를 화면에 숨긴다).
 */

export type ActionResult<T> = ({ ok: true } & T) | { ok: false; message: string };

/** 화면에 내려가는 요청 보기 — 부원장에게는 결제된 요청의 금액이 null */
export type PosChargeRequestView = ChargeViewAmountsMasked<AdminChargeRequestView>;

/**
 * 요청 보기를 역할에 맞게 가린다(검수 S2). 부원장이면 묶인 청구(대표 + 항목)의 «지금 상태»를 DB 에서 읽어
 * 하나라도 미납이 아니면 금액을 뺀다. 원장은 DB 를 읽지 않고 그대로.
 */
async function maskViewForRole(view: AdminChargeRequestView | null, role: string): Promise<PosChargeRequestView | null> {
    if (!view || canSeeAllMoney(role)) return maskChargeRequestViewForRole(view, role, []);
    const ids = [...new Set([view.paymentId, ...view.items.map((item) => item.paymentId)].filter(Boolean))];
    const rows = await prisma.$queryRawUnsafe<{ status: string }[]>(
        `SELECT status FROM "Payment" WHERE id = ANY($1::text[])`,
        ids,
    );
    // 찾은 행 수가 다르면(삭제 등) «모름»으로 보고 가린다
    const statuses = rows.length === ids.length ? rows.map((row) => row.status) : [];
    return maskChargeRequestViewForRole(view, role, statuses);
}

/** 원장만 — 결제 취소(환불)·POS 연결 코드 */
async function requireFinanceOwner() {
    const admin = await requireAdmin();
    if (admin.appUserRole !== "ADMIN") throw new ChargeRequestError("NOT_ELIGIBLE", "원장만 결제 취소·POS 연결을 다룰 수 있습니다.");
    return admin;
}

/** 원장·부원장 — 카운터 현장 결제(요청 만들기·조회·결제 전 취소·정리 확인). requireAdmin 이 두 역할만 통과시킨다 */
async function requirePosCounter() {
    const admin = await requireAdmin();
    if (admin.appUserRole !== "ADMIN" && admin.appUserRole !== "VICE_ADMIN") {
        throw new ChargeRequestError("NOT_ELIGIBLE", "관리자만 현장 결제를 다룰 수 있습니다.");
    }
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
export async function loadPosChargeRequest(paymentIds: string | string[]): Promise<ActionResult<{ request: PosChargeRequestView | null }>> {
    try {
        const admin = await requirePosCounter();
        const ids = paymentIdsOf(paymentIds);
        const request = ids.length > 1 ? await getChargeRequestForPayments(ids) : await getChargeRequestForPayment(ids[0] ?? "");
        // 부원장: 묶인 청구가 하나라도 미납이 아니면 금액을 가린다(원장은 그대로)
        return { ok: true, request: await maskViewForRole(request, admin.appUserRole) };
    } catch (error) {
        return failure(error, "현장 결제 요청을 불러오지 못했습니다.");
    }
}

/**
 * «현장 결제» — 요청 만들기(이미 같은 묶음의 열린 요청이 있으면 그것을 돌려준다).
 * 여러 건 = 같은 학생의 수강료·셔틀비 미납을 POS 결제 한 번으로(2026-11-08 원장 결정). 학생이 섞이면 서버가 막는다.
 */
export async function createPosChargeRequest(paymentIds: string | string[]): Promise<ActionResult<{ request: PosChargeRequestView; existing: boolean }>> {
    try {
        const admin = await requirePosCounter();
        // 미납(PENDING·OVERDUE)·같은 학생·결제 가능 유형·금액 일치는 서비스가 DB 값으로 다시 확인한다(부원장도 같은 검증)
        const result = await createChargeRequestByAdmin({
            paymentIds: paymentIdsOf(paymentIds),
            adminUserId: admin.appUserId,
            adminName: admin.appUserName,
        });
        // 새로 만든(또는 열려 있던) 요청도 같은 기준 — 묶인 청구가 전부 미납이면 금액이 그대로 보인다
        const request = await maskViewForRole(result.request, admin.appUserRole);
        if (!request) throw new ChargeRequestError("NOT_FOUND", "현장 결제 요청을 만들지 못했습니다.");
        return { ok: true, request, existing: result.existing };
    } catch (error) {
        return failure(error, "현장 결제 요청을 만들지 못했습니다.");
    }
}

/** 요청 취소(열린 요청만, 돈은 안 움직임) */
export async function cancelPosChargeRequest(requestId: string): Promise<ActionResult<object>> {
    try {
        // 부원장도 — 서비스가 «결제 전(PENDING·SENT, 결제 흔적 없음)» 요청만 취소한다. 돈은 안 움직인다
        const admin = await requirePosCounter();
        await cancelChargeRequestByAdmin({ requestId: String(requestId ?? ""), adminUserId: admin.appUserId });
        return { ok: true };
    } catch (error) {
        return failure(error, "현장 결제 요청을 취소하지 못했습니다.");
    }
}

export async function acknowledgePosChargeDismissal(requestId: string): Promise<ActionResult<object>> {
    try {
        // 부원장도 — 취소된(결제 안 된) 요청의 «POS 에서 직접 정리함» 확인만. 청구·환불은 건드리지 않는다
        const admin = await requirePosCounter();
        await acknowledgeChargeDismissalByAdmin({ requestId: String(requestId ?? ""), adminUserId: admin.appUserId });
        return { ok: true };
    } catch (error) {
        return failure(error, "POS에서 직접 확인한 결과를 저장하지 못했습니다.");
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
