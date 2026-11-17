/**
 * «발행 뒤 바뀐 청구» DB 연결부 — 읽기 · 승인(취소/금액 변경) · 무시(2026-11-17).
 *
 * ■ 기존 기능과의 관계(새로 만들지 않고 이어 쓴 것)
 *   - 어긋남 판정 근거 = 수강(Enrollment) 상태 + 그 수강의 마지막 «반영됨(APPLIED)» 수강 변경 기록(퇴원·반 변경)의 효력일.
 *     관리자 직접 퇴원·반 이동·학부모 퇴원 자동 반영이 모두 이 기록을 남긴다(enrollment-end-cleanup 이 쓰는 효력일과 같은 값).
 *   - 건너뛰는 이유(결제 진행 중·POS 요청·결제 거래·이월·휴원 정산·부상 결석 감액·청구서 상태) = 부상 결석 «발행 보류로 돌리기»
 *     (illness-period-admin holdIssuedBillsForPeriod)와 같은 조건·같은 이유 글자.
 *   - 취소 = 관리자 «청구서 삭제»(cancelUnpaidPayment)와 같은 조건부 UPDATE(Payment·PaymentInvoice 함께 CANCELED) + 같은 감사 이름.
 *     그 함수는 자기 거래·권한 확인을 따로 열고 결제 잠금을 잡지 않아, 결제 잠금 안에서 다시 확인해야 하는 여기서는
 *     부상 결석 보류(holdIssuedBillsForPeriod)처럼 같은 SQL 을 거래 안에서 쓴다.
 *   - 금액 변경 = 관리자 «청구서 수정»(updateUnpaidPayment)과 같은 잠금 순서(결제 잠금 → 청구 행)·같은 감사 이름(PAYMENT_UPDATE_UNPAID, 되돌릴 값 포함).
 *   - 무시 기록 = OperationsAuditLog 한 줄(새 표 없음 → 마이그레이션 없음). 휴원 정산 보류 건수처럼 감사 기록을 상태로 읽는다.
 *
 * ■ 하지 않는 것: 학부모 알림·문자·푸시, 카드 결제 환불, 반 변경 차감 자동 반영(목록만).
 *
 * prisma 를 import 하지 않는다 — 테스트가 가짜 DB 로 이 파일을 그대로 실행한다.
 */
import { notMergedStudent } from "@/lib/studentVisibility";
import { rallyzMirrorExclusionSql } from "@/lib/billing/parentSendGuard";
import { APPROVED_PENDING_SQL, findParentCheckoutActivePaymentIds, lockPaymentsForCheckout } from "@/lib/payments/bundleLedger";
import { HOLD_POS_BUSY_SQL } from "@/lib/regular/illness-period-admin";
import { computeClassChangeProration } from "@/lib/enrollment/proration";
import { WorkbenchError, illnessReducedSumSql } from "./workbench";
import { anomalyOf, baseKeyOf, classChangeProblemOf, decideClassChange, decideEndedBill, sameProposal, sortPostIssueItems, type EndedBillInput, type IssuedDraftAmounts, type PostIssueItem, type PostIssueSkipCode } from "./post-issue-rules";

export type PostIssueTx = {
  $queryRawUnsafe<T = unknown>(sql: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(sql: string, ...values: unknown[]): Promise<number>;
};
export type PostIssueDb = PostIssueTx & { $transaction<T>(work: (tx: PostIssueTx) => Promise<T>, options?: { timeout?: number }): Promise<T> };
/** 그 달·그 요일의 수업일(연간 계획표) — 못 읽으면 부르는 쪽이 null 을 넘긴다(반 변경 줄은 «확인 필요») */
export type ClassDatesFor = (ym: string, dayOfWeek: string) => string[];

/** 감사 기록 이름 — 무시·승인 */
export const POST_ISSUE_DISMISS_ACTION = "BILLING_POST_ISSUE_DISMISSED";
export const POST_ISSUE_APPROVE_ACTION = "BILLING_POST_ISSUE_APPROVED";
/** 취소·변경 감사(PaymentAuditLog) 사유 — 청구·수납 화면 이력에서 «어디서 왜» 바뀌었는지 보이게 */
export const POST_ISSUE_CANCEL_REASON = "수강 종료 뒤 남은 청구 — 청구 준비 «발행 뒤 바뀐 청구»에서 원장 승인으로 취소";
export const POST_ISSUE_PRORATE_REASON = "월 중간 퇴원 — 청구 준비 «발행 뒤 바뀐 청구»에서 원장 승인으로 다닌 회차만큼 변경";

// 열쇠 = 대상:종료일:제안 종류(검수 D-4)
const KEY_RE = /^(P:[A-Za-z0-9_-]{1,100}:\d{4}-\d{2}-\d{2}:(CANCEL|PRORATE|PAID|CHECK)|R:[A-Za-z0-9_-]{1,100}:(DEDUCT|CHECK))$/;

async function tableSet(db: PostIssueTx, names: string[]): Promise<Set<string>> {
  const rows = await db.$queryRawUnsafe<Array<{ name: string; found: boolean }>>(
    `SELECT name, to_regclass('public."' || name || '"') IS NOT NULL AS found FROM unnest($1::text[]) AS name`, names);
  return new Set(rows.filter((r) => r.found).map((r) => r.name));
}

type BillRow = {
  id: string; studentId: string; studentName: string; classId: string; className: string; year: number; month: number; amount: number; status: string;
  endKind: "WITHDRAW" | "CLASS_CHANGE"; endYmd: string; invoiceStatus: string | null;
  posBusy: boolean; paidTx: boolean; carryUsed: boolean; carrySource: boolean; pauseSettled: boolean; illnessReduced: boolean;
  draftPayload: unknown; draftDates: unknown; hasDraft: boolean;
  /** 검수 D-1 이상 신호 재료 */
  draftClassId: string | null; manualEdited: boolean; sameClassActive: boolean; otherClassUnbilled: boolean;
};

const asAmounts = (value: unknown): IssuedDraftAmounts | null => {
  const v = (typeof value === "string" ? (() => { try { return JSON.parse(value); } catch { return null; } })() : value) as Record<string, unknown> | null;
  if (!v || typeof v !== "object") return null;
  const pick = (k: string) => Number(v[k]);
  return { baseAmount: pick("baseAmount"), discountAmount: pick("discountAmount"), prorationAmount: pick("prorationAmount"), carryAmount: pick("carryAmount"), shuttleAmount: pick("shuttleAmount") };
};
const asDates = (value: unknown): string[] => Array.isArray(value) ? value.filter((d): d is string => typeof d === "string") : [];

/** 건너뛰는 이유 — 부상 결석 보류(readHoldTargets)와 같은 순서 */
export function skipCodeOf(row: Pick<BillRow, "posBusy" | "paidTx" | "carryUsed" | "carrySource" | "pauseSettled" | "illnessReduced" | "invoiceStatus">, checkoutActive: boolean): PostIssueSkipCode | null {
  return checkoutActive ? "CHECKOUT"
    : row.posBusy ? "POS"
    : row.paidTx ? "PAID_TX"
    : row.carryUsed ? "CARRY_USED"
    : row.carrySource ? "CARRY_SOURCE"
    : row.pauseSettled ? "PAUSE_SETTLED"
    : row.illnessReduced ? "ILLNESS_REDUCED"
    : !row.invoiceStatus || !["ISSUED", "SENT", "OVERDUE"].includes(row.invoiceStatus) ? "INVOICE"
    : null;
}

/**
 * 끝난 반(퇴원·반 이동)의 청구 중 수강 상태와 어긋난 줄. paymentId 를 주면 그 청구만(승인 때 다시 계산).
 * 효력일 = 그 수강의 «마지막» 반영 기록(그 뒤 복귀했다가 다시 퇴원했으면 마지막 퇴원). 마지막 기록이 퇴원·반 변경이 아니면 보지 않는다.
 * 반영 기록이 없는 옛 퇴원(기록 도입 전)은 종료일을 알 수 없어 보지 않는다(추측하지 않는다).
 */
export async function readEndedBillItems(db: PostIssueTx, opts: { paymentId?: string; nowMs?: number } = {}): Promise<PostIssueItem[]> {
  const tables = await tableSet(db, ["BillingWorkbenchDraft", "BillingCarryUsage", "BillingCarryCredit", "EnrollmentChangeSettlementLine", "PosChargeRequest", "PosChargeRequestItem", "PaymentAuditLog"]);
  const has = (t: string) => tables.has(t);
  const draftReady = has("BillingWorkbenchDraft");
  const carryReady = draftReady && has("BillingCarryUsage") && has("BillingCarryCredit");
  const rows = await db.$queryRawUnsafe<BillRow[]>(
    `WITH last_end AS (
       SELECT DISTINCT ON (r."enrollmentId") r."enrollmentId", r.kind, to_char(r."effectiveFrom",'YYYY-MM-DD') AS "endYmd"
         FROM "EnrollmentChangeRequest" r
        WHERE r.status = 'APPLIED' AND r."enrollmentId" IS NOT NULL
        ORDER BY r."enrollmentId", r."appliedAt" DESC NULLS LAST, r."updatedAt" DESC, r.id DESC
     )
     SELECT p.id, p."studentId", s.name AS "studentName", p."classId", c.name AS "className", p.year, p.month, p.amount, p.status,
            le.kind AS "endKind", le."endYmd",
            (SELECT i.status FROM "PaymentInvoice" i WHERE i."paymentId" = p.id ORDER BY i."createdAt" DESC LIMIT 1) AS "invoiceStatus",
            ${has("PosChargeRequest") && has("PosChargeRequestItem") ? HOLD_POS_BUSY_SQL : "false"} AS "posBusy",
            EXISTS (SELECT 1 FROM "PaymentTransaction" t
                     WHERE (t.status = 'DONE' OR ${APPROVED_PENDING_SQL})
                       AND (t."paymentId" = p.id OR EXISTS (SELECT 1 FROM "PaymentTransactionItem" it WHERE it."transactionId" = t.id AND it."paymentId" = p.id))) AS "paidTx",
            ${carryReady ? `EXISTS (SELECT 1 FROM "BillingCarryUsage" u WHERE u."paymentId" = p.id
                               OR EXISTS (SELECT 1 FROM "BillingWorkbenchDraft" ud WHERE ud."paymentId" = p.id AND ud.id = u."draftId" AND ud.month = u.month))` : "false"} AS "carryUsed",
            ${carryReady ? `EXISTS (SELECT 1 FROM "BillingCarryCredit" source_credit WHERE source_credit.basis->>'sourcePaymentId' = p.id)` : "false"} AS "carrySource",
            ${has("EnrollmentChangeSettlementLine") ? `EXISTS (SELECT 1 FROM "EnrollmentChangeSettlementLine" l WHERE l."paymentId" = p.id AND l.kind IN ('UNPAID_REDUCE','CARRY_APPLY'))` : "false"} AS "pauseSettled",
            ${has("PaymentAuditLog") ? `${illnessReducedSumSql("p.id")} > 0` : "false"} AS "illnessReduced",
            ${draftReady ? `d.payload AS "draftPayload", d."scheduledDates" AS "draftDates", (d.id IS NOT NULL) AS "hasDraft", d."classId" AS "draftClassId"` : `NULL::jsonb AS "draftPayload", NULL::jsonb AS "draftDates", false AS "hasDraft", NULL::text AS "draftClassId"`},
            -- 검수 D-1 (b) 발행 뒤 손 수정 감사(관리자 «청구서 수정») — 이 기능의 승인 기록(source POST_ISSUE)은 빼고 본다
            ${has("PaymentAuditLog") ? `EXISTS (SELECT 1 FROM "PaymentAuditLog" ma WHERE ma."paymentId" = p.id AND ma.action = 'PAYMENT_UPDATE_UNPAID' AND COALESCE(ma.metadata->>'source','') <> 'POST_ISSUE')` : "false"} AS "manualEdited",
            -- (c) 같은 반에 지금 수강 중(재등록)
            EXISTS (SELECT 1 FROM "Enrollment" se WHERE se."studentId" = p."studentId" AND se."classId" = p."classId" AND se.status = 'ACTIVE') AS "sameClassActive",
            -- (d) 그 달 다른 반을 수강 중인데 그 반 청구가 없음(청구 반을 옮겼을 수 있다)
            EXISTS (SELECT 1 FROM "Enrollment" oe
                     WHERE oe."studentId" = p."studentId" AND oe."classId" <> p."classId" AND oe.status = 'ACTIVE'
                       AND (oe."startsOn" IS NULL OR oe."startsOn" < make_date(p.year, p.month, 1) + interval '1 month')
                       AND NOT EXISTS (SELECT 1 FROM "Payment" op WHERE op."studentId" = p."studentId" AND op."classId" = oe."classId"
                                        AND op.year = p.year AND op.month = p.month AND op.status NOT IN ('CANCELED','CANCELLED'))) AS "otherClassUnbilled"
       FROM "Enrollment" e
       JOIN last_end le ON le."enrollmentId" = e.id AND le.kind IN ('WITHDRAW','CLASS_CHANGE')
       JOIN "Payment" p ON p."studentId" = e."studentId" AND p."classId" = e."classId"
       JOIN "Student" s ON s.id = p."studentId" AND ${notMergedStudent("s")}
       JOIN "Class" c ON c.id = p."classId"
       ${draftReady ? `LEFT JOIN "BillingWorkbenchDraft" d ON d."paymentId" = p.id AND d.status = 'ISSUED'` : ""}
      WHERE e.status = 'WITHDRAWN'
        AND COALESCE(p.type, 'MONTHLY') = 'MONTHLY' AND p.year IS NOT NULL AND p.month IS NOT NULL
        AND p.status IN ('PENDING','OVERDUE','PAID')
        AND make_date(p.year, p.month, 1) + interval '1 month' > le."endYmd"::date
        AND ${rallyzMirrorExclusionSql("p")}
        ${opts.paymentId ? `AND p.id = $1` : ""}
      ORDER BY p.year, p.month, p.id
      LIMIT 500`,
    ...(opts.paymentId ? [opts.paymentId] : []),
  );
  // 학부모 결제 진행 중(30분 안 결제창·기한 남은 입금 계좌) — 관리자 청구서 수정·부상 결석 보류와 같은 판정 함수
  const unpaidIds = rows.filter((r) => r.status !== "PAID").map((r) => String(r.id));
  const active = unpaidIds.length ? await findParentCheckoutActivePaymentIds(db, unpaidIds, opts.nowMs ?? Date.now()) : new Set<string>();
  const items: PostIssueItem[] = [];
  for (const row of rows) {
    const input: EndedBillInput = {
      paymentId: String(row.id), studentId: String(row.studentId), studentName: String(row.studentName ?? ""), classId: String(row.classId),
      className: String(row.className ?? ""), year: Number(row.year), month: Number(row.month), amount: Number(row.amount), status: String(row.status),
      endKind: row.endKind, endYmd: String(row.endYmd),
      draft: row.hasDraft ? { payload: asAmounts(row.draftPayload), scheduledDates: asDates(row.draftDates) } : null,
      skip: row.status === "PAID" ? null : skipCodeOf(row, active.has(String(row.id))),
      anomaly: anomalyOf({ draftClassId: row.draftClassId ?? null, paymentClassId: String(row.classId), hasDraft: Boolean(row.hasDraft),
        manualEdited: Boolean(row.manualEdited), sameClassActive: Boolean(row.sameClassActive), otherClassUnbilled: Boolean(row.otherClassUnbilled) }),
      // 결제된 청구가 이미 이월 근거가 됐으면 목록에서 숨긴다(검수 D-3)
      carried: Boolean(row.carrySource),
    };
    const item = decideEndedBill(input);
    if (item) items.push(item);
  }
  return items;
}

/** 반 변경 차액이 마이너스인 줄(목록만) — 차액 청구서를 만들지 않은(invoicedPaymentId 없음) 승인·반영 건 */
export async function readClassChangeItems(db: PostIssueTx, classDatesFor: ClassDatesFor | null, sinceYmd: string): Promise<PostIssueItem[]> {
  const rows = await db.$queryRawUnsafe<Array<{
    id: string; studentId: string; studentName: string; fromClassName: string | null; toClassName: string | null; effectiveFrom: string;
    fromDay: string | null; toDay: string | null; fromFee: number | null; toFee: number | null;
  }>>(
    `SELECT r.id, r."studentId", s.name AS "studentName", fc.name AS "fromClassName", tc.name AS "toClassName",
            to_char(r."effectiveFrom",'YYYY-MM-DD') AS "effectiveFrom",
            fc."dayOfWeek" AS "fromDay", tc."dayOfWeek" AS "toDay", fp.price AS "fromFee", tp.price AS "toFee"
       FROM "EnrollmentChangeRequest" r
       JOIN "Student" s ON s.id = r."studentId" AND ${notMergedStudent("s")}
       LEFT JOIN "Class" fc ON fc.id = r."fromClassId"
       LEFT JOIN "Class" tc ON tc.id = r."toClassId"
       LEFT JOIN "Program" fp ON fp.id = fc."programId"
       LEFT JOIN "Program" tp ON tp.id = tc."programId"
      WHERE r.kind = 'CLASS_CHANGE' AND r.status IN ('APPROVED','APPLIED') AND r."invoicedPaymentId" IS NULL
        AND r."effectiveFrom" >= $1::date
      ORDER BY r."effectiveFrom", r.id
      LIMIT 300`,
    sinceYmd,
  );
  const items: PostIssueItem[] = [];
  for (const row of rows) {
    const ym = String(row.effectiveFrom).slice(0, 7);
    // 반 변경 청구서 발행(issueProrationInvoice)과 같은 계산 함수·같은 입력(프로그램 정가·그달 수업일)
    // 계산하지 못하면 이유를 따로 정한다(달력 못 읽음·옛 반/새 반 요일 모름 — 검수 D-2)
    const problem = classChangeProblemOf({ calendarRead: Boolean(classDatesFor), fromDay: row.fromDay, toDay: row.toDay });
    const proration = classDatesFor && !problem && row.fromDay && row.toDay
      ? computeClassChangeProration({
          effectiveFrom: row.effectiveFrom,
          from: { monthlyFee: Number(row.fromFee ?? 0), classDates: classDatesFor(ym, row.fromDay) },
          to: { monthlyFee: Number(row.toFee ?? 0), classDates: classDatesFor(ym, row.toDay) },
        })
      : null;
    const item = decideClassChange({
      requestId: String(row.id), studentId: String(row.studentId), studentName: String(row.studentName ?? ""),
      fromClassName: row.fromClassName ?? "기존 반", toClassName: row.toClassName ?? "새 반", effectiveFrom: String(row.effectiveFrom), proration, problem,
    });
    if (item) items.push(item);
  }
  return items;
}

/**
 * 이미 처리한 줄 — 무시는 «열쇠 그대로»(제안 종류 포함, 검수 D-4), 승인은 «바탕 열쇠»(종류를 뗀 것)로 거른다.
 * 승인으로 금액을 바꾼 청구는 다시 읽으면 «발행 뒤 금액이 바뀜 → 확인 필요»가 되는데, 그 줄까지 다시 뜨지 않게 하려는 것.
 */
async function handledKeys(db: PostIssueTx): Promise<{ dismissed: Set<string>; approvedBase: Set<string> }> {
  const rows = await db.$queryRawUnsafe<Array<{ action: string; key: string | null }>>(
    `SELECT DISTINCT a.action, a."detailsJson"->>'key' AS key FROM "OperationsAuditLog" a WHERE a.action = ANY($1::text[])`,
    [POST_ISSUE_DISMISS_ACTION, POST_ISSUE_APPROVE_ACTION],
  );
  const dismissed = new Set<string>(), approvedBase = new Set<string>();
  for (const row of rows) {
    if (!row.key) continue;
    if (row.action === POST_ISSUE_APPROVE_ACTION) approvedBase.add(baseKeyOf(row.key)); else dismissed.add(row.key);
  }
  return { dismissed, approvedBase };
}

export type PostIssueView = { items: PostIssueItem[]; writesEnabled: boolean; calendarMissing: boolean };

/** 화면에 보일 목록(무시·승인한 줄은 뺀다) */
export async function readPostIssueView(db: PostIssueTx, input: { classDatesFor: ClassDatesFor | null; writesEnabled: boolean; sinceYmd: string; nowMs?: number }): Promise<PostIssueView> {
  const bills = await readEndedBillItems(db, { nowMs: input.nowMs });
  const changes = await readClassChangeItems(db, input.classDatesFor, input.sinceYmd);
  const handled = await handledKeys(db);
  return {
    items: sortPostIssueItems([...bills, ...changes].filter((item) => !handled.dismissed.has(item.key) && !handled.approvedBase.has(baseKeyOf(item.key)))),
    writesEnabled: input.writesEnabled,
    calendarMissing: !input.classDatesFor,
  };
}

export type ApproveInput = { key: string; kind: "CANCEL" | "PRORATE"; paymentId: string; currentAmount: number; proposedAmount: number };

/** 승인 요청 모양 검사 — 화면이 본 제안(열쇠·종류·지금 금액·제안 금액)만 받는다. 금액은 서버가 다시 계산해 같을 때만 쓴다 */
export function validateApproveInput(body: unknown): ApproveInput {
  const b = (body && typeof body === "object" && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
  const ok = typeof b.key === "string" && KEY_RE.test(b.key) && b.key.startsWith("P:")
    && (b.kind === "CANCEL" || b.kind === "PRORATE")
    && typeof b.paymentId === "string" && b.key.split(":")[1] === b.paymentId && b.key.endsWith(`:${String(b.kind)}`)
    && Number.isSafeInteger(b.currentAmount) && Number.isSafeInteger(b.proposedAmount)
    && (b.proposedAmount as number) >= 0 && (b.proposedAmount as number) < (b.currentAmount as number);
  if (!ok) throw new WorkbenchError("요청 내용을 확인해 주세요. 목록을 새로 조회해 주세요.");
  return { key: b.key as string, kind: b.kind as ApproveInput["kind"], paymentId: b.paymentId as string, currentAmount: b.currentAmount as number, proposedAmount: b.proposedAmount as number };
}

/**
 * 한 줄 승인 — 취소 또는 금액 변경. 전부 한 거래(READ COMMITTED — 결제 잠금 «뒤에» 읽는 결제·POS 가 그 사이 커밋분까지 보이게).
 * 잠금 순서(청구 준비 발행·부상 결석 보류·청구서 수정과 같게 — 교착 금지): 청구 준비 전역 잠금 → 결제 잠금 → 청구 행 → 청구서 행.
 * 잠근 뒤 제안을 다시 계산해 화면이 본 것과 같을 때만 쓴다(그 사이 복귀·결제·수정이 끼면 아무것도 하지 않는다).
 * 권한(원장)·쓰기 스위치는 부르는 쪽(API)이 먼저 확인하고, 여기서도 스위치를 다시 본다.
 */
export async function approvePostIssueChange(db: PostIssueDb, body: unknown, actorId: string, writesEnabled: boolean, nowMs = Date.now()) {
  if (!writesEnabled) throw new WorkbenchError("청구 준비 저장은 운영 적용 승인 전까지 잠겨 있습니다.", 503);
  if (!actorId) throw new WorkbenchError("관리자 확인이 필요합니다.", 403);
  const input = validateApproveInput(body);
  return db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext('STIZ_BILLING_WORKBENCH'))`);
    await lockPaymentsForCheckout(tx, [input.paymentId]);
    const locked = await tx.$queryRawUnsafe<Array<{ id: string; status: string }>>(`SELECT id, status FROM "Payment" WHERE id = $1 FOR UPDATE`, input.paymentId);
    if (!locked.length) throw new WorkbenchError("청구를 찾을 수 없습니다. 목록을 새로 조회해 주세요.", 409, true);
    // 잠근 뒤 다시 계산 — 화면이 본 제안과 다르면(복귀·결제 시작·금액 수정 등) 쓰지 않는다
    // 같은 청구·같은 종료일 줄을 «바탕 열쇠»로 찾는다 — 그 사이 «확인 필요»로 바뀌었으면 그 이유를 그대로 알려 준다
    const now = (await readEndedBillItems(tx, { paymentId: input.paymentId, nowMs })).find((item) => baseKeyOf(item.key) === baseKeyOf(input.key)) ?? null;
    if (!sameProposal(input, now)) {
      throw new WorkbenchError(now && !now.approvable ? `지금은 승인할 수 없습니다: ${now.text}` : "청구 상태가 바뀌었습니다. 목록을 새로 조회해 주세요.", 409, true);
    }
    const invoices = await tx.$queryRawUnsafe<Array<{ id: string; status: string; amount: number }>>(
      `SELECT id, status, amount FROM "PaymentInvoice" WHERE "paymentId" = $1 FOR UPDATE`, input.paymentId);
    const invoice = invoices[0];
    if (!invoice || !["ISSUED", "SENT", "OVERDUE"].includes(invoice.status)) throw new WorkbenchError("청구서 상태가 바뀌었습니다. 목록을 새로 조회해 주세요.", 409, true);

    if (input.kind === "CANCEL") {
      // 관리자 «청구서 삭제»(cancelUnpaidPayment)와 같은 조건부 UPDATE — 지금도 미납·연체일 때만, 청구서도 함께 취소
      const paymentUpdated = Number(await tx.$executeRawUnsafe(
        `UPDATE "Payment" SET status = 'CANCELED', "paidDate" = NULL, "updatedAt" = NOW()
          WHERE id = $1 AND status IN ('PENDING', 'OVERDUE')`, input.paymentId));
      const invoiceUpdated = Number(await tx.$executeRawUnsafe(
        `UPDATE "PaymentInvoice" SET status = 'CANCELED', "canceledAt" = NOW(), "updatedAt" = NOW()
          WHERE id = $1 AND "paymentId" = $2 AND status IN ('ISSUED', 'SENT', 'OVERDUE')`, invoice.id, input.paymentId));
      if (paymentUpdated !== 1 || invoiceUpdated !== 1) throw new WorkbenchError("청구 상태가 바뀌어 처리하지 않았습니다. 목록을 새로 조회해 주세요.", 409, true);
      await tx.$executeRawUnsafe(
        `INSERT INTO "PaymentAuditLog" (id, "paymentId", "invoiceId", "actorType", "actorId", action, message, metadata, "createdAt")
         VALUES (gen_random_uuid()::text, $1, $2, 'ADMIN', $3, 'PAYMENT_CANCEL_UNPAID', $4, $5::jsonb, NOW())`,
        input.paymentId, invoice.id, actorId, POST_ISSUE_CANCEL_REASON,
        // 취소 전 청구·청구서 상태를 남긴다 — 손으로 되살릴 때 근거(검수 D-5)
        JSON.stringify({ amount: input.currentAmount, source: "POST_ISSUE", key: input.key,
          before: { paymentStatus: locked[0].status, invoiceStatus: invoice.status } }));
    } else {
      // 관리자 «청구서 수정»(updateUnpaidPayment)과 같은 칸만 바꾼다(금액). 지금 금액이 본 금액일 때만(조건부)
      const paymentUpdated = Number(await tx.$executeRawUnsafe(
        `UPDATE "Payment" SET amount = $2, "updatedAt" = NOW()
          WHERE id = $1 AND status IN ('PENDING', 'OVERDUE') AND amount = $3`, input.paymentId, input.proposedAmount, input.currentAmount));
      const invoiceUpdated = Number(await tx.$executeRawUnsafe(
        `UPDATE "PaymentInvoice" SET amount = $3, "updatedAt" = NOW()
          WHERE id = $1 AND "paymentId" = $2 AND status IN ('ISSUED', 'SENT', 'OVERDUE')`, invoice.id, input.paymentId, input.proposedAmount));
      if (paymentUpdated !== 1 || invoiceUpdated !== 1) throw new WorkbenchError("청구 상태가 바뀌어 처리하지 않았습니다. 목록을 새로 조회해 주세요.", 409, true);
      await tx.$executeRawUnsafe(
        `INSERT INTO "PaymentAuditLog" (id, "paymentId", "invoiceId", "actorType", "actorId", action, message, metadata, "createdAt")
         VALUES (gen_random_uuid()::text, $1, $2, 'ADMIN', $3, 'PAYMENT_UPDATE_UNPAID', $4, $5::jsonb, NOW())`,
        input.paymentId, invoice.id, actorId, POST_ISSUE_PRORATE_REASON,
        JSON.stringify({ before: { amount: input.currentAmount, invoiceAmount: Number(invoice.amount), paymentStatus: locked[0].status, invoiceStatus: invoice.status }, after: { amount: input.proposedAmount },
          rollback: { amount: input.currentAmount }, source: "POST_ISSUE", key: input.key }));
    }

    // 현장 결제(POS) 요청은 결제 잠금을 잡지 않는다 — 바꾼 «뒤에» 한 번 더 읽어 그 사이 생겼으면 전부 되돌린다(부상 결석 보류와 같은 방어)
    const posTables = await tableSet(tx, ["PosChargeRequest", "PosChargeRequestItem"]);
    if (posTables.size === 2) {
      const busy = await tx.$queryRawUnsafe<Array<{ id: string }>>(`SELECT p.id FROM "Payment" p WHERE p.id = $1 AND ${HOLD_POS_BUSY_SQL}`, input.paymentId);
      if (busy.length) throw new WorkbenchError("현장 결제 요청이 방금 시작된 청구라 처리하지 않았습니다. 요청이 끝난 뒤 다시 확인해 주세요.", 409, true);
    }
    await tx.$executeRawUnsafe(
      `INSERT INTO "OperationsAuditLog" (id, action, "actorType", "actorUserId", "detailsJson")
       VALUES (gen_random_uuid()::text, $1, 'ADMIN', $2, $3::jsonb)`,
      POST_ISSUE_APPROVE_ACTION, actorId,
      JSON.stringify({ key: input.key, kind: input.kind, paymentId: input.paymentId, before: input.currentAmount, after: input.proposedAmount, notificationsSent: false }));
    return { ok: true as const, kind: input.kind, paymentId: input.paymentId, amount: input.proposedAmount };
  }, { timeout: 20_000 });
}

/** «무시» — 다시 뜨지 않게 기록만 남긴다(같은 열쇠는 한 번만). 청구·수강은 건드리지 않는다 */
export async function dismissPostIssueChange(db: PostIssueDb, body: unknown, actorId: string, writesEnabled: boolean) {
  if (!writesEnabled) throw new WorkbenchError("청구 준비 저장은 운영 적용 승인 전까지 잠겨 있습니다.", 503);
  if (!actorId) throw new WorkbenchError("관리자 확인이 필요합니다.", 403);
  const b = (body && typeof body === "object" && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
  if (typeof b.key !== "string" || !KEY_RE.test(b.key)) throw new WorkbenchError("요청 내용을 확인해 주세요.");
  const key = b.key;
  return db.$transaction(async (tx) => {
    // 같은 열쇠 동시 «무시»가 두 줄을 남기지 않게 열쇠 단위로 잠근다
    await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, `stiz-post-issue:${key}`);
    const exists = await tx.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT id FROM "OperationsAuditLog" WHERE action = $1 AND "detailsJson"->>'key' = $2 LIMIT 1`, POST_ISSUE_DISMISS_ACTION, key);
    if (!exists.length) {
      await tx.$executeRawUnsafe(
        `INSERT INTO "OperationsAuditLog" (id, action, "actorType", "actorUserId", "detailsJson")
         VALUES (gen_random_uuid()::text, $1, 'ADMIN', $2, $3::jsonb)`,
        POST_ISSUE_DISMISS_ACTION, actorId, JSON.stringify({ key }));
    }
    return { ok: true as const, key };
  });
}
