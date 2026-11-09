import { prisma } from "@/lib/prisma";
import { markPaymentPaid } from "@/lib/payment-ledger";
import {
  PAYMENT_METHOD_LABEL,
  PAYMENT_REQUEST_KIND_LABEL,
  RECEIPT_TYPE_LABEL,
  type PaymentMethodKind,
  type PaymentRequestKind,
  type ReceiptType,
} from "@/lib/payments/parentRequestRules";

// ── 원장의 입금 확인·영수증 요청 처리 ────────────────────────────────────────
//
// 승인하면 실제로 납부 처리까지 간다(기존 markPaymentPaid 재사용 — 청구서 상태·감사
// 기록이 함께 맞춰진다). 여기서 Payment 만 직접 UPDATE 하면 PaymentInvoice 가 어긋난다.

export type AdminPaymentRequestRow = {
  id: string;
  kind: string;
  kindLabel: string;
  studentName: string;
  description: string | null;
  amount: number;
  paymentStatus: string;
  dueDate: string | null;
  paidOn: string | null;
  methodLabel: string | null;
  depositorName: string | null;
  receiptTypeLabel: string | null;
  receiptTarget: string | null;
  note: string | null;
  status: string;
  decisionNote: string | null;
  createdAt: string;
};

export async function getPaymentParentRequests(status = "PENDING"): Promise<AdminPaymentRequestRow[]> {
  const rows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT r.id, r.kind, r.status, r."decisionNote", r.note,
            r."depositorName", r.method, r."receiptType", r."receiptTarget",
            to_char(r."paidOn",'YYYY-MM-DD') AS "paidOn",
            to_char(r."createdAt" AT TIME ZONE 'Asia/Seoul','YYYY-MM-DD HH24:MI') AS "createdAt",
            s.name AS "studentName",
            p.description, p.amount, p.status AS "paymentStatus",
            to_char(p."dueDate",'YYYY-MM-DD') AS "dueDate"
       FROM "PaymentParentRequest" r
       JOIN "Student" s ON s.id = r."studentId"
       JOIN "Payment" p ON p.id = r."paymentId"
      WHERE ($1 = 'ALL' OR r.status = $1)
      ORDER BY r."createdAt" DESC
      LIMIT 200`,
    status,
  );
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    kindLabel: PAYMENT_REQUEST_KIND_LABEL[row.kind as PaymentRequestKind] ?? row.kind,
    studentName: row.studentName,
    description: row.description ?? null,
    amount: Number(row.amount ?? 0),
    paymentStatus: row.paymentStatus,
    dueDate: row.dueDate ?? null,
    paidOn: row.paidOn ?? null,
    methodLabel: row.method ? (PAYMENT_METHOD_LABEL[row.method as PaymentMethodKind] ?? row.method) : null,
    depositorName: row.depositorName ?? null,
    receiptTypeLabel: row.receiptType
      ? (RECEIPT_TYPE_LABEL[row.receiptType as ReceiptType] ?? row.receiptType)
      : null,
    receiptTarget: row.receiptTarget ?? null,
    note: row.note ?? null,
    status: row.status,
    decisionNote: row.decisionNote ?? null,
    createdAt: row.createdAt,
  }));
}

export async function decidePaymentParentRequest(input: {
  adminUserId: string;
  requestId: string;
  approve: boolean;
  note?: string | null;
  /** 영수증 요청을 처리하며 링크를 남길 때(선택) */
  receiptUrl?: string | null;
}) {
  const note = (input.note ?? "").trim().slice(0, 500) || null;

  // PENDING 만 처리한다. 두 번 눌러도 두 번 납부 처리되지 않는다.
  const rows = await prisma.$queryRawUnsafe<any[]>(
    `UPDATE "PaymentParentRequest"
        SET status = $2, "decidedByUserId" = $3, "decidedAt" = now(),
            "decisionNote" = $4, "updatedAt" = now()
      WHERE id = $1 AND status = 'PENDING'
      RETURNING id, kind, "paymentId", "studentId", method,
                to_char("paidOn",'YYYY-MM-DD') AS "paidOn"`,
    input.requestId, input.approve ? "DONE" : "REJECTED", input.adminUserId, note,
  );
  if (!rows[0]) return { ok: false as const, message: "이미 처리된 요청입니다." };
  const row = rows[0];

  if (input.approve && row.kind === "PAYMENT_CLAIM") {
    try {
      // 기존 납부 처리 경로를 그대로 쓴다. 청구서 상태·감사 기록이 함께 맞춰진다.
      await markPaymentPaid({
        paymentId: row.paymentId,
        actorType: "ADMIN",
        actorId: input.adminUserId,
        method: row.method ?? "MANUAL",
        // 학부모가 직접 입금한 건 = 사람 확인 납부. 예전 토스 결제(묶음 포함)가 환불된 뒤 다시 납부된 청구가
        // 옛 TOSS 표시를 달고 남으면, 그 옛 토스 주문의 전액 취소 때 이 청구까지 환불될 수 있다(2026-11-09 결제 재검수)
        provider: "MANUAL",
        paidAt: row.paidOn ?? null,
      });
    } catch (error) {
      // 납부 처리가 실패하면 요청도 되돌린다. "처리 완료"인데 미납인 상태를 남기면
      // 원장도 학부모도 무엇이 맞는지 알 수 없다.
      await prisma.$executeRawUnsafe(
        `UPDATE "PaymentParentRequest"
            SET status = 'PENDING', "decidedByUserId" = NULL, "decidedAt" = NULL,
                "decisionNote" = NULL, "updatedAt" = now()
          WHERE id = $1`,
        input.requestId,
      );
      console.error("[admin-payment-request] 납부 처리 실패:", error);
      return { ok: false as const, message: "납부 처리에 실패했습니다. 수납 화면에서 직접 확인해 주세요." };
    }
  }

  if (input.approve && row.kind === "RECEIPT" && input.receiptUrl?.trim()) {
    await prisma.$executeRawUnsafe(
      `UPDATE "Payment" SET "receiptUrl" = $2, "updatedAt" = now() WHERE id = $1`,
      row.paymentId, input.receiptUrl.trim().slice(0, 500),
    );
  }

  await notifyParentOfPaymentDecision({
    studentId: row.studentId,
    kind: row.kind,
    approved: input.approve,
    note,
  });

  return { ok: true as const };
}

async function notifyParentOfPaymentDecision(input: {
  studentId: string;
  kind: string;
  approved: boolean;
  note: string | null;
}) {
  try {
    const { notifyParentsOfStudents } = await import("@/lib/notification");
    const label = PAYMENT_REQUEST_KIND_LABEL[input.kind as PaymentRequestKind] ?? "요청";
    const isClaim = input.kind === "PAYMENT_CLAIM";
    const title = input.approved ? `${label} 처리 완료` : `${label} 결과`;
    const message = input.approved
      ? isClaim
        ? "입금이 확인되어 납부 처리되었습니다."
        : "영수증이 발급되었습니다."
      : `확인되지 않았습니다.${input.note ? ` (${input.note})` : " 학원으로 문의해 주세요."}`;
    await notifyParentsOfStudents([input.studentId], "PAYMENT_REQUEST", title, message, "/mypage/payments");
  } catch (error) {
    // 알림 실패가 처리를 되돌리면 안 된다. 원장은 이미 결정했다.
    console.error("[admin-payment-request] 학부모 알림 실패:", error);
  }
}
