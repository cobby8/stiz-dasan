import { childAccessSql } from "@/lib/account/child-access";
import { prisma } from "@/lib/prisma";
import { notMergedStudent } from "@/lib/studentVisibility";
import {
  PAYMENT_REQUEST_MESSAGE,
  validatePaymentRequest,
  type PaymentRequestKind,
} from "@/lib/payments/parentRequestRules";

// ── 학부모의 청구서 요청(입금 확인·영수증) ──────────────────────────────────
//
// ★ 보안 가드(반드시 유지):
//   1) IDOR 방어 — paymentId 가 그 부모(appUserId)의 자녀 청구서인지 SQL 로 재검증.
//   2) 상태는 DB 에서 읽는다 — 클라이언트가 보낸 "납부 여부"를 믿으면 미납 건에
//      영수증을 발급하거나 이미 낸 건에 확인 요청을 넣을 수 있다.
//   3) 같은 청구서·같은 종류의 대기 요청은 한 건(DB 부분 유니크가 최종 방어선).

function kstTodayYmd(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

export type ParentPaymentRow = {
  paymentId: string;
  studentId: string;
  studentName: string;
  description: string | null;
  amount: number;
  status: string;
  dueDate: string | null;
  paidDate: string | null;
  invoiceNo: string | null;
  receiptUrl: string | null;
  /** 진행 중인 요청(종류별로 최대 한 건씩) */
  pending: { id: string; kind: string; createdAt: string }[];
  /** 처리 완료된 최근 요청 — 학부모가 결과를 확인할 수 있게 */
  resolved: { id: string; kind: string; status: string; decisionNote: string | null; decidedAt: string | null }[];
};

export async function getParentPaymentRequests(parentUserId: string): Promise<ParentPaymentRow[]> {
  const rows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT p.id AS "paymentId", s.id AS "studentId", s.name AS "studentName",
            p.description, p.amount, p.status, p."receiptUrl",
            to_char(p."dueDate",'YYYY-MM-DD') AS "dueDate",
            to_char(p."paidDate",'YYYY-MM-DD') AS "paidDate",
            i."invoiceNo"
       FROM "Payment" p
       JOIN "Student" s ON s.id = p."studentId"
       LEFT JOIN "PaymentInvoice" i ON i."paymentId" = p.id
      WHERE ${await childAccessSql("s", "$1")} AND ${notMergedStudent("s")}
        AND p.status <> 'CANCELED'
      ORDER BY p."dueDate" DESC NULLS LAST
      LIMIT 60`,
    parentUserId,
  );
  if (rows.length === 0) return [];

  const requests = await prisma.$queryRawUnsafe<any[]>(
    `SELECT r.id, r."paymentId", r.kind, r.status, r."decisionNote",
            to_char(r."createdAt" AT TIME ZONE 'Asia/Seoul','YYYY-MM-DD HH24:MI') AS "createdAt",
            to_char(r."decidedAt" AT TIME ZONE 'Asia/Seoul','YYYY-MM-DD HH24:MI') AS "decidedAt"
       FROM "PaymentParentRequest" r
       JOIN "Student" s ON s.id = r."studentId"
      WHERE ${await childAccessSql("s", "$1")}
      ORDER BY r."createdAt" DESC`,
    parentUserId,
  );

  return rows.map((row) => ({
    paymentId: row.paymentId,
    studentId: row.studentId,
    studentName: row.studentName,
    description: row.description ?? null,
    amount: Number(row.amount ?? 0),
    status: row.status,
    dueDate: row.dueDate ?? null,
    paidDate: row.paidDate ?? null,
    invoiceNo: row.invoiceNo ?? null,
    receiptUrl: row.receiptUrl ?? null,
    pending: requests
      .filter((item) => item.paymentId === row.paymentId && item.status === "PENDING")
      .map((item) => ({ id: item.id, kind: item.kind, createdAt: item.createdAt })),
    resolved: requests
      .filter((item) => item.paymentId === row.paymentId && item.status !== "PENDING")
      .slice(0, 3)
      .map((item) => ({
        id: item.id,
        kind: item.kind,
        status: item.status,
        decisionNote: item.decisionNote ?? null,
        decidedAt: item.decidedAt ?? null,
      })),
  }));
}

export type SubmitPaymentRequestInput = {
  paymentId?: string;
  kind?: unknown;
  paidOn?: unknown;
  method?: unknown;
  depositorName?: unknown;
  receiptType?: unknown;
  receiptTarget?: unknown;
  note?: unknown;
};

export async function submitPaymentParentRequest(parentUserId: string, input: SubmitPaymentRequestInput) {
  const paymentId = typeof input.paymentId === "string" ? input.paymentId.trim() : "";
  if (!paymentId) return { ok: false as const, message: "청구서를 다시 선택해 주세요." };

  // 가드1+2: 소유권과 **현재 상태**를 DB 에서 함께 읽는다.
  const owned = await prisma.$queryRawUnsafe<any[]>(
    `SELECT p.id, p.status, p.amount, s.id AS "studentId", s.name AS "studentName", p.description
       FROM "Payment" p
       JOIN "Student" s ON s.id = p."studentId"
      WHERE p.id = $1 AND ${await childAccessSql("s", "$2")}
      LIMIT 1`,
    paymentId, parentUserId,
  );
  if (!owned[0]) return { ok: false as const, message: "본인 자녀의 청구서만 요청할 수 있습니다." };

  const checked = validatePaymentRequest(input, {
    paymentStatus: owned[0].status,
    today: kstTodayYmd(),
  });
  if (!checked.ok) return { ok: false as const, message: PAYMENT_REQUEST_MESSAGE[checked.error] };
  const kind: PaymentRequestKind = checked.kind;

  // 가드3: 같은 종류가 이미 대기 중이면 원장이 같은 일을 두 번 한다.
  const existing = await prisma.$queryRawUnsafe<any[]>(
    `SELECT 1 FROM "PaymentParentRequest"
      WHERE "paymentId" = $1 AND kind = $2 AND status = 'PENDING' LIMIT 1`,
    paymentId, kind,
  );
  if (existing.length > 0) {
    return { ok: false as const, message: "이미 확인 중인 요청이 있습니다. 결과를 기다려 주세요." };
  }

  const note = typeof input.note === "string" ? input.note.trim().slice(0, 500) || null : null;
  const isClaim = kind === "PAYMENT_CLAIM";

  await prisma.$executeRawUnsafe(
    `INSERT INTO "PaymentParentRequest"
        ("paymentId","studentId","requestedByUserId","kind","paidOn","method","depositorName",
         "receiptType","receiptTarget","note")
     VALUES ($1,$2,$3,$4,$5::date,$6,$7,$8,$9,$10)`,
    paymentId, owned[0].studentId, parentUserId, kind,
    isClaim ? String(input.paidOn) : null,
    isClaim ? String(input.method) : null,
    isClaim && typeof input.depositorName === "string" ? input.depositorName.trim().slice(0, 60) || null : null,
    isClaim ? null : String(input.receiptType),
    isClaim ? null : String(input.receiptTarget).trim().slice(0, 60),
    note,
  );

  await notifyAdminsOfPaymentRequest({
    kind,
    studentName: owned[0].studentName,
    description: owned[0].description,
    amount: Number(owned[0].amount ?? 0),
  });

  return { ok: true as const };
}

export async function cancelPaymentParentRequest(parentUserId: string, requestId: string) {
  const id = requestId?.trim();
  if (!id) return { ok: false as const, message: "취소할 요청을 찾을 수 없습니다." };

  // 원장이 이미 처리한 건은 학부모가 되돌릴 수 없다.
  const canceled = Number(
    await prisma.$executeRawUnsafe(
      `UPDATE "PaymentParentRequest" r
          SET status = 'CANCELED', "updatedAt" = now()
         FROM "Student" s
        WHERE r."studentId" = s.id AND ${await childAccessSql("s", "$1")}
          AND r.id = $2 AND r.status = 'PENDING'`,
      parentUserId, id,
    ),
  );
  if (canceled === 0) return { ok: false as const, message: "이미 처리된 요청은 취소할 수 없습니다." };
  return { ok: true as const };
}

/**
 * 요청이 들어온 것을 원장에게 알린다.
 * 알림 실패가 요청을 되돌리면 안 된다 — 학부모는 이미 요청을 마쳤다.
 */
async function notifyAdminsOfPaymentRequest(input: {
  kind: PaymentRequestKind;
  studentName: string;
  description: string | null;
  amount: number;
}) {
  try {
    const { notifyAdmins } = await import("@/lib/notification");
    const { PAYMENT_REQUEST_KIND_LABEL } = await import("@/lib/payments/parentRequestRules");
    const what = input.description || `${input.amount.toLocaleString()}원`;
    // 코치 SMS 는 보내지 않는다 — 수납은 원장이 처리한다.
    await notifyAdmins(
      "PAYMENT_REQUEST",
      PAYMENT_REQUEST_KIND_LABEL[input.kind],
      `${input.studentName} 학생 · ${what}`,
      "/admin/payment-requests",
      { notifyCoaches: false },
    );
  } catch (error) {
    console.error("[parent-payment-request] 원장 알림 실패:", error);
  }
}
