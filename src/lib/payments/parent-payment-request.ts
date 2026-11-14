import { childAccessSql } from "@/lib/account/child-access";
import { payerAccessSql } from "@/lib/payments/payerAccess";
import { prisma } from "@/lib/prisma";
import { notMergedStudent } from "@/lib/studentVisibility";
import {
  PAYMENT_REQUEST_MESSAGE,
  validatePaymentRequest,
  type PaymentRequestKind,
} from "@/lib/payments/parentRequestRules";
import { MAX_BUNDLE_ITEMS } from "@/lib/payments/checkoutBundle";
import { todayKst } from "@/lib/datetime/kst";
import { txCoversPaymentSql } from "@/lib/payments/bundleLedger";
import { parentVirtualAccountView, type PublicVirtualAccountView } from "@/lib/payments/virtualAccount";
import { periodCarryColumnsReady } from "@/lib/regular/absence-period-service";
import { illnessBillingHoldSql } from "@/lib/regular/illnessPeriodRules";

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
  /** 청구 종류(MONTHLY·SHUTTLE·SPECIAL…) — 세부 시트 항목 이름 */
  type?: string | null;
  /** 청구 대상 연·월 — 월 카드 묶음 기준(없으면 납기일의 달) */
  year?: number | null;
  month?: number | null;
  /** 결제수단(납부 완료 건) — 세부 시트에 «카드»·«현장 카드» 등으로 */
  method?: string | null;
  paidProvider?: string | null;
  dueDate: string | null;
  paidDate: string | null;
  invoiceNo: string | null;
  /** 온라인 결제 화면(/payments/[invoiceId])으로 가는 청구서 id. 청구서가 아직 없으면 null */
  invoiceId: string | null;
  /** 결제 담당(대표) 보호자인가 — 마이페이지 홈과 같은 기준(학생의 parentId 가 본인). 연결 가족은 결제 버튼 대신 안내만 본다. */
  canCheckout: boolean;
  receiptUrl: string | null;
  /**
   * 무통장입금 계좌(입금 대기·만료) — 대표 보호자에게만. 묶음 결제 계좌면 amount 가 이 청구 금액보다 크다(합계).
   * 마이페이지 홈 «납부할 청구» 줄이 같은 기준(이 목록)으로 계좌를 보여 준다(2026-11-09).
   */
  virtualAccount: PublicVirtualAccountView | null;
  /** 진행 중인 요청(종류별로 최대 한 건씩) */
  pending: { id: string; kind: string; createdAt: string }[];
  /** 처리 완료된 최근 요청 — 학부모가 결과를 확인할 수 있게 */
  resolved: { id: string; kind: string; status: string; decisionNote: string | null; decidedAt: string | null }[];
};

// 최근 입금 계좌(단건·묶음) — queries.ts 의 PARENT_VIRTUAL_ACCOUNT_LATERAL 과 같은 범위. secret(depositSecretHash)은 고르지 않는다
const PARENT_VA_LATERAL = `LEFT JOIN LATERAL (
         SELECT t.status, t."rawResponse"->'virtualAccountIssue' AS issue
           FROM "PaymentTransaction" t
          WHERE ${txCoversPaymentSql("t", "p.id")}
            AND t.status IN ('WAITING_FOR_DEPOSIT', 'EXPIRED')
            AND t."rawResponse"->'virtualAccountIssue' IS NOT NULL
          ORDER BY t."createdAt" DESC
          LIMIT 1
       ) va ON true`;

/**
 * 부상 결석이 승인돼 수강료 청구를 잠시 멈춘 자녀(2026-11-15 원장 결정) — 결제 화면이 «학원에 문의» 대신 상태를 그대로 보인다.
 * 판정은 illnessBillingHoldSql 한 곳(청구 준비와 같은 조건). 본인 자녀만(childAccessSql).
 * 기간 정산 칸이 없거나 조회가 실패하면 빈 목록 — 결제 화면 자체는 떠야 한다.
 */
export async function getParentBillingHolds(parentUserId: string): Promise<Array<{ studentId: string; studentName: string }>> {
  try {
    const ready = await periodCarryColumnsReady(prisma);
    if (!ready) return [];
    const rows = await prisma.$queryRawUnsafe<Array<{ studentId: string; studentName: string }>>(
      `SELECT s.id AS "studentId", s.name AS "studentName"
         FROM "Student" s
        WHERE ${await childAccessSql("s", "$1")} AND ${notMergedStudent("s")}
          AND ${illnessBillingHoldSql("s", ready)}
        ORDER BY s.name, s.id
        LIMIT 20`,
      parentUserId,
    );
    return rows.map((row) => ({ studentId: String(row.studentId), studentName: String(row.studentName ?? "") }));
  } catch (error) {
    console.error("[parent-billing-hold]", error instanceof Error ? error.name : "");
    return [];
  }
}

export async function getParentPaymentRequests(parentUserId: string): Promise<ParentPaymentRow[]> {
  const rows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT p.id AS "paymentId", s.id AS "studentId", s.name AS "studentName",
            p.description, p.amount, p.status, p."receiptUrl",
            -- 월 카드·세부 시트(2026-11-14): 종류·청구 달·결제수단
            p.type, p.year, p.month, p.method, p."paidProvider",
            -- 시간대 없는 칸 → «두 번» 바꿔 KST 날짜(아이 기록 childRecordQuery 와 같은 식. 한 번이면 9시간 밀린다)
            to_char(((p."dueDate" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Seoul'),'YYYY-MM-DD') AS "dueDate",
            to_char(((p."paidDate" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Seoul'),'YYYY-MM-DD') AS "paidDate",
            i."invoiceNo", i.id AS "invoiceId",
            -- 결제 버튼 = 결제 권한(대표 보호자 + 승인된 가족, payerAccess 한 곳 — 2026-11-13 f8)
            (${await payerAccessSql("s", "$1")}) AS "canCheckout",
            va.status AS "vaStatus", va.issue AS "vaIssue"
       FROM "Payment" p
       JOIN "Student" s ON s.id = p."studentId"
       LEFT JOIN "PaymentInvoice" i ON i."paymentId" = p.id
       ${PARENT_VA_LATERAL}
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
    type: row.type ?? null,
    year: row.year === null || row.year === undefined ? null : Number(row.year),
    month: row.month === null || row.month === undefined ? null : Number(row.month),
    method: row.method ?? null,
    paidProvider: row.paidProvider ?? null,
    dueDate: row.dueDate ?? null,
    paidDate: row.paidDate ?? null,
    invoiceNo: row.invoiceNo ?? null,
    invoiceId: row.invoiceId ?? null,
    canCheckout: row.canCheckout === true,
    receiptUrl: row.receiptUrl ?? null,
    // 계좌는 결제할 수 있는 보호자에게만(대표 + 승인된 가족) — 열린 계좌를 봐야 두 번째 보호자가 이중 결제하지 않는다(홈 getMyPageData 와 같은 규칙)
    virtualAccount: row.canCheckout === true ? parentVirtualAccountView(row.status, row.vaStatus, row.vaIssue, Date.now()) : null,
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

export type SubmitBundlePaymentClaimInput = {
  paymentIds?: unknown;
  paidOn?: unknown;
  method?: unknown;
  depositorName?: unknown;
  note?: unknown;
};

/**
 * 묶음 «입금했어요» — 계좌로 직접 입금한 청구 여러 건을 한 번에 알린다(2026-11-09 묶음 결제).
 * 서버는 건마다 PAYMENT_CLAIM 을 하나씩 만든다(원장 확인 화면·처리 흐름은 단건과 같다).
 *
 * ★ 단건과 같은 보안 가드:
 *   1) IDOR — 고른 청구 전부가 내 자녀(childAccessSql) 청구인지 SQL 로 재검증. 하나라도 아니면 전부 거절.
 *   2) 상태는 DB 에서 읽는다 — 하나라도 이미 납부면 전부 거절(validatePaymentRequest 한 벌).
 *   3) 이미 확인 중인 청구는 건너뛰고 알려 준다(DB 부분 유니크가 최종 방어선 — 겹치면 트랜잭션 전체가 되돌아간다).
 */
export async function submitBundlePaymentClaim(parentUserId: string, input: SubmitBundlePaymentClaimInput) {
  const rawIds = Array.isArray(input.paymentIds) ? input.paymentIds : [];
  const ids = rawIds.map((value) => (typeof value === "string" ? value.trim() : ""));
  if (ids.length === 0 || ids.some((id) => !id)) return { ok: false as const, message: "청구서를 다시 선택해 주세요." };
  if (new Set(ids).size !== ids.length) return { ok: false as const, message: "같은 청구가 두 번 들어 있어요. 다시 선택해 주세요." };
  if (ids.length > MAX_BUNDLE_ITEMS) {
    return { ok: false as const, message: `한 번에 알릴 수 있는 청구는 ${MAX_BUNDLE_ITEMS}건까지예요.` };
  }

  // 가드1+2: 소유권과 **현재 상태**를 DB 에서 함께 읽는다.
  const owned = await prisma.$queryRawUnsafe<any[]>(
    `SELECT p.id, p.status, p.amount, s.id AS "studentId", s.name AS "studentName", p.description
       FROM "Payment" p
       JOIN "Student" s ON s.id = p."studentId"
      WHERE p.id = ANY($1::text[]) AND ${await childAccessSql("s", "$2")} AND ${notMergedStudent("s")}`,
    ids, parentUserId,
  );
  if (owned.length !== ids.length) return { ok: false as const, message: "본인 자녀의 청구서만 요청할 수 있습니다." };

  const today = todayKst();
  for (const row of owned) {
    const checked = validatePaymentRequest({ ...input, kind: "PAYMENT_CLAIM" }, { paymentStatus: row.status, today });
    if (!checked.ok) return { ok: false as const, message: PAYMENT_REQUEST_MESSAGE[checked.error] };
  }

  // 가드3: 이미 확인 중인 청구는 건너뛴다(원장이 같은 일을 두 번 하지 않게)
  const pendingRows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT "paymentId" FROM "PaymentParentRequest"
      WHERE "paymentId" = ANY($1::text[]) AND kind = 'PAYMENT_CLAIM' AND status = 'PENDING'`,
    ids,
  );
  const alreadyPending = new Set<string>(pendingRows.map((row) => String(row.paymentId)));
  const targets = owned.filter((row) => !alreadyPending.has(String(row.id)));
  if (targets.length === 0) {
    return { ok: false as const, message: "이미 확인 중인 요청이 있습니다. 결과를 기다려 주세요." };
  }

  const note = typeof input.note === "string" ? input.note.trim().slice(0, 500) || null : null;
  const depositorName = typeof input.depositorName === "string" ? input.depositorName.trim().slice(0, 60) || null : null;
  // 전부 아니면 전무 — 중간에 하나가 막히면(동시 요청) 아무것도 남기지 않는다
  await prisma.$transaction(async (db) => {
    for (const row of targets) {
      await db.$executeRawUnsafe(
        `INSERT INTO "PaymentParentRequest"
            ("paymentId","studentId","requestedByUserId","kind","paidOn","method","depositorName",
             "receiptType","receiptTarget","note")
         VALUES ($1,$2,$3,'PAYMENT_CLAIM',$4::date,$5,$6,NULL,NULL,$7)`,
        row.id, row.studentId, parentUserId, String(input.paidOn), String(input.method), depositorName, note,
      );
    }
  });

  // 원장 알림은 한 번만(건수·합계)
  const total = targets.reduce((acc, row) => acc + Number(row.amount ?? 0), 0);
  await notifyAdminsOfPaymentRequest({
    kind: "PAYMENT_CLAIM",
    studentName: targets[0].studentName,
    description: targets.length > 1
      ? `${targets[0].description || "청구"} 외 ${targets.length - 1}건 · 합계 ${total.toLocaleString("ko-KR")}원`
      : targets[0].description,
    amount: total,
  });

  return {
    ok: true as const,
    submitted: targets.map((row) => String(row.id)),
    alreadyPending: [...alreadyPending],
  };
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
