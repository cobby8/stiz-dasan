/**
 * 관리자 직접 수강 변경(상태 변경·반 이동·수강 종료) 뒤 «남는 찌꺼기» 정리 (2026-11-14 원장 지시 — 김루빈 사례 재발 방지)
 *
 * 실제로 일어난 일:
 *   1) 학부모 복귀 신청 2건이 «승인됨·미적용»으로 남은 채 관리자가 반을 직접 «수강 중»으로 바꿨다.
 *      옛 신청이 그대로 남아 이후 반 이동이 «처리 중인 수강 변경 신청이 있어요»로 막혔다(운영에서 수동 SUPERSEDED).
 *   2) 반을 옮기고 수강 종료했는데 그 반의 미래 결석(학부모 사전 신고)·그 결석으로 나간 보강권·미납 청구가 남았다.
 *
 * 그래서 세 가지를 같은 트랜잭션에서 한다:
 *   A. 같은 수강의 처리 중(대기·승인 미적용) 신청 — 관리자 변경과 «같은 방향»인 승인 건은 SUPERSEDED 로 닫고,
 *      판단이 어려운 건(대기 중·반대 방향)은 화면이 확인창으로 묻고, 돈·반영 처리가 걸린 건은 막는다.
 *   B. 끝난 반의 효력일(포함) 이후 결석 → CANCELLED, 그 결석으로 나간 미사용 보강권 → REVOKED.
 *      청구 정산·이월·보강 예약·출석 기록에 묶인 것은 건드리지 않고 «정리 못 한 N건»으로 알린다(기간 결석 서비스와 같은 보호).
 *   C. 그 반의 효력일이 낀 달 이후 미납 청구는 «목록만» 돌려준다 — 돈과 연결돼 자동으로 지우지 않는다.
 *
 * 판정은 DB 를 읽지 않는 순수 함수(테스트가 실제로 실행), DB 쓰기는 호출부 트랜잭션(db 인자)으로만 한다.
 * prisma 를 import 하지 않는다 — 테스트가 가짜 DB 로 이 파일을 그대로 실행한다.
 */
import { lockCompensation } from "@/lib/billing/absence-compensation-guard";
import { isKstYmd } from "@/lib/datetime/kst";
import { regularAbsenceSourceKey } from "@/lib/makeup/absence-report-credit";
import { PERIOD_ABSENCE_NOTE_PREFIX } from "@/lib/regular/absence-period-plan";
import { closeIllnessReviewInTx, illnessReviewReady } from "@/lib/regular/illness-carry-tx";
import { CHANGE_STATUS_LABEL, REQUEST_KIND_LABEL } from "@/lib/enrollment/changeRequestRules";

export type CleanupDb = {
  $queryRawUnsafe<T = unknown>(sql: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(sql: string, ...values: unknown[]): Promise<number>;
};

// ══ A. 처리 중 수강 변경 신청 ═══════════════════════════════════════════════

/** 처리 중(대기·승인 미적용) 신청의 상태 — 이 두 값만 «열린 신청»이다(삭제·반 이동 차단 조회와 같은 기준) */
export const OPEN_CHANGE_REQUEST_STATUSES = ["PENDING", "APPROVED"] as const;
/** 관리자 직접 변경으로 닫힌 신청의 상태값 — 운영에서 수동 정리할 때 쓰던 값을 그대로 쓴다 */
export const SUPERSEDED_STATUS = "SUPERSEDED";

export type AdminEnrollmentAction =
  | { type: "STATUS"; nextStatus: "ACTIVE" | "PAUSED" | "WITHDRAWN" }
  | { type: "MOVE"; toClassId: string };

export type OpenChangeRequestRow = {
  id: string;
  kind: string;
  status: string;
  toClassId: string | null;
  toClassName?: string | null;
  effectiveFrom: string | null;
  resumeOn: string | null;
  /** 차액 청구서를 이미 발행함 */
  invoiced: boolean;
  /** 휴원 수강료 처리(이월·환불) 기록이 있음 */
  settled: boolean;
  /** 적용일 처리에서 운영 원장(enrollment-change:<id>)이 이미 만들어짐(반영 보류 등) */
  linkedCommand: boolean;
};

export type OpenChangeRequestPlan = {
  /** 관리자 변경과 같은 방향의 승인 건 — 바로 닫는다 */
  supersede: OpenChangeRequestRow[];
  /** 대기 중이거나 방향이 다른 건 — 관리자 확인을 받은 뒤에만 함께 닫는다 */
  ask: OpenChangeRequestRow[];
  /** 돈·반영 처리가 걸린 건 — 여기서 닫지 않는다(«수강 변경 신청»에서 먼저 처리) */
  block: OpenChangeRequestRow[];
};

/**
 * 관리자 변경 결과와 «같은 방향»인가.
 * - 수강 중으로 바꿈 ↔ 복귀(RESUME) · 휴원으로 바꿈 ↔ 휴원(PAUSE, 복귀일 없는 것만 — 복귀일이 있으면 예정된 복귀가 사라지므로 묻는다)
 * - 수강 종료 ↔ 퇴원(WITHDRAW) · 반 이동 ↔ 같은 반으로 가는 반 변경(CLASS_CHANGE)
 */
export function isSameDirection(row: Pick<OpenChangeRequestRow, "kind" | "toClassId" | "resumeOn">, action: AdminEnrollmentAction): boolean {
  if (action.type === "MOVE") return row.kind === "CLASS_CHANGE" && Boolean(row.toClassId) && row.toClassId === action.toClassId;
  if (action.nextStatus === "ACTIVE") return row.kind === "RESUME";
  if (action.nextStatus === "PAUSED") return row.kind === "PAUSE" && !row.resumeOn;
  return row.kind === "WITHDRAW";
}

/** 처리 중 신청을 «바로 닫기 / 물어보기 / 막기»로 나눈다 */
export function planOpenChangeRequests(rows: OpenChangeRequestRow[], action: AdminEnrollmentAction): OpenChangeRequestPlan {
  const plan: OpenChangeRequestPlan = { supersede: [], ask: [], block: [] };
  for (const row of rows) {
    if (!(OPEN_CHANGE_REQUEST_STATUSES as readonly string[]).includes(row.status)) continue; // 이미 끝난 신청은 대상 아님
    if (row.invoiced || row.settled || row.linkedCommand) plan.block.push(row);
    else if (row.status === "APPROVED" && isSameDirection(row, action)) plan.supersede.push(row);
    else plan.ask.push(row);
  }
  return plan;
}

/** 화면 한 줄 — «복귀 · 승인됨 · 2026-11-16부터» */
export function openRequestLabel(row: OpenChangeRequestRow): string {
  const kind = REQUEST_KIND_LABEL[row.kind] ?? row.kind;
  const target = row.kind === "CLASS_CHANGE" && row.toClassName ? `${kind}(→ ${row.toClassName})` : kind;
  const status = CHANGE_STATUS_LABEL[row.status] ?? row.status;
  return [target, status, row.effectiveFrom ? `${row.effectiveFrom}부터` : ""].filter(Boolean).join(" · ");
}

export type OpenRequestView = { id: string; label: string };

export function openRequestViews(rows: OpenChangeRequestRow[]): OpenRequestView[] {
  return rows.map((row) => ({ id: row.id, label: openRequestLabel(row) }));
}

export function blockedRequestsMessage(count: number): string {
  return `이 수강에 청구서·휴원 정산·반영 처리가 걸린 수강 변경 신청이 ${count}건 있어요. «수강 변경 신청»에서 먼저 처리해 주세요.`;
}

/** 학부모 취소 요청에 남기는 답(학부모에게 보이는 글) */
export const CANCEL_REQUEST_SUPERSEDED_NOTE = "관리자 직접 변경으로 신청이 정리되었습니다";

/**
 * 확인창에서 관리자가 «함께 정리»를 고른 신청이 지금 서버가 다시 읽은 대상과 같은가.
 * - 물어볼 신청이 없으면 확인이 필요 없다(true).
 * - 있으면 화면에 보여 준 id 목록과 «정확히 같은 집합»일 때만 true — 그 사이 새 신청이 들어왔거나 빠졌으면 다시 묻는다.
 */
export function askConfirmed(ask: Pick<OpenChangeRequestRow, "id">[], shownIds: readonly string[] | null | undefined): boolean {
  if (!ask.length) return true;
  if (!shownIds || !shownIds.length) return false;
  const shown = new Set(shownIds);
  return shown.size === ask.length && ask.every((row) => shown.has(row.id));
}

/** 다시 물을 때 문구 — 화면이 이미 한 번 보여 준 뒤면 «바뀌었다»고 알려 준다 */
export function openRequestsMessage(count: number, changedSinceShown: boolean): string {
  return changedSinceShown
    ? `그 사이 처리 중인 수강 변경 신청이 바뀌었어요(지금 ${count}건). 다시 확인해 주세요.`
    : `이 수강에 처리 중인 수강 변경 신청이 ${count}건 있어요.`;
}

async function cancelRequestColumnsReady(db: CleanupDb): Promise<boolean> {
  const rows = await db.$queryRawUnsafe<Array<{ n: number }>>(
    `SELECT COUNT(*)::int AS n FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'EnrollmentChangeRequest'
        AND column_name IN ('cancelRequestStatus','cancelDecisionNote')`,
  );
  return Number(rows[0]?.n ?? 0) === 2;
}

/** 닫을 때 남기는 사유(decisionNote) — 누가 왜 닫았는지 신청 행에서 바로 보이게 */
export function supersedeNote(action: AdminEnrollmentAction, todayYmd: string, confirmed: boolean): string {
  const what = action.type === "MOVE" ? "반 이동"
    : action.nextStatus === "ACTIVE" ? "수강 중 전환"
    : action.nextStatus === "PAUSED" ? "휴원 전환" : "수강 종료";
  return `관리자 직접 변경(${what}, ${todayYmd})으로 정리${confirmed ? " — 관리자 확인" : ""}`;
}

/**
 * 같은 수강의 처리 중 신청을 잠그고 읽는다(FOR UPDATE).
 * ★ 수강(Enrollment) 행보다 «먼저» 잠근다 — 적용일 크론이 «신청 → 수강» 순서로 잠그므로 같은 순서여야 서로 기다리다 막히지 않는다.
 */
export async function readOpenChangeRequestsForUpdate(db: CleanupDb, enrollmentId: string): Promise<OpenChangeRequestRow[]> {
  const settlementReady = await tableExists(db, "EnrollmentChangeSettlement");
  const settledSql = settlementReady
    ? `EXISTS (SELECT 1 FROM "EnrollmentChangeSettlement" st WHERE st."requestId" = r.id)`
    : `false`;
  const rows = await db.$queryRawUnsafe<OpenChangeRequestRow[]>(
    `SELECT r.id, r.kind, r.status, r."toClassId" AS "toClassId", tc.name AS "toClassName",
            to_char(r."effectiveFrom",'YYYY-MM-DD') AS "effectiveFrom", to_char(r."resumeOn",'YYYY-MM-DD') AS "resumeOn",
            (r."invoicedPaymentId" IS NOT NULL) AS invoiced, ${settledSql} AS settled,
            EXISTS (SELECT 1 FROM "OperationsCommand" c WHERE c."idempotencyKey" = 'enrollment-change:' || r.id) AS "linkedCommand"
       FROM "EnrollmentChangeRequest" r
       LEFT JOIN "Class" tc ON tc.id = r."toClassId"
      WHERE r."enrollmentId" = $1 AND r.status IN ('PENDING','APPROVED') AND r."appliedAt" IS NULL
      ORDER BY r."createdAt"
      FOR UPDATE OF r`,
    enrollmentId,
  );
  return rows.map((row) => ({
    ...row,
    invoiced: Boolean(row.invoiced),
    settled: Boolean(row.settled),
    linkedCommand: Boolean(row.linkedCommand),
  }));
}

/**
 * 신청을 SUPERSEDED 로 닫고 감사 기록을 남긴다(같은 트랜잭션).
 * - 승인자(decidedBy·decidedAt)는 지우지 않는다 — 대기 중이던 건만 이번 관리자를 결정자로 적는다.
 * - 조건부 UPDATE(아직 열린 건만) — 그 사이 크론이 적용했으면 0행이라 건드리지 않는다.
 * - 적용일 크론·학부모 신청 중복 확인·신청함은 모두 status='APPROVED'/'PENDING' 만 보므로 SUPERSEDED 는 다시 적용되지 않는다.
 */
export async function supersedeChangeRequests(db: CleanupDb, rows: OpenChangeRequestRow[], input: {
  enrollmentId: string; actorUserId: string; note: string; confirmed: boolean;
}): Promise<number> {
  if (!rows.length) return 0;
  const ids = rows.map((r) => r.id);
  // 학부모 «취소 요청»(d8) 대기 건도 함께 끝낸다 — 남겨 두면 관리자 «처리할 취소 요청» 목록에 찌꺼기로 남는다.
  // 값은 DB CHECK(NULL·PENDING·APPROVED·REJECTED)가 허용하는 REJECTED, 결정 시각 칸은 따로 없어 updatedAt 만(기존 «요청 거절»과 같은 방식).
  // 칸은 마이그레이션 20261110130000 이후에만 있어 있을 때만 쓴다.
  const cancelSql = (await cancelRequestColumnsReady(db))
    ? `, "cancelRequestStatus" = CASE WHEN "cancelRequestStatus" = 'PENDING' THEN 'REJECTED' ELSE "cancelRequestStatus" END,
            "cancelDecisionNote" = CASE WHEN "cancelRequestStatus" = 'PENDING' THEN $4 ELSE "cancelDecisionNote" END`
    : "";
  const closed = await db.$queryRawUnsafe<Array<{ id: string }>>(
    `UPDATE "EnrollmentChangeRequest"
        SET status = 'SUPERSEDED',
            "decidedByUserId" = COALESCE("decidedByUserId", $2),
            "decidedAt" = COALESCE("decidedAt", now()),
            "decisionNote" = CASE WHEN COALESCE("decisionNote",'') = '' THEN $3 ELSE "decisionNote" || ' / ' || $3 END,
            "updatedAt" = now()${cancelSql}
      WHERE id = ANY($1::text[]) AND status IN ('PENDING','APPROVED') AND "appliedAt" IS NULL
      RETURNING id`,
    ...(cancelSql ? [ids, input.actorUserId, input.note, CANCEL_REQUEST_SUPERSEDED_NOTE] : [ids, input.actorUserId, input.note]),
  );
  const closedIds = new Set(closed.map((r) => r.id));
  for (const row of rows) {
    if (!closedIds.has(row.id)) continue;
    await db.$executeRawUnsafe(
      `INSERT INTO "OperationsAuditLog" (id, action, "actorType", "actorUserId", "detailsJson")
       VALUES (gen_random_uuid()::text, 'ENROLLMENT_CHANGE_REQUEST_SUPERSEDED', 'ADMIN', $1, $2::jsonb)`,
      input.actorUserId,
      JSON.stringify({
        changeRequestId: row.id, enrollmentId: input.enrollmentId, kind: row.kind, from: row.status, to: SUPERSEDED_STATUS,
        effectiveFrom: row.effectiveFrom, reason: input.note, confirmedByAdmin: input.confirmed,
      }),
    );
  }
  return closedIds.size;
}

// ══ B. 끝난 반의 결석·보강권 ════════════════════════════════════════════════

/**
 * 수강 종료·반 이동으로 취소한 결석 행의 note 머리말.
 * 알림 재조정(operational-notification-reconciliation)이 이 머리말의 CANCELLED 행은 «결석 취소» 알림을 보내지 않는다 —
 * 학생이 그 반을 그만둬서 지운 것이지, 다시 수업에 오는 게 아니다(원장·코치·기사에게 잘못된 안내).
 */
export const ENROLLMENT_END_ABSENCE_NOTE_PREFIX = "수강 종료로 정리";
export const ENROLLMENT_END_CREDIT_NOTE = "수강 종료(반 이동)로 그 반 결석이 정리되어 회수";

/** note 를 어떻게 바꿀지 — 기간 결석 행은 그 머리말을 지켜야 기간 결석 서비스가 계속 «자기 행»으로 알아본다 */
export function endedAbsenceNote(input: { note: string | null; periodRow: boolean }): string | null {
  if (input.periodRow) return input.note;
  const old = (input.note ?? "").trim();
  return old ? `${ENROLLMENT_END_ABSENCE_NOTE_PREFIX} · ${old}` : ENROLLMENT_END_ABSENCE_NOTE_PREFIX;
}

export type ClassEndAbsenceRow = {
  id: string;
  /** 결석일(KST 달력 YYYY-MM-DD — DATE 칸을 글자로 읽은 값) */
  date: string;
  status: string;
  note: string | null;
  /** 관리자 «기간 결석»이 만든 행(periodId·관리자 행·기간 머리말) */
  periodRow: boolean;
  /** 청구 정산(BillingAbsenceResolution — 이월/보강 결정)에 묶임 */
  billingResolved: boolean;
  /** 이월 금액(BillingCarryCredit)이 만들어짐 */
  carryCredit: boolean;
  /** 보강 예약(MakeupSession, 취소 아님)이 있음 */
  makeupBooked: boolean;
  /** 그날 그 반 출석부에 기록(출석·지각·결석 무엇이든)이 있음 */
  attendanceRecorded: boolean;
  /** 그 결석의 보강권 상태(없으면 null) */
  creditId: string | null;
  creditStatus: string | null;
  /** 보강권이 예약에 묶인 흔적(makeupSessionId) */
  creditBooked: boolean;
};

export type ClassEndAbsenceDecision = "SKIP" | "CANCEL" | "KEEP_BILLING" | "KEEP_MAKEUP" | "KEEP_ATTENDANCE";

/**
 * 끝난 반의 결석 한 건을 어떻게 할지.
 * - 효력일 «전» 결석은 그 반을 다니던 때라 그대로 둔다(SKIP).
 * - 효력일(포함) 이후: 정산·이월 → 보강 예약/사용 → 출석 기록 순으로 보호하고, 아무것도 안 묶였으면 취소.
 */
export function decideAbsenceOnClassEnd(row: ClassEndAbsenceRow, fromYmd: string): ClassEndAbsenceDecision {
  if (!isKstYmd(row.date) || row.date < fromYmd) return "SKIP";
  if (row.status !== "REPORTED" && row.status !== "CONFIRMED") return "SKIP";
  if (row.billingResolved || row.carryCredit) return "KEEP_BILLING";
  if (row.makeupBooked || row.creditBooked || ["RESERVED", "USED", "NO_SHOW"].includes(String(row.creditStatus))) return "KEEP_MAKEUP";
  if (row.attendanceRecorded) return "KEEP_ATTENDANCE";
  return "CANCEL";
}

/** 취소하는 결석의 보강권 — 쓰지 않은(AVAILABLE·예약 흔적 없음) 것만 회수 */
export function creditActionOnClassEnd(row: Pick<ClassEndAbsenceRow, "creditStatus" | "creditBooked">): "REVOKE" | "NONE" {
  return row.creditStatus === "AVAILABLE" && !row.creditBooked ? "REVOKE" : "NONE";
}

export type ClassEndAbsencePlan = {
  cancel: ClassEndAbsenceRow[];
  revokeCreditIds: string[];
  kept: { billing: number; makeup: number; attendance: number };
};

export function planClassEndAbsences(rows: ClassEndAbsenceRow[], fromYmd: string): ClassEndAbsencePlan {
  const plan: ClassEndAbsencePlan = { cancel: [], revokeCreditIds: [], kept: { billing: 0, makeup: 0, attendance: 0 } };
  for (const row of rows) {
    const decision = decideAbsenceOnClassEnd(row, fromYmd);
    if (decision === "CANCEL") {
      plan.cancel.push(row);
      if (row.creditId && creditActionOnClassEnd(row) === "REVOKE") plan.revokeCreditIds.push(row.creditId);
    } else if (decision === "KEEP_BILLING") plan.kept.billing++;
    else if (decision === "KEEP_MAKEUP") plan.kept.makeup++;
    else if (decision === "KEEP_ATTENDANCE") plan.kept.attendance++;
  }
  return plan;
}

// ══ C. 미납 청구(안내만) ══════════════════════════════════════════════════

export type UnpaidPaymentRow = {
  id: string;
  status: string;
  amount: number | null;
  year: number | null;
  month: number | null;
  /** 청구 기한(KST 달력) — 대상 월이 비어 있는 청구만 이걸로 판단 */
  dueYmd: string | null;
  description: string | null;
};

export type UnpaidPaymentView = {
  id: string;
  /** «2026년 12월» */
  monthLabel: string;
  amount: number | null;
  description: string | null;
  /** 효력일이 그달 중간이라 일부는 다닌 달 — 금액 조정이 필요할 수 있다 */
  partial: boolean;
};

const UNPAID_STATUSES = new Set(["PENDING", "OVERDUE"]);

/**
 * 효력일이 낀 달 이후의 미납 청구인가.
 * - 대상 월(year·month)이 있으면 «그달 ≥ 효력일의 달».
 * - 없으면 청구 기한(KST 날짜) ≥ 효력일.
 */
export function isUnpaidAfterEnd(row: UnpaidPaymentRow, fromYmd: string): { match: boolean; partial: boolean } {
  if (!UNPAID_STATUSES.has(row.status) || !isKstYmd(fromYmd)) return { match: false, partial: false };
  const fromYm = Number(fromYmd.slice(0, 4)) * 100 + Number(fromYmd.slice(5, 7));
  if (row.year && row.month) {
    const ym = row.year * 100 + row.month;
    // 효력일이 1일이 아니면 그달은 일부 다닌 달
    return { match: ym >= fromYm, partial: ym === fromYm && fromYmd.slice(8, 10) !== "01" };
  }
  if (row.dueYmd && isKstYmd(row.dueYmd)) return { match: row.dueYmd >= fromYmd, partial: false };
  return { match: false, partial: false };
}

export function unpaidPaymentViews(rows: UnpaidPaymentRow[], fromYmd: string): UnpaidPaymentView[] {
  const views: UnpaidPaymentView[] = [];
  for (const row of rows) {
    const hit = isUnpaidAfterEnd(row, fromYmd);
    if (!hit.match) continue;
    const monthLabel = row.year && row.month ? `${row.year}년 ${row.month}월` : row.dueYmd ? `기한 ${row.dueYmd}` : "월 미지정";
    views.push({ id: row.id, monthLabel, amount: row.amount == null ? null : Number(row.amount), description: row.description, partial: hit.partial });
  }
  return views;
}

// ══ 결과 요약 ══════════════════════════════════════════════════════════════

export type EnrollmentEndCleanupSummary = {
  supersededRequests: number;
  cancelledAbsences: number;
  revokedCredits: number;
  /** 정리 못 한 결석(보호 대상) */
  keptAbsences: { billing: number; makeup: number; attendance: number };
  /** 끝난 반에 남은 효력일 이후 미납 청구(자동으로 지우지 않음) */
  unpaidPayments: Array<UnpaidPaymentView & { className: string }>;
};

export function emptyCleanupSummary(): EnrollmentEndCleanupSummary {
  return { supersededRequests: 0, cancelledAbsences: 0, revokedCredits: 0, keptAbsences: { billing: 0, makeup: 0, attendance: 0 }, unpaidPayments: [] };
}

/** 화면 한 줄 — «처리 중 신청 2건 정리 · 결석 3건 취소 · 보강권 2장 회수 · 정리 못 한 결석 1건(보강 예약 1)». 할 일이 없었으면 빈 글자 */
export function cleanupResultMessage(s: EnrollmentEndCleanupSummary): string {
  const kept = s.keptAbsences.billing + s.keptAbsences.makeup + s.keptAbsences.attendance;
  const keptWhy = [
    s.keptAbsences.billing ? `청구 정산 ${s.keptAbsences.billing}` : "",
    s.keptAbsences.makeup ? `보강 예약·사용 ${s.keptAbsences.makeup}` : "",
    s.keptAbsences.attendance ? `출석 기록 ${s.keptAbsences.attendance}` : "",
  ].filter(Boolean).join("·");
  return [
    s.supersededRequests ? `처리 중 신청 ${s.supersededRequests}건 정리` : "",
    s.cancelledAbsences ? `결석 ${s.cancelledAbsences}건 취소` : "",
    s.revokedCredits ? `보강권 ${s.revokedCredits}장 회수` : "",
    kept ? `정리 못 한 결석 ${kept}건(${keptWhy}) — 결석 관리에서 확인` : "",
  ].filter(Boolean).join(" · ");
}

// ══ DB 연결부 ══════════════════════════════════════════════════════════════

async function tableExists(db: CleanupDb, name: string): Promise<boolean> {
  const rows = await db.$queryRawUnsafe<Array<{ found: string | null }>>(`SELECT to_regclass($1)::text AS found`, `public."${name}"`);
  return Boolean(rows[0]?.found);
}

/**
 * 끝난 반(학생·반)의 효력일 이후 결석·보강권 정리 + 미납 청구 목록. 호출부 트랜잭션 안에서 부른다.
 * 청구 정산·출석부·기간 결석과 같은 전역 잠금(lockCompensation) 안에서 한다.
 */
export async function cleanupEndedClassInTx(db: CleanupDb, input: {
  studentId: string; classId: string; className: string; fromYmd: string; actorUserId: string;
}): Promise<Omit<EnrollmentEndCleanupSummary, "supersededRequests">> {
  if (!isKstYmd(input.fromYmd)) throw new Error("효력일 형식이 올바르지 않습니다.");
  await lockCompensation(db);

  // 트랜잭션 하나는 쿼리를 한 줄로 보내야 해서 차례로 확인한다
  const resolutionReady = await tableExists(db, "BillingAbsenceResolution");
  const carryReady = await tableExists(db, "BillingCarryCredit");
  const makeupReady = await tableExists(db, "MakeupSession");
  const resolvedSql = resolutionReady ? `EXISTS (SELECT 1 FROM "BillingAbsenceResolution" r WHERE r."absenceId" = ra.id)` : `false`;
  const carrySql = carryReady ? `EXISTS (SELECT 1 FROM "BillingCarryCredit" cc WHERE cc."absenceId" = ra.id)` : `false`;
  // 보강 예약은 결석과 자연키(학생·원래 반·결석일)로 묶인다 — 기간 결석 서비스·absence-compensation-guard 와 같은 비교
  const makeupSql = makeupReady
    ? `EXISTS (SELECT 1 FROM "MakeupSession" m WHERE m."studentId" = ra."studentId" AND m."originalClassId" = ra."classId"
         AND to_char(m."originalDate" AT TIME ZONE 'Asia/Seoul','YYYY-MM-DD') = to_char(ra.date,'YYYY-MM-DD')
         AND m.status <> 'CANCELLED')`
    : `false`;

  // 효력일 이후의 살아 있는 결석(잠금). Session.date 는 무tz 칸에 KST 자정을 담아 글자 그대로 비교한다(보강권 모듈과 같은 규칙).
  const rows = await db.$queryRawUnsafe<Array<Omit<ClassEndAbsenceRow, "creditId" | "creditStatus" | "creditBooked">>>(
    `SELECT ra.id, to_char(ra.date,'YYYY-MM-DD') AS date, ra.status, ra.note,
            (ra."periodId" IS NOT NULL AND ra."reportedByUserId" IS NULL AND COALESCE(ra.note,'') LIKE $4) AS "periodRow",
            ${resolvedSql} AS "billingResolved", ${carrySql} AS "carryCredit", ${makeupSql} AS "makeupBooked",
            EXISTS (SELECT 1 FROM "Attendance" t JOIN "Session" se ON se.id = t."sessionId"
                     WHERE t."studentId" = ra."studentId" AND se."classId" = ra."classId"
                       AND to_char(se.date,'YYYY-MM-DD') = to_char(ra.date,'YYYY-MM-DD')) AS "attendanceRecorded"
       FROM "RegularAbsence" ra
      WHERE ra."studentId" = $1 AND ra."classId" = $2 AND ra.date >= $3::date AND ra.status IN ('REPORTED','CONFIRMED')
      ORDER BY ra.date
      FOR UPDATE OF ra`,
    input.studentId, input.classId, input.fromYmd, `${PERIOD_ABSENCE_NOTE_PREFIX} · %`,
  );

  // 그 결석들의 보강권(같은 키 REGULAR:{반}:{날짜}) — 잠금
  const keys = rows.map((r) => regularAbsenceSourceKey(input.classId, r.date));
  const credits = keys.length
    ? await db.$queryRawUnsafe<Array<{ id: string; sourceKey: string; status: string; booked: boolean }>>(
        `SELECT id, "sourceKey", status, ("makeupSessionId" IS NOT NULL) AS booked
           FROM "MakeupCredit" WHERE "studentId" = $1 AND "sourceKey" = ANY($2::text[])
          FOR UPDATE`,
        input.studentId, keys,
      )
    : [];
  const creditByKey = new Map(credits.map((c) => [c.sourceKey, c]));
  const full: ClassEndAbsenceRow[] = rows.map((r) => {
    const credit = creditByKey.get(regularAbsenceSourceKey(input.classId, r.date)) ?? null;
    return {
      ...r,
      periodRow: Boolean(r.periodRow),
      billingResolved: Boolean(r.billingResolved),
      carryCredit: Boolean(r.carryCredit),
      makeupBooked: Boolean(r.makeupBooked),
      attendanceRecorded: Boolean(r.attendanceRecorded),
      creditId: credit?.id ?? null,
      creditStatus: credit?.status ?? null,
      creditBooked: Boolean(credit?.booked),
    };
  });
  const plan = planClassEndAbsences(full, input.fromYmd);

  let cancelledAbsences = 0;
  const cancelledIds: string[] = [];
  for (const row of plan.cancel) {
    // 행마다 note 를 정한다(기간 결석 행은 머리말 유지 → 기간 결석 서비스·알림 재조정 제외가 계속 맞는다)
    const n = await db.$executeRawUnsafe(
      `UPDATE "RegularAbsence" SET status = 'CANCELLED', note = $2, "resolvedByUserId" = $3, "updatedAt" = now()
        WHERE id = $1 AND status IN ('REPORTED','CONFIRMED')`,
      row.id, endedAbsenceNote(row), input.actorUserId,
    );
    if (Number(n) > 0) { cancelledAbsences++; cancelledIds.push(row.id); }
  }
  // 질병·부상 이월 검토 중이던 결석이면 함께 닫는다(관리자 결석 취소와 같은 함수)
  if (cancelledIds.length && await illnessReviewReady(db)) {
    for (const id of cancelledIds) await closeIllnessReviewInTx(db, id, { canceled: true });
  }
  const revokedCredits = plan.revokeCreditIds.length
    ? Number(await db.$executeRawUnsafe(
        `UPDATE "MakeupCredit" SET status = 'REVOKED', note = $2, "updatedAt" = now()
          WHERE id = ANY($1::text[]) AND status = 'AVAILABLE' AND "makeupSessionId" IS NULL`,
        plan.revokeCreditIds, ENROLLMENT_END_CREDIT_NOTE,
      ))
    : 0;

  // C. 미납 청구 — 읽기만(자동 삭제 금지). dueDate 는 무tz 칸이라 «두 번» 걸어 KST 날짜로 읽는다.
  const unpaidRows = await db.$queryRawUnsafe<UnpaidPaymentRow[]>(
    `SELECT p.id, p.status, p.amount, p.year, p.month, p.description,
            to_char(((p."dueDate" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Seoul')::date,'YYYY-MM-DD') AS "dueYmd"
       FROM "Payment" p
      WHERE p."studentId" = $1 AND p."classId" = $2 AND p.status IN ('PENDING','OVERDUE')
      ORDER BY p.year NULLS LAST, p.month NULLS LAST, p."dueDate"`,
    input.studentId, input.classId,
  );
  const unpaidPayments = unpaidPaymentViews(unpaidRows, input.fromYmd).map((v) => ({ ...v, className: input.className }));

  // 감사 기록 — 무엇을 지웠고 무엇을 남겼는지(되살릴 때 근거)
  if (cancelledAbsences || revokedCredits || plan.kept.billing || plan.kept.makeup || plan.kept.attendance || unpaidPayments.length) {
    await db.$executeRawUnsafe(
      `INSERT INTO "OperationsAuditLog" (id, action, "actorType", "actorUserId", "detailsJson")
       VALUES (gen_random_uuid()::text, 'ENROLLMENT_END_CLEANUP', 'ADMIN', $1, $2::jsonb)`,
      input.actorUserId,
      JSON.stringify({
        studentId: input.studentId, classId: input.classId, className: input.className, fromYmd: input.fromYmd,
        cancelledAbsenceIds: cancelledIds, revokedCreditIds: plan.revokeCreditIds, kept: plan.kept,
        unpaidPaymentIds: unpaidPayments.map((p) => p.id),
      }),
    );
  }

  return { cancelledAbsences, revokedCredits, keptAbsences: plan.kept, unpaidPayments };
}
