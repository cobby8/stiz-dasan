import { createHash, randomUUID } from "node:crypto";
import { rallyzMirrorExclusionSql } from "@/lib/billing/parentSendGuard";
import { findParentCheckoutActivePaymentIds, lockPaymentsForCheckout } from "@/lib/payments/bundleLedger";
import {
  describePausePlan,
  isSettlementMode,
  planFingerprint,
  planPauseSettlement,
  settlementLineDrafts,
  settlementNoticeLine,
  settlementTodoText,
  type PausePaymentInput,
  type PausePlan,
  type SettlementMode,
} from "@/lib/enrollment/pause-settlement-plan";

// ── 휴원 수강료 처리(이월·환불·없음) 실행부 — 2026-11-10 원장 결정 m6 ─────────────────────────
//
// 계산은 순수 pause-settlement-plan.ts 한 곳. 여기는 DB 를 읽고 쓰는 연결부다(prisma 를 import 하지 않고 db 를 인자로 받는다 —
// 테스트가 가짜 DB 로 실제 실행한다). 토스 부분 취소는 payment-ledger.ts 의 함수를 deps 로 받는다.
//
// ★ 돈이 움직이는 길의 안전장치
//   1) 금액은 서버가 실행 순간 DB 로 다시 계산하고, 원장이 본 미리보기 지문(previewKey)과 같을 때만 실행한다.
//   2) 한 트랜잭션 안에서: 청구 작업대와 같은 전역 잠금(STIZ_BILLING_WORKBENCH) + 신청별 advisory 잠금 + 신청·청구 FOR UPDATE.
//      처리 기록은 신청당 1행(UNIQUE requestId) — 두 번 눌러도 두 번째는 «이미 처리»로 끝난다.
//   3) 미납 청구 감액은 «지금 금액 = 계산에 쓴 금액·미납 상태»일 때만 바꾸는 조건부 UPDATE(0행이면 전부 되돌림).
//   4) 토스 부분 취소는 트랜잭션 «밖»(커밋 뒤)에서 한다. 줄을 먼저 REQUESTED 로 남기고, 결과는 토스 재조회로만 DONE.
//      같은 줄은 표식·멱등 키가 같아 다시 시도해도 두 번 취소되지 않는다.
//   5) 받은 돈(납부완료)은 상태를 바꾸지 않는다(paidStatusGuard 규칙) — 환불 기록만 남긴다.

export type SettlementSql = {
  $queryRawUnsafe<T = any>(sql: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(sql: string, ...values: unknown[]): Promise<number>;
};
export type SettlementDb = SettlementSql & {
  $transaction<T>(fn: (tx: SettlementSql) => Promise<T>, options?: { timeout?: number; maxWait?: number }): Promise<T>;
};
/** 반 요일·수강월 → 그달 수업일(연간 일정). 실제로는 getMonthlyClassDates(planEvents, ym, dow). */
export type ClassDatesFor = (yearMonth: string, dayOfWeek: string) => string[];

export type TossPartialRefund = (input: {
  transactionId: string; paymentId: string; amount: number; lineId: string; adminUserId: string;
  /** 확실히 실패한 횟수(멱등 키에 섞는다) */ attempt?: number;
  /** 이 줄을 만든 시각(ISO) */ notBefore?: string;
}) => Promise<{ ok: true; alreadyApplied: boolean } | { ok: false; message: string; uncertain: boolean; retryWithNewKey?: boolean }>;

const WORKBENCH_LOCK_SQL = "SELECT pg_advisory_xact_lock(hashtext('STIZ_BILLING_WORKBENCH'))";
const SETTLEMENT_LOCK_SQL = "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))";

/** 승인과 별도 수강료 처리가 신청 행을 잡기 전에 같은 순서로 잠근다. */
export async function lockPauseSettlement(tx: SettlementSql, requestId: string): Promise<void> {
  await tx.$executeRawUnsafe(WORKBENCH_LOCK_SQL);
  await tx.$executeRawUnsafe(SETTLEMENT_LOCK_SQL, `pause-settlement:${requestId}`);
}

/** 표가 있는가(마이그레이션 20261110180000 적용 전이면 미리보기만, 실행은 막는다) */
export async function settlementTablesReady(db: SettlementSql): Promise<boolean> {
  const rows = await db.$queryRawUnsafe<Array<{ a: string | null; b: string | null }>>(
    `SELECT to_regclass('public."EnrollmentChangeSettlement"')::text AS a,
            to_regclass('public."EnrollmentChangeSettlementLine"')::text AS b`,
  );
  return Boolean(rows[0]?.a && rows[0]?.b);
}

/** "YYYY-MM" ± n 달(시간대 없는 숫자 계산) → 비교용 숫자 YYYYMM */
function ymNumber(ym: string, delta = 0): number {
  const [y, m] = ym.split("-").map(Number);
  const index = y * 12 + (m - 1) + delta;
  return Math.floor(index / 12) * 100 + (index % 12) + 1;
}

/** 청구 p 를 덮는 거래(대표 청구이거나 묶음 항목) — 별칭 t 의 조건 */
const TX_COVERS_P = `(t."paymentId" = p.id OR EXISTS (SELECT 1 FROM "PaymentTransactionItem" it WHERE it."transactionId" = t.id AND it."paymentId" = p.id))`;

type PauseRequestRow = {
  id: string; kind: string; status: string; studentId: string; fromClassId: string | null;
  enrollmentId: string | null; cancelRequestStatus: string | null;
  pauseFrom: string; resumeOn: string | null; dayOfWeek: string | null;
  /** 원장이 결정한 날(KST "YYYY-MM-DD") — 기능 시작 전 승인 건을 거르려고 */
  decidedOn?: string | null;
};

async function loadPauseRequest(db: SettlementSql, requestId: string, lock: boolean): Promise<PauseRequestRow | null> {
  const rows = await db.$queryRawUnsafe<PauseRequestRow[]>(
    `SELECT r.id, r.kind, r.status, r."studentId", r."fromClassId", r."enrollmentId",
            to_jsonb(r)->>'cancelRequestStatus' AS "cancelRequestStatus",
            to_char(r."effectiveFrom",'YYYY-MM-DD') AS "pauseFrom", to_char(r."resumeOn",'YYYY-MM-DD') AS "resumeOn",
            c."dayOfWeek",
            to_char(r."decidedAt" AT TIME ZONE 'Asia/Seoul','YYYY-MM-DD') AS "decidedOn"
       FROM "EnrollmentChangeRequest" r
       LEFT JOIN "Class" c ON c.id = r."fromClassId"
      WHERE r.id = $1
      LIMIT 1${lock ? " FOR UPDATE OF r" : ""}`,
    requestId,
  );
  return rows[0] ?? null;
}

const PAUSE_ENROLLMENT_CHANGED = "신청 이후 수강 상태가 바뀌었어요. 현재 반과 상태를 확인한 뒤 수강료를 처리해 주세요.";
const PAUSE_CANCEL_PENDING = "휴원 취소 요청을 먼저 처리해 주세요.";

async function pauseSettlementEligibilityProblem(db: SettlementSql, req: PauseRequestRow, lock: boolean): Promise<string | null> {
  if (req.cancelRequestStatus === "PENDING") return PAUSE_CANCEL_PENDING;
  // 이미 실제 반영된 휴원은 이후에 복귀했어도 지난 기간의 처리 근거가 남아 있다.
  if (req.status === "APPLIED") return null;
  const rows = await db.$queryRawUnsafe<Array<{ id: string }>>(
    `SELECT e.id FROM "Enrollment" e WHERE e.id = $1 AND e."studentId" = $2
       AND e."classId" = $3 AND e.status = 'ACTIVE'${lock ? " FOR UPDATE OF e" : ""}`,
    req.enrollmentId, req.studentId, req.fromClassId,
  );
  return rows.length === 1 ? null : PAUSE_ENROLLMENT_CHANGED;
}

/** 휴원한 반의 수강료 청구(휴원 시작 수강월 한 달 앞부터) + 결제 경로·진행 중 여부 + 이미 처리된 날 */
/** 이 휴원이 볼 청구의 범위(학생·반·수강료·휴원 시작 수강월 한 달 앞부터) — 별칭 p, 인자 $1 학생 · $2 반 · $3 YYYYMM */
const PAUSE_PAYMENT_SCOPE = `p."studentId" = $1 AND p."classId" = $2 AND COALESCE(p.type, 'MONTHLY') = 'MONTHLY'
        AND p.status IN ('PAID','PENDING','OVERDUE') AND p.year IS NOT NULL AND p.month IS NOT NULL
        AND (p.year * 100 + p.month) >= $3`;

/** 결제 잠금 뒤 다시 읽은 청구 목록이 처음과 다를 때(실행부가 «다시 시도» 문구로 바꾼다) */
const SCOPE_CHANGED = "PAUSE_SETTLEMENT_SCOPE_CHANGED";

/** 현장 결제(POS) 요청에 묶인 청구 — 별칭 p */
const POS_BUSY_P = `(EXISTS (SELECT 1 FROM "PosChargeRequestItem" pi WHERE pi."paymentId" = p.id AND pi."open")
             OR EXISTS (SELECT 1 FROM "PosChargeRequest" pr WHERE pr."paymentId" = p.id AND pr.status IN ('PENDING','SENT')))`;

/**
 * 휴원한 반의 수강료 청구 + 결제 경로·진행 중 여부 + 이미 처리된 날.
 * lock=true(실행)면 잠금 순서를 관리자 «청구서 수정»(updateUnpaidPayment)과 같게 한다 — 교착 금지:
 *   (부르는 쪽이 이미 전역 잠금) → ① 대상 청구 id 를 잠금 없이 읽고 → ② 결제 잠금(lockPaymentsForCheckout, id 정렬순)
 *   → ③ 그 id 들만 청구 행 FOR UPDATE → ④ 학부모 결제 진행 중 판정(findParentCheckoutActivePaymentIds).
 * 결제 시작·승인 직전도 같은 결제 잠금을 잡고 금액을 다시 읽으므로, 감액과 «옛 금액 결제»가 엇갈리지 않는다.
 */
async function loadPausePayments(db: SettlementSql, req: PauseRequestRow, tablesReady: boolean, lock: boolean, classDatesFor: ClassDatesFor, nowMs = Date.now()) {
  const scopeArgs = [req.studentId, req.fromClassId, ymNumber(req.pauseFrom.slice(0, 7), -1)];
  let lockedIds: string[] | null = null;
  if (lock) {
    const candidates = await db.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT p.id FROM "Payment" p WHERE ${PAUSE_PAYMENT_SCOPE} ORDER BY p.id`, ...scopeArgs,
    );
    lockedIds = candidates.map((row) => String(row.id));
    await lockPaymentsForCheckout(db, lockedIds);
  }
  const rows = await db.$queryRawUnsafe<any[]>(
    `SELECT p.id, p.year, p.month, p.amount, p.status, p."paidProvider", p.method,
            NOT (${rallyzMirrorExclusionSql("p")}) AS "rallyzMirror",
            tx.id AS "tossTxId", tx.method AS "tossTxMethod",
            ${POS_BUSY_P} AS "posBusy"
       FROM "Payment" p
       LEFT JOIN LATERAL (
         SELECT t.id, t.method FROM "PaymentTransaction" t
          WHERE t.provider = 'TOSS' AND t.status = 'DONE' AND ${TX_COVERS_P}
          ORDER BY t."approvedAt" DESC NULLS LAST LIMIT 1
       ) tx ON true
      WHERE ${PAUSE_PAYMENT_SCOPE}${lockedIds ? ` AND p.id = ANY($4::text[])` : ""}
      ORDER BY p.year, p.month, p.id${lock ? " FOR UPDATE OF p" : ""}`,
    ...scopeArgs, ...(lockedIds ? [lockedIds] : []),
  );
  if (lockedIds) {
    // 잠금을 다 잡은 뒤 범위 조건으로 다시 읽어 처음 목록과 같은지 본다 — 그 사이 새 청구가 생기거나 빠졌으면
    // 잠그지 않은 청구를 계산에 넣거나 빼게 되므로 실행하지 않는다(원장이 다시 누르면 새 목록으로 잠근다)
    const again = (await db.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT p.id FROM "Payment" p WHERE ${PAUSE_PAYMENT_SCOPE} ORDER BY p.id`, ...scopeArgs,
    )).map((row) => String(row.id));
    if (again.length !== lockedIds.length || again.some((id, i) => id !== lockedIds![i])) throw new Error(SCOPE_CHANGED);
  }
  const ids = rows.map((row) => String(row.id));
  // 학부모 결제 진행 중(30분 안 결제창·기한 남은 입금 계좌) — 관리자 청구서 수정과 같은 판정 함수
  const checkoutActive = await findParentCheckoutActivePaymentIds(db, ids, nowMs);
  const settled = new Map<string, string[]>();
  const reduced = new Map<string, number>();
  const carried = new Map<string, number>();
  if (tablesReady && ids.length > 0) {
    const prior = await db.$queryRawUnsafe<Array<{ paymentId: string; kind: string; amount: number; missedDates: unknown; requestCanceled: boolean }>>(
      `SELECT l."paymentId", l.kind, l.amount, l."missedDates", (r.status = 'CANCELED') AS "requestCanceled"
         FROM "EnrollmentChangeSettlementLine" l
         JOIN "EnrollmentChangeSettlement" s ON s.id = l."settlementId"
         JOIN "EnrollmentChangeRequest" r ON r.id = s."requestId"
        WHERE l."paymentId" = ANY($1::text[]) AND s."requestId" <> $2`,
      ids, req.id,
    );
    for (const line of prior) {
      // 취소된 휴원의 처리가 «뺀 날»은 실제로 빠지지 않았다 → 다시 뺄 수 있게 제외
      if (!line.requestCanceled) {
        const dates = Array.isArray(line.missedDates) ? line.missedDates.map(String) : [];
        settled.set(line.paymentId, [...(settled.get(line.paymentId) ?? []), ...dates]);
      }
      // 청구에서 이미 줄인 금액(휴원 감액·이월 차감)은 신청이 취소됐어도 실제로 줄었다 → 원래 금액 계산에 그대로 더한다
      if (line.kind === "UNPAID_REDUCE" || line.kind === "CARRY_APPLY") reduced.set(line.paymentId, (reduced.get(line.paymentId) ?? 0) + Number(line.amount));
      if (line.kind === "CARRY_APPLY") carried.set(line.paymentId, (carried.get(line.paymentId) ?? 0) + Number(line.amount));
    }
  }
  const payments: PausePaymentInput[] = rows.map((row) => {
    const ym = `${row.year}-${String(row.month).padStart(2, "0")}`;
    return {
      paymentId: String(row.id),
      year: Number(row.year),
      month: Number(row.month),
      amount: Number(row.amount),
      status: String(row.status),
      paidProvider: row.paidProvider ?? null,
      method: row.method ?? null,
      rallyzMirror: Boolean(row.rallyzMirror),
      tossTx: row.tossTxId ? { transactionId: String(row.tossTxId), method: row.tossTxMethod ?? null } : null,
      busy: Boolean(row.posBusy) || checkoutActive.has(String(row.id)),
      classDates: req.dayOfWeek ? classDatesFor(ym, req.dayOfWeek) : [],
      settledDates: settled.get(String(row.id)) ?? [],
      priorReduction: reduced.get(String(row.id)) ?? 0,
      carryApplied: carried.get(String(row.id)) ?? 0,
    };
  });
  return payments;
}

export type PauseSettlementPreview = {
  requestId: string;
  plan: PausePlan;
  previewKey: string;
  lines: string[];
  /** 처리 실행 가능 여부(표 준비·계산 문제 없음) */
  ready: boolean;
  tablesReady: boolean;
};

export function previewKeyOf(requestId: string, plan: PausePlan): string {
  return createHash("sha256").update(planFingerprint(requestId, plan)).digest("hex");
}

/** 미리보기(읽기만). 휴원 신청이 아니면 null. */
export async function previewPauseSettlement(db: SettlementSql, requestId: string, classDatesFor: ClassDatesFor, lock = false): Promise<PauseSettlementPreview | null> {
  const req = await loadPauseRequest(db, requestId, lock);
  if (!req || req.kind !== "PAUSE" || !req.fromClassId) return null;
  const eligibilityProblem = await pauseSettlementEligibilityProblem(db, req, lock);
  const tablesReady = await settlementTablesReady(db);
  const payments = await loadPausePayments(db, req, tablesReady, lock && tablesReady, classDatesFor);
  const plan = planPauseSettlement({ pauseFrom: req.pauseFrom, resumeOn: req.resumeOn, payments });
  if (!req.dayOfWeek) plan.problems.push("반 요일을 알 수 없어 금액을 계산할 수 없어요.");
  if (eligibilityProblem) plan.problems.push(eligibilityProblem);
  return {
    requestId, plan, previewKey: previewKeyOf(requestId, plan), lines: describePausePlan(plan),
    ready: tablesReady && plan.problems.length === 0, tablesReady,
  };
}

export type RefundJob = { lineId: string; paymentId: string; transactionId: string; amount: number };

export type ExecuteSettlementResult =
  | {
      ok: true; settlementId: string; studentId: string; mode: SettlementMode;
      paidTotal: number; unpaidTotal: number; refundJobs: RefundJob[]; noticeLine: string | null;
    }
  | { ok: false; message: string };

/**
 * 처리 실행(트랜잭션 안에서만 부른다 — 승인과 같은 트랜잭션이면 처리 실패 시 승인도 되돌아간다).
 * 신청은 이미 APPROVED/APPLIED 여야 한다(승인 UPDATE 뒤에 부른다).
 */
export async function executePauseSettlementInTx(tx: SettlementSql, input: {
  requestId: string; adminUserId: string; mode: unknown; expectedPreviewKey: unknown; classDatesFor: ClassDatesFor;
  /** 이 날(KST) 이전에 승인된 휴원은 처리하지 않는다(기능 이전 건은 사람이 이미 정리) — 화면 숨김과 같은 기준을 서버에서도 */
  decidedSince?: string;
}): Promise<ExecuteSettlementResult> {
  if (!isSettlementMode(input.mode)) return { ok: false, message: "수강료 처리 방식(이월·환불·없음)을 골라 주세요." };
  const mode = input.mode;
  if (typeof input.expectedPreviewKey !== "string" || !/^[a-f0-9]{64}$/.test(input.expectedPreviewKey)) {
    return { ok: false, message: "수강료 미리보기를 다시 불러온 뒤 처리해 주세요." };
  }
  // 청구 작업대·수동 청구와 같은 전역 잠금 → 신청별 잠금(같은 신청 두 번 누름은 여기서 줄 선다)
  await lockPauseSettlement(tx, input.requestId);
  if (!(await settlementTablesReady(tx))) {
    // (운영 표 준비 = 마이그레이션 20261110180000 적용 전)
    return { ok: false, message: "수강료 처리 기록이 아직 준비되지 않았어요. 준비가 끝난 뒤 다시 해 주세요." };
  }
  const req = await loadPauseRequest(tx, input.requestId, true);
  if (!req || req.kind !== "PAUSE" || !req.fromClassId) return { ok: false, message: "휴원 신청만 수강료를 처리할 수 있어요." };
  if (req.status !== "APPROVED" && req.status !== "APPLIED") return { ok: false, message: "승인된 휴원만 수강료를 처리할 수 있어요." };
  if (input.decidedSince && !(req.decidedOn && req.decidedOn >= input.decidedSince)) {
    return { ok: false, message: "이 기능 전에 승인된 휴원이에요. 수강료는 직접 정리해 주세요." };
  }
  const eligibilityProblem = await pauseSettlementEligibilityProblem(tx, req, true);
  if (eligibilityProblem) return { ok: false, message: eligibilityProblem };
  const existing = await tx.$queryRawUnsafe<Array<{ id: string }>>(
    `SELECT id FROM "EnrollmentChangeSettlement" WHERE "requestId" = $1 LIMIT 1`, req.id,
  );
  if (existing.length > 0) return { ok: false, message: "이미 수강료를 처리한 휴원이에요." };

  // 잠근 뒤 DB 로 다시 계산 → 원장이 본 금액과 다르면 실행하지 않는다
  let payments: PausePaymentInput[];
  try {
    payments = await loadPausePayments(tx, req, true, true, input.classDatesFor);
  } catch (error) {
    if (error instanceof Error && error.message === SCOPE_CHANGED) {
      return { ok: false, message: "처리하는 사이 청구 목록이 바뀌었어요. 새로고침한 뒤 다시 시도해 주세요." };
    }
    throw error;
  }
  const plan = planPauseSettlement({ pauseFrom: req.pauseFrom, resumeOn: req.resumeOn, payments });
  if (!req.dayOfWeek) plan.problems.push("반 요일을 알 수 없어 금액을 계산할 수 없어요.");
  if (previewKeyOf(req.id, plan) !== input.expectedPreviewKey) {
    return { ok: false, message: "미리보기 뒤 청구·일정이 바뀌었어요. 새로고침해 금액을 다시 확인해 주세요." };
  }
  if (plan.problems.length > 0) return { ok: false, message: plan.problems[0] };

  const { lines, carryTotal } = settlementLineDrafts(plan, mode);
  const settlementId = randomUUID();
  await tx.$executeRawUnsafe(
    `INSERT INTO "EnrollmentChangeSettlement"
       (id, "requestId", "studentId", mode, "paidAmount", "unpaidAmount", "carryRemaining", "carryAfterYm",
        status, "previewKey", basis, "decidedByUserId")
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'OPEN',$9,$10::jsonb,$11)`,
    settlementId, req.id, req.studentId, mode, plan.paidTotal, mode === "NONE" ? 0 : plan.unpaidTotal, carryTotal,
    plan.carryAfterYm, input.expectedPreviewKey,
    JSON.stringify({ pauseFrom: plan.pauseFrom, resumeOn: plan.resumeOn, lines: plan.lines, describe: describePausePlan(plan) }),
    input.adminUserId,
  );

  const byPayment = new Map(payments.map((p) => [p.paymentId, p]));
  const refundJobs: RefundJob[] = [];
  for (const line of lines) {
    const lineId = randomUUID();
    const payment = byPayment.get(line.paymentId)!;
    const transactionId = line.kind === "REFUND" && line.channel === "TOSS" ? payment.tossTx?.transactionId ?? null : null;
    await tx.$executeRawUnsafe(
      `INSERT INTO "EnrollmentChangeSettlementLine"
         (id, "settlementId", "paymentId", kind, channel, amount, status, "missedDates", "transactionId", "doneByUserId", "doneAt")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10, CASE WHEN $7 = 'DONE' THEN now() ELSE NULL END)`,
      lineId, settlementId, line.paymentId, line.kind, line.channel, line.amount, line.status,
      JSON.stringify(line.missedDates), transactionId, line.status === "DONE" ? input.adminUserId : null,
    );
    if (line.kind === "UNPAID_REDUCE" && line.channel === "SITE") {
      await reduceUnpaidPayment(tx, {
        paymentId: line.paymentId, expectedAmount: payment.amount, reduceBy: line.amount, adminUserId: input.adminUserId,
        action: "ENROLLMENT_PAUSE_UNPAID_REDUCED", message: `휴원 기간 수업 ${line.missedDates.length}회 감액`,
        metadata: { requestId: req.id, settlementId, lineId, missedDates: line.missedDates },
      });
    }
    if (transactionId) refundJobs.push({ lineId, paymentId: line.paymentId, transactionId, amount: line.amount });
  }
  await refreshSettlementStatus(tx, settlementId);
  await tx.$executeRawUnsafe(
    `INSERT INTO "OperationsAuditLog" (id, action, "actorType", "actorUserId", "detailsJson")
     VALUES ($1, 'ENROLLMENT_PAUSE_SETTLED', 'ADMIN', $2, $3::jsonb)`,
    randomUUID(), input.adminUserId,
    JSON.stringify({ requestId: req.id, studentId: req.studentId, settlementId, mode,
      paidAmount: plan.paidTotal, unpaidAmount: plan.unpaidTotal, refundJobs: refundJobs.length }),
  );
  return {
    ok: true, settlementId, studentId: req.studentId, mode,
    paidTotal: plan.paidTotal, unpaidTotal: plan.unpaidTotal, refundJobs,
    noticeLine: settlementNoticeLine(mode, plan.paidTotal, plan.unpaidTotal),
  };
}

/**
 * 미납 청구 금액을 줄인다(조건부 UPDATE — 지금 금액·미납 상태가 계산 때와 같을 때만, 아니면 throw 로 전부 되돌림).
 * 0원이 되면 청구·청구서를 «취소»로 둔다(0원 미납이 학부모 화면에 남지 않게). 납부완료(PAID)는 절대 건드리지 않는다.
 */
async function reduceUnpaidPayment(tx: SettlementSql, input: {
  paymentId: string; expectedAmount: number; reduceBy: number; adminUserId: string | null;
  action: string; message: string; metadata: Record<string, unknown>;
}) {
  const next = input.expectedAmount - input.reduceBy;
  if (!Number.isSafeInteger(next) || next < 0 || input.reduceBy <= 0) throw new Error("PAUSE_SETTLEMENT_AMOUNT_INVALID");
  const changed = await tx.$executeRawUnsafe(
    `UPDATE "Payment" SET amount = $2,
            status = CASE WHEN $2 = 0 THEN 'CANCELED' ELSE status END, "updatedAt" = now()
      WHERE id = $1 AND status IN ('PENDING','OVERDUE') AND amount = $3`,
    input.paymentId, next, input.expectedAmount,
  );
  if (changed !== 1) throw new Error("PAUSE_SETTLEMENT_PAYMENT_CONFLICT");
  await tx.$executeRawUnsafe(
    `UPDATE "PaymentInvoice" SET amount = $2,
            status = CASE WHEN $2 = 0 THEN 'CANCELED' ELSE status END,
            "canceledAt" = CASE WHEN $2 = 0 THEN now() ELSE "canceledAt" END, "updatedAt" = now()
      WHERE "paymentId" = $1 AND status <> 'PAID'`,
    input.paymentId, next,
  );
  await tx.$executeRawUnsafe(
    // 관리자 승인 중이면 ADMIN, 매일 크론의 이월 차감이면 SYSTEM
    `INSERT INTO "PaymentAuditLog" (id, "paymentId", "actorType", "actorId", action, message, metadata, "createdAt")
     VALUES (gen_random_uuid()::text, $1, $6, $2, $3, $4, $5::jsonb, now())`,
    input.paymentId, input.adminUserId, input.action, input.message,
    JSON.stringify({ ...input.metadata, before: input.expectedAmount, after: next, reduceBy: input.reduceBy }),
    input.adminUserId ? "ADMIN" : "SYSTEM",
  );
}

/** 남은 일(사람 할 일·결과 확인 중·실패)이나 남은 이월이 있으면 OPEN, 없으면 DONE */
export async function refreshSettlementStatus(tx: SettlementSql, settlementId: string) {
  await tx.$executeRawUnsafe(
    `UPDATE "EnrollmentChangeSettlement" s
        SET status = CASE WHEN s."carryRemaining" > 0 OR EXISTS (
                       SELECT 1 FROM "EnrollmentChangeSettlementLine" l
                        WHERE l."settlementId" = s.id AND l.status IN ('TODO','REQUESTED','FAILED'))
                     THEN 'OPEN' ELSE 'DONE' END,
            "updatedAt" = now()
      WHERE s.id = $1`,
    settlementId,
  );
}

export type RefundRunSummary = { done: number; failed: number; uncertain: number; messages: string[] };

/**
 * 토스 부분 취소 실행(커밋 뒤). 처리 settlementId 의 REQUESTED·FAILED 토스 환불 줄을 하나씩.
 * 결과는 토스 재조회로만 판정된 값(deps.refundToss)으로 줄을 바꾼다. 사람이 이미 «직접 처리»로 닫은 줄은 건드리지 않는다.
 */
export async function runSettlementTossRefunds(db: SettlementSql, input: {
  settlementId: string; adminUserId: string; refundToss: TossPartialRefund;
}): Promise<RefundRunSummary> {
  const summary: RefundRunSummary = { done: 0, failed: 0, uncertain: 0, messages: [] };
  const lines = await db.$queryRawUnsafe<Array<{ id: string; paymentId: string | null; transactionId: string | null; amount: number; failedAttempts: number; createdAt: Date | string }>>(
    `SELECT id, "paymentId", "transactionId", amount, "failedAttempts", "createdAt" FROM "EnrollmentChangeSettlementLine"
      WHERE "settlementId" = $1 AND kind = 'REFUND' AND channel = 'TOSS' AND status IN ('REQUESTED','FAILED')
      ORDER BY "createdAt", id`,
    input.settlementId,
  );
  for (const line of lines) {
    if (!line.paymentId || !line.transactionId) {
      await db.$executeRawUnsafe(
        `UPDATE "EnrollmentChangeSettlementLine" SET status = 'FAILED', message = $2, "updatedAt" = now()
          WHERE id = $1 AND status IN ('REQUESTED','FAILED')`,
        line.id, "결제 기록이 사라져 자동 환불할 수 없어요.",
      );
      summary.failed += 1;
      continue;
    }
    let result: Awaited<ReturnType<TossPartialRefund>>;
    try {
      result = await input.refundToss({
        transactionId: line.transactionId, paymentId: line.paymentId, amount: Number(line.amount),
        lineId: line.id, adminUserId: input.adminUserId,
        // 확실한 실패 뒤 다시 시도는 새 멱등 키(시도 번호), 결과 모름은 같은 키로 확인만
        attempt: Number(line.failedAttempts ?? 0),
        // 이 줄을 만든 뒤 생긴 «표식 없는 같은 금액 취소»(상점관리자 직접 취소 등)를 알아보려는 기준 시각
        notBefore: line.createdAt instanceof Date ? line.createdAt.toISOString() : String(line.createdAt ?? ""),
      });
    } catch {
      result = { ok: false, message: "토스 부분 취소 중 오류가 났어요. 잠시 후 다시 시도해 주세요.", uncertain: true };
    }
    if (result.ok) {
      await db.$executeRawUnsafe(
        `UPDATE "EnrollmentChangeSettlementLine"
            SET status = 'DONE', message = $2, "doneByUserId" = $3, "doneAt" = now(), "updatedAt" = now()
          WHERE id = $1 AND status IN ('REQUESTED','FAILED')`,
        line.id, result.alreadyApplied ? "토스 부분 취소 확인(이미 처리됨)" : "토스 부분 취소 완료", input.adminUserId,
      );
      summary.done += 1;
    } else {
      // 결과를 모르면 REQUESTED 로 남긴다(다시 시도 = 같은 표식으로 확인부터) · 확실한 실패만 FAILED
      const updated = await db.$executeRawUnsafe(
        `UPDATE "EnrollmentChangeSettlementLine"
            SET status = $2, message = $3, "failedAttempts" = "failedAttempts" + $4, "updatedAt" = now()
          WHERE id = $1 AND status IN ('REQUESTED','FAILED') AND "failedAttempts" = $5`,
        line.id, result.uncertain ? "REQUESTED" : "FAILED", result.message.slice(0, 300),
        !result.uncertain && result.retryWithNewKey ? 1 : 0, Number(line.failedAttempts ?? 0),
      );
      // 같은 시도에 대한 늦은 응답은 이미 기록된 새 시도를 덮을 수 없다.
      if (updated === 0) continue;
      if (result.uncertain) summary.uncertain += 1; else summary.failed += 1;
      summary.messages.push(result.message);
    }
  }
  await refreshSettlementStatus(db, input.settlementId);
  return summary;
}

/**
 * 이월을 다음 청구에서 뺀다(승인 직후 + 매일 크론). 남은 이월이 있는 처리마다
 * 그 학생의 «carryAfterYm 보다 뒤» 미납 수강료 청구(랠리즈 사본·결제 진행 중 제외)를 수강월 순으로 줄인다.
 * 랠리즈 청구뿐이면 줄일 사이트 청구가 없어 이월이 남는다 → 관리자 «이월 직접 처리»로 닫는다.
 */
export async function applyOpenPauseCarries(db: SettlementDb, input: { studentId?: string | null } = {}): Promise<{ applied: number; amount: number }> {
  if (!(await settlementTablesReady(db))) return { applied: 0, amount: 0 };
  // 승인 직후 = 그 학생 하나
  if (input.studentId) return applyCarriesForStudent(db, input.studentId);
  // 매일 크론 = 학생마다 트랜잭션을 나눈다(학생 id 정렬순). 한 학생이 실패해도 다른 학생 차감은 되돌리지 않는다.
  const students = await db.$queryRawUnsafe<Array<{ studentId: string }>>(
    `SELECT DISTINCT "studentId" FROM "EnrollmentChangeSettlement" WHERE "carryRemaining" > 0 ORDER BY "studentId" LIMIT 200`,
  );
  const sum = { applied: 0, amount: 0 };
  for (const { studentId } of students) {
    try {
      const one = await applyCarriesForStudent(db, String(studentId));
      sum.applied += one.applied;
      sum.amount += one.amount;
    } catch (error) {
      // 남은 이월은 그대로라 다음 크론에서 다시 시도된다(개인정보 없이 오류 이름만)
      console.error("[pause-settlement] 학생 이월 차감 실패", error instanceof Error ? error.name : "");
    }
  }
  return sum;
}

/** 한 학생의 남은 이월을 한 트랜잭션에서 차감한다(전역 잠금 → 처리 행 → 결제 잠금 → 청구 행) */
async function applyCarriesForStudent(db: SettlementDb, studentId: string): Promise<{ applied: number; amount: number }> {
  return db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(WORKBENCH_LOCK_SQL);
    const open = await tx.$queryRawUnsafe<Array<{ id: string; studentId: string; requestId: string; carryRemaining: number; carryAfterYm: string | null }>>(
      `SELECT id, "studentId", "requestId", "carryRemaining", "carryAfterYm" FROM "EnrollmentChangeSettlement"
        WHERE "carryRemaining" > 0 AND "studentId" = $1
        ORDER BY "createdAt", id
        LIMIT 200
        FOR UPDATE`,
      studentId,
    );
    let applied = 0;
    let total = 0;
    for (const s of open) {
      let remaining = Number(s.carryRemaining);
      const after = s.carryAfterYm && /^\d{4}-\d{2}$/.test(s.carryAfterYm) ? ymNumber(s.carryAfterYm) : 0;
      // 차감 대상 조건(별칭 p) — $1 학생 · $2 기준 수강월 · $3 처리 id
      const targetScope = `p."studentId" = $1 AND COALESCE(p.type, 'MONTHLY') = 'MONTHLY'
            AND p.status IN ('PENDING','OVERDUE') AND p.amount > 0
            AND p.year IS NOT NULL AND p.month IS NOT NULL AND (p.year * 100 + p.month) > $2
            AND ${rallyzMirrorExclusionSql("p")}
            AND NOT ${POS_BUSY_P}
            AND NOT EXISTS (SELECT 1 FROM "EnrollmentChangeSettlementLine" l
                             WHERE l."settlementId" = $3 AND l."paymentId" = p.id AND l.kind = 'CARRY_APPLY')`;
      // 잠금 순서 = 관리자 청구서 수정과 같게: (전역 잠금 뒤) id 를 잠금 없이 읽고 → 결제 잠금(정렬순) → 그 id 만 행 잠금
      const candidateIds = (await tx.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT p.id FROM "Payment" p WHERE ${targetScope} ORDER BY p.id`, s.studentId, after, s.id,
      )).map((row) => String(row.id));
      if (candidateIds.length === 0) continue;
      await lockPaymentsForCheckout(tx, candidateIds);
      const locked = await tx.$queryRawUnsafe<Array<{ id: string; amount: number; year: number; month: number }>>(
        `SELECT p.id, p.amount, p.year, p.month FROM "Payment" p
          WHERE ${targetScope} AND p.id = ANY($4::text[])
          ORDER BY p.year, p.month, p."createdAt", p.id
          FOR UPDATE OF p`,
        s.studentId, after, s.id, candidateIds,
      );
      // 학부모 결제 진행 중(30분 안 결제창·기한 남은 입금 계좌)인 청구는 이번엔 건너뛴다(다음 크론에서 다시)
      const active = await findParentCheckoutActivePaymentIds(tx, locked.map((row) => row.id), Date.now());
      const targets = locked.filter((row) => !active.has(row.id));
      for (const target of targets) {
        if (remaining <= 0) break;
        const use = Math.min(remaining, Number(target.amount));
        if (use <= 0) continue;
        await reduceUnpaidPayment(tx, {
          paymentId: target.id, expectedAmount: Number(target.amount), reduceBy: use, adminUserId: null,
          action: "ENROLLMENT_PAUSE_CARRY_APPLIED", message: `휴원 수강료 이월 ${use}원 차감`,
          metadata: { requestId: s.requestId, settlementId: s.id },
        });
        await tx.$executeRawUnsafe(
          `INSERT INTO "EnrollmentChangeSettlementLine"
             (id, "settlementId", "paymentId", kind, channel, amount, status, message, "doneAt")
           VALUES ($1,$2,$3,'CARRY_APPLY','SITE',$4,'DONE',$5, now())`,
          randomUUID(), s.id, target.id, use, `${target.year}-${String(target.month).padStart(2, "0")} 청구에서 차감`,
        );
        remaining -= use;
        applied += 1;
        total += use;
      }
      if (remaining !== Number(s.carryRemaining)) {
        await tx.$executeRawUnsafe(
          `UPDATE "EnrollmentChangeSettlement" SET "carryRemaining" = $2, "updatedAt" = now() WHERE id = $1 AND "carryRemaining" = $3`,
          s.id, remaining, Number(s.carryRemaining),
        );
        await refreshSettlementStatus(tx, s.id);
      }
    }
    return { applied, amount: total };
  }, { timeout: 30_000 });
}

/** 사람 할 일(TODO)·확실한 실패(FAILED) 줄을 «직접 처리함»으로 닫는다(현금 환불·랠리즈 반영·POS 취소 등). */
export async function markSettlementLineDone(db: SettlementDb, input: { lineId: string; adminUserId: string; note?: string | null }) {
  const note = (input.note ?? "").trim().slice(0, 300) || "직접 처리함";
  return db.$transaction(async (tx) => {
    const rows = await tx.$queryRawUnsafe<Array<{ settlementId: string }>>(
      `UPDATE "EnrollmentChangeSettlementLine"
          SET status = 'DONE_MANUAL', message = $3, "doneByUserId" = $2, "doneAt" = now(), "updatedAt" = now()
        WHERE id = $1 AND status IN ('TODO','FAILED')
        RETURNING "settlementId"`,
      input.lineId, input.adminUserId, note,
    );
    if (!rows[0]) return { ok: false as const, message: "이미 처리됐거나 확인 중인 항목이에요." };
    await refreshSettlementStatus(tx, rows[0].settlementId);
    return { ok: true as const };
  });
}

/** 사이트에 줄일 청구가 없는 이월(랠리즈 청구 등)을 사람이 직접 차감했다고 닫는다. */
export async function markCarryHandledManually(db: SettlementDb, input: { settlementId: string; adminUserId: string; note?: string | null }) {
  const note = (input.note ?? "").trim().slice(0, 300) || "다음 청구에서 직접 차감함";
  return db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(WORKBENCH_LOCK_SQL);
    const rows = await tx.$queryRawUnsafe<Array<{ carryRemaining: number }>>(
      `SELECT "carryRemaining" FROM "EnrollmentChangeSettlement" WHERE id = $1 AND "carryRemaining" > 0 FOR UPDATE`,
      input.settlementId,
    );
    if (!rows[0]) return { ok: false as const, message: "남은 이월이 없어요." };
    const amount = Number(rows[0].carryRemaining);
    await tx.$executeRawUnsafe(
      `INSERT INTO "EnrollmentChangeSettlementLine"
         (id, "settlementId", "paymentId", kind, channel, amount, status, message, "doneByUserId", "doneAt")
       VALUES ($1,$2,NULL,'CARRY_MANUAL','MANUAL',$3,'DONE_MANUAL',$4,$5, now())`,
      randomUUID(), input.settlementId, amount, note, input.adminUserId,
    );
    await tx.$executeRawUnsafe(
      `UPDATE "EnrollmentChangeSettlement" SET "carryRemaining" = 0, "updatedAt" = now() WHERE id = $1`,
      input.settlementId,
    );
    await refreshSettlementStatus(tx, input.settlementId);
    return { ok: true as const, amount };
  });
}

export type SettlementView = {
  id: string;
  mode: SettlementMode;
  paidAmount: number;
  unpaidAmount: number;
  carryRemaining: number;
  status: "OPEN" | "DONE";
  createdAt: string;
  decidedByName: string | null;
  lines: Array<{ id: string; kind: string; channel: string; amount: number; status: string; message: string | null; todo: string | null; ym: string | null }>;
};

/** 관리자 화면용 — 신청 id 들의 처리 기록(표가 없으면 빈 지도) */
export async function readSettlements(db: SettlementSql, requestIds: string[]): Promise<Map<string, SettlementView>> {
  const out = new Map<string, SettlementView>();
  if (requestIds.length === 0 || !(await settlementTablesReady(db))) return out;
  const heads = await db.$queryRawUnsafe<any[]>(
    `SELECT s.id, s."requestId", s.mode, s."paidAmount", s."unpaidAmount", s."carryRemaining", s.status,
            to_char(s."createdAt" AT TIME ZONE 'Asia/Seoul','YYYY-MM-DD HH24:MI') AS "createdAt", u.name AS "decidedByName"
       FROM "EnrollmentChangeSettlement" s
       LEFT JOIN "User" u ON u.id = s."decidedByUserId"
      WHERE s."requestId" = ANY($1::text[])`,
    requestIds,
  );
  if (heads.length === 0) return out;
  const lines = await db.$queryRawUnsafe<any[]>(
    `SELECT l.id, l."settlementId", l.kind, l.channel, l.amount, l.status, l.message,
            CASE WHEN p.id IS NULL THEN NULL ELSE p.year::text || '-' || lpad(p.month::text, 2, '0') END AS ym
       FROM "EnrollmentChangeSettlementLine" l
       LEFT JOIN "Payment" p ON p.id = l."paymentId"
      WHERE l."settlementId" = ANY($1::text[])
      ORDER BY l."createdAt", l.id`,
    heads.map((h) => h.id),
  );
  for (const h of heads) {
    out.set(String(h.requestId), {
      id: String(h.id),
      mode: h.mode,
      paidAmount: Number(h.paidAmount),
      unpaidAmount: Number(h.unpaidAmount),
      carryRemaining: Number(h.carryRemaining),
      status: h.status === "DONE" ? "DONE" : "OPEN",
      createdAt: String(h.createdAt ?? ""),
      decidedByName: h.decidedByName ?? null,
      lines: lines.filter((l) => l.settlementId === h.id).map((l) => ({
        id: String(l.id), kind: l.kind, channel: l.channel, amount: Number(l.amount), status: l.status,
        message: l.message ?? null, ym: l.ym ?? null,
        todo: settlementTodoText({ kind: l.kind, channel: l.channel, amount: Number(l.amount), status: l.status }),
      })),
    });
  }
  return out;
}

/** 수강료 처리 남은 일 건수(사람 할 일·결과 확인 중·실패 줄 + 남은 이월 처리) — 화면 상단 알림용 */
export async function countOpenSettlementWork(db: SettlementSql): Promise<number> {
  if (!(await settlementTablesReady(db))) return 0;
  const rows = await db.$queryRawUnsafe<Array<{ n: number }>>(
    `SELECT count(*)::int AS n FROM "EnrollmentChangeSettlement" WHERE status = 'OPEN'`,
  );
  return Number(rows[0]?.n ?? 0);
}

/** 이 휴원에 돈이 움직인 처리(환불·이월·감액)가 있는가 — 승인 취소(d8) 전에 확인 */
export async function hasMovedMoneySettlement(db: SettlementSql, requestId: string): Promise<boolean> {
  if (!(await settlementTablesReady(db))) return false;
  const rows = await db.$queryRawUnsafe<Array<{ id: string }>>(
    `SELECT id FROM "EnrollmentChangeSettlement"
      WHERE "requestId" = $1 AND mode <> 'NONE' AND ("paidAmount" > 0 OR "unpaidAmount" > 0) LIMIT 1`,
    requestId,
  );
  return rows.length > 0;
}
