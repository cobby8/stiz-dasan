"use server";

/**
 * 관리자 «결제 링크 복사»(학생 상세 «청구/수납» ⚡ 메뉴, 2026-11-14) — 가입하지 않은 학부모에게 카톡으로 직접 붙여 보낼
 * 청구서 한 장 전용 비회원 결제 링크(/pay/<토큰>)를 발급한다.
 *  - 권한: 재무 소유자(원장) — 화면 메뉴 표시(isFinanceOwnerRole)와 같은 기준. 링크 = 결제 열쇠라 원장만.
 *  - IDOR: 화면이 보낸 학생 id 와 청구가 맞아야 하고, 미납·연체 청구만 발급한다.
 *  - 감사 기록(PaymentAuditLog GUEST_PAY_LINK_ISSUED): 누가·어느 청구에·언제까지 유효한 링크를 만들었는지. 토큰 원문은 남기지 않는다.
 */
import { requireAdmin } from "@/lib/auth-guard";
import { prisma } from "@/lib/prisma";
import { ensureInvoiceForPayment, recordPaymentAudit } from "@/lib/payment-ledger";
import { isFinanceOwnerRole } from "@/lib/payments/studentBillingRules";
import { getOrCreateInvoiceGuestLink, revokeInvoiceGuestLinks } from "@/lib/payments/guestPayLinkService";

export type GuestPayLinkActionResult =
    | { ok: true; url: string; lastYmd: string }
    | { ok: false; message: string };

export async function createGuestPayLinkForPayment(input: { studentId: string; paymentId: string }): Promise<GuestPayLinkActionResult> {
    const admin = await requireAdmin();
    if (!isFinanceOwnerRole(admin.appUserRole)) {
        return { ok: false, message: "원장 권한이 필요합니다." };
    }
    const studentId = String(input?.studentId ?? "").trim();
    const paymentId = String(input?.paymentId ?? "").trim();
    if (!studentId || !paymentId) return { ok: false, message: "청구를 다시 선택해 주세요." };

    try {
        // 이 학생의 미납·연체 청구인가(화면 값만 믿지 않는다)
        const rows = await prisma.$queryRawUnsafe<Array<{ status: string; invoiceId: string | null }>>(
            `SELECT p.status, i.id AS "invoiceId"
               FROM "Payment" p
               LEFT JOIN "PaymentInvoice" i ON i."paymentId" = p.id
              WHERE p.id = $1 AND p."studentId" = $2
              LIMIT 1`,
            paymentId,
            studentId,
        );
        const row = rows[0];
        if (!row) return { ok: false, message: "청구를 찾을 수 없습니다. 다시 조회해 주세요." };
        if (row.status !== "PENDING" && row.status !== "OVERDUE") {
            return { ok: false, message: "미납·연체 청구만 결제 링크를 만들 수 있습니다." };
        }
        // 청구서가 아직 없으면(예전 청구) 기존 함수로 만든다
        const invoiceId = row.invoiceId ?? (await ensureInvoiceForPayment(paymentId))?.id ?? null;
        if (!invoiceId) return { ok: false, message: "청구서를 만들지 못했습니다. 잠시 후 다시 시도해 주세요." };

        const link = await getOrCreateInvoiceGuestLink(invoiceId, { source: "ADMIN_COPY", createdByUserId: admin.appUserId });
        if (!link) return { ok: false, message: "결제할 수 없는 청구입니다(납부·취소 여부를 확인해 주세요)." };

        await recordPaymentAudit({
            paymentId,
            invoiceId,
            actorType: "ADMIN",
            actorId: admin.appUserId,
            action: "GUEST_PAY_LINK_ISSUED",
            message: `비회원 결제 링크 발급(관리자 복사) · ${link.lastYmd}까지`,
            metadata: { source: "ADMIN_COPY", studentId, lastYmd: link.lastYmd },
        }).catch((error) => console.error("[guest-pay] 감사 기록 실패:", error instanceof Error ? error.message : error));

        return { ok: true, url: link.url, lastYmd: link.lastYmd };
    } catch (error) {
        console.error("[guest-pay] 링크 발급 실패:", error);
        return { ok: false, message: "결제 링크를 만들지 못했습니다. 잠시 후 다시 시도해 주세요." };
    }
}

export type GuestPayLinkRevokeResult = { ok: true; count: number } | { ok: false; message: string };

/**
 * 관리자 «결제 링크 모두 닫기»(학생 상세 ⚡ 메뉴, 검수 권장 2) — 이 청구의 살아 있는 비회원 링크를 전부 닫는다.
 * 이미 보낸 알림톡·문자·카톡의 링크도 그 순간부터 «링크가 만료됐거나 올바르지 않아요»가 된다.
 *  - 권한: 원장(발급과 같은 기준) · IDOR: 학생 id 와 청구가 맞아야 한다(상태는 묻지 않는다 — 납부 뒤에도 닫을 수 있게).
 *  - 감사 기록 GUEST_PAY_LINK_REVOKED(닫은 개수).
 */
export async function revokeGuestPayLinksForPayment(input: { studentId: string; paymentId: string }): Promise<GuestPayLinkRevokeResult> {
    const admin = await requireAdmin();
    if (!isFinanceOwnerRole(admin.appUserRole)) {
        return { ok: false, message: "원장 권한이 필요합니다." };
    }
    const studentId = String(input?.studentId ?? "").trim();
    const paymentId = String(input?.paymentId ?? "").trim();
    if (!studentId || !paymentId) return { ok: false, message: "청구를 다시 선택해 주세요." };

    try {
        const rows = await prisma.$queryRawUnsafe<Array<{ invoiceId: string | null }>>(
            `SELECT i.id AS "invoiceId"
               FROM "Payment" p
               LEFT JOIN "PaymentInvoice" i ON i."paymentId" = p.id
              WHERE p.id = $1 AND p."studentId" = $2
              LIMIT 1`,
            paymentId,
            studentId,
        );
        const row = rows[0];
        if (!row) return { ok: false, message: "청구를 찾을 수 없습니다. 다시 조회해 주세요." };
        // 청구서가 없으면 링크도 없다
        const count = row.invoiceId ? await revokeInvoiceGuestLinks(row.invoiceId) : 0;

        await recordPaymentAudit({
            paymentId,
            invoiceId: row.invoiceId,
            actorType: "ADMIN",
            actorId: admin.appUserId,
            action: "GUEST_PAY_LINK_REVOKED",
            message: `비회원 결제 링크 ${count}개 닫음`,
            metadata: { studentId, count },
        }).catch((error) => console.error("[guest-pay] 감사 기록 실패:", error instanceof Error ? error.message : error));

        return { ok: true, count };
    } catch (error) {
        console.error("[guest-pay] 링크 닫기 실패:", error);
        return { ok: false, message: "결제 링크를 닫지 못했습니다. 잠시 후 다시 시도해 주세요." };
    }
}
