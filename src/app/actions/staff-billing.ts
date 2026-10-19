"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireAdmin, requireStaff } from "@/lib/auth-guard";
import { requireStaffStudentAccess } from "@/lib/staff-class-access";
import { resolveStaffBillingGuard } from "@/lib/staff-billing-policy";
import { getStaffAttendanceBilling, getStaffSessionMonthlyFees } from "@/lib/staff-monthly-fees";
import type { StaffSessionMonthlyFees } from "@/lib/staff-monthly-fee-types";
import {
  getStaffClassBilling,
  type StaffClassBillingItem,
} from "@/lib/staff-class-billing";

const METHODS = new Set(["CASH", "BANK_TRANSFER"]);

export async function loadStaffSessionMonthlyFees(input: { sessionId: string }): Promise<StaffSessionMonthlyFees> {
  return getStaffSessionMonthlyFees(input.sessionId?.trim());
}

export async function loadStaffAttendanceBilling(input: { sessionId: string; rosterId: string }) {
  const rosterId = input.rosterId?.trim();
  if (!rosterId || rosterId.length > 128) throw new Error('학생 정보가 올바르지 않습니다.');
  return getStaffAttendanceBilling(input.sessionId?.trim(), rosterId);
}

export type SerializedStaffClassBillingItem = Omit<
  StaffClassBillingItem,
  "dueDate" | "paidDate"
> & {
  dueDate: string;
  paidDate: string | null;
};

export async function loadStaffClassBilling(input: {
  classId: string;
  studentId?: string;
}): Promise<{ ok: true; items: SerializedStaffClassBillingItem[] }> {
  const classId = input.classId?.trim();
  const studentId = input.studentId?.trim() || undefined;
  if (!classId || classId.length > 128 || (studentId && studentId.length > 128)) {
    throw new Error("수업 또는 학생 정보가 올바르지 않습니다.");
  }

  const items = await getStaffClassBilling(classId, studentId);
  return {
    ok: true,
    items: items.map((item) => ({
      ...item,
      dueDate: item.dueDate.toISOString(),
      paidDate: item.paidDate?.toISOString() ?? null,
    })),
  };
}

export async function requestStaffPaymentConfirmation(input: { paymentId: string; method: string; receivedAt: string; note?: string }) {
  const staff = await requireStaff();
  const paymentId = input.paymentId.trim();
  const method = input.method.trim();
  const receivedAt = new Date(input.receivedAt);
  if (!paymentId || !METHODS.has(method) || Number.isNaN(receivedAt.getTime()) || receivedAt.getTime() > Date.now() + 60_000) {
    return { ok: false as const, message: "납부 확인 정보가 올바르지 않습니다." };
  }
  // 결제-청구서는 paymentId로만 잇습니다. 예전처럼 반/학생/금액을 조인 조건에 넣으면
  // 값이 하나라도 어긋난 순간 청구가 "없는 것"이 되어 원인 없는 실패가 됩니다.
  const rows = await prisma.$queryRawUnsafe<Array<{ id: string; classId: string | null; studentId: string; amount: number; status: string; invoiceId: string; invoiceStatus: string; issuedAt: Date; invoiceAmount: number; invoiceStudentId: string }>>(
    `SELECT p.id,p."classId",p."studentId",p.amount,p.status,i.id AS "invoiceId",i.status AS "invoiceStatus",i."issuedAt",
            i.amount AS "invoiceAmount",i."studentId" AS "invoiceStudentId" FROM "Payment" p
     JOIN "PaymentInvoice" i ON i."paymentId"=p.id
     WHERE p.id=$1 LIMIT 1`, paymentId,
  );
  const payment = rows[0];
  if (!payment?.invoiceId) return { ok: false as const, message: "청구서가 연결된 항목만 처리할 수 있습니다." };
  // 화면의 버튼 비활성화와 똑같은 판정을 서버에서 다시 확인합니다.
  // 반 정보가 없는 과거 청구는 DB 복합 외래키를 만족할 수 없어, 500 대신 사유를 돌려줍니다.
  const guard = resolveStaffBillingGuard({
    paymentClassId: payment.classId,
    amountMismatch: payment.amount !== payment.invoiceAmount,
    studentMismatch: payment.studentId !== payment.invoiceStudentId,
  });
  if (!guard.confirmable || !payment.classId) return { ok: false as const, message: guard.blockReason ?? "지금은 수납 확인을 요청할 수 없습니다." };
  if (receivedAt.getTime() < payment.issuedAt.getTime() - 5 * 60_000 || receivedAt.getTime() < Date.now() - 31 * 24 * 60 * 60_000) {
    return { ok: false as const, message: "수납 일시는 청구서 발행 이후 최근 31일 안에서만 입력할 수 있습니다." };
  }
  await requireStaffStudentAccess(payment.classId, payment.studentId);
  if (!['PENDING','OVERDUE'].includes(payment.status)) return { ok: false as const, message: "이미 처리되었거나 취소된 청구입니다." };
  if (['PAID','CANCELED'].includes(payment.invoiceStatus)) return { ok: false as const, message: "이미 납부되었거나 취소된 청구서입니다." };
  try {
    await prisma.$executeRawUnsafe(
      `INSERT INTO "StaffPaymentConfirmationRequest" (id,"paymentId","invoiceId","classId","studentId","requestedByUserId",method,amount,"receivedAt",note,status,"createdAt","updatedAt")
       VALUES (gen_random_uuid()::text,$1,$2,$3,$4,$5,$6,$7,$8,$9,'PENDING',NOW(),NOW())`,
      payment.id,payment.invoiceId,payment.classId,payment.studentId,staff.appUserId,method,payment.amount,receivedAt,input.note?.trim().slice(0,500)||null,
    );
  } catch (error) {
    if (error instanceof Error && /unique|duplicate/i.test(error.message)) return { ok: false as const, message: "이미 확인 대기 중인 요청이 있습니다." };
    throw error;
  }
  revalidatePath('/staff/billing'); revalidatePath(`/staff/classes/${payment.classId}`); revalidatePath('/admin/payment-confirmations');
  return { ok: true as const, message: "관리자에게 납부 확인을 요청했습니다." };
}

export async function reviewStaffPaymentConfirmation(input: { requestId: string; decision: 'APPROVED'|'REJECTED'; note?: string }) {
  const admin = await requireAdmin();
  const requestId = input.requestId.trim();
  if (!requestId || !['APPROVED','REJECTED'].includes(input.decision)) throw new Error("검토 정보가 올바르지 않습니다.");
  await prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRawUnsafe<Array<{ id:string; paymentId:string; invoiceId:string|null; classId:string; studentId:string; requestedByUserId:string; method:string; amount:number; receivedAt:Date; status:string }>>(
      `SELECT * FROM "StaffPaymentConfirmationRequest" WHERE id=$1 FOR UPDATE`, requestId,
    );
    const request = rows[0];
    if (!request || request.status !== 'PENDING') throw new Error("이미 검토된 요청입니다.");
    if (input.decision === 'REJECTED') {
      await tx.$executeRawUnsafe(`UPDATE "StaffPaymentConfirmationRequest" SET status='REJECTED',"reviewedByUserId"=$2,"reviewedAt"=NOW(),"reviewNote"=$3,"updatedAt"=NOW() WHERE id=$1`,request.id,admin.appUserId,input.note?.trim().slice(0,500)||null);
      return;
    }
    const payments = await tx.$queryRawUnsafe<Array<{ id:string; classId:string|null; studentId:string; amount:number; status:string }>>(`SELECT id,"classId","studentId",amount,status FROM "Payment" WHERE id=$1 FOR UPDATE`,request.paymentId);
    const payment = payments[0];
    if (!payment || payment.classId!==request.classId || payment.studentId!==request.studentId || payment.amount!==request.amount || !['PENDING','OVERDUE'].includes(payment.status)) throw new Error("청구 상태가 요청 당시와 달라 승인할 수 없습니다.");
    if (!request.invoiceId) throw new Error("연결된 청구서가 없어 승인할 수 없습니다.");
    const invoices = await tx.$queryRawUnsafe<Array<{ id:string; paymentId:string; classId:string|null; studentId:string; amount:number; status:string; issuedAt:Date }>>(
      `SELECT id,"paymentId","classId","studentId",amount,status,"issuedAt" FROM "PaymentInvoice" WHERE id=$1 FOR UPDATE`, request.invoiceId,
    );
    const invoice = invoices[0];
    if (!invoice || invoice.paymentId!==payment.id || invoice.classId!==payment.classId || invoice.studentId!==payment.studentId || invoice.amount!==payment.amount || ['PAID','CANCELED'].includes(invoice.status)
      || request.receivedAt.getTime() < invoice.issuedAt.getTime() - 5 * 60_000 || request.receivedAt.getTime() > Date.now() + 60_000) {
      throw new Error("청구서 상태가 요청 당시와 달라 승인할 수 없습니다.");
    }
    const transactionId = crypto.randomUUID();
    const paymentUpdated = await tx.$executeRawUnsafe(`UPDATE "Payment" SET status='PAID',method=$2,"paidDate"=$3,"paidProvider"='MANUAL',"updatedAt"=NOW() WHERE id=$1 AND status IN ('PENDING','OVERDUE')`,payment.id,request.method,request.receivedAt);
    const invoiceUpdated = await tx.$executeRawUnsafe(`UPDATE "PaymentInvoice" SET status='PAID',"paidAt"=$2,"updatedAt"=NOW() WHERE id=$1 AND "paymentId"=$3 AND status NOT IN ('PAID','CANCELED')`,request.invoiceId,request.receivedAt,payment.id);
    if (paymentUpdated !== 1 || invoiceUpdated !== 1) throw new Error("결제 원장을 함께 갱신하지 못했습니다.");
    await tx.$executeRawUnsafe(`INSERT INTO "PaymentTransaction" (id,"paymentId","invoiceId","studentId",provider,"orderId","orderName",amount,status,method,"approvedAt","createdAt","updatedAt") VALUES ($1,$2,$3,$4,'MANUAL',$5,'교사 수납 확인',$6,'DONE',$7,$8,NOW(),NOW())`,transactionId,payment.id,request.invoiceId,request.studentId,`MANUAL-${request.id}`,request.amount,request.method,request.receivedAt);
    await tx.$executeRawUnsafe(`INSERT INTO "PaymentAuditLog" (id,"paymentId","invoiceId","transactionId","actorType","actorId",action,message,metadata,"createdAt") VALUES (gen_random_uuid()::text,$1,$2,$3,'ADMIN',$4,'STAFF_PAYMENT_CONFIRMED','교사 수납 확인 요청 승인',$5::jsonb,NOW())`,payment.id,request.invoiceId,transactionId,admin.appUserId,JSON.stringify({requestId:request.id,requestedByUserId:request.requestedByUserId}));
    await tx.$executeRawUnsafe(`UPDATE "StaffPaymentConfirmationRequest" SET status='APPROVED',"reviewedByUserId"=$2,"reviewedAt"=NOW(),"reviewNote"=$3,"updatedAt"=NOW() WHERE id=$1`,request.id,admin.appUserId,input.note?.trim().slice(0,500)||null);
  });
  revalidatePath('/staff/billing'); revalidatePath('/admin/payment-confirmations');
  return { ok:true as const };
}
