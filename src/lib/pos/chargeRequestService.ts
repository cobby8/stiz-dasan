/**
 * 토스 POS «현장 결제» 요청 — 서버 실행부 (DB · 슬랙 · 원장부 연결)
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 돈을 지키는 규칙
 * ─────────────────────────────────────────────────────────────────────────
 * 1. 청구서를 «납부완료»로 바꾸는 곳은 matchChargeRequestsForOrder **하나뿐**이고,
 *    그 근거는 토스 웹훅(서명 검증) → 토스 Open API 재조회로 받은 주문뿐이다.
 *    플러그인이 보내는 보고(report)는 기록만 하고 절대 납부 처리하지 않는다.
 * 2. 금액은 항상 **서버 DB 값**(요청을 만들 때의 Payment.amount 스냅샷)만 쓴다.
 * 3. 선점·재확인은 **한 문장 조건부 UPDATE**(동시에 두 웹훅이 와도 한 곳만 성공).
 * 4. 납부 처리는 markPaymentPaid(원장부) 경유 — Payment 를 직접 UPDATE 하지 않는다.
 * 5. 자동 반영 조건이 하나라도 어긋나면 요청을 HELD 로 두고 기존 슬랙 확인 흐름에 넘긴다(원장 결정 D1).
 *
 * 판정 규칙은 ./charge-request.mjs(순수 모듈) 한 벌이다. 여기는 입출력만 한다.
 * 시각은 전부 DB(now()·timestamptz)에서 만든다 — 서버 시계(UTC)로 날짜를 만들지 않는다.
 */

import { randomInt } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { markPaymentPaid, markPaymentsPaidTogether, recordPaymentAudit, refundPaidPaymentInTx, revalidatePaymentCaches, type LedgerSqlClient } from "@/lib/payment-ledger";
import { taxFreeAmountFor } from "@/lib/payments/taxFree";
import { postMessage } from "@/lib/slack/client";
import { notMergedStudent } from "@/lib/studentVisibility";
import {
    CHARGE_EXPIRES_MINUTES,
    MATCH_ACTION,
    buildChargeItemName,
    buildChargeMemo,
    chargeEligibility,
    decideChargeMatch,
    extractChargeCodes,
    formatChargeWon,
    maskStudentName,
    nonApprovedPayments,
    paymentTypeLabel,
    taxExemptAmountsOf,
    randomShortCode,
    describeChargePayments,
    isOrderCompleted,
    posMethodLabel,
    posMethodOf,
    CANCEL_PICKUP_TIMEOUT_SEC,
    cancelEligibility,
    chargePaymentIdsOf,
    decideChargeCancel,
    MAX_CHARGE_ITEMS,
    buildChargeBundleName,
    chargeBundleEligibility,
    chargeItemsSummary,
    sortChargeItems,
} from "./charge-request.mjs";

// 순수 JS(.mjs) 함수는 TS 가 인자 타입을 좁게 추론한다 → 이 파일에서만 느슨하게 받는다.
const decide = decideChargeMatch as unknown as (input: unknown) => {
    action: string;
    reason: string;
    /** 대표 결제(가장 먼저 승인된 것) */
    payment: ApprovedPayment | null;
    /** 이 요청에 쓰인 승인 결제 전부(분할이면 여러 건, 승인 순) */
    payments: ApprovedPayment[];
    /** 마지막 승인 시각(납부일·만료 판단) */
    paidAtIso: string | null;
    /** 분할 결제 중간이라 남은 결제를 기다리는 중 */
    waiting?: boolean;
};
const methodOf = posMethodOf as (sourceTypes: string[]) => string;
const describePayments = describeChargePayments as (payments: ApprovedPayment[]) => string;
const posLabelOf = (method: string) => (posMethodLabel as (m: string) => string | null)(method) ?? method;
const completedOf = isOrderCompleted as (order: unknown, eventType?: string) => boolean;
const eligibility = chargeEligibility as unknown as (payment: unknown) => { ok: boolean; reason: string };
const paymentIdsOf = chargePaymentIdsOf as (input: { tossPaymentId?: string | null; note?: string | null; auditPaymentIds?: string[] | null }) => string[];
const cancelVerdictOf = decideChargeCancel as (input: { paymentIds: string[]; order: unknown }) => {
    action: "FULL" | "PARTIAL" | "NONE";
    cancelled: string[];
    other: { id: string; state: string }[];
};
const cancelCheck = cancelEligibility as unknown as (input: unknown) => { ok: boolean; reason: string };
const itemNameOf = buildChargeItemName as (input: { year: number | null; month: number | null; type: string; maskedName: string }) => string;
type ItemNameInput = { year: number | null; month: number | null; type: string };
const bundleNameOf = buildChargeBundleName as (input: { items: ItemNameInput[]; maskedName: string }) => string;
const summaryOf = chargeItemsSummary as (items: ItemNameInput[]) => string;
const bundleCheck = chargeBundleEligibility as unknown as (payments: unknown[]) => { ok: boolean; reason: string };
const sortItems = sortChargeItems as <T>(payments: T[]) => T[];

/** POS 가 취소 완료를 보고한 뒤 토스 확인을 기다리는 «정상» 시간(분). 넘으면 관리자 창에 늦어진다는 안내 */
const CANCEL_CONFIRM_LATE_MIN = 3;

const DISMISS_OUTCOMES = ["DONE", "FAILED", "NEEDS_LOCAL_CANCEL"] as const;
type DismissOutcome = (typeof DISMISS_OUTCOMES)[number];
type DismissState = DismissOutcome | "REQUESTED" | "ACKNOWLEDGED";

// ───────────────────────────── 타입 ─────────────────────────────

/** 승인 결제 1건(payment-notice.mjs 의 extractChargePayments 결과 중 쓰는 칸 — 결제 방식 무관) */
export type ApprovedPayment = { tossPaymentId: string; tossOrderId: string; amount: number; approvedAtIso: string | null; sourceType?: string };

/** 실패 사유 코드 — 관리자 화면·플러그인 API 가 같이 쓴다 */
export type ChargeErrorCode = "NOT_FOUND" | "NOT_ELIGIBLE" | "ALREADY_OPEN" | "NOT_CLAIMABLE" | "CHANGED" | "CODE_EXHAUSTED";

export class ChargeRequestError extends Error {
    constructor(public code: ChargeErrorCode, message: string) {
        super(message);
        this.name = "ChargeRequestError";
    }
}

type ViewRow = {
    id: string;
    shortCode: string;
    paymentId: string;
    status: string;
    amount: number;
    taxFreeAmount: number;
    expiresAtUtc: string;
    expiresKstHm: string;
    createdAtUtc: string;
    paidKst: string | null;
    isExpired: boolean;
    /** PAID 로 바뀐 지 2분 이내(DB 시계) — 원장부 납부 기록이 아직 진행 중일 수 있는 틈 */
    justPaid?: boolean;
    note: string | null;
    createdVia: string;
    paymentType: string;
    year: number | null;
    month: number | null;
    paymentStatus: string;
    studentName: string;
    /** 결제 취소(사이트 → POS) 칸 — VIEW_SQL 이 같이 읽는다 */
    tossOrderId: string | null;
    tossPaymentId: string | null;
    cancelState: string | null;
    cancelReportMessage?: string | null;
    dismissState: DismissState | null;
    dismissReportMessage: string | null;
    pluginReportedEvent: string | null;
    pluginReportMessage: string | null;
    refundedKst?: string | null;
    /** 취소 요청 뒤 CANCEL_PICKUP_TIMEOUT_SEC 가 지나도 플러그인이 안 가져감 */
    cancelPickupLate?: boolean;
    /** 결제 요청이 CHARGE_PICKUP_TIMEOUT_SEC 넘게 PENDING(POS 가 안 받아 감) */
    chargePickupLate?: boolean;
    /** 플러그인이 취소 결과를 보고했나 */
    cancelReported?: boolean;
    /** POS 취소 완료 보고 뒤 CANCEL_CONFIRM_LATE_MIN 분이 지나도 토스 확인(DONE)이 없음 */
    cancelConfirmLate?: boolean;
    paidProvider?: string | null;
};

/** 관리자 화면용(실명 포함) */
export type AdminChargeRequestView = {
    id: string;
    shortCode: string;
    paymentId: string;
    status: string;
    amount: number;
    taxFreeAmount: number;
    expiresAt: string;
    expiresKstHm: string;
    paidKst: string | null;
    isExpired: boolean;
    note: string | null;
    studentName: string;
    /** 단건 = «2026년 11월 수강료», 묶음 = «수강료 11월 외 1건» */
    itemLabel: string;
    memo: string;
    /** 묶인 청구 수(단건 1) */
    itemCount: number;
    /** 묶인 청구(POS 주문 항목 순서) */
    items: { paymentId: string; itemLabel: string; amount: number }[];
    /** POS 로 보낸 지 CHARGE_PICKUP_TIMEOUT_SEC 가 지나도 아직 PENDING(POS 가 안 받아 감) → «POS 가 응답이 없어요» 안내(DB 시계) */
    pickupLate: boolean;
    dismissState: DismissState | null;
    dismissReportMessage: string | null;
    pluginReportedEvent: string | null;
    pluginReportMessage: string | null;
};

/** 플러그인 API 응답용(이름 가림) — docs/toss-pos-plugin-plan.md «API 계약»과 같은 모양 */
export type PluginChargeRequestView = {
    id: string;
    shortCode: string;
    status: string;
    amount: number;
    taxFreeAmount: number;
    itemName: string;
    /** itemName 과 같은 값(플러그인 README 의 칸 이름) */
    itemTitle: string;
    memo: string;
    studentLabel: string;
    /** studentLabel 과 같은 값 — **가린 이름**(플러그인 README 의 칸 이름) */
    studentName: string;
    expiresAt: string;
    createdAt: string;
    /**
     * POS 주문 항목(청구별 1개 · 단건도 1개). 플러그인은 이것대로 항목을 담고 «항목마다 금액·면세·메모 + 합계»를 확인한다.
     * 합계 = amount, 면세 합계 = taxFreeAmount. memo 는 전부 같은 번호(STIZ:S-…) — 웹훅 매칭이 주문에서 번호 1개를 찾는다.
     */
    items: PluginChargeItemView[];
};

/** 플러그인 응답의 POS 주문 항목 1개(이름 가림) */
export type PluginChargeItemView = {
    itemName: string;
    itemTitle: string;
    amount: number;
    taxFreeAmount: number;
    memo: string;
};

/** 요청에 묶인 청구 1건 + 그 청구의 지금 DB 값(PosChargeRequestItem ⨝ Payment). 항목이 없는 옛 요청은 대표 청구 1건으로 만든다. */
type ChargeItemRow = {
    requestId: string;
    paymentId: string;
    /** 요청 순간 스냅샷 금액 */
    amount: number;
    taxFreeAmount: number;
    position: number;
    paymentType: string;
    year: number | null;
    month: number | null;
    /** 청구의 지금 상태·금액·납부 경로 */
    paymentStatus: string;
    paymentAmount: number;
    paidProvider: string | null;
};

/** 결제 요청을 POS 가 이만큼(초) 안 받아 가면 관리자 창에 «POS 가 응답이 없어요» — 취소 쪽(CANCEL_PICKUP_TIMEOUT_SEC)과 같은 90초. 요청은 자동 취소하지 않는다 */
const CHARGE_PICKUP_TIMEOUT_SEC = 90;

const UNPAID_STATUSES = ["PENDING", "OVERDUE"];
const isUnpaid = (status: unknown) => UNPAID_STATUSES.includes(String(status));

// ───────────────────────────── SQL ─────────────────────────────

/**
 * 요청 + 청구서 + 원생 이름. 시각은 timestamptz 라 AT TIME ZONE 을 **한 번만** 건다.
 * 원생은 청구서에 붙은 사람을 그대로 보여 준다(청구 조회 — 병합 필터 예외, studentVisibility.test.ts 에 등록).
 */
const VIEW_SQL = `SELECT r.id, r."shortCode", r."paymentId", r.status, r.amount, r."taxFreeAmount",
        to_char(r."expiresAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "expiresAtUtc",
        to_char(r."expiresAt" AT TIME ZONE 'Asia/Seoul', 'HH24:MI') AS "expiresKstHm",
        to_char(r."createdAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "createdAtUtc",
        to_char(r."paidAt" AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD HH24:MI') AS "paidKst",
        (r."expiresAt" <= now()) AS "isExpired",
        -- 납부 «기록» 시각(paidRecordedAt, 없으면 승인 시각 paidAt) 기준 — 취소 알림 note 등으로 updatedAt 이 바뀌어도 영향 없게
        (r.status = 'PAID' AND COALESCE(r."paidRecordedAt", r."paidAt") > now() - interval '2 minutes') AS "justPaid",
        r.note, r."createdVia",
        r."tossOrderId", r."tossPaymentId", r."cancelState", r."cancelReportMessage",
        r."dismissState", r."dismissReportMessage", r."pluginReportedEvent", r."pluginReportMessage",
        to_char(r."refundedAt" AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD HH24:MI') AS "refundedKst",
        (r."cancelState" = 'REQUESTED' AND r."cancelRequestedAt" < now() - interval '${CANCEL_PICKUP_TIMEOUT_SEC} seconds') AS "cancelPickupLate",
        (r.status = 'PENDING' AND r."createdAt" < now() - interval '${CHARGE_PICKUP_TIMEOUT_SEC} seconds') AS "chargePickupLate",
        (r."cancelReportedAt" IS NOT NULL) AS "cancelReported",
        (r."cancelState" = 'SENT' AND r."cancelReportedAt" < now() - interval '${CANCEL_CONFIRM_LATE_MIN} minutes') AS "cancelConfirmLate",
        p.type AS "paymentType", p.year, p.month, p.status AS "paymentStatus", p."paidProvider",
        st.name AS "studentName"
   FROM "PosChargeRequest" r
   JOIN "Payment" p ON p.id = r."paymentId"
   JOIN "Student" st ON st.id = p."studentId"`;

// ── 묶음(2026-11-08): 요청 1건이 청구 여러 건(PosChargeRequestItem)을 묶는다. 아래 조각을 각 문장에 끼운다. ──

/**
 * 요청 r 에 묶인 청구(청구 id·스냅샷 금액). 항목이 없는 옛 요청(마이그레이션 적용 전후 틈에 옛 코드가 만든 것)은 대표 청구 1건.
 * 요청 표의 별칭이 r 인 문장에서만 쓴다.
 */
const ITEMS_OF_R = `(SELECT i."paymentId", i.amount FROM "PosChargeRequestItem" i WHERE i."requestId" = r.id
          UNION ALL
          SELECT r."paymentId", r.amount
           WHERE NOT EXISTS (SELECT 1 FROM "PosChargeRequestItem" i0 WHERE i0."requestId" = r.id))`;

/**
 * 묶인 청구 «전부»가 아직 미납 + 금액이 스냅샷 그대로 + 수강료·셔틀비, 그리고 항목 합계 = 요청 금액.
 * 하나라도 어긋나면(이미 납부·금액 변경·청구 삭제) 거짓 → 선점·납부를 하지 않는다(일부만 납부 금지).
 * 청구가 지워졌으면(LEFT JOIN 이 NULL) COALESCE 가 false 로 만들어 «어긋남»으로 센다.
 */
const ALL_ITEMS_UNPAID_SQL = `NOT EXISTS (SELECT 1 FROM ${ITEMS_OF_R} it LEFT JOIN "Payment" p ON p.id = it."paymentId"
                       WHERE NOT COALESCE(p.status IN ('PENDING', 'OVERDUE') AND p.amount = it.amount AND p.type IN ('MONTHLY', 'SHUTTLE', 'OTHER'), false))
      AND (SELECT sum(it.amount) FROM ${ITEMS_OF_R} it) = r.amount`;

/** 요청 r 이 청구 $n 을 묶고 있나(대표 청구이거나 항목에 있거나) */
function hasPaymentSql(n: number): string {
    const param = "$" + String(n);
    return `(r."paymentId" = ${param} OR EXISTS (SELECT 1 FROM "PosChargeRequestItem" ih WHERE ih."requestId" = r.id AND ih."paymentId" = ${param}))`;
}

/** 열린 요청 중 시간이 지난 것을 EXPIRED 로(전체 또는 그 청구서가 묶인 요청). */
const EXPIRE_SQL = `UPDATE "PosChargeRequest" r
      SET status = 'EXPIRED', "updatedAt" = now()
    WHERE r.status IN ('PENDING', 'SENT') AND r."expiresAt" <= now()
      AND ($1::text IS NULL OR ${hasPaymentSql(1)})
    RETURNING r.id`;

/**
 * 요청 만들기 — 청구서 상태·금액·학생을 **INSERT 하는 그 문장에서** 다시 확인한다.
 * $9 = 청구 id 들(POS 주문 항목 순서), $10 = 직전에 읽은 금액들(DB 값). 그 사이 하나라도 납부·금액 변경이면 0행.
 * 대표 청구(paymentId) = 1번 항목, 금액 = Payment.amount 합계(DB 값), 같은 학생이어야 한다.
 * 같은 청구서에 열린 요청이 있으면 부분 유일 인덱스(요청의 대표 청구 · 항목 표의 열린 항목)가 막는다.
 */
const INSERT_SQL = `WITH want AS (
        SELECT u.pid, u.amt, u.ord FROM unnest($9::text[], $10::int[]) WITH ORDINALITY AS u(pid, amt, ord)
      ), ok AS (
        SELECT p.id, p.amount, p."studentId", w.ord
          FROM want w
          JOIN "Payment" p ON p.id = w.pid AND p.amount = w.amt
         WHERE p.status IN ('PENDING', 'OVERDUE') AND p.type IN ('MONTHLY', 'SHUTTLE', 'OTHER')
      )
      INSERT INTO "PosChargeRequest" (
        "shortCode", "paymentId", amount, "taxFreeAmount", status, "expiresAt",
        "createdVia", "createdByUserId", "createdByName", "claimedAt", "claimedByTokenId"
      )
      SELECT $1, (SELECT ok.id FROM ok ORDER BY ok.ord LIMIT 1), (SELECT sum(ok.amount) FROM ok)::int, $2::int, $3,
             now() + ($4::int * interval '1 minute'),
             $5, $6, $7, CASE WHEN $8::text IS NULL THEN NULL ELSE now() END, $8::text
       WHERE (SELECT count(*) FROM ok) = cardinality($9::text[])
         AND (SELECT count(DISTINCT ok."studentId") FROM ok) = 1
      RETURNING id`;

/**
 * 묶인 청구 항목 — 같은 트랜잭션에서 요청 바로 뒤에. 금액은 위에서 확인한 DB 값($3), 면세는 taxFreeAmountFor($4).
 * 요청 INSERT 트리거(pos_charge_request_add_rep_item)가 대표 청구 항목(1번, 금액 = 요청 합계)을 먼저 넣어 두므로
 * 같은 (요청, 청구) 행은 ON CONFLICT 로 덮어써 흡수한다 — 대표 항목이 두 줄 생기지 않고, 묶음이면 대표 항목 금액이 그 청구 몫으로 고쳐진다.
 * RETURNING 은 새로 넣은 행·덮어쓴 행 모두 돌려주므로 행 수 = 청구 수.
 */
const INSERT_ITEMS_SQL = `INSERT INTO "PosChargeRequestItem" ("requestId", "paymentId", amount, "taxFreeAmount", position)
      SELECT $1, p.id, u.amt, u.tf, u.ord::int
        FROM unnest($2::text[], $3::int[], $4::int[]) WITH ORDINALITY AS u(pid, amt, tf, ord)
        JOIN "Payment" p ON p.id = u.pid AND p.amount = u.amt AND p.status IN ('PENDING', 'OVERDUE')
      ON CONFLICT ("requestId", "paymentId") DO UPDATE
         SET amount = EXCLUDED.amount, "taxFreeAmount" = EXCLUDED."taxFreeAmount", position = EXCLUDED.position
      RETURNING id`;

/**
 * 요청들에 묶인 청구 + 그 청구의 지금 값(이름은 요청 쪽 대표 청구의 학생 = 묶음 전체의 학생).
 */
const ITEMS_SQL = `SELECT i."requestId", i."paymentId", i.amount, i."taxFreeAmount", i.position,
        p.type AS "paymentType", p.year, p.month, p.status AS "paymentStatus", p.amount AS "paymentAmount", p."paidProvider"
   FROM "PosChargeRequestItem" i
   JOIN "Payment" p ON p.id = i."paymentId"
  WHERE i."requestId" = ANY($1::text[])
  ORDER BY i."requestId", i.position`;

/**
 * 플러그인 선점(PENDING → SENT). 같은 토큰이 다시 부르면(응답을 못 받고 재시도) 그대로 성공.
 * 묶인 청구가 그 사이 바뀌었으면(하나라도 납부·금액 수정) 0행.
 */
const CLAIM_SQL = `UPDATE "PosChargeRequest" r
      SET status = 'SENT', "claimedAt" = COALESCE(r."claimedAt", now()), "claimedByTokenId" = $2, "updatedAt" = now()
    WHERE r.id = $1 AND r."expiresAt" > now()
      AND (r.status = 'PENDING' OR (r.status = 'SENT' AND r."claimedByTokenId" = $2))
      AND ${ALL_ITEMS_UNPAID_SQL}
    RETURNING r.id`;

/**
 * 자동 납부 선점 — 이 문장이 1행을 바꿨을 때만 원장부에 납부를 쓴다.
 * 결제 승인 시각이 만료 전이어야 하고(늦게 온 웹훅·스윕이 먼저 EXPIRED 로 바꾼 경우도 살린다),
 * 묶인 청구가 «전부» 아직 미납이고 금액이 스냅샷과 같아야 한다(ALL_ITEMS_UNPAID_SQL). 같은 토스 결제가 다른 요청에 이미 붙었으면 유일 인덱스가 막는다.
 * 분할 결제(2026-11-08): 유일 칸(tossPaymentId)에는 대표 결제(가장 먼저 승인) 1건만 넣고, 나머지 결제 ID 는
 * note($6)·감사 기록(PaymentAuditLog)에 남긴다. 나머지 결제의 이중 매칭은 «같은 토스 주문이 다른 요청에 이미 PAID»
 * 조건(NOT EXISTS)으로 막는다 — 한 주문의 결제는 전부 그 주문 몫이라 주문 단위로 막으면 결제 단위로도 막힌다.
 * $4 = 마지막 승인 시각(만료 판단·납부일).
 */
const CLAIM_PAY_SQL = `UPDATE "PosChargeRequest" r
      SET status = 'PAID', "tossOrderId" = $2, "tossPaymentId" = $3,
          "paidAt" = COALESCE($4::timestamptz, now()), "paidRecordedAt" = now(), note = COALESCE($6::text, r.note), "updatedAt" = now()
    WHERE r.id = $1 AND r.amount = $5::int
      AND r.status IN ('PENDING', 'SENT', 'EXPIRED')
      AND COALESCE($4::timestamptz, now()) <= r."expiresAt"
      AND NOT EXISTS (SELECT 1 FROM "PosChargeRequest" o
                       WHERE o.id <> r.id AND o."tossOrderId" = $2 AND o.status = 'PAID')
      AND ${ALL_ITEMS_UNPAID_SQL}
    RETURNING r.id, r."paymentId", r."shortCode"`;

/** 보류(HELD) — 열린/만료 요청만. 토스 결제 ID 는 note 에만 적는다(유일 인덱스는 «납부된 결제» 용). */
const HOLD_SQL = `UPDATE "PosChargeRequest"
      SET status = 'HELD', "heldAt" = now(), "tossOrderId" = COALESCE("tossOrderId", $2), note = $3, "updatedAt" = now()
    WHERE id = $1 AND status IN ('PENDING', 'SENT', 'EXPIRED')
    RETURNING id`;

// ───────────────────────────── 도우미 ─────────────────────────────

const readEnv = (name: string) => (typeof process.env[name] === "string" ? (process.env[name] as string).trim() : "");

/** 유일 제약 위반(23505)인가 + 어느 인덱스인가 */
function uniqueViolation(error: unknown): string | null {
    const message = String((error as Error)?.message ?? "");
    if (!/23505|unique constraint|duplicate key/i.test(message)) return null;
    // 요청 표(PosChargeRequest_…)와 묶음 항목 표(PosChargeRequestItem_…) 인덱스 둘 다
    const m = /"(PosChargeRequest(?:Item)?_[A-Za-z_]+)"/.exec(message);
    return m ? m[1] : "unknown";
}

/** 항목이 없는 옛 요청 → 대표 청구 1건(요청 금액 = 그 청구 금액) */
function fallbackItem(row: ViewRow & { paymentAmount?: number }): ChargeItemRow {
    return {
        requestId: row.id,
        paymentId: row.paymentId,
        amount: Number(row.amount),
        taxFreeAmount: Number(row.taxFreeAmount),
        position: 1,
        paymentType: row.paymentType,
        year: row.year,
        month: row.month,
        paymentStatus: String(row.paymentStatus),
        paymentAmount: Number(row.paymentAmount ?? row.amount),
        paidProvider: row.paidProvider ?? null,
    };
}

/** 요청들의 묶인 청구(항목 순서). 한 번의 조회로 읽고, 항목이 없는 요청은 대표 청구 1건으로 채운다. */
async function itemsByRequest(rows: Array<ViewRow & { paymentAmount?: number }>): Promise<Map<string, ChargeItemRow[]>> {
    const map = new Map<string, ChargeItemRow[]>();
    if (rows.length === 0) return map;
    const found = await prisma.$queryRawUnsafe<ChargeItemRow[]>(ITEMS_SQL, rows.map((r) => r.id));
    for (const it of found ?? []) {
        const list = map.get(it.requestId) ?? [];
        list.push({
            ...it,
            amount: Number(it.amount),
            taxFreeAmount: Number(it.taxFreeAmount),
            position: Number(it.position),
            paymentAmount: Number(it.paymentAmount),
            paidProvider: it.paidProvider ?? null,
        });
        map.set(it.requestId, list);
    }
    for (const row of rows) if (!map.has(row.id)) map.set(row.id, [fallbackItem(row)]);
    return map;
}

async function itemsOf(row: ViewRow & { paymentAmount?: number }): Promise<ChargeItemRow[]> {
    return (await itemsByRequest([row])).get(row.id) ?? [fallbackItem(row)];
}

/** 항목 → 상품명 입력 */
const nameInputOf = (it: ChargeItemRow): ItemNameInput => ({ year: it.year, month: it.month, type: it.paymentType });

function toAdminView(row: ViewRow, items: ChargeItemRow[] = [fallbackItem(row)]): AdminChargeRequestView {
    // 자동 납부는 «요청 PAID 선점 → 원장부(청구서) 납부 기록» 순서다. 그 짧은 틈에 관리자 창이 PAID 를 읽으면
    // 목록을 다시 읽어도 청구서가 아직 미납이라 «미납»으로 남았다(2026-11-08 원장 화면). 청구서가 아직 미납이면
    // 관리자 화면엔 «결제 기다리는 중»(SENT, 만료 아님)으로 보여 계속 읽게 하고, 청구서까지 납부된 뒤 PAID 로 보인다.
    // 단, PAID 로 바뀐 지 2분 이내일 때만 — 서버가 그 틈에 멈춘 드문 경우 창이 끝없이 기다리지 않게.
    // 묶음은 묶인 청구 중 하나라도 아직 미납이면 기다린다(원장부는 묶음을 한 트랜잭션으로 쓴다).
    const ledgerPending = row.status === "PAID" && Boolean(row.justPaid)
        && (isUnpaid(row.paymentStatus) || items.some((it) => isUnpaid(it.paymentStatus)));
    return {
        id: row.id,
        shortCode: row.shortCode,
        paymentId: row.paymentId,
        status: ledgerPending ? "SENT" : row.status,
        amount: Number(row.amount),
        taxFreeAmount: Number(row.taxFreeAmount),
        expiresAt: row.expiresAtUtc,
        expiresKstHm: row.expiresKstHm,
        paidKst: row.paidKst,
        isExpired: ledgerPending ? false : Boolean(row.isExpired),
        note: row.note,
        studentName: row.studentName,
        itemLabel: items.length > 1
            ? summaryOf(items.map(nameInputOf))
            : itemNameOf({ year: row.year, month: row.month, type: row.paymentType, maskedName: "" }),
        memo: buildChargeMemo(row.shortCode),
        itemCount: items.length,
        items: items.map((it) => ({
            paymentId: it.paymentId,
            itemLabel: itemNameOf({ ...nameInputOf(it), maskedName: "" }),
            amount: it.amount,
        })),
        // 원장부 대기(ledgerPending)면 상태를 SENT 로 보이므로 무응답 안내도 끈다
        pickupLate: !ledgerPending && row.status === "PENDING" && Boolean(row.chargePickupLate),
        dismissState: row.dismissState,
        dismissReportMessage: row.dismissReportMessage,
        pluginReportedEvent: row.pluginReportedEvent,
        pluginReportMessage: row.pluginReportMessage,
    };
}

function toPluginView(row: ViewRow, items: ChargeItemRow[] = [fallbackItem(row)]): PluginChargeRequestView {
    const masked = maskStudentName(row.studentName);
    // 대표 상품명: 단건 = «2026년 11월 수강료(홍*동)» 그대로, 묶음 = «2026년 11월 수강료 외 1건(홍*동)»
    const itemName = items.length > 1
        ? bundleNameOf({ items: items.map(nameInputOf), maskedName: masked })
        : itemNameOf({ year: row.year, month: row.month, type: row.paymentType, maskedName: masked });
    const memo = buildChargeMemo(row.shortCode);
    return {
        id: row.id,
        shortCode: row.shortCode,
        status: row.status,
        amount: Number(row.amount),
        // 면세 금액(필수) — 만들 때 taxFreeAmountFor(amount) 로 저장한 값. 플러그인은 amount 와 같을 때만 결제 화면을 연다.
        taxFreeAmount: Number(row.taxFreeAmount),
        itemName,
        itemTitle: itemName,
        memo,
        studentLabel: masked,
        studentName: masked,
        expiresAt: row.expiresAtUtc,
        createdAt: row.createdAtUtc,
        // 항목별 금액·면세(요청 순간 스냅샷). 단건은 항목 1개 = 요청 금액·면세 그대로.
        items: items.length > 1
            ? items.map((it) => {
                const name = itemNameOf({ ...nameInputOf(it), maskedName: masked });
                return { itemName: name, itemTitle: name, amount: it.amount, taxFreeAmount: it.taxFreeAmount, memo };
            })
            : [{ itemName, itemTitle: itemName, amount: Number(row.amount), taxFreeAmount: Number(row.taxFreeAmount), memo }],
    };
}

async function loadView(where: string, ...params: unknown[]): Promise<ViewRow[]> {
    const rows = await prisma.$queryRawUnsafe<ViewRow[]>(`${VIEW_SQL} ${where}`, ...params);
    return rows.map((r) => ({ ...r, amount: Number(r.amount), taxFreeAmount: Number(r.taxFreeAmount) }));
}

async function notifyOwner(text: string): Promise<boolean> {
    const owner = readEnv("SLACK_OWNER_USER_ID");
    if (!owner) {
        console.warn("[pos-charge] 원장 슬랙 ID(SLACK_OWNER_USER_ID)가 없어 알림을 보내지 못했습니다.");
        return false;
    }
    try {
        await postMessage({ channel: owner, text });
        return true;
    } catch (error) {
        console.error("[pos-charge] 슬랙 알림 실패:", String((error as Error).message).slice(0, 300));
        return false;
    }
}

/** 슬랙 알림을 요청당 한 번만 — 표시 칸을 먼저 선점한 쪽만 보낸다. */
async function notifyOnce(requestId: string, column: "slackNotifiedAt" | "cancelNotifiedAt" | "refundNotifiedAt", text: string) {
    const claimed = await prisma.$queryRawUnsafe<{ id: string }[]>(
        `UPDATE "PosChargeRequest" SET "${column}" = now() WHERE id = $1 AND "${column}" IS NULL RETURNING id`,
        requestId,
    );
    if (claimed.length === 0) return;
    const sent = await notifyOwner(text);
    // 못 보냈으면 표시를 풀어 다음 웹훅·스윕이 다시 보낼 수 있게 한다.
    if (!sent) {
        await prisma.$executeRawUnsafe(`UPDATE "PosChargeRequest" SET "${column}" = NULL WHERE id = $1`, requestId);
    }
}

// ───────────────────────────── 만료 ─────────────────────────────

/** 시간 지난 열린 요청을 EXPIRED 로. 10분 스윕과 조회 직전에 부른다. */
export async function expireStaleChargeRequests(paymentId: string | null = null): Promise<number> {
    const rows = await prisma.$queryRawUnsafe<{ id: string }[]>(EXPIRE_SQL, paymentId);
    return rows.length;
}

// ───────────────────────────── 만들기·취소·조회 ─────────────────────────────

type PaymentRow = { id: string; studentId: string; type: string; status: string; amount: number; year: number | null; month: number | null };

async function loadPayments(paymentIds: string[]): Promise<PaymentRow[]> {
    const rows = await prisma.$queryRawUnsafe<PaymentRow[]>(
        `SELECT id, "studentId", type, status, amount, year, month FROM "Payment" WHERE id = ANY($1::text[])`,
        paymentIds,
    );
    return (rows ?? []).map((r) => ({ ...r, amount: Number(r.amount) }));
}

/** 이 청구들 중 하나라도 묶고 있는 열린 요청 */
async function openRequestsFor(paymentIds: string[]): Promise<ViewRow[]> {
    return loadView(
        `WHERE (r.status IN ('PENDING', 'SENT') OR r."dismissState" IN ('REQUESTED', 'FAILED', 'NEEDS_LOCAL_CANCEL'))
           AND (r."paymentId" = ANY($1::text[])
                OR EXISTS (SELECT 1 FROM "PosChargeRequestItem" ih WHERE ih."requestId" = r.id AND ih."paymentId" = ANY($1::text[])))
         ORDER BY r."createdAt" DESC
         LIMIT 5`,
        paymentIds,
    );
}

/** 두 청구 id 목록이 같은 묶음인가(순서 무관) */
const sameSet = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join("\n") === [...b].sort().join("\n");

/**
 * 이미 열린 요청이 있을 때: 정확히 같은 청구 묶음이면 그것을 돌려주고(같은 버튼을 두 번 누름),
 * 일부만 겹치면 막는다 — 같은 청구가 두 열린 요청에 들어가면 한 결제가 두 번 받힐 수 있다.
 */
async function existingOpenFor(paymentIds: string[]): Promise<ViewRow | null> {
    const open = await openRequestsFor(paymentIds);
    if (open.length === 0) return null;
    const waitingDismissal = open.find((r) => r.status === "CANCELLED");
    if (waitingDismissal) {
        throw new ChargeRequestError("ALREADY_OPEN", `이전 요청(${waitingDismissal.shortCode})의 POS 취소를 먼저 확인해 주세요.`);
    }
    const items = await itemsByRequest(open);
    const same = open.find((r) => sameSet((items.get(r.id) ?? []).map((it) => it.paymentId), paymentIds));
    if (same && open.length === 1) return same;
    const codes = open.map((r) => r.shortCode).join(", ");
    throw new ChargeRequestError(
        "ALREADY_OPEN",
        `선택한 청구가 이미 POS 로 보낸 다른 결제 요청(${codes})에 들어 있습니다. 그 요청이 끝나거나 취소된 뒤 다시 보내 주세요.`,
    );
}

/**
 * 요청 만들기(청구 1건 또는 같은 학생의 여러 건). 이미 같은 묶음의 열린 요청이 있으면 그것을 돌려준다(existing: true).
 * claimTokenId 를 주면(플러그인 탭) 만들면서 바로 SENT 로 선점한다.
 * 요청 + 항목은 한 트랜잭션 — 항목이 하나라도 못 들어가면(그 사이 납부·다른 요청에 들어감) 요청도 남지 않는다.
 */
async function createRow(input: {
    paymentIds: string[];
    via: "ADMIN" | "PLUGIN";
    actorUserId: string | null;
    actorName: string | null;
    claimTokenId: string | null;
}): Promise<{ row: ViewRow; existing: boolean }> {
    const paymentIds = [...new Set((Array.isArray(input.paymentIds) ? input.paymentIds : []).map((id) => String(id ?? "").trim()))];
    if (paymentIds.length === 0 || paymentIds.some((id) => !id || id.length > 100)) {
        throw new ChargeRequestError("NOT_FOUND", "청구서를 찾지 못했습니다.");
    }
    if (paymentIds.length > MAX_CHARGE_ITEMS) {
        throw new ChargeRequestError("NOT_ELIGIBLE", `한 번에 현장 결제할 수 있는 청구는 ${MAX_CHARGE_ITEMS}건까지입니다.`);
    }

    for (const id of paymentIds) await expireStaleChargeRequests(id);
    // 서버에서 다시 확인: 청구가 다 있고 · 수강료·셔틀비 · 미납 · 금액 정상 · 같은 학생(화면 판단은 믿지 않는다)
    const loaded = await loadPayments(paymentIds);
    if (loaded.length !== paymentIds.length) throw new ChargeRequestError("NOT_FOUND", "청구서를 찾지 못했습니다.");
    const check = paymentIds.length === 1 ? eligibility(loaded[0]) : bundleCheck(loaded);
    if (!check.ok) throw new ChargeRequestError("NOT_ELIGIBLE", check.reason);

    const open = await existingOpenFor(paymentIds);
    if (open) return { row: open, existing: true };

    // POS 주문 항목 순서(연·월 → 수강료·셔틀비). 1번이 대표 청구.
    const sorted = sortItems(loaded);
    const ids = sorted.map((p) => p.id);
    const amounts = sorted.map((p) => p.amount);
    // 면세 금액 — 토스페이먼츠 경로와 같은 한 함수(원장 결정 D2: 수강료·셔틀비 전액 면세). 청구마다 계산해 더한다.
    const taxFrees = sorted.map((payment) => taxFreeAmountFor(payment.amount));
    const taxFree = taxFrees.reduce((acc, n) => acc + n, 0);
    const total = amounts.reduce((acc, n) => acc + n, 0);
    for (let attempt = 0; attempt < 8; attempt += 1) {
        const code = randomShortCode(randomInt) as string;
        try {
            const requestId = await prisma.$transaction(async (db) => {
                const inserted = await db.$queryRawUnsafe<{ id: string }[]>(
                    INSERT_SQL,
                    code,
                    taxFree,
                    input.claimTokenId ? "SENT" : "PENDING",
                    CHARGE_EXPIRES_MINUTES,
                    input.via,
                    input.actorUserId,
                    input.actorName,
                    input.claimTokenId,
                    ids,
                    amounts,
                );
                if (inserted.length === 0) throw new ChargeRequestError("CHANGED", "청구서 상태나 금액이 방금 바뀌었습니다. 화면을 새로고침해 주세요.");
                const items = await db.$queryRawUnsafe<{ id: string }[]>(INSERT_ITEMS_SQL, inserted[0].id, ids, amounts, taxFrees);
                if (items.length !== ids.length) throw new ChargeRequestError("CHANGED", "청구서 상태나 금액이 방금 바뀌었습니다. 화면을 새로고침해 주세요.");
                return inserted[0].id;
            });
            const rows = await loadView(`WHERE r.id = $1`, requestId);
            if (!rows[0]) throw new ChargeRequestError("NOT_FOUND", "만든 요청을 다시 읽지 못했습니다.");
            // 감사 기록은 묶인 청구마다(청구 상세 이력에서 각자 보이게)
            for (const payment of sorted) {
                await recordPaymentAudit({
                    paymentId: payment.id,
                    actorType: input.via === "ADMIN" ? "ADMIN" : "SYSTEM",
                    actorId: input.via === "ADMIN" ? input.actorUserId : `pos-token:${input.claimTokenId}`,
                    action: "POS_CHARGE_REQUEST_CREATED",
                    message: ids.length > 1
                        ? `현장 결제 요청 ${code} (묶음 ${ids.length}건 · 합계 ${formatChargeWon(total)} 중 ${formatChargeWon(payment.amount)})`
                        : `현장 결제 요청 ${code} (${formatChargeWon(payment.amount)})`,
                    metadata: {
                        requestId,
                        shortCode: code,
                        amount: payment.amount,
                        taxFreeAmount: taxFreeAmountFor(payment.amount),
                        via: input.via,
                        ...(ids.length > 1 ? { bundle: { paymentIds: ids, total, taxFreeTotal: taxFree } } : {}),
                    },
                }).catch((e) => console.error("[pos-charge] 감사기록 실패:", String((e as Error).message).slice(0, 200)));
            }
            return { row: rows[0], existing: false };
        } catch (error) {
            if (error instanceof ChargeRequestError) throw error;
            const index = uniqueViolation(error);
            if (index === "PosChargeRequest_open_shortCode_key") continue; // 번호가 겹쳤다 → 다시 뽑는다
            if (index === "PosChargeRequest_open_payment_key" || index === "PosChargeRequestItem_open_payment_key") {
                // 다른 사람이 동시에 같은 청구로 만들었다 → 같은 묶음이면 그 요청을 보여 주고, 아니면 막는다
                const again = await existingOpenFor(paymentIds);
                if (again) return { row: again, existing: true };
            }
            throw error;
        }
    }
    throw new ChargeRequestError("CODE_EXHAUSTED", "번호를 만들지 못했습니다. 잠시 후 다시 눌러 주세요.");
}

/** 관리자 «현장 결제» — 청구 1건, 또는 같은 학생의 여러 건(«선택 항목 납부 처리 → 현장 결제»)을 POS 결제 한 번으로 */
export async function createChargeRequestByAdmin(input: { paymentIds: string[]; adminUserId: string; adminName: string }) {
    const { row, existing } = await createRow({
        paymentIds: input.paymentIds,
        via: "ADMIN",
        actorUserId: input.adminUserId,
        actorName: input.adminName,
        claimTokenId: null,
    });
    return { request: toAdminView(row, await itemsOf(row)), existing };
}

/** 관리자 화면: 이 청구서가 묶인 최근 요청(열린 것 우선, 없으면 가장 최근 것) */
export async function getChargeRequestForPayment(paymentId: string): Promise<AdminChargeRequestView | null> {
    await expireStaleChargeRequests(paymentId);
    const rows = await loadView(
        `WHERE ${hasPaymentSql(1)}
         ORDER BY (r.status IN ('PENDING', 'SENT')) DESC, r."createdAt" DESC
         LIMIT 1`,
        paymentId,
    );
    return rows[0] ? toAdminView(rows[0], await itemsOf(rows[0])) : null;
}

/**
 * 관리자 화면(여러 건): 정확히 이 청구 묶음으로 만든 최근 요청. 1건이면 getChargeRequestForPayment 와 같다.
 * 일부만 겹치는 요청(다른 묶음)은 보여 주지 않는다 — «보내기»를 누르면 서버가 겹침을 막고 이유를 알려 준다.
 */
export async function getChargeRequestForPayments(paymentIds: string[]): Promise<AdminChargeRequestView | null> {
    const ids = [...new Set((Array.isArray(paymentIds) ? paymentIds : []).map((id) => String(id ?? "").trim()).filter(Boolean))];
    if (ids.length <= 1) return ids[0] ? getChargeRequestForPayment(ids[0]) : null;
    if (ids.length > MAX_CHARGE_ITEMS || ids.some((id) => id.length > 100)) return null;
    for (const id of ids) await expireStaleChargeRequests(id);
    const rows = await loadView(
        `WHERE ${hasPaymentSql(1)}
         ORDER BY (r.status IN ('PENDING', 'SENT')) DESC, r."createdAt" DESC
         LIMIT 10`,
        ids[0],
    );
    const items = await itemsByRequest(rows);
    const row = rows.find((r) => sameSet((items.get(r.id) ?? []).map((it) => it.paymentId), ids));
    return row ? toAdminView(row, items.get(row.id)) : null;
}

/** 관리자 취소 — 미결제 요청을 닫고, 선점한 POS가 있으면 그 기기의 주문 정리를 요청한다. */
export async function cancelChargeRequestByAdmin(input: { requestId: string; adminUserId: string }) {
    const rows = await prisma.$queryRawUnsafe<{ id: string; paymentId: string; shortCode: string }[]>(
        `UPDATE "PosChargeRequest"
            SET status = 'CANCELLED', "cancelledAt" = now(), "cancelledBy" = $2, "updatedAt" = now(),
                "dismissState" = CASE WHEN status = 'SENT' AND "claimedByTokenId" IS NOT NULL THEN 'REQUESTED' ELSE NULL END
          WHERE id = $1 AND status IN ('PENDING', 'SENT')
            AND "paidAt" IS NULL AND "tossPaymentId" IS NULL
          RETURNING id, "paymentId", "shortCode"`,
        input.requestId,
        input.adminUserId,
    );
    if (rows.length === 0) throw new ChargeRequestError("NOT_CLAIMABLE", "이미 끝났거나 취소된 요청입니다.");
    // 감사 기록은 묶인 청구마다(청구 상세 이력에서 각자 보이게). 항목이 없는 옛 요청은 대표 청구 1건.
    // 취소는 이미 확정됐다 — 항목 조회가 실패해도 오류로 돌려주지 않고 대표 청구 1건으로 기록한다(검수 권장 2026-11-08)
    const found = await prisma
        .$queryRawUnsafe<{ paymentId: string }[]>(ITEMS_SQL, [rows[0].id])
        .catch(() => [] as { paymentId: string }[]);
    const paymentIds = found && found.length > 0 ? [...new Set(found.map((it) => it.paymentId))] : [rows[0].paymentId];
    for (const paymentId of paymentIds) {
        await recordPaymentAudit({
            paymentId,
            actorType: "ADMIN",
            actorId: input.adminUserId,
            action: "POS_CHARGE_REQUEST_CANCELLED",
            message: paymentIds.length > 1
                ? `현장 결제 요청 ${rows[0].shortCode} 취소 (묶음 ${paymentIds.length}건)`
                : `현장 결제 요청 ${rows[0].shortCode} 취소`,
            metadata: { requestId: rows[0].id, ...(paymentIds.length > 1 ? { bundleSize: paymentIds.length } : {}) },
        }).catch((e) => console.error("[pos-charge] 감사기록 실패:", String((e as Error).message).slice(0, 200)));
    }
}

/** POS에서 수동으로 주문을 정리한 뒤 관리자가 확인한다. 청구·환불은 처리하지 않는다. */
export async function acknowledgeChargeDismissalByAdmin(input: { requestId: string; adminUserId: string }) {
    const rows = await prisma.$queryRawUnsafe<{ id: string; paymentId: string; shortCode: string }[]>(
        `UPDATE "PosChargeRequest"
            SET "dismissState" = 'ACKNOWLEDGED', "dismissReportedAt" = now(), "updatedAt" = now()
          WHERE id = $1 AND status = 'CANCELLED' AND "paidAt" IS NULL AND "tossPaymentId" IS NULL
            AND "dismissState" IN ('FAILED', 'NEEDS_LOCAL_CANCEL')
          RETURNING id, "paymentId", "shortCode"`,
        input.requestId,
    );
    if (!rows[0]) throw new ChargeRequestError("NOT_CLAIMABLE", "POS 취소 확인이 필요한 요청을 찾지 못했습니다.");
    await recordPaymentAudit({
        paymentId: rows[0].paymentId,
        actorType: "ADMIN",
        actorId: input.adminUserId,
        action: "POS_CHARGE_DISMISSAL_ACKNOWLEDGED",
        message: `현장 결제 요청 ${rows[0].shortCode}의 POS 수동 취소를 확인했습니다.`,
        metadata: { requestId: rows[0].id },
    }).catch((e) => console.error("[pos-charge] 감사기록 실패:", String((e as Error).message).slice(0, 200)));
}

/** 원래 주문을 선점한 POS만 그 주문의 미결제 취소를 받는다. */
export async function listChargeDismissalsForPlugin(tokenId: string) {
    return prisma.$queryRawUnsafe<{ id: string; shortCode: string }[]>(
        `SELECT id, "shortCode" FROM "PosChargeRequest"
          WHERE "claimedByTokenId" = $1 AND status = 'CANCELLED' AND "dismissState" = 'REQUESTED'
            AND "paidAt" IS NULL AND "tossPaymentId" IS NULL
          ORDER BY "cancelledAt" ASC LIMIT 20`, tokenId,
    );
}

export async function hasUnknownChargeDismissal(tokenId: string, knownIds: string[]): Promise<boolean> {
    const [row] = await prisma.$queryRawUnsafe<{ found: boolean }[]>(
        `SELECT EXISTS (SELECT 1 FROM "PosChargeRequest"
          WHERE "claimedByTokenId" = $1 AND status = 'CANCELLED' AND "dismissState" = 'REQUESTED'
            AND "paidAt" IS NULL AND "tossPaymentId" IS NULL
            AND "cancelledAt" > now() - interval '90 seconds'
            AND NOT (id = ANY($2::text[]))) AS found`, tokenId, knownIds,
    );
    return Boolean(row?.found);
}

export function normalizePluginDismissOutcome(value: unknown): DismissOutcome | null {
    return DISMISS_OUTCOMES.find((outcome) => outcome === value) ?? null;
}

/** POS에서 장바구니 확인을 마친 뒤 결제창 열기 직전에 요청 상태를 다시 읽는다. */
export async function assertChargeRequestMayStartForPlugin(requestId: string, tokenId: string): Promise<void> {
    const [row] = await prisma.$queryRawUnsafe<{ id: string }[]>(
        `SELECT r.id FROM "PosChargeRequest" r
          WHERE r.id = $1 AND r."claimedByTokenId" = $2 AND r.status = 'SENT' AND r."expiresAt" > now()
            AND r."dismissState" IS NULL AND r."paidAt" IS NULL AND r."tossPaymentId" IS NULL
            AND ${ALL_ITEMS_UNPAID_SQL}`, requestId, tokenId,
    );
    if (!row) throw new ChargeRequestError("NOT_CLAIMABLE", "취소됐거나 상태가 달라진 결제 요청입니다.");
}

/**
 * POS 가 startPayment 오류를 받았을 때 «정말 결제됐는지» 서버에 묻는다(읽기 전용, 2026-11-10 S-563655).
 * 이 POS 가 가져간 요청만 본다. 납부 여부는 토스 웹훅이 기록한 값(status·paidAt·tossPaymentId)만 쓴다.
 */
export async function getChargeRequestPaymentStateForPlugin(requestId: string, tokenId: string): Promise<{ status: string; paid: boolean }> {
    const id = String(requestId ?? "").trim();
    if (!/^[0-9a-f-]{10,64}$/i.test(id)) throw new ChargeRequestError("NOT_FOUND", "요청을 찾지 못했습니다.");
    const [row] = await prisma.$queryRawUnsafe<{ status: string; paid: boolean }[]>(
        `SELECT r.status, (r.status = 'PAID' OR r."paidAt" IS NOT NULL OR r."tossPaymentId" IS NOT NULL) AS paid
           FROM "PosChargeRequest" r WHERE r.id = $1 AND r."claimedByTokenId" = $2`,
        id,
        tokenId,
    );
    if (!row) throw new ChargeRequestError("NOT_FOUND", "요청을 찾지 못했습니다.");
    return { status: row.status, paid: row.paid === true };
}

/** 이 보고는 POS 주문의 UI 상태만 기록한다. 승인·환불 상태는 토스가 확인한 값만 쓴다. */
export async function reportChargeDismissalFromPlugin(input: {
    requestId: string;
    tokenId: string;
    outcome: DismissOutcome;
    reason?: string | null;
}): Promise<{ dismissState: DismissState; duplicate: boolean }> {
    const [updated] = await prisma.$queryRawUnsafe<{ dismissState: DismissState }[]>(
        `UPDATE "PosChargeRequest"
            SET "dismissState" = $3, "dismissReportMessage" = $4, "dismissReportedAt" = now(), "updatedAt" = now()
          WHERE id = $1 AND "claimedByTokenId" = $2 AND status = 'CANCELLED' AND "dismissState" = 'REQUESTED'
            AND "paidAt" IS NULL AND "tossPaymentId" IS NULL
          RETURNING "dismissState"`, input.requestId, input.tokenId, input.outcome, input.reason?.trim().slice(0, 120) || null,
    );
    if (updated) return { dismissState: updated.dismissState, duplicate: false };
    const [previous] = await prisma.$queryRawUnsafe<{ dismissState: DismissState | null }[]>(
        `SELECT "dismissState" FROM "PosChargeRequest" WHERE id = $1 AND "claimedByTokenId" = $2 AND status = 'CANCELLED'`,
        input.requestId, input.tokenId,
    );
    if (!previous?.dismissState) throw new ChargeRequestError("NOT_FOUND", "이 POS에서 처리할 취소 요청을 찾지 못했습니다.");
    return { dismissState: previous.dismissState, duplicate: true };
}

// ───────────────────────────── 플러그인 API ─────────────────────────────

/** 열린(대기·가져감) 요청 목록 — 만료 전인 것만 */
export async function listOpenChargeRequestsForPlugin(): Promise<PluginChargeRequestView[]> {
    await expireStaleChargeRequests(null);
    const rows = await loadView(
        `WHERE r.status IN ('PENDING', 'SENT') AND r."expiresAt" > now()
         ORDER BY r."createdAt" ASC
         LIMIT 50`,
    );
    const items = await itemsByRequest(rows);
    return rows.map((row) => toPluginView(row, items.get(row.id)));
}

/**
 * 롱폴링 대기 중 약 1초마다 부르는 «가벼운» 확인 — 플러그인이 모르는(known 에 없는) 대기 요청이 있는지만.
 * 만료 정리(UPDATE)나 이름·청구서 JOIN 없이 (status, expiresAt) 인덱스만 본다. 있으면 그때 목록을 다시 읽는다.
 */
export async function hasUnknownPendingChargeRequest(knownIds: string[]): Promise<boolean> {
    const rows = await prisma.$queryRawUnsafe<{ found: boolean }[]>(
        `SELECT EXISTS (
            SELECT 1 FROM "PosChargeRequest"
             WHERE status = 'PENDING' AND "expiresAt" > now() AND NOT (id = ANY($1::text[]))
         ) AS found`,
        knownIds,
    );
    return Boolean(rows[0]?.found);
}

/** 선점(PENDING → SENT). 응답 금액·면세·메모는 서버 DB 값. */
export async function claimChargeRequestForPlugin(requestId: string, tokenId: string): Promise<PluginChargeRequestView> {
    const id = String(requestId ?? "").trim();
    if (!/^[0-9a-f-]{10,64}$/i.test(id)) throw new ChargeRequestError("NOT_FOUND", "요청을 찾지 못했습니다.");
    const claimed = await prisma.$queryRawUnsafe<{ id: string }[]>(CLAIM_SQL, id, tokenId);
    const rows = await loadView(`WHERE r.id = $1`, id);
    if (!rows[0]) throw new ChargeRequestError("NOT_FOUND", "요청을 찾지 못했습니다.");
    if (claimed.length === 0) {
        throw new ChargeRequestError("NOT_CLAIMABLE", "이미 다른 곳에서 가져갔거나, 만료·취소된 요청입니다.");
    }
    return toPluginView(rows[0], await itemsOf(rows[0]));
}

/**
 * POS 탭에서 미납을 골랐을 때 — 요청을 만들면서 바로 선점(같은 청구서 단건 대기 요청이 있으면 그걸 선점).
 * 그 청구가 관리자가 보낸 «묶음» 요청에 들어 있으면 막는다(ALREADY_OPEN) — 묶음은 대기 목록에서 결제한다.
 */
export async function createAndClaimForPlugin(paymentId: string, tokenId: string): Promise<PluginChargeRequestView> {
    const { row, existing } = await createRow({ paymentIds: [paymentId], via: "PLUGIN", actorUserId: null, actorName: null, claimTokenId: tokenId });
    if (!existing) return toPluginView(row, await itemsOf(row));
    return claimChargeRequestForPlugin(row.id, tokenId);
}

export const PLUGIN_REPORT_EVENTS = ["SENT", "PAID", "CANCELLED", "FAILED", "START_FAILED"] as const;
export type PluginReportEvent = (typeof PLUGIN_REPORT_EVENTS)[number];

/**
 * 플러그인이 보내는 event 글자 → 저장 값. 플러그인 README 는 소문자(paid·cancel·start_failed)를 쓴다.
 * 모르는 값이면 null(400).
 */
export function normalizePluginReportEvent(value: unknown): PluginReportEvent | null {
    const raw = String(value ?? "").trim().toUpperCase().replace(/-/g, "_");
    const alias: Record<string, PluginReportEvent> = { CANCEL: "CANCELLED", CANCELED: "CANCELLED" };
    const event = alias[raw] ?? raw;
    return (PLUGIN_REPORT_EVENTS as readonly string[]).includes(event) ? (event as PluginReportEvent) : null;
}

/**
 * 플러그인 보고 — **기록만** 한다. PAID 보고로 납부 처리하지 않는다(위조 가능).
 * CANCELLED 는 열린 요청을 취소 표시한다(돈은 안 움직임 — 그 뒤 결제가 오면 슬랙 확인 흐름).
 */
export async function reportChargeRequestFromPlugin(input: {
    requestId: string;
    tokenId: string;
    event: PluginReportEvent;
    message?: string | null;
}): Promise<{ status: string; paid: boolean; duplicate: boolean }> {
    const id = String(input.requestId ?? "").trim();
    if (!/^[0-9a-f-]{10,64}$/i.test(id)) throw new ChargeRequestError("NOT_FOUND", "요청을 찾지 못했습니다.");
    const message = input.message ? String(input.message).slice(0, 300) : null;
    // 같은 요청 + 같은 event 는 한 번만(워커·탭이 둘 다 보낼 수 있다): 받은 종류 목록에 없을 때만 바뀐다.
    const rows = await prisma.$queryRawUnsafe<{ status: string }[]>(
        `UPDATE "PosChargeRequest"
            SET "pluginReportedEvent" = $2::text, "pluginReportedAt" = now(), "pluginReportMessage" = $3,
                "pluginReportedEvents" = array_append("pluginReportedEvents", $2::text),
                status = CASE WHEN $2::text = 'CANCELLED' AND status IN ('PENDING', 'SENT') THEN 'CANCELLED' ELSE status END,
                "cancelledAt" = CASE WHEN $2::text = 'CANCELLED' AND status IN ('PENDING', 'SENT') THEN now() ELSE "cancelledAt" END,
                "cancelledBy" = CASE WHEN $2::text = 'CANCELLED' AND status IN ('PENDING', 'SENT') THEN $4 ELSE "cancelledBy" END,
                "updatedAt" = now()
          WHERE id = $1 AND NOT ($2::text = ANY("pluginReportedEvents"))
          RETURNING status`,
        id,
        input.event,
        message,
        `pos-token:${input.tokenId}`,
    );
    if (rows[0]) return { status: rows[0].status, paid: rows[0].status === "PAID", duplicate: false };
    // 0행 = 없는 요청이거나 이미 받은 보고. 지금 상태만 알려 준다(아무것도 바꾸지 않음).
    const current = await prisma.$queryRawUnsafe<{ status: string }[]>(`SELECT status FROM "PosChargeRequest" WHERE id = $1`, id);
    if (!current[0]) throw new ChargeRequestError("NOT_FOUND", "요청을 찾지 못했습니다.");
    return { status: current[0].status, paid: current[0].status === "PAID", duplicate: true };
}

export type PluginUnpaidItem = {
    paymentId: string;
    studentLabel: string;
    /** studentLabel 과 같은 값 — **가린 이름**(플러그인 README 의 칸 이름) */
    studentName: string;
    className: string | null;
    title: string;
    amount: number;
    status: string;
    hasOpenRequest: boolean;
};

/**
 * POS 탭 미납 목록 — 이름은 가리고, 반·청구월·금액만. 전화번호·주소·보호자는 절대 싣지 않는다.
 * 검색어는 서버에서 실명과 비교하되 응답에는 가린 이름만 나간다. 최대 30건.
 */
export async function listUnpaidForPlugin(query: string): Promise<PluginUnpaidItem[]> {
    // LIKE 특수문자(% _ \)는 지워 «아무거나 맞음» 검색을 막는다.
    const q = String(query ?? "").replace(/[%_\\]/g, "").trim().slice(0, 20);
    const rows = await prisma.$queryRawUnsafe<{
        paymentId: string; studentName: string; className: string | null; type: string;
        year: number | null; month: number | null; amount: number; status: string; hasOpenRequest: boolean;
    }[]>(
        `SELECT p.id AS "paymentId", s.name AS "studentName", c.name AS "className", p.type, p.year, p.month,
                p.amount, p.status,
                EXISTS (SELECT 1 FROM "PosChargeRequest" r
                         WHERE r.status IN ('PENDING', 'SENT') AND r."expiresAt" > now()
                           AND (r."paymentId" = p.id
                                OR EXISTS (SELECT 1 FROM "PosChargeRequestItem" ih WHERE ih."requestId" = r.id AND ih."paymentId" = p.id))) AS "hasOpenRequest"
           FROM "Payment" p
           JOIN "Student" s ON s.id = p."studentId" AND ${notMergedStudent("s")}
           LEFT JOIN "Class" c ON c.id = p."classId"
          WHERE p.status IN ('PENDING', 'OVERDUE') AND p.type IN ('MONTHLY', 'SHUTTLE', 'OTHER') AND p.amount > 0
            AND ($1::text = '' OR s.name ILIKE '%' || $1::text || '%')
          ORDER BY p.year DESC NULLS LAST, p.month DESC NULLS LAST, s.name ASC
          LIMIT 30`,
        q,
    );
    return rows.map((r) => {
        const masked = maskStudentName(r.studentName);
        return {
            paymentId: r.paymentId,
            studentLabel: masked,
            studentName: masked,
            className: r.className,
            title: itemNameOf({ year: r.year, month: r.month, type: r.type, maskedName: "" }),
            amount: Number(r.amount),
            status: r.status,
            hasOpenRequest: Boolean(r.hasOpenRequest),
        };
    });
}

// ───────────────────────────── 웹훅 매칭 (돈이 움직이는 유일한 곳) ─────────────────────────────

type MatchRow = ViewRow & {
    expiresAtTs: string;
    paymentAmount: number;
    /** 결제 취소 진행 상태(NULL = 없음) */
    cancelState: string | null;
    /** DB 시계로 지금 만료됐나(분할 결제 대기 판단) */
    isExpiredNow: boolean;
    /** 묶인 청구(항목 순서 · 단건·옛 요청은 대표 청구 1건) — loadMatchRows 가 채운다 */
    items: ChargeItemRow[];
};

const MATCH_SELECT = `SELECT r.id, r."shortCode", r."paymentId", r.status, r.amount, r."taxFreeAmount",
        r."tossPaymentId", r."tossOrderId", r.note, r."cancelState",
        to_char(r."expiresAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "expiresAtTs",
        (r."expiresAt" <= now()) AS "isExpiredNow",
        p.type AS "paymentType", p.year, p.month, p.status AS "paymentStatus", p.amount AS "paymentAmount",
        st.name AS "studentName"
   FROM "PosChargeRequest" r
   JOIN "Payment" p ON p.id = r."paymentId"
   JOIN "Student" st ON st.id = p."studentId"`;

async function loadMatchRows(where: string, ...params: unknown[]): Promise<MatchRow[]> {
    const raw = await prisma.$queryRawUnsafe<Omit<MatchRow, "items">[]>(`${MATCH_SELECT} ${where}`, ...params);
    const rows = raw.map((r) => ({ ...r, amount: Number(r.amount), paymentAmount: Number(r.paymentAmount), items: [] as ChargeItemRow[] }));
    // 묶인 청구를 한 번에 붙인다(판정·납부·환불·알림이 모두 이 목록을 본다)
    const items = await itemsByRequest(rows);
    for (const row of rows) row.items = items.get(row.id) ?? [fallbackItem(row)];
    return rows;
}

/** 이 요청의 묶인 청구(없으면 대표 청구 1건) */
const itemsOfRow = (row: MatchRow): ChargeItemRow[] => (row.items && row.items.length > 0 ? row.items : [fallbackItem(row)]);

/** 슬랙 문구용 요청 설명. 단건 «S-… · 홍길동 · 2026년 11월 수강료 · 180,000원», 묶음 «S-… · 홍길동 · 수강료 11월 외 1건 · 합계 280,000원» */
function describe(row: Pick<MatchRow, "shortCode" | "studentName" | "year" | "month" | "paymentType" | "amount"> & { items?: ChargeItemRow[] }) {
    if (row.items && row.items.length > 1) {
        return `${row.shortCode} · ${row.studentName} · ${summaryOf(row.items.map(nameInputOf))} · 합계 ${formatChargeWon(row.amount)}`;
    }
    const when = row.year && row.month ? `${row.year}년 ${row.month}월 ` : "";
    return `${row.shortCode} · ${row.studentName} · ${when}${paymentTypeLabel(row.paymentType)} · ${formatChargeWon(row.amount)}`;
}

/**
 * 토스 재조회로 받은 주문 1건을 «현장 결제» 요청과 맞춘다.
 * 돌려주는 handledTossPaymentIds 의 결제는 기존 슬랙 확인 알림(PosPaymentNotice)을 만들지 않는다
 * (자동 납부됐거나, 같은 결제로 이미 자동 납부된 재전송, 분할 결제의 남은 결제를 기다리는 중). 나머지는 전부 기존 흐름 그대로.
 *
 * approved = 이 주문의 **방식 무관** 승인 결제(payment-notice.mjs 의 extractChargePayments).
 * eventType = 웹훅 종류(order.order.completed 면 주문이 끝난 것 — 분할 결제 합계가 모자라면 그때 보류).
 *
 * retryLater = true 면 웹훅 처리부가 이 알림을 «처리 완료»로 표시하지 않는다 → 10분 스윕이 다시 부른다.
 *   (분할 결제 대기 중 · 납부 기록 복구를 아직 못 함) — 대기 상태가 DB(웹훅 note)에 남고, 주문이 버려져도
 *   요청 유효 시간이 지나면 스윕이 보류(HOLD)+알림으로 끝낸다(2026-11-08 검수).
 */
export async function matchChargeRequestsForOrder(input: {
    order: unknown;
    orderId: string;
    approved: ApprovedPayment[];
    eventType?: string;
    redact: (message: string) => string;
}): Promise<{ handledTossPaymentIds: string[]; note: string; retryLater: boolean }> {
    const { order, orderId, approved, redact } = input;
    const handled: string[] = [];
    const notes: string[] = [];
    let retryLater = false;
    const idsOf = (list: ApprovedPayment[]) => list.map((p) => p.tossPaymentId);
    const done = () => ({ handledTossPaymentIds: handled, note: notes.join(" · "), retryLater });

    // ① 자동 납부된 요청의 결제가 취소됐나(사이트 «결제 취소»로 시작했든 POS 에서 직접 취소했든 같은 길).
    //    그 요청의 결제가 «전부» 취소면 청구서를 환불(REFUNDED)로, 일부만이면 청구서는 그대로 두고 사람 확인(PARTIAL).
    //    근거는 이 함수에 들어온 주문(토스 재조회 값)뿐이다 — 플러그인 보고로는 환불하지 않는다.
    const paidRows = await loadMatchRows(`WHERE r."tossOrderId" = $1 AND r.status = 'PAID'`, orderId);
    for (const row of paidRows) {
        const settled = await settleCancelForRow(row, order, orderId);
        if (settled) {
            notes.push(settled.note);
            // 납부 기록이 아직 진행 중일 수 있는 틈에 취소가 왔다 → 스윕이 다시 와서 환불·알림을 마무리한다
            if (settled.retry) retryLater = true;
        }
    }

    // ② 메모 번호 → 요청. 번호가 0개·2개 이상이면 자동 처리하지 않는다(기존 흐름).
    const codes = extractChargeCodes(order) as string[];
    if (codes.length !== 1) {
        if (codes.length > 1) notes.push(`메모에 번호가 ${codes.length}개라 자동 처리 안 함`);
        return done();
    }
    const code = codes[0];
    // 열린 요청 우선, 없으면 사흘 안의 가장 최근 요청(만료·납부·보류 판정용)
    const rows = await loadMatchRows(
        `WHERE r."shortCode" = $1 AND r."createdAt" > now() - interval '3 days'
         ORDER BY (r.status IN ('PENDING', 'SENT')) DESC, r."createdAt" DESC
         LIMIT 1`,
        code,
    );
    const request = rows[0];
    if (!request) {
        notes.push(`${code} 요청 없음`);
        return done();
    }

    // 결제마다 토스가 알려 준 면세 금액(taxExemptAmount)을 붙여 판정한다(합계가 요청 면세액과 다르면 보류).
    const exempt = taxExemptAmountsOf(order) as Record<string, number | null>;
    const verdict = decide({
        request: {
            status: request.status,
            amount: request.amount,
            taxFreeAmount: Number(request.taxFreeAmount),
            tossPaymentId: request.tossPaymentId,
            expiresAt: request.expiresAtTs,
            isExpiredNow: Boolean(request.isExpiredNow),
        },
        site: { status: request.paymentStatus, amount: request.paymentAmount, type: request.paymentType },
        // 묶음이면 묶인 청구 «전부»를 본다(하나라도 이미 납부·금액 변경이면 보류). 단건은 site 그대로.
        items: itemsOfRow(request).length > 1
            ? itemsOfRow(request).map((it) => ({ status: it.paymentStatus, paymentAmount: it.paymentAmount, amount: it.amount, type: it.paymentType }))
            : null,
        approved: approved.map((p) => ({ ...p, taxExemptAmount: exempt[p.tossPaymentId] ?? null })),
        others: nonApprovedPayments(order),
        orderCompleted: completedOf(order, input.eventType ?? ""),
    });

    if (verdict.action === MATCH_ACTION.ALREADY_DONE && verdict.payment) {
        const mine = verdict.payments.length > 0 ? verdict.payments : [verdict.payment];
        handled.push(...idsOf(mine));
        // 요청은 PAID 인데 청구서가 아직 미납 = «선점 → 원장부 기록» 사이에 함수가 멈췄던 것(웹훅 4초 응답 뒤 등).
        // 같은 결제·같은 금액이면 원장부 기록을 다시 시도한다(멱등 — 임대 SQL 이 한 곳만 통과시킨다). 취소가 걸린 요청은 건드리지 않는다.
        // 묶음: 묶인 청구 중 하나라도 미납이면 복구 대상(임대 SQL 이 «전부 미납»일 때만 통과 — 섞여 있으면 사람에게 알린다).
        const ledgerUnpaid = isUnpaid(request.paymentStatus) || itemsOfRow(request).some((it) => isUnpaid(it.paymentStatus));
        if (ledgerUnpaid && !request.cancelState) {
            const repaired = await repairLedgerPaid({ request, orderId, payments: mine, paidAtIso: verdict.paidAtIso, redact });
            notes.push(`${code} ${repaired.note}`);
            if (repaired.retry) retryLater = true;
            return done();
        }
        notes.push(`${code} 이미 자동 반영됨`);
        return done();
    }
    if (verdict.action === MATCH_ACTION.SKIP) {
        // 분할 결제 중간: 아직 판단 전이라 그 결제들의 슬랙 확인 알림도 미룬다(주문 완료 웹훅에서 납부 또는 보류 → 그때 알림).
        // 대기 판정은 웹훅을 «처리 완료»로 두지 않는다 → 스윕이 다시 보고, 유효 시간이 지나면 보류+알림으로 끝난다.
        if (verdict.waiting) {
            handled.push(...idsOf(verdict.payments));
            retryLater = true;
        }
        notes.push(`${code} ${verdict.reason}`);
        return done();
    }

    const hold = async (reason: string) => {
        const paymentRef = verdict.payments.length > 1
            ? ` (토스 결제 ${idsOf(verdict.payments).join(", ")})`
            : verdict.payment ? ` (토스 결제 ${verdict.payment.tossPaymentId})` : "";
        const heldRows = await prisma.$queryRawUnsafe<{ id: string }[]>(HOLD_SQL, request.id, orderId, `${reason}${paymentRef}`.slice(0, 1000));
        if (heldRows.length > 0) {
            await notifyOnce(
                request.id,
                "slackNotifiedAt",
                `⏸️ 현장 결제 자동 반영 보류 — ${describe(request)}\n사유: ${reason}\n카드·간편결제는 이어서 오는 결제 확인 알림에서, 현금·계좌이체 등은 관리자 수납 화면에서 처리해 주세요.`,
            );
        } else if (verdict.payment) {
            // 보류 0행 = 그 사이 상태가 바뀜. 동시에 온 다른 웹훅(주문·결제 알림)이 «이 결제로» 이미 자동 납부했으면
            // 처리 끝으로 본다 — 안 그러면 납부된 결제에 슬랙 확인 DM 이 한 통 더 간다.
            const now = await prisma.$queryRawUnsafe<{ status: string; tossPaymentId: string | null }[]>(
                `SELECT status, "tossPaymentId" FROM "PosChargeRequest" WHERE id = $1`,
                request.id,
            );
            if (now[0]?.status === "PAID" && now[0].tossPaymentId === verdict.payment.tossPaymentId) {
                handled.push(...idsOf(verdict.payments.length > 0 ? verdict.payments : [verdict.payment]));
                notes.push(`${code} 다른 알림이 이미 자동 반영함`);
                return done();
            }
        }
        notes.push(`${code} 보류: ${reason}`);
        return done();
    };

    if (verdict.action === MATCH_ACTION.HOLD || !verdict.payment) return hold(verdict.reason);

    // ③ 자동 납부 — 한 문장 선점이 1행일 때만 원장부에 쓴다.
    //    대표 결제 = 가장 먼저 승인된 결제(유일 칸), 납부일 = 마지막 승인 시각, 분할이면 나머지 결제 ID 를 note 에.
    const payment = verdict.payment;
    const payments = verdict.payments.length > 0 ? verdict.payments : [payment];
    const method = methodOf(payments.map((p) => String(p.sourceType ?? "")));
    const splitNote = payments.length > 1 ? describePayments(payments).slice(0, 1000) : null;
    let claimed: { id: string; paymentId: string; shortCode: string }[] = [];
    try {
        claimed = await prisma.$queryRawUnsafe(CLAIM_PAY_SQL, request.id, orderId, payment.tossPaymentId, verdict.paidAtIso, request.amount, splitNote);
    } catch (error) {
        if (uniqueViolation(error)) {
            // 이 토스 결제가 이미 다른 요청에 붙었다 → 자동 처리하지 않고 기존 흐름
            notes.push(`${code} 같은 토스 결제가 다른 요청에 이미 반영됨`);
            return done();
        }
        throw error;
    }
    if (claimed.length === 0) return hold("확정하는 순간 청구서·요청 상태가 바뀌었습니다(또는 같은 주문이 다른 요청에 이미 반영됨).");

    try {
        // 원장부 기록 — 정상 경로와 복구 경로(repairLedgerPaid)가 같은 도우미(writeLedgerPaid, 파일 맨 아래)를 쓴다.
        // 묶음은 묶인 청구 전부를 한 트랜잭션으로(하나라도 이미 납부·금액 변경이면 전부 되돌려 아래 보류로).
        await writeLedgerPaid({ claimed: claimed[0], orderId, method, payment, paidAtIso: verdict.paidAtIso, items: itemsOfRow(request) });
    } catch (error) {
        const message = redact((error as Error).message);
        console.error("[pos-charge] 자동 납부 반영 실패:", message, { requestId: request.id });
        // 대표 청구로 판단한다 — 묶음 납부(markPaymentsPaidTogether)는 한 트랜잭션이라 대표가 미납이면 전부 미납이다.
        // ⚠️ 이 판단은 «묶음 = 한 트랜잭션»에 기대고 있다. 묶음 경로에 단건 markPaymentPaid 를 건마다 섞어 부르면
        //    일부만 납부된 채 여기서 «미납»으로 보고 HOLD 해 버린다 — 섞지 말 것(writeLedgerPaid 참고).
        const now = await prisma.$queryRawUnsafe<{ status: string }[]>(`SELECT status FROM "Payment" WHERE id = $1`, claimed[0].paymentId);
        if (now[0]?.status !== "PAID") {
            // 납부가 안 됐다 → 보류로 돌리고 기존 슬랙 확인 흐름에 맡긴다(돈이 들어온 건 사실이므로 사람이 확인).
            await prisma.$executeRawUnsafe(
                `UPDATE "PosChargeRequest" SET status = 'HELD', "heldAt" = now(), note = $2, "updatedAt" = now()
                  WHERE id = $1 AND status = 'PAID'`,
                request.id,
                `자동 납부 반영 중 오류: ${message}`.slice(0, 1000),
            );
            await notifyOnce(request.id, "slackNotifiedAt", `⚠️ 현장 결제 자동 반영 실패 — ${describe(request)}\n이어서 오는 결제 확인 알림에서 처리해 주세요.`);
            notes.push(`${code} 자동 반영 실패 → 보류`);
            return done();
        }
    }

    await recordChargePaymentsAudit({ claimed: claimed[0], orderId, method, payments, redact, items: itemsOfRow(request) });

    handled.push(...idsOf(payments));
    // 납부 기록 «사이»에 취소 웹훅이 먼저 와서 요청을 DONE 으로 만들었으면, 방금 쓴 납부를 곧바로 환불로 되돌린다(검수 P-1).
    if (await refundIfCancelledDuringLedger(claimed[0], request)) {
        notes.push(`${code} 납부 기록 중 POS 취소 확인 → 환불`);
        return done();
    }
    const split = payments.length > 1 ? ` · 분할 ${payments.length}건` : "";
    const bundle = itemsOfRow(request).length > 1 ? `청구 ${itemsOfRow(request).length}건을 모두` : "사이트 청구서를";
    await notifyOnce(
        request.id,
        "slackNotifiedAt",
        `✅ 자동 납부 반영 — 현장 결제 ${describe(request)} (${posLabelOf(method)}${split})\n${bundle} 납부완료로 바꿨습니다.`,
    );
    notes.push(`${code} 자동 납부 반영`);
    return done();
}

// ───────────────────────────── 원장부 기록 도우미 (정상 경로·복구 경로 공용) ─────────────────────────────

type ClaimedRow = { id?: string; paymentId: string; shortCode: string };

/**
 * 원장부(청구서)에 납부를 쓴다 — 이 파일에서 markPaymentPaid·markPaymentsPaidTogether 를 부르는 유일한 곳.
 * 부르는 쪽은 둘뿐이다: ① CLAIM_PAY_SQL 선점 1행 뒤(정상) ② REPAIR_LEASE_SQL 임대 1행 뒤(멈춘 기록 복구).
 * 단건 = markPaymentPaid(예전과 같음) · 묶음 = markPaymentsPaidTogether(묶인 청구 전부를 한 트랜잭션, 하나라도 안 되면 전부 되돌림).
 */
async function writeLedgerPaid(input: {
    claimed: ClaimedRow;
    orderId: string;
    method: string;
    payment: ApprovedPayment;
    paidAtIso: string | null;
    items: ChargeItemRow[];
}) {
    if (input.items.length > 1) {
        await markPaymentsPaidTogether({
            items: input.items.map((it) => ({ paymentId: it.paymentId, amount: it.amount })),
            actorType: "WEBHOOK",
            actorId: `pos-charge:${input.claimed.shortCode}`,
            method: input.method,
            provider: "TOSS_POS",
            providerOrderId: input.orderId,
            paymentKey: input.payment.tossPaymentId,
            paidAt: input.paidAtIso,
            bundle: { shortCode: input.claimed.shortCode, paymentIds: input.items.map((it) => it.paymentId) },
        });
        return;
    }
    await markPaymentPaid({
        paymentId: input.claimed.paymentId,
        actorType: "WEBHOOK",
        actorId: `pos-charge:${input.claimed.shortCode}`,
        // 실제 결제 방식(2026-11-08): CARD·CASH·EASY_PAY(QR·토스페이)·BANK_TRANSFER·ETC, 분할이면 «CARD+CASH».
        // 단건 카드는 예전과 같은 «CARD» 그대로다. 화면은 posMethodLabel 이 «현장 · 카드+현금» 으로 보여 준다.
        method: input.method,
        provider: "TOSS_POS",
        providerOrderId: input.orderId,
        paymentKey: input.payment.tossPaymentId,
        paidAt: input.paidAtIso,
    });
}

/**
 * 감사 기록 — 이 납부에 쓰인 토스 결제 전부(분할이면 여러 건)와 방식. 실패해도 납부는 이미 끝났으니 막지 않는다.
 * 묶음은 묶인 청구마다 한 줄씩(청구 상세 이력에서 각자 보이게). 취소 때 결제 ID 는 대표 청구의 기록에서 읽는다.
 */
async function recordChargePaymentsAudit(input: {
    claimed: ClaimedRow;
    orderId: string;
    method: string;
    payments: ApprovedPayment[];
    redact: (message: string) => string;
    items: ChargeItemRow[];
}) {
    const splitNote = input.payments.length > 1 ? describePayments(input.payments).slice(0, 1000) : null;
    const bundle = input.items.length > 1;
    const targets = bundle ? input.items.map((it) => it.paymentId) : [input.claimed.paymentId];
    for (const paymentId of targets) {
        try {
            await recordPaymentAudit({
                paymentId,
                actorType: "WEBHOOK",
                actorId: `pos-charge:${input.claimed.shortCode}`,
                action: "POS_CHARGE_PAYMENTS",
                message: `${bundle ? `묶음 ${input.items.length}건 · ` : ""}${splitNote ?? `현장 결제 1건(${input.method})`}`.slice(0, 1000),
                metadata: {
                    shortCode: input.claimed.shortCode,
                    tossOrderId: input.orderId,
                    method: input.method,
                    payments: input.payments.map((p) => ({ tossPaymentId: p.tossPaymentId, sourceType: p.sourceType ?? null, amount: p.amount })),
                    ...(bundle ? { bundle: { paymentIds: input.items.map((it) => it.paymentId), amounts: input.items.map((it) => it.amount) } } : {}),
                },
            });
        } catch (error) {
            console.error("[pos-charge] 감사 기록 실패(납부는 반영됨):", input.redact((error as Error).message), { paymentId });
        }
    }
}

/**
 * 멈춘 납부 기록 복구용 «임대» — 요청은 PAID(같은 토스 주문)인데 청구서가 아직 미납일 때 한 곳만 통과시킨다.
 * - PAID 로 바뀐 지 30초가 지나야(원래 처리가 아직 진행 중일 수 있는 틈은 건드리지 않는다)
 * - updatedAt 30초 임대(두 웹훅·스윕이 동시에 복구하지 않게 — 통과한 쪽이 updatedAt 을 지금으로 바꾼다)
 * - 취소가 걸린 요청은 제외, 묶인 청구 «전부»가 선점 때와 같은 조건(미납·금액·종류) — 섞여 있으면 0행 → 사람에게 알림
 */
const REPAIR_LEASE_SQL = `UPDATE "PosChargeRequest" r
      SET "updatedAt" = now()
    WHERE r.id = $1 AND r.status = 'PAID' AND r."cancelState" IS NULL AND r."tossOrderId" = $2
      AND COALESCE(r."paidRecordedAt", r."paidAt") < now() - interval '30 seconds'
      AND r."updatedAt" < now() - interval '30 seconds'
      AND ${ALL_ITEMS_UNPAID_SQL}
    RETURNING r.id, r."paymentId", r."shortCode"`;

/**
 * ALREADY_DONE 인데 청구서가 미납 → 원장부 기록을 다시 시도한다(멱등).
 * retry = true 면 웹훅을 처리 완료로 두지 않아 스윕이 다시 온다(아직 30초 안 · 기록 실패).
 */
async function repairLedgerPaid(input: {
    request: MatchRow;
    orderId: string;
    payments: ApprovedPayment[];
    paidAtIso: string | null;
    redact: (message: string) => string;
}): Promise<{ note: string; retry: boolean }> {
    const { request, orderId, payments, redact } = input;
    const leased = await prisma.$queryRawUnsafe<ClaimedRow[]>(REPAIR_LEASE_SQL, request.id, orderId);
    if (leased.length === 0) {
        // 못 빌림 = 아직 30초 안(원래 처리 중일 수 있음)·다른 곳이 복구 중·그 사이 청구서가 바뀜.
        // 시간 문제면 다시 오고, 아니면(청구 금액이 바뀌는 등) 사람에게 알린다.
        // paymentStatus = 묶인 청구가 «전부» PAID 면 'PAID'(다른 곳이 마침), 아니면 대표 청구 상태.
        const why = await prisma.$queryRawUnsafe<{ tooSoon: boolean; paymentStatus: string | null }[]>(
            `SELECT (COALESCE(r."paidRecordedAt", r."paidAt") >= now() - interval '30 seconds'
                     OR r."updatedAt" >= now() - interval '30 seconds') AS "tooSoon",
                    CASE WHEN NOT EXISTS (SELECT 1 FROM ${ITEMS_OF_R} it JOIN "Payment" ip ON ip.id = it."paymentId" WHERE ip.status <> 'PAID')
                         THEN 'PAID' ELSE p.status END AS "paymentStatus"
               FROM "PosChargeRequest" r JOIN "Payment" p ON p.id = r."paymentId"
              WHERE r.id = $1`,
            request.id,
        );
        if (why[0]?.paymentStatus === "PAID") return { note: "다른 곳이 납부 기록을 마침", retry: false };
        if (why[0]?.tooSoon) return { note: "납부 기록 진행 중(잠시 뒤 스윕이 다시 확인)", retry: true };
        await notifyOnce(
            request.id,
            "slackNotifiedAt",
            `⚠️ 현장 결제 납부 기록 확인 필요 — ${describe(request)}\n결제는 확인됐지만 청구서가 미납 그대로이고 자동 복구 조건(금액·종류${itemsOfRow(request).length > 1 ? "·묶인 청구 전부 미납" : ""})이 맞지 않습니다. 관리자 수납 화면에서 확인해 주세요.`,
        );
        return { note: "납부 기록 복구 조건 불일치 → 원장 알림", retry: false };
    }
    const method = methodOf(payments.map((p) => String(p.sourceType ?? "")));
    try {
        await writeLedgerPaid({ claimed: leased[0], orderId, method, payment: payments[0], paidAtIso: input.paidAtIso, items: itemsOfRow(request) });
    } catch (error) {
        console.error("[pos-charge] 납부 기록 복구 실패(스윕이 다시 시도):", redact((error as Error).message), { requestId: request.id });
        return { note: "납부 기록 복구 실패(스윕이 다시 시도)", retry: true };
    }
    await recordChargePaymentsAudit({ claimed: leased[0], orderId, method, payments, redact, items: itemsOfRow(request) });
    if (await refundIfCancelledDuringLedger(leased[0], request)) return { note: "납부 기록 복구 중 POS 취소 확인 → 환불", retry: false };
    const split = payments.length > 1 ? ` · 분할 ${payments.length}건` : "";
    const bundle = itemsOfRow(request).length > 1 ? `청구 ${itemsOfRow(request).length}건을 모두` : "사이트 청구서를";
    await notifyOnce(
        request.id,
        "slackNotifiedAt",
        `✅ 자동 납부 반영 — 현장 결제 ${describe(request)} (${posLabelOf(method)}${split})\n${bundle} 납부완료로 바꿨습니다.`,
    );
    return { note: "멈췄던 납부 기록 복구", retry: false };
}

// ───────────────────────────── 결제 취소 확정(토스 웹훅 재조회로만) ─────────────────────────────

/** 이 요청으로 납부된 토스 결제 ID 전부(감사 기록 → note → 대표 결제) */
async function chargePaymentIdsFor(row: Pick<MatchRow, "paymentId" | "tossOrderId" | "tossPaymentId" | "note">): Promise<string[]> {
    let auditPaymentIds: string[] | null = null;
    try {
        const rows = await prisma.$queryRawUnsafe<{ ids: string[] | null }[]>(
            `SELECT CASE WHEN jsonb_typeof(metadata->'payments') = 'array'
                         THEN ARRAY(SELECT e->>'tossPaymentId' FROM jsonb_array_elements(metadata->'payments') e)
                    END AS ids
               FROM "PaymentAuditLog"
              WHERE "paymentId" = $1 AND action = 'POS_CHARGE_PAYMENTS' AND metadata->>'tossOrderId' = $2
              ORDER BY "createdAt" DESC
              LIMIT 1`,
            row.paymentId,
            row.tossOrderId,
        );
        auditPaymentIds = rows[0]?.ids ?? null;
    } catch (error) {
        console.error("[pos-charge] 결제 목록(감사 기록) 조회 실패 — note 로 대신:", String((error as Error).message).slice(0, 200));
    }
    return paymentIdsOf({ tossPaymentId: row.tossPaymentId, note: row.note, auditPaymentIds });
}

/** 환불 확정 표시 — 한 문장 조건부 UPDATE(동시에 두 웹훅이 와도 한 곳만) */
const MARK_REFUND_SQL = `UPDATE "PosChargeRequest"
      SET "cancelState" = 'DONE', "refundedAt" = COALESCE("refundedAt", now()), "updatedAt" = now()
    WHERE id = $1 AND status = 'PAID' AND "cancelState" IS DISTINCT FROM 'DONE'
    RETURNING id`;

/**
 * 자동 납부된 요청 1건 ↔ 토스 재조회 주문 → 취소 판정·반영. 할 일이 없으면 null.
 *   전부 취소 → (한 트랜잭션) 요청 DONE + 청구서 환불(원장부 refundPaidPaymentInTx) → 목록 갱신 → 슬랙 «환불 처리»
 *   일부 취소 → 요청 PARTIAL + note, 청구서는 그대로 → 슬랙 «확인 필요»
 * 여러 번 불려도 안전하다(조건부 UPDATE · 알림 표시 칸 선점).
 */
async function settleCancelForRow(row: MatchRow, order: unknown, orderId: string): Promise<{ note: string; retry: boolean } | null> {
    const ids = await chargePaymentIdsFor(row);
    const verdict = cancelVerdictOf({ paymentIds: ids, order });
    if (verdict.action === "NONE") return null;

    if (verdict.action === "PARTIAL") {
        const what = verdict.other.map((o) => `${o.id}:${o.state}`).join(", ");
        const text = `POS 결제 일부만 취소됨(취소 ${verdict.cancelled.length}/${ids.length}건${what ? ` · 그 밖 ${what}` : ""}) — 청구서는 그대로, 확인 필요`;
        await prisma.$executeRawUnsafe(
            `UPDATE "PosChargeRequest"
                SET "cancelState" = 'PARTIAL', note = left(COALESCE(note || ' / ', '') || $2, 1000), "updatedAt" = now()
              WHERE id = $1 AND status = 'PAID' AND "cancelState" IS DISTINCT FROM 'PARTIAL' AND "cancelState" IS DISTINCT FROM 'DONE'`,
            row.id,
            text.slice(0, 500),
        );
        await notifyOnce(
            row.id,
            "cancelNotifiedAt",
            `⚠️ POS 결제 일부만 취소됨 — 현장 결제 ${describe(row)}\n취소 ${verdict.cancelled.length}건 / 전체 ${ids.length}건. 사이트 청구서는 납부완료 그대로입니다. 남은 결제를 POS 에서 취소하거나 수납 화면에서 확인해 주세요.`,
        );
        return { note: `${row.shortCode} POS 일부 취소 → 확인 필요`, retry: false };
    }

    // 전부 취소 → 환불. 요청 표시와 청구서 환불을 한 트랜잭션으로(한쪽만 남지 않게).
    // 요청이 이미 DONE 이어도(재전송·앞선 처리) 청구가 PAID 면 다시 환불을 시도한다 — 조건부 UPDATE 라 몇 번이든 안전하고,
    // «요청 PAID → 청구서 기록» 틈에 취소가 먼저 와서 나중에 청구서가 PAID 로 써진 경우도 여기서 바로잡힌다(검수 P-1).
    const items = itemsOfRow(row);
    const result = await prisma.$transaction(async (db) => {
        const marked = (await db.$queryRawUnsafe<{ id: string }[]>(MARK_REFUND_SQL, row.id)).length > 0;
        // 이번에 처음 취소 확정(marked)이면 환불한다. 이미 DONE 이었으면(재전송·스윕) «청구의 마지막 납부·상태 기록이
        // 이 현장 결제의 자동 납부(pos-charge:번호)일 때만» 환불한다 — 관리자가 그 뒤 일부러 다시 납부 처리한 건을
        // 재전송 웹훅이 몰래 환불로 되돌리지 않게(재검수 2026-11-08).
        // 묶음(2026-11-08): POS 결제 하나에 묶인 청구 «전부»를 같은 판단으로 환불한다(같은 트랜잭션).
        let allowedAny = false;
        let refundedCount = 0;
        for (const it of items) {
            const target = { paymentId: it.paymentId, shortCode: row.shortCode };
            const allowed = marked || (await lastLedgerWriteIsThisCharge(db, target));
            if (!allowed) continue;
            allowedAny = true;
            if (await refundPaidPaymentInTx(db, refundInput(target, orderId, verdict.cancelled))) refundedCount += 1;
        }
        return { marked, allowed: allowedAny, refunded: refundedCount > 0, refundedCount };
    });
    if (result.refunded) {
        revalidatePaymentCaches();
        const what = items.length <= 1
            ? "사이트 청구서를 환불로 바꿨습니다."
            : result.refundedCount === items.length
                ? `묶인 청구 ${items.length}건을 모두 환불로 바꿨습니다.`
                : `묶인 청구 ${items.length}건 중 ${result.refundedCount}건만 환불로 바꿨습니다(나머지는 그 사이 다른 경로로 처리됨). 수납 화면에서 확인해 주세요.`;
        await notifyOnce(row.id, "refundNotifiedAt", `↩️ POS 결제 취소 확인 — 현장 결제 ${describe(row)}\n${what}`);
        return { note: `${row.shortCode} POS 취소 → 환불 처리${items.length > 1 ? `(${result.refundedCount}/${items.length}건)` : ""}`, retry: false };
    }
    // 환불할 게 없었다 = 청구가 PAID 가 아니다. 지금 상태를 DB 에서 다시 읽고 실제 상태대로 알린다.
    // 묶음은 묶인 청구 중 하나라도 PAID 면 'PAID' 로 본다(아래 판단이 «다시 확인 / 다른 경로 납부»로 간다).
    const cur = await prisma.$queryRawUnsafe<{ paymentStatus: string | null; ledgerMayRun: boolean }[]>(
        `SELECT CASE WHEN EXISTS (SELECT 1 FROM ${ITEMS_OF_R} it JOIN "Payment" ip ON ip.id = it."paymentId" WHERE ip.status = 'PAID')
                     THEN 'PAID' ELSE p.status END AS "paymentStatus",
                (COALESCE(r."paidRecordedAt", r."paidAt") > now() - interval '2 minutes') AS "ledgerMayRun"
           FROM "PosChargeRequest" r JOIN "Payment" p ON p.id = r."paymentId"
          WHERE r.id = $1`,
        row.id,
    );
    const status = String(cur[0]?.paymentStatus ?? row.paymentStatus ?? "");
    if (status === "PAID") {
        if (result.allowed) {
            // 환불 UPDATE 때는 아직 미납으로 보였는데 지금은 PAID = 납부 기록이 그 사이에 확정됨(READ COMMITTED 경합).
            // 알리지 않고 다시 본다 — 다음 스윕의 이 함수가 «마지막 기록 = 이 현장 결제»를 확인하고 환불로 수렴시킨다.
            return { note: `${row.shortCode} POS 취소 확인 · 납부 기록이 방금 확정돼 다시 확인`, retry: true };
        }
        // 관리자 등 다른 출처가 그 뒤 납부 처리함 → 환불하지 않고 한 번만 알린다
        await notifyOnce(
            row.id,
            "cancelNotifiedAt",
            `⚠️ POS 결제 취소 확인 — 현장 결제 ${describe(row)}\n사이트 청구는 그 뒤 다른 경로로 납부 처리돼 있어 자동 환불하지 않았습니다. 수납 화면에서 확인해 주세요.`,
        );
        return { note: `${row.shortCode} POS 취소 확인 · 청구가 다른 경로로 납부돼 있어 환불 안 함`, retry: false };
    }
    if (["PENDING", "OVERDUE"].includes(status) && cur[0]?.ledgerMayRun) {
        // 납부 기록이 아직 진행 중일 수 있다 → 알림을 미루고 다시 본다(기록이 끝나면 그쪽이 환불하거나, 다음 스윕이 환불한다)
        return { note: `${row.shortCode} POS 취소 확인 · 납부 기록 진행 중이라 다시 확인`, retry: true };
    }
    const tail = ["PENDING", "OVERDUE"].includes(status)
        ? "\n납부 기록 전에 결제가 취소돼 사이트 청구는 미납 그대로입니다(돈은 POS 에서 돌려줌)."
        : status === "REFUNDED"
            ? "\n사이트 청구는 이미 환불 상태입니다."
            : `\n사이트 청구 상태가 ${status || "알 수 없음"}이라 그대로 두었습니다. 수납 화면에서 확인해 주세요.`;
    // 알림은 표시 칸으로 한 번만 — 앞선 처리가 알림 직전에 멈췄으면 여기서 이어서 보낸다.
    await notifyOnce(row.id, "refundNotifiedAt", `↩️ POS 결제 취소 확인 — 현장 결제 ${describe(row)}${tail}`);
    return { note: `${row.shortCode} ${result.marked ? "POS 취소 확인" : "이미 취소 확정됨"}(청구 ${status || "?"})`, retry: false };
}

/**
 * 이 청구의 «마지막 납부·상태 변경 기록»이 이 현장 결제의 자동 납부인가.
 * 납부 기록 = markPaymentPaid 의 감사 기록 action 'PAYMENT_MARK_PAID'(자동 납부는 actorType WEBHOOK · actorId «pos-charge:번호»,
 * 관리자 수동 납부는 ADMIN · actorId 없음), 상태 변경 = 'PAYMENT_STATUS_UPDATE'(관리자)·'PAYMENT_REFUNDED'(환불).
 * 일괄 상태 변경(PAYMENT_BULK_STATUS_UPDATE)은 paymentId 가 비어 있지만, 일괄 «납부»는 markPaymentPaid(ADMIN)를 거쳐
 * 'PAYMENT_MARK_PAID' 가 따로 남으므로 여기서 걸러진다.
 */
async function lastLedgerWriteIsThisCharge(db: LedgerSqlClient, row: Pick<MatchRow, "paymentId" | "shortCode">): Promise<boolean> {
    const last = await db.$queryRawUnsafe<{ action: string; actorType: string | null; actorId: string | null }[]>(
        `SELECT action, "actorType", "actorId" FROM "PaymentAuditLog"
          WHERE "paymentId" = $1 AND action IN ('PAYMENT_MARK_PAID', 'PAYMENT_STATUS_UPDATE', 'PAYMENT_REFUNDED')
          ORDER BY "createdAt" DESC
          LIMIT 1`,
        row.paymentId,
    );
    return last[0]?.action === "PAYMENT_MARK_PAID" && last[0]?.actorType === "WEBHOOK" && last[0]?.actorId === `pos-charge:${row.shortCode}`;
}

/** 환불 감사 기록 입력(취소 확정·납부 직후 재확인 공용) */
function refundInput(row: Pick<MatchRow, "paymentId" | "shortCode">, orderId: string | null, cancelledPaymentIds: string[] | null) {
    return {
        paymentId: row.paymentId,
        actorType: "WEBHOOK" as const,
        actorId: `pos-charge:${row.shortCode}`,
        message: `현장 결제 ${row.shortCode} POS 결제 취소 확인 → 환불`,
        metadata: { provider: "TOSS_POS", shortCode: row.shortCode, tossOrderId: orderId, cancelledPaymentIds },
    };
}

/**
 * 원장부 납부 기록 «직후» 취소 상태 재확인(검수 P-1). 기록하는 사이에 취소 웹훅이 먼저 와서 요청을 DONE 으로 만들고
 * (그때는 청구가 아직 미납이라 환불할 게 없었다) 그 뒤 markPaymentPaid 가 청구를 PAID 로 써 버리면 돈이 어긋난다.
 * 요청이 DONE 이면 같은 원장부 함수로 바로 환불한다. 환불했으면 true(호출한 쪽은 «납부 반영» 알림을 보내지 않는다).
 */
async function refundIfCancelledDuringLedger(claimed: ClaimedRow, request: MatchRow): Promise<boolean> {
    const rows = await prisma.$queryRawUnsafe<{ cancelState: string | null; tossOrderId: string | null }[]>(
        `SELECT "cancelState", "tossOrderId" FROM "PosChargeRequest" WHERE id = $1`,
        request.id,
    );
    if (rows[0]?.cancelState !== "DONE") return false;
    // 묶음이면 방금 납부로 쓴 청구 «전부»를 한 트랜잭션으로 되돌린다(단건은 대표 청구 1건 — 예전과 같다)
    const targets = itemsOfRow(request).length > 1 ? itemsOfRow(request).map((it) => it.paymentId) : [claimed.paymentId];
    const refunded = await prisma.$transaction(async (db) => {
        let any = false;
        for (const paymentId of targets) {
            if (await refundPaidPaymentInTx(db, refundInput({ paymentId, shortCode: claimed.shortCode }, rows[0].tossOrderId, null))) any = true;
        }
        return any;
    });
    if (refunded) revalidatePaymentCaches();
    await notifyOnce(
        request.id,
        "refundNotifiedAt",
        `↩️ POS 결제 취소 확인 — 현장 결제 ${describe(request)}\n${refunded ? "사이트 청구서를 환불로 바꿨습니다." : "사이트 청구는 환불 상태입니다."}`,
    );
    return true;
}

// ───────────────────────────── 관리자 «결제 취소» ─────────────────────────────

/** 관리자 화면 «결제 취소» 창 */
export type AdminChargeCancelView = {
    requestId: string;
    shortCode: string;
    /** 요청 금액(묶음이면 합계 — POS 결제 하나를 취소하면 이만큼 돌려준다) */
    amount: number;
    paidKst: string | null;
    studentName: string;
    /** 단건 = «2026년 11월 수강료», 묶음 = «수강료 11월 외 1건» */
    itemLabel: string;
    /** 묶인 청구 수(단건 1) — 2 이상이면 취소하면 전부 환불된다 */
    itemCount: number;
    /**
     * 취소하면 환불될 청구 목록(POS 주문 항목 순서) — 창·확인창에 줄마다 «종류·월·금액»을 보인다.
     * amount = 요청 순간 스냅샷(POS 가 돌려주는 금액). 항목 표가 비어 있는 옛 요청은 대표 청구 1건.
     */
    items: AdminChargeCancelItem[];
    paymentStatus: string;
    /** NULL = 취소 없음 · REQUESTED · SENT · FAILED · PARTIAL · DONE */
    cancelState: string | null;
    cancelReportMessage: string | null;
    refundedKst: string | null;
    /** 요청 뒤 90초가 지나도 POS 가 안 가져감 → «POS 에서 직접 취소» 안내 */
    pickupLate: boolean;
    /** POS 가 취소를 끝냈다고 보고함(토스 확인 대기) */
    reported: boolean;
    /** 보고 뒤 3분이 지나도 토스 확인이 안 옴 → «잠시 후 수납 화면에서 확인» 안내 */
    confirmLate: boolean;
    /** 지금 «결제 취소»를 누를 수 있나 + 못 하면 이유 */
    canRequest: boolean;
    blockReason: string;
};

/** 결제 취소 창의 환불될 청구 1건 */
export type AdminChargeCancelItem = {
    paymentId: string;
    /** MONTHLY · SHUTTLE · OTHER … */
    type: string;
    year: number | null;
    month: number | null;
    amount: number;
    studentName: string;
    /** «2026년 11월 수강료» — 화면에 그대로 쓰는 이름 */
    itemLabel: string;
};

function toCancelView(row: ViewRow, items: ChargeItemRow[] = [fallbackItem(row)]): AdminChargeCancelView {
    const check = cancelCheck({
        request: { status: row.status, cancelState: row.cancelState ?? null },
        site: { status: row.paymentStatus, paidProvider: row.paidProvider ?? null },
        // 묶음이면 묶인 청구 전부가 토스 POS 납부완료여야 취소를 보낼 수 있다
        sites: items.length > 1 ? items.map((it) => ({ status: it.paymentStatus, paidProvider: it.paidProvider })) : null,
    });
    const noOrder = !row.tossOrderId;
    return {
        requestId: row.id,
        shortCode: row.shortCode,
        amount: Number(row.amount),
        paidKst: row.paidKst,
        studentName: row.studentName,
        itemLabel: items.length > 1
            ? summaryOf(items.map(nameInputOf))
            : itemNameOf({ year: row.year, month: row.month, type: row.paymentType, maskedName: "" }),
        itemCount: items.length,
        // 묶음은 한 학생만 묶이므로(만들 때 확인) 이름은 요청의 대표 청구 학생
        items: items.map((it) => ({
            paymentId: it.paymentId,
            type: it.paymentType,
            year: it.year,
            month: it.month,
            amount: it.amount,
            studentName: row.studentName,
            itemLabel: itemNameOf({ ...nameInputOf(it), maskedName: "" }),
        })),
        paymentStatus: row.paymentStatus,
        cancelState: row.cancelState ?? null,
        cancelReportMessage: row.cancelReportMessage ?? null,
        refundedKst: row.refundedKst ?? null,
        pickupLate: Boolean(row.cancelPickupLate),
        reported: Boolean(row.cancelReported),
        confirmLate: Boolean(row.cancelConfirmLate),
        canRequest: check.ok && !noOrder,
        blockReason: check.ok && noOrder ? "토스 주문 번호가 없어 POS 로 취소를 보낼 수 없습니다." : check.reason,
    };
}

/**
 * 이 청구서를 납부시킨 현장 결제 요청(가장 최근 PAID — 대표 청구든 묶음의 다른 청구든).
 * 청구서 id 로만 찾는다(요청 id 를 밖에서 받지 않음 — IDOR 방지).
 */
async function paidRequestRowFor(paymentId: string): Promise<ViewRow | null> {
    const id = String(paymentId ?? "").trim();
    if (!id || id.length > 100) return null;
    const rows = await loadView(
        `WHERE ${hasPaymentSql(1)} AND r.status = 'PAID'
         ORDER BY r."paidAt" DESC NULLS LAST, r."createdAt" DESC
         LIMIT 1`,
        id,
    );
    return rows[0] ?? null;
}

/** 관리자 «결제 취소» 창: 지금 상태 */
export async function getChargeCancelForPayment(paymentId: string): Promise<AdminChargeCancelView | null> {
    const row = await paidRequestRowFor(paymentId);
    return row ? toCancelView(row, await itemsOf(row)) : null;
}

/**
 * 관리자 «결제 취소» — 요청에 «취소할 일»(REQUESTED)을 남긴다. 돈은 여기서 안 움직인다.
 * 실제 환불은 POS 가 취소한 뒤 토스 웹훅이 오면 settleCancelForRow 가 한다(묶음이면 묶인 청구 전부).
 * 조건은 UPDATE 한 문장 안에서 다시 확인한다(묶인 청구 «전부» 납부완료·토스 POS · 요청과 청구가 맞물림).
 */
export async function requestChargeCancelByAdmin(input: { paymentId: string; adminUserId: string }): Promise<AdminChargeCancelView> {
    const row = await paidRequestRowFor(input.paymentId);
    if (!row) throw new ChargeRequestError("NOT_FOUND", "현장 결제로 납부된 기록을 찾지 못했습니다.");
    const items = await itemsOf(row);
    const view = toCancelView(row, items);
    if (!view.canRequest) throw new ChargeRequestError("NOT_ELIGIBLE", view.blockReason || "결제 취소를 보낼 수 없습니다.");
    const updated = await prisma.$queryRawUnsafe<{ id: string }[]>(
        `UPDATE "PosChargeRequest" r
            SET "cancelState" = 'REQUESTED', "cancelRequestedAt" = now(), "cancelRequestedBy" = $2,
                "cancelClaimedAt" = NULL, "cancelClaimedByTokenId" = NULL,
                "cancelReportedAt" = NULL, "cancelReportMessage" = NULL, "updatedAt" = now()
          WHERE r.id = $1 AND r."paymentId" = $3 AND r.status = 'PAID' AND r."tossOrderId" IS NOT NULL
            AND (r."cancelState" IS NULL OR r."cancelState" IN ('FAILED', 'PARTIAL'))
            AND NOT EXISTS (SELECT 1 FROM ${ITEMS_OF_R} it LEFT JOIN "Payment" p ON p.id = it."paymentId"
                             WHERE NOT COALESCE(p.status = 'PAID' AND p."paidProvider" = 'TOSS_POS', false))
          RETURNING r.id`,
        row.id,
        input.adminUserId,
        row.paymentId,
    );
    if (updated.length === 0) throw new ChargeRequestError("CHANGED", "그 사이 상태가 바뀌었습니다. 창을 닫고 다시 열어 주세요.");
    // 감사 기록은 묶인 청구마다(어느 청구에서 눌렀든 전부 환불 대상이 된다)
    for (const it of items) {
        await recordPaymentAudit({
            paymentId: it.paymentId,
            actorType: "ADMIN",
            actorId: input.adminUserId,
            action: "POS_CHARGE_CANCEL_REQUESTED",
            message: items.length > 1
                ? `현장 결제 ${row.shortCode} POS 결제 취소 요청 (묶음 ${items.length}건 · 합계 ${formatChargeWon(row.amount)})`
                : `현장 결제 ${row.shortCode} POS 결제 취소 요청 (${formatChargeWon(row.amount)})`,
            metadata: { requestId: row.id, shortCode: row.shortCode, previousCancelState: row.cancelState ?? null, ...(items.length > 1 ? { bundleSize: items.length } : {}) },
        }).catch((e) => console.error("[pos-charge] 감사기록 실패:", String((e as Error).message).slice(0, 200)));
    }
    const after = await paidRequestRowFor(row.paymentId);
    return toCancelView(after ?? row, items);
}

// ───────────────────────────── 플러그인: 취소할 일 ─────────────────────────────

/** 롱폴링 응답의 «취소할 일» 1건(이름 가림 · 결제 ID 는 선점 응답에서만 준다) */
export type PluginCancelJobView = {
    id: string;
    shortCode: string;
    amount: number;
    studentName: string;
    itemName: string;
    cancelState: string;
};

/** 플러그인이 «취소할 일»을 선점했을 때 받는 값 — 취소할 토스 주문·결제 ID 는 서버 DB 값만 */
export type PluginCancelClaimView = PluginCancelJobView & { tossOrderId: string; tossPaymentIds: string[] };

function toCancelJobView(row: ViewRow, items: ChargeItemRow[] = [fallbackItem(row)]): PluginCancelJobView {
    const masked = maskStudentName(row.studentName);
    return {
        id: row.id,
        shortCode: row.shortCode,
        // 묶음이면 합계(POS 결제 하나 = 주문 하나를 취소)
        amount: Number(row.amount),
        studentName: masked,
        itemName: items.length > 1
            ? bundleNameOf({ items: items.map(nameInputOf), maskedName: masked })
            : itemNameOf({ year: row.year, month: row.month, type: row.paymentType, maskedName: masked }),
        cancelState: String(row.cancelState ?? ""),
    };
}

/**
 * 취소할 일 목록 — 새 요청(REQUESTED) + 가져간 뒤 보고 없이 2분이 지난 것(플러그인이 중간에 꺼짐 → 다시 맡긴다).
 * 다시 맡겨도 안전하다: 플러그인은 결제마다 상태를 먼저 확인해 이미 취소된 건은 건너뛴다.
 */
export async function listCancelJobsForPlugin(): Promise<PluginCancelJobView[]> {
    const rows = await loadView(
        `WHERE r.status = 'PAID' AND r."tossOrderId" IS NOT NULL
           AND (r."cancelState" = 'REQUESTED'
                OR (r."cancelState" = 'SENT' AND r."cancelReportedAt" IS NULL AND r."cancelClaimedAt" < now() - interval '2 minutes'))
         ORDER BY r."cancelRequestedAt" ASC NULLS LAST
         LIMIT 20`,
    );
    const items = await itemsByRequest(rows);
    return rows.map((row) => toCancelJobView(row, items.get(row.id)));
}

/**
 * 롱폴링 대기 중 «모르는 새 취소 요청»이 있나(가벼운 EXISTS). 요청 뒤 CANCEL_PICKUP_TIMEOUT_SEC 안의 것만 깨운다 —
 * 오래된 것까지 깨우면 그 일을 못 하는 기기가 1초마다 다시 묻게 된다(요청 한도). 오래된 것은 평소 응답에 실린다.
 */
export async function hasUnknownCancelJob(knownIds: string[]): Promise<boolean> {
    const rows = await prisma.$queryRawUnsafe<{ found: boolean }[]>(
        `SELECT EXISTS (
            SELECT 1 FROM "PosChargeRequest"
             WHERE "cancelState" = 'REQUESTED' AND "cancelRequestedAt" > now() - interval '${CANCEL_PICKUP_TIMEOUT_SEC} seconds'
               AND NOT (id = ANY($1::text[]))
         ) AS found`,
        knownIds,
    );
    return Boolean(rows[0]?.found);
}

/** 취소할 일 선점(REQUESTED → SENT). 같은 토큰의 재시도·2분 넘게 보고 없는 것은 다시 가져갈 수 있다. */
export async function claimCancelForPlugin(requestId: string, tokenId: string): Promise<PluginCancelClaimView> {
    const id = String(requestId ?? "").trim();
    if (!/^[0-9a-f-]{10,64}$/i.test(id)) throw new ChargeRequestError("NOT_FOUND", "요청을 찾지 못했습니다.");
    const claimed = await prisma.$queryRawUnsafe<{ id: string }[]>(
        `UPDATE "PosChargeRequest" r
            SET "cancelState" = 'SENT', "cancelClaimedAt" = now(), "cancelClaimedByTokenId" = $2, "updatedAt" = now()
          WHERE r.id = $1 AND r.status = 'PAID' AND r."tossOrderId" IS NOT NULL
            AND (r."cancelState" = 'REQUESTED'
                 OR (r."cancelState" = 'SENT' AND r."cancelReportedAt" IS NULL
                     AND (r."cancelClaimedByTokenId" = $2 OR r."cancelClaimedAt" < now() - interval '2 minutes')))
          RETURNING r.id`,
        id,
        tokenId,
    );
    if (claimed.length === 0) throw new ChargeRequestError("NOT_CLAIMABLE", "이미 다른 POS 가 가져갔거나, 취소할 일이 없는 요청입니다.");
    const rows = await loadView(`WHERE r.id = $1`, id);
    const row = rows[0];
    if (!row || !row.tossOrderId) throw new ChargeRequestError("NOT_FOUND", "요청을 찾지 못했습니다.");
    const tossPaymentIds = await chargePaymentIdsFor({ paymentId: row.paymentId, tossOrderId: row.tossOrderId, tossPaymentId: row.tossPaymentId, note: row.note });
    return { ...toCancelJobView(row, await itemsOf(row)), tossOrderId: row.tossOrderId, tossPaymentIds };
}

export const PLUGIN_CANCEL_RESULTS = ["DONE", "FAILED"] as const;
export type PluginCancelResult = (typeof PLUGIN_CANCEL_RESULTS)[number];

/** 플러그인 취소 결과 글자 → 저장 값(done·failed, 대소문자 무관). 모르는 값이면 null(400). */
export function normalizePluginCancelResult(value: unknown): PluginCancelResult | null {
    const raw = String(value ?? "").trim().toUpperCase();
    return (PLUGIN_CANCEL_RESULTS as readonly string[]).includes(raw) ? (raw as PluginCancelResult) : null;
}

/**
 * 플러그인 취소 결과 보고 — **기록만**(환불 확정은 토스 웹훅으로만). 선점한 토큰만 보고할 수 있다.
 * FAILED 면 상태를 FAILED 로(사이트 창이 «POS 에서 직접 취소해 주세요» 안내 · 다시 요청 가능). 이미 DONE 이면 그대로.
 */
export async function reportCancelFromPlugin(input: {
    requestId: string;
    tokenId: string;
    result: PluginCancelResult;
    message?: string | null;
}): Promise<{ cancelState: string; refunded: boolean }> {
    const id = String(input.requestId ?? "").trim();
    if (!/^[0-9a-f-]{10,64}$/i.test(id)) throw new ChargeRequestError("NOT_FOUND", "요청을 찾지 못했습니다.");
    const message = input.message ? String(input.message).slice(0, 300) : null;
    const rows = await prisma.$queryRawUnsafe<{ cancelState: string | null }[]>(
        `UPDATE "PosChargeRequest"
            SET "cancelReportedAt" = now(), "cancelReportMessage" = $3,
                "cancelState" = CASE WHEN $2::text = 'FAILED' AND "cancelState" IN ('REQUESTED', 'SENT') THEN 'FAILED' ELSE "cancelState" END,
                "updatedAt" = now()
          WHERE id = $1 AND "cancelClaimedByTokenId" = $4 AND "cancelState" IS NOT NULL
          RETURNING "cancelState"`,
        id,
        input.result,
        message,
        input.tokenId,
    );
    if (!rows[0]) throw new ChargeRequestError("NOT_CLAIMABLE", "이 POS 가 가져간 취소 요청이 아닙니다.");
    const state = String(rows[0].cancelState ?? "");
    return { cancelState: state, refunded: state === "DONE" };
}
