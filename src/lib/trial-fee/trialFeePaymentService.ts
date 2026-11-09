// 체험비 온라인 결제 — 실행부(prisma + 토스 호출). 서버 전용.
//
// 흐름(로그인 없는 신청자):
//   ① 신청 접수 → issueTrialPaymentToken: 결제 링크 토큰 발급(해시만 저장) → 신청 완료 화면에 «체험비 결제하기»
//   ② /apply/trial/pay/[token] → startTrialFeeCheckout: 토큰으로 신청 확인 → 금액(설정)·면세 → 토스 결제창 인자
//   ③ 결제창 → /apply/trial/pay/done → confirmTrialFeeOnlinePayment: 승인 전 잠금·재확인 → 토스 승인 → 장부 반영
//        카드·계좌이체 = 즉시 «결제 완료(체험 확정)», 무통장입금 = 계좌 발급(입금 대기) → 입금 웹훅에서 확정
//   ④ 토스 웹훅(/api/payments/toss/webhook) 중 주문번호 TRIAL- 은 recordTrialFeeTossWebhook 으로
//   ⑤ 관리자 «체험비 환불» → refundTrialFeeByAdmin: 청구 환불(refundTossPaymentByAdmin)과 같은 순서
//        (재조회 → 기록 → 토스 전액 취소 → 재조회로 «전액 취소» 확인될 때만 장부 반영)
// 토스 호출 함수(조회·키·멱등키)·면세 규칙·가상계좌 판정은 청구 결제(payment-ledger·payments/*)의 것을 그대로 쓴다.

import { createHash, randomUUID } from "node:crypto";
import { revalidatePath, revalidateTag } from "next/cache";
import { prisma } from "@/lib/prisma";
import {
    encodeTossSecret,
    getPaymentProviderConfig,
    getVerifiedTossPayment,
    makeUuidFromSeed,
    readTossErrorMessage,
} from "@/lib/payment-ledger";
import { taxFreeAmountFor, describeTaxFreeMismatch } from "@/lib/payments/taxFree";
import { classifyTossCancel } from "@/lib/payments/tossCancel";
import {
    VA_METHOD,
    decideVirtualAccountClose,
    extractVirtualAccountIssue,
    isDepositCallbackPayload,
    readStoredIssue,
    stripPaymentSecret,
    stripWebhookSecrets,
    toPublicVirtualAccountView,
    toTossMobilePhone,
    type PublicVirtualAccountView,
} from "@/lib/payments/virtualAccount";
import { buildIssuedRawResponse, checkDepositSecret } from "@/lib/payments/virtualAccountSecret";
import { postMessage } from "@/lib/slack/client";
import { toKstYmd, kstDow, isKstYmd } from "@/lib/datetime/kst";
import {
    TRIAL_CHECKOUT_BLOCK_MESSAGE,
    TRIAL_CONFIRM_REJECT_MESSAGE,
    TRIAL_VA_VALID_HOURS,
    classifyTrialTossResult,
    extractWebhookOrderId,
    formatTrialFeeAmount,
    isTrialFeeOrderId,
    makeTrialFeeOrderId,
    trialCheckoutBlock,
    trialFeeOrderName,
    type TrialCheckoutBlock,
} from "@/lib/trial-fee/trialFeeRules";
import {
    applyTrialFeeFullCancelInTx,
    claimTrialFeeConfirmInTx,
    finalizeTrialFeePaidInTx,
    findTrialFeePaymentForLead,
    findTrialLeadByTokenHash,
    latestTrialFeePayment,
    markTrialFeeFailed,
    recordTrialVirtualAccountIssuedInTx,
    releaseTrialVirtualAccountInTx,
    reserveTrialFeeOrderInTx,
    type FinalizeResult,
    type TrialFeeLeadRow,
    type TrialFeePaymentRow,
} from "@/lib/trial-fee/trialFeeLedger";
import { createTrialPaymentToken, tokenHashOrNull, trialCustomerKey } from "@/lib/trial-fee/trialFeeToken";
import { getTrialFeeSettings } from "@/lib/trial-fee/trialFeeSettings";
import { sendTrialGuideIfEnabled } from "@/lib/trial-fee/guideSender";

type TossResult = Record<string, unknown>;
const DOW_LABEL = ["일", "월", "화", "수", "목", "금", "토"];

function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" ? value as Record<string, unknown> : {};
}
function readString(value: unknown): string | null {
    return typeof value === "string" && value.length > 0 ? value : null;
}

/** 온라인 결제를 받을 수 있는가 = 설정 스위치 켜짐 + 토스 키 한 쌍 준비(카페24 중계 모드면 받지 않음) */
function onlinePaymentReady(settingEnabled: boolean): boolean {
    const config = getPaymentProviderConfig();
    return settingEnabled && config.keyPairReady && config.provider === "TOSS";
}

function revalidateTrialCaches() {
    revalidatePath("/admin/apply");
    revalidatePath("/admin/trial");
    revalidateTag("admin-trial", { expire: 0 });
}

async function alertOwner(text: string) {
    const owner = (process.env.SLACK_OWNER_USER_ID || "").trim();
    if (!owner) {
        console.warn(`[trial-fee] 원장 슬랙 ID 없음 — 알림 생략: ${text}`);
        return;
    }
    try {
        await postMessage({ channel: owner, text });
    } catch (error) {
        console.error("[trial-fee] 슬랙 알림 실패:", error instanceof Error ? error.message : error);
    }
}

/** 화면에 보일 희망 일정 «11월 12일(수) 4교시» (날짜는 KST 모듈로만) */
function preferredLabel(lead: Pick<TrialFeeLeadRow, "trialDate" | "preferredPeriod">): string {
    const parts: string[] = [];
    if (lead.trialDate) {
        const ymd = toKstYmd(lead.trialDate);
        if (isKstYmd(ymd)) {
            const [, month, day] = ymd.split("-");
            parts.push(`${Number(month)}월 ${Number(day)}일(${DOW_LABEL[kstDow(ymd)]})`);
        }
    }
    if (lead.preferredPeriod) parts.push(`${lead.preferredPeriod}교시`);
    return parts.join(" ");
}

function virtualAccountViewOf(row: TrialFeePaymentRow | null, nowMs: number): PublicVirtualAccountView | null {
    if (!row || (row.status !== "WAITING_FOR_DEPOSIT" && row.status !== "EXPIRED")) return null;
    const issue = readStoredIssue(asRecord(row.rawResponse).virtualAccountIssue);
    return issue ? toPublicVirtualAccountView(issue, row.status, nowMs) : null;
}

/** 공개 신청 화면용 — 체험비 금액(설정값)과 온라인 결제 가능 여부만 */
export async function getTrialFeePublicInfo(): Promise<{ amount: number; amountLabel: string; onlinePayment: boolean }> {
    const settings = await getTrialFeeSettings();
    return {
        amount: settings.amount,
        amountLabel: formatTrialFeeAmount(settings.amount),
        onlinePayment: onlinePaymentReady(settings.onlinePaymentEnabled),
    };
}

// ───────────────────────────── ① 링크 토큰 ─────────────────────────────

/**
 * 신청 직후 결제 링크 토큰을 만든다(해시만 저장). 온라인 결제가 꺼졌거나 이미 낸 신청이면 null.
 * 실패해도 신청 접수는 그대로 — 화면은 예전 계좌 안내로 동작한다.
 */
export async function issueTrialPaymentToken(trialLeadId: string): Promise<string | null> {
    try {
        const settings = await getTrialFeeSettings();
        if (!onlinePaymentReady(settings.onlinePaymentEnabled)) return null;
        const { token, hash } = createTrialPaymentToken();
        const updated = await prisma.$executeRawUnsafe(
            `UPDATE "TrialLead" SET "paymentTokenHash" = $2, "updatedAt" = NOW()
             WHERE id = $1 AND COALESCE("trialFeeConfirmed", false) = false`,
            trialLeadId,
            hash,
        );
        return updated === 1 ? token : null;
    } catch (error) {
        console.error("[trial-fee] 결제 링크 발급 실패(계좌 안내로 대체):", error instanceof Error ? error.message : error);
        return null;
    }
}

// ───────────────────────────── ② 결제 화면·시작 ─────────────────────────────

export type TrialPaymentPageData =
    | { state: "NOT_FOUND" }
    | {
        state: "READY" | "PAID" | "CLOSED" | "PAYMENT_OFF" | "WAITING_DEPOSIT";
        childName: string;
        preferredSchedule: string;
        amount: number;
        amountLabel: string;
        virtualAccount: PublicVirtualAccountView | null;
        contactPhone: string | null;
    };

/** 결제 화면(서버 페이지)용 — 토큰이 맞는 신청의 요약만. 학부모 번호·신청 id 는 내보내지 않는다. */
export async function getTrialPaymentPageData(token: string): Promise<TrialPaymentPageData> {
    const hash = tokenHashOrNull(token);
    if (!hash) return { state: "NOT_FOUND" };
    const lead = await findTrialLeadByTokenHash(prisma, hash);
    if (!lead) return { state: "NOT_FOUND" };
    const settings = await getTrialFeeSettings();
    const block = trialCheckoutBlock({
        found: true,
        status: lead.status,
        feeConfirmed: lead.trialFeeConfirmed,
        feeSummary: lead.trialFeePaymentStatus,
        paymentEnabled: onlinePaymentReady(settings.onlinePaymentEnabled),
    });
    const latest = await latestTrialFeePayment(prisma, lead.id);
    const va = virtualAccountViewOf(latest, Date.now());
    const state = block === "ALREADY_PAID" ? "PAID"
        : block === "CLOSED" ? "CLOSED"
            : va && !va.expired ? "WAITING_DEPOSIT"
                : block === "PAYMENT_OFF" ? "PAYMENT_OFF"
                    : "READY";
    // 결제가 끝난 주문 금액이 있으면 그 금액을(설정이 바뀌어도 낸 금액 그대로) 보인다
    const amount = latest && ["DONE", "WAITING_FOR_DEPOSIT"].includes(latest.status) ? Number(latest.amount) : settings.amount;
    return {
        state,
        childName: lead.childName,
        preferredSchedule: preferredLabel(lead),
        amount,
        amountLabel: formatTrialFeeAmount(amount),
        virtualAccount: va,
        contactPhone: settings.contactPhone,
    };
}

export type StartCheckoutResult =
    | { ok: false; error: string; block?: TrialCheckoutBlock }
    | { ok: true; openVirtualAccount: PublicVirtualAccountView }
    | {
        ok: true;
        clientKey: string;
        customerKey: string;
        orderId: string;
        orderName: string;
        amount: number;
        taxFreeAmount: number;
        customerName: string;
        customerMobilePhone?: string;
        successUrl: string;
        failUrl: string;
        virtualAccountValidHours: number;
    };

/** 결제 시작 — 금액은 서버 설정값(화면 값을 믿지 않는다). 면세 = taxFreeAmountFor(청구 결제와 같은 규칙). */
export async function startTrialFeeCheckout(input: { token: string; origin: string }): Promise<StartCheckoutResult> {
    const hash = tokenHashOrNull(input.token);
    const lead = hash ? await findTrialLeadByTokenHash(prisma, hash) : null;
    const settings = await getTrialFeeSettings();
    const block = trialCheckoutBlock({
        found: Boolean(lead),
        status: lead?.status,
        feeConfirmed: lead?.trialFeeConfirmed,
        feeSummary: lead?.trialFeePaymentStatus,
        paymentEnabled: onlinePaymentReady(settings.onlinePaymentEnabled),
    });
    if (block || !lead) return { ok: false, error: TRIAL_CHECKOUT_BLOCK_MESSAGE[block ?? "NOT_FOUND"], block: block ?? "NOT_FOUND" };

    const amount = settings.amount;
    const taxFreeAmount = taxFreeAmountFor(amount);
    const nowMs = Date.now();
    const reserved = await prisma.$transaction((tx) => reserveTrialFeeOrderInTx(tx, {
        trialLeadId: lead.id,
        amount,
        taxFreeAmount,
        newOrderId: makeTrialFeeOrderId(randomUUID()),
        isDepositExpired: (row) => virtualAccountViewOf(row, nowMs)?.expired !== false,
    }));
    if (reserved.kind === "ALREADY_PAID") return { ok: false, error: TRIAL_CHECKOUT_BLOCK_MESSAGE.ALREADY_PAID, block: "ALREADY_PAID" };
    if (reserved.kind === "OPEN_DEPOSIT") {
        const view = virtualAccountViewOf(reserved.row, nowMs);
        if (view) return { ok: true, openVirtualAccount: view };
        return { ok: false, error: "입금 대기 중인 계좌가 있어요. 학원에 문의해 주세요." };
    }

    const config = getPaymentProviderConfig();
    const origin = input.origin.replace(/\/$/, "");
    const tokenPart = encodeURIComponent(input.token);
    const parentName = (lead.parentName ?? "").trim();
    return {
        ok: true,
        clientKey: config.clientKey,
        customerKey: trialCustomerKey(lead.id),
        orderId: reserved.row.orderId,
        orderName: trialFeeOrderName(),
        amount: Number(reserved.row.amount),
        // 주문에 저장한 면세 금액 그대로(설정이 바뀌어도 이 주문은 같은 값)
        taxFreeAmount: Number(reserved.row.taxFreeAmount),
        customerName: parentName && parentName !== "미입력" ? parentName : `${lead.childName} 보호자`,
        customerMobilePhone: toTossMobilePhone(lead.parentPhone) ?? undefined,
        successUrl: `${origin}/apply/trial/pay/done?t=${tokenPart}`,
        failUrl: `${origin}/apply/trial/pay/${tokenPart}?failed=1`,
        virtualAccountValidHours: TRIAL_VA_VALID_HOURS,
    };
}

// ───────────────────────────── ③ 승인 ─────────────────────────────

export type ConfirmResult =
    | { ok: true; paid: true; amountLabel: string; alreadyConfirmed?: boolean }
    | { ok: true; waitingForDeposit: true; virtualAccount: PublicVirtualAccountView }
    | { ok: false; error: string; retryable?: boolean; duplicate?: boolean };

/** 확정 반영(트랜잭션) + 결과에 따른 후속(체험 안내·이중 결제 알림) — 승인·웹훅 공용 */
type LinkedPaymentRow = TrialFeePaymentRow & { trialLeadId: string };

async function finalizePaid(row: LinkedPaymentRow, payment: TossResult): Promise<FinalizeResult> {
    const taxWarning = describeTaxFreeMismatch(payment);
    if (taxWarning) console.warn(`[trial-fee] ${taxWarning} orderId=${row.orderId}`);
    const result = await prisma.$transaction((tx) => finalizeTrialFeePaidInTx(tx, {
        paymentRowId: row.id,
        trialLeadId: row.trialLeadId,
        paymentKey: String(payment.paymentKey),
        method: readString(payment.method),
        receiptUrl: readString(asRecord(payment.receipt).url),
        approvedAt: readString(payment.approvedAt),
        rawResponse: stripPaymentSecret(payment),
    }));
    if (result.kind === "PAID") {
        revalidateTrialCaches();
        // 체험 안내 — 스위치 꺼짐이 기본(원장 문구 승인 전). 실패해도 결제 확정은 그대로.
        try {
            await sendTrialGuideIfEnabled(row.trialLeadId);
        } catch (error) {
            console.error("[trial-fee] 체험 안내 발송 실패:", error instanceof Error ? error.message : error);
        }
    } else if (result.kind === "CANCELED_ORDER") {
        // 우리가 취소로 닫은 주문에 토스 «결제 완료»가 왔다 — 돈이 들어온 것이라 조용히 넘기지 않는다
        await alertOwner(`[체험비] 취소로 닫힌 주문에 결제(입금)가 확인됐어요(주문 ${row.orderId}). 토스 상점관리자에서 확인 후 환불 또는 확정해 주세요.`);
    } else if (result.kind === "DUPLICATE") {
        revalidateTrialCaches();
        await alertOwner(`[체험비] 같은 체험 신청에 결제가 두 번 들어왔어요(주문 ${row.orderId}). 관리자 체험 목록에서 «체험비 환불»로 돌려주세요.`);
    }
    return result;
}

/**
 * 결제창 복귀 → 토스 승인. 토큰으로 찾은 신청의 주문만(남의 주문번호 거부), 금액은 저장된 주문 금액과 같아야 한다.
 * 승인 직전 잠금·재확인으로 «이미 확정된 신청»은 승인 자체를 하지 않는다(돈이 나가지 않음).
 */
export async function confirmTrialFeeOnlinePayment(input: {
    token: string;
    paymentKey: string;
    orderId: string;
    amount: number;
}): Promise<ConfirmResult> {
    const hash = tokenHashOrNull(input.token);
    if (!hash || !isTrialFeeOrderId(input.orderId) || !input.paymentKey || !Number.isFinite(input.amount)) {
        return { ok: false, error: "결제 정보를 확인할 수 없어요. 결제 화면에서 다시 시도해 주세요." };
    }
    const lead = await findTrialLeadByTokenHash(prisma, hash);
    if (!lead) return { ok: false, error: TRIAL_CHECKOUT_BLOCK_MESSAGE.NOT_FOUND };
    const found = await findTrialFeePaymentForLead(prisma, input.orderId, lead.id);
    if (!found) return { ok: false, error: "결제 주문을 찾을 수 없어요." };
    const row: LinkedPaymentRow = { ...found, trialLeadId: lead.id };

    const decision = await prisma.$transaction((tx) => claimTrialFeeConfirmInTx(tx, {
        paymentRowId: row.id,
        trialLeadId: lead.id,
        paymentKey: input.paymentKey,
        amount: Number(input.amount),
        nowMs: Date.now(),
    }));
    if (decision.kind === "ALREADY_DONE") return { ok: true, paid: true, amountLabel: formatTrialFeeAmount(Number(row.amount)), alreadyConfirmed: true };
    if (decision.kind === "WAITING_DEPOSIT") {
        const view = virtualAccountViewOf(row, Date.now());
        if (view) return { ok: true, waitingForDeposit: true, virtualAccount: view };
        return { ok: false, error: "입금 계좌 정보를 불러오지 못했어요. 학원에 문의해 주세요." };
    }
    if (decision.kind === "REJECT") {
        return { ok: false, error: TRIAL_CONFIRM_REJECT_MESSAGE[decision.reason], retryable: decision.reason === "IN_PROGRESS" };
    }

    const { secretKey } = getPaymentProviderConfig();
    if (!secretKey) return { ok: false, error: TRIAL_CHECKOUT_BLOCK_MESSAGE.PAYMENT_OFF };

    // «다시 확인»(같은 결제키로 이미 승인을 시작함): 승인을 또 부르기 전에 토스 재조회부터.
    // 이미 결제됐거나 계좌가 발급됐으면 그 결과로 바로 반영하고, 아직 승인 전이면 아래에서 같은 멱등키로 다시 승인한다.
    let recheckedResult: TossResult | null = null;
    if (decision.kind === "RECHECK") {
        const lookup = await getVerifiedTossPayment(input.paymentKey, row.orderId);
        if (lookup.kind === "retryable") {
            return { ok: false, retryable: true, error: "결제 상태를 확인하는 중이에요. 잠시 후 다시 확인해 주세요." };
        }
        if (lookup.kind === "verified"
            && classifyTrialTossResult(lookup.payment, { orderId: row.orderId, amount: Number(row.amount) }, input.paymentKey) !== "MISMATCH") {
            recheckedResult = lookup.payment as TossResult;
        }
    }

    const response = recheckedResult ? null : await fetch("https://api.tosspayments.com/v1/payments/confirm", {
        method: "POST",
        headers: {
            Authorization: `Basic ${encodeTossSecret(secretKey)}`,
            "Content-Type": "application/json",
            "Idempotency-Key": makeUuidFromSeed(`stiz-trial-confirm:${row.id}:${row.orderId}`),
        },
        // 금액은 저장된 주문 금액(위에서 요청 금액과 같음을 확인)
        body: JSON.stringify({ paymentKey: input.paymentKey, orderId: row.orderId, amount: Number(row.amount) }),
        cache: "no-store",
    });
    const result = response
        ? asRecord(await response.json().catch(() => ({ code: `TOSS_HTTP_${response.status}` })))
        : (recheckedResult as TossResult);

    // 응답이 실패여도 실제 상태는 재조회로 판정한다(승인됐는데 응답만 끊긴 경우)
    let verified: TossResult | null = !response || response.ok ? result : null;
    let lookupRetryable = false;
    if (response && !response.ok) {
        const lookup = await getVerifiedTossPayment(input.paymentKey, row.orderId);
        if (lookup.kind === "verified") verified = lookup.payment as TossResult;
        lookupRetryable = lookup.kind === "retryable";
    }
    const kind = classifyTrialTossResult(verified, { orderId: row.orderId, amount: Number(row.amount) }, input.paymentKey);

    if (kind === "WAITING" && verified) {
        // 무통장입금: 승인 = 계좌 발급. 돈은 아직 — 신청은 «입금 대기»로만.
        const issue = extractVirtualAccountIssue(verified, Number(row.amount));
        if (issue) {
            const saved = await prisma.$transaction((tx) => recordTrialVirtualAccountIssuedInTx(tx, {
                paymentRowId: row.id,
                trialLeadId: lead.id,
                paymentKey: input.paymentKey,
                method: readString(verified!.method),
                rawResponse: buildIssuedRawResponse(verified!, issue),
            }));
            if (saved) revalidateTrialCaches();
            return { ok: true, waitingForDeposit: true, virtualAccount: toPublicVirtualAccountView(issue, "WAITING_FOR_DEPOSIT", Date.now()) };
        }
    }
    if (kind === "DONE" && verified) {
        const finalized = await finalizePaid(row, verified);
        if (finalized.kind === "PAID" || finalized.kind === "ALREADY") {
            return { ok: true, paid: true, amountLabel: formatTrialFeeAmount(Number(row.amount)) };
        }
        if (finalized.kind === "DUPLICATE") {
            return { ok: false, duplicate: true, error: "이미 체험수업비가 확인된 신청이라 이번 결제는 학원에서 환불해 드릴게요." };
        }
        if (finalized.kind === "CANCELED_ORDER") {
            return { ok: false, error: "결제가 확인됐지만 닫힌 주문이라 학원에서 확인 후 안내드릴게요." };
        }
        return { ok: false, error: "결제는 됐지만 신청 반영이 늦어지고 있어요. 학원에 문의해 주세요." };
    }

    const retryable = response ? (response.status === 429 || response.status >= 500 || lookupRetryable) : false;
    await markTrialFeeFailed(prisma, {
        paymentRowId: row.id,
        code: readString(result.code) ?? (!response || response.ok ? "TRIAL_CONFIRM_VERIFICATION_FAILED" : "TRIAL_CONFIRM_FAILED"),
        message: readString(result.message) ?? "체험비 결제 승인 실패",
        retryable,
    });
    return {
        ok: false,
        retryable,
        error: retryable ? "결제 상태를 확인하는 중이에요. 잠시 후 다시 확인해 주세요." : "결제가 완료되지 않았어요. 결제 화면에서 다시 시도해 주세요.",
    };
}

// ───────────────────────────── ④ 웹훅 ─────────────────────────────

/** 주문번호가 체험비(TRIAL-)인 웹훅인가 — 웹훅 라우트가 갈래를 나눌 때 쓴다 */
export function isTrialFeeWebhook(payload: unknown): boolean {
    return isTrialFeeOrderId(extractWebhookOrderId(payload));
}

/**
 * 체험비 주문의 토스 웹훅 — 결제 완료·무통장 입금·계좌 만료·상점관리자 전액 취소.
 * 알림 본문은 믿지 않고 토스 재조회 결과로만 장부를 바꾼다(청구 웹훅과 같은 원칙). 같은 알림이 여러 번 와도 결과가 같다.
 */
export async function recordTrialFeeTossWebhook(payload: unknown): Promise<{ ok: boolean; processed: boolean; retryable?: boolean }> {
    const record = asRecord(payload);
    const data = asRecord(record.data ?? payload);
    const orderId = extractWebhookOrderId(payload);
    const depositCallback = isDepositCallbackPayload(record);
    const fingerprint = createHash("sha256").update(JSON.stringify(payload ?? null)).digest("hex").slice(0, 48);
    const eventRows = await prisma.$queryRawUnsafe<Array<{ id: string; processed: boolean }>>(
        `INSERT INTO "PaymentWebhookEvent" (id, provider, "eventId", "eventType", "paymentKey", "orderId", payload, "receivedAt")
         VALUES (gen_random_uuid()::text, 'TOSS', $1, $2, $3, $4, $5::jsonb, NOW())
         ON CONFLICT (provider, "eventId") DO UPDATE SET "receivedAt" = NOW()
         RETURNING id, processed`,
        `trial:${fingerprint}`,
        depositCallback ? "DEPOSIT_CALLBACK" : readString(record.eventType) ?? readString(data.status),
        readString(data.paymentKey),
        orderId,
        JSON.stringify(stripWebhookSecrets(payload)),
    );
    const eventId = eventRows[0]?.id ?? null;
    if (eventRows[0]?.processed) return { ok: true, processed: true };
    const finish = async (processed: boolean, error: string | null) => {
        await prisma.$executeRawUnsafe(
            `UPDATE "PaymentWebhookEvent" SET processed = $2, error = $3, "processedAt" = NOW() WHERE id = $1`,
            eventId, processed, error,
        );
        return { ok: true, processed };
    };

    const rows = orderId
        ? await prisma.$queryRawUnsafe<TrialFeePaymentRow[]>(`SELECT * FROM "TrialFeePayment" WHERE "orderId" = $1 LIMIT 1`, orderId)
        : [];
    const found = rows[0];
    if (!found) return finish(false, "TRIAL_ORDER_NOT_FOUND");
    // 신청이 지워진 주문(연결 끊김) — 자동 반영하지 않고 원장에게 알린다(토스 상점관리자에서 확인)
    if (!found.trialLeadId) {
        await alertOwner(`[체험비] 지워진 체험 신청의 결제 알림이 왔어요(주문 ${found.orderId}). 토스 상점관리자에서 확인해 주세요.`);
        return finish(false, "TRIAL_LEAD_DELETED");
    }
    const row: LinkedPaymentRow = { ...found, trialLeadId: found.trialLeadId };

    // 무통장 입금 알림: secret 대조를 토스 조회보다 먼저(위조 알림이면 토스를 부르지 않는다)
    const isVa = depositCallback || row.status === "WAITING_FOR_DEPOSIT" || row.method === VA_METHOD;
    if (isVa) {
        const check = checkDepositSecret(readString(record.secret) ?? readString(data.secret), asRecord(row.rawResponse).depositSecretHash);
        if (check === "MISMATCH" || (depositCallback && check === "NOT_PROVIDED")) {
            return finish(false, check === "MISMATCH" ? "DEPOSIT_SECRET_MISMATCH" : "DEPOSIT_SECRET_MISSING");
        }
    }

    const lookup = await getVerifiedTossPayment(row.paymentKey ?? readString(data.paymentKey), row.orderId);
    if (lookup.kind === "retryable") {
        await prisma.$executeRawUnsafe(`UPDATE "PaymentWebhookEvent" SET error = $2 WHERE id = $1`, eventId, lookup.reason);
        return { ok: false, processed: false, retryable: true };
    }
    const verified = lookup.kind === "verified" ? lookup.payment as TossResult : null;
    const kind = classifyTrialTossResult(verified, { orderId: row.orderId, amount: Number(row.amount) }, row.paymentKey);
    if (kind === "DONE" && verified) {
        const finalized = await finalizePaid(row, verified);
        if (finalized.kind === "CANCELED_ORDER") return finish(false, "TRIAL_CANCELED_ORDER_PAID");
        return finish(finalized.kind !== "NOT_FOUND", finalized.kind === "NOT_FOUND" ? "TRIAL_LEAD_NOT_FOUND" : null);
    }
    if (kind === "WAITING") return finish(true, null);

    // 입금 전 계좌가 닫힘(기한 지남·취소)
    if (verified && row.status === "WAITING_FOR_DEPOSIT" && (verified.status === "EXPIRED" || verified.status === "CANCELED")
        && verified.orderId === row.orderId) {
        const released = await prisma.$transaction((tx) => releaseTrialVirtualAccountInTx(tx, {
            paymentRowId: row.id,
            trialLeadId: row.trialLeadId,
            status: verified.status === "EXPIRED" ? "EXPIRED" : "CANCELED",
        }));
        if (released) revalidateTrialCaches();
        return finish(true, null);
    }

    // 확정 뒤 상점관리자에서 전액 취소
    const cancel = classifyTossCancel(verified, { orderId: row.orderId, amount: Number(row.amount) }, row.paymentKey);
    if (cancel.kind === "FULL_CANCEL" && verified) {
        await prisma.$transaction((tx) => applyTrialFeeFullCancelInTx(tx, {
            paymentRowId: row.id,
            trialLeadId: row.trialLeadId,
            rawResponse: stripPaymentSecret(verified),
            actor: { userId: null, userName: "토스 취소 알림" },
        }));
        revalidateTrialCaches();
        return finish(true, null);
    }
    if (cancel.kind === "PARTIAL_CANCEL") {
        await alertOwner(`[체험비] 일부만 취소된 결제가 있어요(주문 ${row.orderId}). 토스 상점관리자에서 확인해 주세요.`);
        return finish(false, "TRIAL_PARTIAL_CANCEL_REVIEW");
    }
    return finish(false, "TRIAL_PAYMENT_NOT_VERIFIED");
}

// ───────────────────────────── ⑤ 관리자 환불 ─────────────────────────────

export type TrialFeeRefundResult = { ok: true; alreadyApplied: boolean } | { ok: false; message: string };

/**
 * 체험비 환불(토스 전액 취소) — refundTossPaymentByAdmin 과 같은 순서:
 * 재조회(완료·금액·부분취소 없음) → 기록 → 토스 취소 API(전액) → 재조회로 «전액 취소» 확인될 때만 장부 반영.
 * 권한 확인(원장)은 부르는 쪽 서버 액션이 한다.
 */
export async function refundTrialFeeByAdmin(input: {
    trialLeadId: string;
    adminUserId: string | null;
    adminName: string | null;
}): Promise<TrialFeeRefundResult> {
    // 환불할 결제: 이중 결제(NEEDS_REFUND)가 있으면 그것부터, 아니면 확정 결제(DONE)
    const rows = await prisma.$queryRawUnsafe<TrialFeePaymentRow[]>(
        `SELECT * FROM "TrialFeePayment" WHERE "trialLeadId" = $1 AND status IN ('NEEDS_REFUND', 'DONE')
         ORDER BY CASE status WHEN 'NEEDS_REFUND' THEN 0 ELSE 1 END, "createdAt" DESC LIMIT 1`,
        input.trialLeadId,
    );
    const found = rows[0];
    if (!found || !found.paymentKey) return { ok: false, message: "온라인으로 낸 체험비가 없어요. 계좌로 받은 체험비는 직접 돌려주세요." };
    const row = { ...found, trialLeadId: input.trialLeadId, paymentKey: found.paymentKey };
    const actor = { userId: input.adminUserId, userName: input.adminName };
    const apply = async (payment: TossResult) => {
        const applied = await prisma.$transaction((tx) => applyTrialFeeFullCancelInTx(tx, {
            paymentRowId: row.id,
            trialLeadId: row.trialLeadId,
            rawResponse: stripPaymentSecret(payment),
            actor,
        }));
        revalidateTrialCaches();
        return { ok: true as const, alreadyApplied: !applied.changed };
    };

    const before = await getVerifiedTossPayment(row.paymentKey, row.orderId);
    if (before.kind !== "verified") return { ok: false, message: "토스에서 결제를 확인하지 못했어요. 잠시 후 다시 시도해 주세요." };
    const beforeCancel = classifyTossCancel(before.payment, { orderId: row.orderId, amount: Number(row.amount) }, row.paymentKey);
    if (beforeCancel.kind === "FULL_CANCEL") return apply(before.payment as TossResult);
    if (beforeCancel.kind === "PARTIAL_CANCEL") return { ok: false, message: "토스에서 일부만 취소된 결제예요. 토스 상점관리자에서 확인해 주세요." };
    const verified = before.payment as TossResult;
    if (verified.status !== "DONE" || verified.orderId !== row.orderId || Number(verified.totalAmount) !== Number(row.amount)) {
        return { ok: false, message: "토스 결제 상태가 장부와 달라 취소하지 않았어요. 토스 상점관리자에서 확인해 주세요." };
    }
    // 입금이 끝난 무통장입금은 환불받을 계좌가 있어야 토스가 돌려준다 — 청구 환불과 같이 여기서는 받지 않는다
    if (verified.method === VA_METHOD || row.method === VA_METHOD) {
        return { ok: false, message: "무통장입금으로 낸 체험비는 환불 계좌가 필요해요. 토스 상점관리자에서 환불해 주세요." };
    }

    // 기록 먼저(취소 요청 뒤 서버가 멈춰도 누가 눌렀는지 남게)
    await prisma.$executeRawUnsafe(
        `INSERT INTO "ApplicationContactLog" (
            id, "targetType", "trialLeadId", "enrollmentApplicationId", action, note,
            "createdByUserId", "createdByName", "createdAt", "updatedAt"
        ) VALUES (gen_random_uuid()::text, 'TRIAL', $1, NULL, 'UPDATED', $2, $3, $4, NOW(), NOW())`,
        row.trialLeadId,
        `체험비 환불 요청(토스 전액 취소 · 주문 ${row.orderId})`,
        input.adminUserId,
        input.adminName,
    );

    const { secretKey } = getPaymentProviderConfig();
    if (!secretKey) return { ok: false, message: "토스 결제 키가 설정되어 있지 않아요." };
    let tossError: string | null = null;
    try {
        const response = await fetch(`https://api.tosspayments.com/v1/payments/${encodeURIComponent(row.paymentKey)}/cancel`, {
            method: "POST",
            headers: {
                Authorization: `Basic ${encodeTossSecret(secretKey)}`,
                "Content-Type": "application/json",
                // 10분 칸 번호 — 같은 버튼을 연달아 눌러도 토스가 한 번만 처리한다(청구 환불과 같은 방식)
                "Idempotency-Key": makeUuidFromSeed(`stiz-trial-refund:${row.id}:${row.paymentKey}:${Math.floor(Date.now() / 600_000)}`),
            },
            body: JSON.stringify({ cancelReason: "체험수업 취소 환불" }),
            cache: "no-store",
            signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) tossError = await readTossErrorMessage(response) ?? `토스 응답 ${response.status}`;
    } catch {
        tossError = "토스 응답이 없어요";
    }

    const after = await getVerifiedTossPayment(row.paymentKey, row.orderId);
    if (after.kind === "verified") {
        const cancel = classifyTossCancel(after.payment, { orderId: row.orderId, amount: Number(row.amount) }, row.paymentKey);
        if (cancel.kind === "FULL_CANCEL") return apply(after.payment as TossResult);
        if (cancel.kind === "PARTIAL_CANCEL") return { ok: false, message: "토스에서 일부만 취소됐어요. 토스 상점관리자에서 확인해 주세요." };
    }
    return { ok: false, message: tossError ? `토스가 취소하지 않았어요(${tossError}).` : "취소가 확인되지 않았어요. 잠시 후 다시 확인해 주세요." };
}

// ───────────────────────────── ⑥ 매일 점검(무통장입금 기한 지난 계좌) ─────────────────────────────

export type TrialSweepResult = { checked: number; paid: number; released: number; waiting: number; failed: number; deferred: number };

/**
 * 체험비 무통장입금 «입금 대기» 중 기한이 지난 계좌를 토스에 다시 물어 실제 상태로 정리한다(매일 가상계좌 점검 크론이 부른다).
 * 판정은 청구 점검과 같은 decideVirtualAccountClose — 입금됨(DONE) = 확정 반영, 만료·취소 = «입금 대기» 해제,
 * 토스가 아직 입금 대기면 그대로(다음 날 다시), 부분 취소 등 애매하면 원장 알림. 장부는 재조회 결과로만 바꾼다(멱등).
 */
export async function sweepTrialVirtualAccounts(limit = 50, budgetMs = 10_000): Promise<TrialSweepResult> {
    const startedAt = Date.now();
    const result: TrialSweepResult = { checked: 0, paid: 0, released: 0, waiting: 0, failed: 0, deferred: 0 };
    const rows = await prisma.$queryRawUnsafe<TrialFeePaymentRow[]>(
        `SELECT * FROM "TrialFeePayment"
         WHERE status = 'WAITING_FOR_DEPOSIT' AND "paymentKey" IS NOT NULL AND "trialLeadId" IS NOT NULL
         ORDER BY "createdAt" ASC LIMIT $1`,
        limit,
    );
    // 기한(발급 정보의 dueDate)이 지난 계좌만 — 기한 안의 계좌는 입금 알림을 기다린다
    const nowMs = Date.now();
    const due = rows.filter((row) => virtualAccountViewOf(row, nowMs)?.expired !== false);
    for (const found of due) {
        if (Date.now() - startedAt > budgetMs) {
            result.deferred = due.length - result.checked;
            break;
        }
        result.checked += 1;
        try {
            const row: LinkedPaymentRow = { ...found, trialLeadId: found.trialLeadId as string };
            const lookup = await getVerifiedTossPayment(row.paymentKey, row.orderId);
            if (lookup.kind !== "verified") {
                result.failed += 1;
                continue;
            }
            const verified = lookup.payment as TossResult;
            const step = decideVirtualAccountClose(verified, { orderId: row.orderId, paymentKey: row.paymentKey });
            if (step === "PAID" && classifyTrialTossResult(verified, { orderId: row.orderId, amount: Number(row.amount) }, row.paymentKey) === "DONE") {
                const finalized = await finalizePaid(row, verified);
                if (finalized.kind === "PAID" || finalized.kind === "DUPLICATE") result.paid += 1;
            } else if (step === "RELEASED") {
                const released = await prisma.$transaction((tx) => releaseTrialVirtualAccountInTx(tx, {
                    paymentRowId: row.id,
                    trialLeadId: row.trialLeadId,
                    status: verified.status === "EXPIRED" ? "EXPIRED" : "CANCELED",
                }));
                if (released) {
                    result.released += 1;
                    revalidateTrialCaches();
                }
            } else if (step === "CANCEL") {
                // 토스는 아직 입금 대기 — 기한이 지나면 은행이 입금을 받지 않는다. 다음 점검에서 다시 본다.
                result.waiting += 1;
            } else {
                result.failed += 1;
                await alertOwner(`[체험비] 입금 대기 계좌의 토스 상태를 확인할 수 없어요(주문 ${row.orderId}, 토스 상태 ${String(verified.status ?? "없음")}). 토스 상점관리자에서 확인해 주세요.`);
            }
        } catch (error) {
            result.failed += 1;
            console.error("[trial-fee] 입금 대기 점검 실패:", error instanceof Error ? error.message : error);
        }
    }
    return result;
}
