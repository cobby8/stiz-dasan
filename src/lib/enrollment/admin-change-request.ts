import { childAccessSql, childConnectionsAvailable } from "@/lib/account/child-access";
import { prisma } from "@/lib/prisma";
import { notMergedStudent } from "@/lib/studentVisibility";
import { createHash } from "node:crypto";
import { CHANGE_KIND_LABEL, type ChangeKind } from "@/lib/enrollment/changeRequestRules";
import { computeClassChangeProration, describeProration, type ProrationResult } from "@/lib/enrollment/proration";
import { getMonthlyClassDates, loadAnnualPlanEvents } from "@/lib/enrollment/monthlyClassDates";
import { DEFAULT_HOLD_REASON, planDueEnrollmentChange } from "@/lib/enrollment/due-change-plan";
import { initialSyncAttempt, isSheetSyncRetired } from "@/lib/operations-sync/sheetRetirement";
import { externalSyncPendingSql, isRallyzSyncRetired, websiteDoneLedgerStatus } from "@/lib/operations-sync/rallyzRetirement";
import { notClosedByDeletedEnrollmentSql } from "@/lib/enrollment/admin-enrollment-edit";
import { notifyParentOfEnrollmentChange } from "@/lib/enrollment/change-decision-notify";
import {
  applyOpenPauseCarries,
  countOpenSettlementWork,
  executePauseSettlementInTx,
  hasMovedMoneySettlement,
  lockPauseSettlement,
  previewPauseSettlement,
  readSettlements,
  runSettlementTossRefunds,
  type ClassDatesFor,
  type PauseSettlementPreview,
  type RefundRunSummary,
  type SettlementView,
} from "@/lib/enrollment/pause-settlement";
import { SETTLEMENT_CHOICE_REQUIRED_MESSAGE, settlementChoiceRequired, type SettlementMode } from "@/lib/enrollment/pause-settlement-plan";
import { todayKst } from "@/lib/datetime/kst";

// ── 원장의 수강 변경 승인/거절 + 적용일이 된 건 반영 ────────────────────────
//
// 승인은 "예약"이다. 8월에 승인해도 실제 반 이동은 적용일(다음 달 1일)에 일어난다.
// 바로 옮기면 그달 남은 수업의 출석부와 청구가 어긋난다.

export type AdminChangeRequestRow = {
  id: string;
  studentName: string;
  kind: string;
  kindLabel: string;
  fromClassName: string | null;
  toClassName: string | null;
  effectiveFrom: string;
  resumeOn: string | null;
  reason: string | null;
  status: string;
  waitlisted: boolean;
  toClassFull: boolean;
  createdAt: string;
  appliedAt: string | null;
  enrollmentStatus: string | null;
  effectiveDateReached: boolean;
  decisionNote: string | null;
  /** 반 변경일 때만. 계획표 기준 일할 계산 결과와 근거 문장. */
  proration: (ProrationResult & { lines: string[] }) | null;
  /** 이미 발행한 차액 청구서가 있으면 그 id. 두 번 발행을 막는다. */
  invoicedPaymentId: string | null;
  invoicePreviewKey: string;
  /** 적용일 처리에서 만든 운영 원장(`enrollment-change:<id>`). 없으면 null. */
  syncCommandId: string | null;
  syncCommandStatus: string | null;
  syncHoldReason: string | null;
  /** 시트·랠리즈 반영 상태(PENDING/SUCCEEDED/FAILED). 자동 적용 건의 "확인 필요" 배지에 쓴다. */
  sheetStatus: string | null;
  rallyzStatus: string | null;
  /** 관리자가 학생 상세에서 바로 옮긴 반 이동(신청자=결정자, 반 변경, 적용됨) — 학부모 신청 아님 */
  adminDirectMove: boolean;
  /** 휴원 수강료 처리 미리보기(아직 처리 전인 휴원만 — 2026-11-10 원장 결정 m6). 계산 근거·금액·지문. */
  settlementPreview: AdminSettlementPreview | null;
  settlementReadFailed: boolean;
  /** 이미 실행한 휴원 수강료 처리(무엇을·얼마·언제·누가 + 남은 일) */
  settlement: SettlementView | null;
};

export type AdminSettlementPreview = Omit<PauseSettlementPreview, "plan"> & {
  paidTotal: number;
  unpaidTotal: number;
  problems: string[];
  /** 낸 돈이 돌아갈 길(TOSS·TOSS_POS·RALLYZ·MANUAL…) — 환불 확인창 문구에 쓴다 */
  channels: string[];
};

export async function getEnrollmentChangeRequests(status = "PENDING", requestIds: string[] | null = null): Promise<AdminChangeRequestRow[]> {
  const rows = await prisma.$queryRawUnsafe<any[]>(
    // 정원은 신청 당시가 아니라 **지금** 기준으로 다시 센다. 그 사이 자리가 났을 수 있다.
    `SELECT r.id, s.name AS "studentName", s."parentId", r.kind,
            fc.name AS "fromClassName", tc.name AS "toClassName",
            to_char(r."effectiveFrom",'YYYY-MM-DD') AS "effectiveFrom",
            to_char(r."resumeOn",'YYYY-MM-DD') AS "resumeOn",
            r.reason, r.status, r.waitlisted, r."decisionNote", r."invoicedPaymentId",
            e.status AS "enrollmentStatus",
            (r."effectiveFrom" <= (now() AT TIME ZONE 'Asia/Seoul')::date) AS "effectiveDateReached",
            (r.kind = 'CLASS_CHANGE' AND r.status = 'APPLIED' AND r."requestedByUserId" = r."decidedByUserId") AS "adminDirectMove",
            r."studentId", r."fromClassId", r."toClassId", fc."dayOfWeek" AS "fromDay", tc."dayOfWeek" AS "toDay",
            fp.price AS "fromFee", tp.price AS "toFee",
            to_char(r."createdAt" AT TIME ZONE 'Asia/Seoul','YYYY-MM-DD HH24:MI') AS "createdAt",
            to_char(r."appliedAt" AT TIME ZONE 'Asia/Seoul','YYYY-MM-DD HH24:MI') AS "appliedAt",
            to_char(r."decidedAt" AT TIME ZONE 'Asia/Seoul','YYYY-MM-DD') AS "decidedOn",
            CASE WHEN tc.id IS NULL THEN false ELSE
              (SELECT count(*) FROM "Enrollment" x WHERE x."classId" = tc.id AND x.status = 'ACTIVE') >= tc.capacity
            END AS "toClassFull",
            oc.id AS "syncCommandId", oc.status AS "syncCommandStatus", oc."holdReason" AS "syncHoldReason",
            (SELECT a.status FROM "OperationsSyncAttempt" a WHERE a."commandId" = oc.id AND a.target = 'SHEET' LIMIT 1) AS "sheetStatus",
            (SELECT a.status FROM "OperationsSyncAttempt" a WHERE a."commandId" = oc.id AND a.target = 'RALLYZ' LIMIT 1) AS "rallyzStatus"
       FROM "EnrollmentChangeRequest" r
       JOIN "Student" s ON s.id = r."studentId"
       LEFT JOIN "Enrollment" e ON e.id = r."enrollmentId" AND e."studentId" = r."studentId"
       LEFT JOIN "Class" fc ON fc.id = r."fromClassId"
       LEFT JOIN "Class" tc ON tc.id = r."toClassId"
       LEFT JOIN "Program" fp ON fp.id = fc."programId"
       LEFT JOIN "Program" tp ON tp.id = tc."programId"
       -- 이 신청에 연결된 운영 원장 1건. 시트·랠리즈 확인 상태를 보여 주려고 붙인다.
       -- LATERAL ... LIMIT 1 이라 원장이 여러 건이어도 신청 행이 늘어나지 않는다.
       LEFT JOIN LATERAL (SELECT c.id, c.status, c."holdReason" FROM "OperationsCommand" c
                           WHERE ${LINKED_COMMAND_SQL}
                             AND ${notClosedByDeletedEnrollmentSql("c")}
                           ORDER BY c."createdAt" DESC LIMIT 1) oc ON true
      WHERE ($1 = 'ALL' OR r.status = $1
             OR ($1 = 'NEEDS_CHECK' AND r.status = 'APPLIED' AND ${NEEDS_CHECK_SQL}))
        AND ($2::text[] IS NULL OR r.id = ANY($2::text[]))
      ORDER BY r."createdAt" DESC
      LIMIT 200`,
    status,
    requestIds,
  );
  // 계획표(구글 캘린더)는 한 번만 읽어 모든 건에 재사용한다.
  const needsPlan = rows.some((row) => (row.kind === "CLASS_CHANGE" && row.toDay && row.fromDay) || row.kind === "PAUSE");
  const planEvents = needsPlan ? await loadAnnualPlanEvents().catch(() => []) : [];

  // 휴원 수강료 처리 — 이미 처리한 기록 + 아직이면 미리보기(검토 중·승인·반영된 휴원만)
  const pauseIds = rows.filter((row) => row.kind === "PAUSE").map((row) => String(row.id));
  const settlements = await readSettlements(prisma, pauseIds).catch((error) => {
    if (requestIds) throw error;
    console.error("[admin-change-request] 휴원 수강료 처리 기록 조회 실패", error instanceof Error ? error.name : "");
    return new Map<string, SettlementView>();
  });
  const classDatesFor: ClassDatesFor = (ym, dow) => getMonthlyClassDates(planEvents, ym, dow);
  const previews = new Map<string, AdminSettlementPreview>();
  const failedPreviews = new Set<string>();
  for (const row of rows) {
    if (row.kind !== "PAUSE" || settlements.has(row.id) || !["PENDING", "APPROVED", "APPLIED"].includes(row.status)) continue;
    // 이 기능 이전에 승인된 휴원은 수강료를 이미 사람이(랠리즈 등) 정리했다 — 처리 버튼을 다시 띄우지 않는다
    if (row.status !== "PENDING" && !(row.decidedOn && row.decidedOn >= PAUSE_SETTLEMENT_SINCE)) continue;
    const preview = await previewPauseSettlement(prisma, row.id, classDatesFor).catch(() => null);
    if (!preview && requestIds) failedPreviews.add(row.id);
    if (!preview) continue;
    const { plan, ...rest } = preview;
    previews.set(row.id, {
      ...rest, paidTotal: plan.paidTotal, unpaidTotal: plan.unpaidTotal, problems: plan.problems,
      channels: [...new Set(plan.lines.filter((l) => l.paid).map((l) => l.channel))],
    });
  }

  return rows.map((row) => ({
    id: row.id,
    studentName: row.studentName,
    kind: row.kind,
    // 복귀(RESUME)는 관리자 직접 변경 + 학부모 복귀 신청(휴원 중인 반, 2026-11-09~)에서 생긴다.
    kindLabel: CHANGE_KIND_LABEL[row.kind as ChangeKind] ?? (row.kind === "RESUME" ? "복귀" : row.kind),
    fromClassName: row.fromClassName ?? null,
    toClassName: row.toClassName ?? null,
    effectiveFrom: row.effectiveFrom,
    resumeOn: row.resumeOn ?? null,
    reason: row.reason ?? null,
    status: row.status,
    waitlisted: Boolean(row.waitlisted),
    toClassFull: Boolean(row.toClassFull),
    createdAt: row.createdAt,
    appliedAt: row.appliedAt ?? null,
    enrollmentStatus: row.enrollmentStatus ?? null,
    effectiveDateReached: Boolean(row.effectiveDateReached),
    decisionNote: row.decisionNote ?? null,
    invoicedPaymentId: row.invoicedPaymentId ?? null,
    invoicePreviewKey: invoicePreviewKey(row, buildProration(row, planEvents)),
    proration: buildProration(row, planEvents),
    syncCommandId: row.syncCommandId ?? null,
    syncCommandStatus: row.syncCommandStatus ?? null,
    syncHoldReason: row.syncHoldReason ?? null,
    sheetStatus: row.sheetStatus ?? null,
    rallyzStatus: row.rallyzStatus ?? null,
    adminDirectMove: Boolean(row.adminDirectMove),
    settlementPreview: previews.get(row.id) ?? null,
    settlementReadFailed: failedPreviews.has(row.id),
    settlement: settlements.get(row.id) ?? null,
  }));
}

/**
 * 휴원 1건의 수강료 처리 미리보기(다른 화면 — 예: 신청함 상세 칸 — 이 승인 전에 금액·지문을 받을 때).
 * 휴원이 아니면 null. 결과의 previewKey 를 decideEnrollmentChange({ settlement: { mode, expectedPreviewKey } }) 에 그대로 넘긴다.
 */
export async function getPauseSettlementPreview(requestId: string): Promise<AdminSettlementPreview | null> {
  const preview = await previewPauseSettlement(prisma, requestId, await loadClassDatesFor());
  if (!preview) return null;
  const { plan, ...rest } = preview;
  return {
    ...rest, paidTotal: plan.paidTotal, unpaidTotal: plan.unpaidTotal, problems: plan.problems,
    channels: [...new Set(plan.lines.filter((l) => l.paid).map((l) => l.channel))],
  };
}

/** 휴원 수강료 처리 기능 시작일(KST) — 이보다 먼저 승인된 휴원에는 «수강료 처리» 미리보기·버튼을 띄우지 않는다 */
const PAUSE_SETTLEMENT_SINCE = "2026-11-10";

/** 수강료 처리 남은 일 건수(화면 상단 알림) — 표가 없거나 실패하면 0 */
export async function countOpenPauseSettlements(): Promise<number> {
  return countOpenSettlementWork(prisma).catch(() => 0);
}

/**
 * 신청(별칭 r)에 연결된 운영 원장(별칭 c)을 찾는 조건. 두 경로를 모두 인정한다.
 * - 적용일 자동 적용·보류: idempotencyKey = `enrollment-change:<신청 id>`
 * - 관리자 직접 휴원·퇴원·복귀(updateEnrollmentStatus): 키는 해시라 afterJson 의 enrollmentChangeRequestId 로 잇는다.
 *   (2026-10-06 이후 건만 연결된다. 과거 직접 변경 건은 소급하지 않는다.)
 */
const LINKED_COMMAND_SQL = `(c."idempotencyKey" = 'enrollment-change:' || r.id
      OR c."afterJson"->>'enrollmentChangeRequestId' = r.id)`;

/**
 * 사이트에는 자동 적용됐지만 시트·랠리즈 확인이 안 끝난 건(별칭 r = 신청).
 * 보류(HELD)된 명령은 사람이 다른 경로로 정리해야 하므로 여기서도 "확인 필요"로 센다.
 * 은퇴로 건너뛴 SHEET·RALLYZ(SKIPPED)는 확인할 것이 없으므로 "확인 필요"가 아니다.
 * (2026-11-14 랠리즈 은퇴: 랠리즈 칸 SKIPPED 도 끝난 것으로 본다 — 조건은 공용 externalSyncPendingSql 하나.)
 */
// 잘못 등록 삭제로 닫은 명령(사유 DELETED_ENROLLMENT_CLOSE_REASON, 칸 SKIPPED)은 할 일이 없으므로 «확인 필요»가 아니다.
// 화면 탭·건수(countEnrollmentChangesNeedingCheck → 일일 요약 포함)가 모두 이 조건 하나를 쓴다.
const NEEDS_CHECK_SQL = `EXISTS (SELECT 1 FROM "OperationsCommand" c
    JOIN "OperationsSyncAttempt" a ON a."commandId" = c.id
   WHERE ${LINKED_COMMAND_SQL}
     AND ${notClosedByDeletedEnrollmentSql("c")}
     AND ${externalSyncPendingSql("a")})`;

/** 확인 필요 건수 — 탭 이름과 상단 경고에 쓴다. 기본 탭이 "검토 중"이어도 놓치지 않게. */
export async function countEnrollmentChangesNeedingCheck(): Promise<number> {
  const rows = await prisma.$queryRawUnsafe<Array<{ n: number }>>(
    `SELECT count(*)::int AS n FROM "EnrollmentChangeRequest" r WHERE r.status = 'APPLIED' AND ${NEEDS_CHECK_SQL}`,
  );
  return Number(rows[0]?.n ?? 0);
}

function invoicePreviewKey(row: any, proration: unknown) {
  return createHash("sha256").update(JSON.stringify({
    requestId: row.id, studentId: row.studentId, parentId: row.parentId, fromClassId: row.fromClassId,
    toClassId: row.toClassId, effectiveFrom: row.effectiveFrom, proration,
  })).digest("hex");
}

/** 반 변경 건의 일할 계산. 계획표를 못 읽었으면 계산 불가로 표시된다(추측하지 않는다). */
function buildProration(row: any, planEvents: any[]): (ProrationResult & { lines: string[] }) | null {
  if (row.kind !== "CLASS_CHANGE" || !row.fromDay || !row.toDay) return null;
  const yearMonth = String(row.effectiveFrom).slice(0, 7);
  const result = computeClassChangeProration({
    effectiveFrom: row.effectiveFrom,
    from: {
      monthlyFee: Number(row.fromFee ?? 0),
      classDates: getMonthlyClassDates(planEvents, yearMonth, row.fromDay),
    },
    to: {
      monthlyFee: Number(row.toFee ?? 0),
      classDates: getMonthlyClassDates(planEvents, yearMonth, row.toDay),
    },
  });
  return {
    ...result,
    lines: describeProration(result, {
      from: row.fromClassName ?? "기존 반",
      to: row.toClassName ?? "새 반",
    }),
  };
}

/** 휴원 승인과 함께(또는 승인 뒤) 고르는 수강료 처리. expectedPreviewKey = 원장이 본 미리보기 지문. */
export type PauseSettlementChoice = { mode: SettlementMode; expectedPreviewKey: string };

/** 처리 실패로 승인까지 되돌릴 때 쓰는 표식 오류(문구는 원장에게 그대로 보인다) */
class SettlementRejected extends Error {
  constructor(readonly userMessage: string) { super("PAUSE_SETTLEMENT_REJECTED"); }
}

type ExecutedSettlement = Extract<Awaited<ReturnType<typeof executePauseSettlementInTx>>, { ok: true }>;

export async function decideEnrollmentChangeRequest(input: {
  adminUserId: string;
  requestId: string;
  approve: boolean;
  note?: string | null;
  /** 휴원 승인 때만. 처리할 금액이 있으면 승인과 함께 선택해야 한다. */
  settlement?: PauseSettlementChoice | null;
  /**
   * true 면 «승인만» — 수강료 처리 선택을 요구하지 않고 승인한다(처리는 나중에 원장이 settlePauseTuition 으로).
   * 부원장 승인용(2026-11-14 원장 결정): 부원장은 금액을 못 보므로 이월·환불을 고를 수 없다.
   * 승인된 휴원은 수강 변경 화면에 수강료 처리 미리보기가 다시 떠서 원장이 이어서 처리한다.
   */
  deferSettlementChoice?: boolean;
}) {
  const note = (input.note ?? "").trim().slice(0, 500) || null;
  const settlementChoice = input.approve && input.settlement && !input.deferSettlementChoice ? input.settlement : null;
  const pendingKind = input.approve && !settlementChoice && !input.deferSettlementChoice && todayKst() >= PAUSE_SETTLEMENT_SINCE
    ? (await prisma.$queryRawUnsafe<Array<{ kind: string }>>(
      `SELECT kind FROM "EnrollmentChangeRequest" WHERE id = $1 AND status = 'PENDING'`, input.requestId,
    ))[0]?.kind
    : null;
  const mustCheckChoice = pendingKind === "PAUSE";
  // 일정은 잠금을 잡기 전에 읽고, 청구는 거래 안에서 잠근 뒤 다시 읽는다.
  const classDatesFor = settlementChoice || mustCheckChoice ? await loadClassDatesFor() : null;
  // 콜백 안에서 채우므로 객체로 둔다(let 이면 TS 가 콜백 밖에서 null 로만 본다)
  const holder: { settled: ExecutedSettlement | null } = { settled: null };
  let rows: any[];
  try {
  rows = await prisma.$transaction(async (tx) => {
  if (classDatesFor) await lockPauseSettlement(tx, input.requestId);
  if (mustCheckChoice && classDatesFor) {
    const preview = await previewPauseSettlement(tx, input.requestId, classDatesFor, true);
    if (preview?.tablesReady && settlementChoiceRequired(preview.plan)) {
      throw new SettlementRejected(SETTLEMENT_CHOICE_REQUIRED_MESSAGE);
    }
  }
  const decided = await tx.$queryRawUnsafe<any[]>(
    // 결정과 결정 기록(감사 로그)은 함께 저장한다.
    `UPDATE "EnrollmentChangeRequest"
        SET status = $2, "decidedByUserId" = $3, "decidedAt" = now(),
            "decisionNote" = $4, "updatedAt" = now()
      WHERE id = $1 AND status = 'PENDING'
      RETURNING id, "studentId", kind, to_char("effectiveFrom",'YYYY-MM-DD') AS "effectiveFrom"`,
    input.requestId, input.approve ? "APPROVED" : "REJECTED", input.adminUserId, note,
  );
  // 2026-11-10 원장 결정 d6: 결정 알림을 더는 보류(HELD)하지 않는다 — 신청한 학부모에게 앱 알림(인앱+웹푸시)만 보낸다.
  // 문자·알림톡은 보내지 않는다. 발송은 트랜잭션이 끝난 뒤(아래) — 알림 실패가 결정을 되돌리면 안 된다.
  if (decided[0]) await tx.operationsAuditLog.create({ data: {
    action: "ENROLLMENT_CHANGE_DECIDED", actorType: "ADMIN", actorUserId: input.adminUserId,
    detailsJson: { requestId: input.requestId, studentId: decided[0].studentId,
      kind: decided[0].kind, approved: input.approve, effectiveFrom: decided[0].effectiveFrom,
      notificationChannel: "APP_ONLY" },
  }});
  // 휴원 수강료 처리(2026-11-10 m6) — 승인과 «같은 트랜잭션». 처리가 막히면 승인도 되돌린다(원장이 확인한 뒤 다시 승인).
  if (decided[0] && settlementChoice && classDatesFor) {
    if (decided[0].kind !== "PAUSE") throw new SettlementRejected("수강료 처리는 휴원 신청에만 고를 수 있어요.");
    const result = await executePauseSettlementInTx(tx as any, {
      requestId: input.requestId, adminUserId: input.adminUserId,
      mode: settlementChoice.mode, expectedPreviewKey: settlementChoice.expectedPreviewKey, classDatesFor, decidedSince: PAUSE_SETTLEMENT_SINCE,
    });
    if (!result.ok) throw new SettlementRejected(result.message);
    holder.settled = result;
  }
  return decided;
  }, { timeout: 30_000 });
  } catch (error) {
    const rejected = settlementErrorMessage(error);
    if (rejected === SETTLEMENT_CHOICE_REQUIRED_MESSAGE) {
      return { ok: false as const, message: rejected, needsSettlementChoice: true as const };
    }
    if (rejected) return { ok: false as const, message: rejected };
    throw error;
  }
  if (!rows[0]) return { ok: false as const, message: "이미 처리된 신청입니다." };

  // 커밋 뒤: 토스 부분 취소 실행 → 이월 차감. 알림 문구가 처리 기록(이월·환불 예정)을 읽으므로 알림보다 먼저.
  const settlementResult = holder.settled ? await finishSettlement(holder.settled, input.adminUserId) : null;

  // 학부모 앱 알림 — 신청자가 지금도 그 학생 보호자일 때만(관리자 직접 변경은 건너뜀). 중복 키로 한 번만.
  const notificationStatus = await notifyParentOfEnrollmentChange(input.requestId, input.approve ? "APPROVED" : "REJECTED");

  // 적용일이 이미 지났으면(예: 늦게 승인) 바로 반영한다. 크론과 겹쳐도 신청 행 잠금으로 한 번만 적용된다.
  // (반영되면 그 안에서 «휴원이 시작됐어요» 알림이 따로 나간다.)
  const summary = input.approve ? await applyDueEnrollmentChangesWithSummary() : null;
  return {
    ok: true as const,
    appliedNow: Boolean(summary?.appliedIds.includes(input.requestId)),
    // 이번 처리에서 사이트에 적용된 전체 건수(밀린 다른 신청 포함). 캐시를 비울지 판단하는 데 쓴다.
    appliedCount: summary?.applied ?? 0,
    notificationStatus,
    settlement: settlementResult,
  };
}

/** 처리 막힘(문구 그대로 보여 줄 것)·청구 경합이면 원장용 문구, 그 밖의 오류면 null(그대로 던진다) */
function settlementErrorMessage(error: unknown): string | null {
  if (error instanceof SettlementRejected) return error.userMessage;
  if (error instanceof Error && ["PAUSE_SETTLEMENT_PAYMENT_CONFLICT", "PAUSE_SETTLEMENT_SCOPE_CHANGED"].includes(error.message)) {
    return "그 사이 청구가 바뀌었어요. 새로고침해 금액을 다시 확인해 주세요.";
  }
  return null;
}

/** 연간 일정을 읽어 «반 요일·수강월 → 수업일» 함수로(청구·/annual 과 같은 getMonthlyClassDates) */
async function loadClassDatesFor(): Promise<ClassDatesFor> {
  const planEvents = await loadAnnualPlanEvents().catch(() => []);
  return (ym, dow) => getMonthlyClassDates(planEvents, ym, dow);
}

export type SettlementOutcome = {
  mode: SettlementMode;
  paidTotal: number;
  unpaidTotal: number;
  refund: RefundRunSummary | null;
  carryApplied: number;
};

/** 커밋 뒤 이어지는 동작: 토스 부분 취소(트랜잭션 밖) → 이월 차감(다음 미납 청구) */
async function finishSettlement(settled: ExecutedSettlement, adminUserId: string): Promise<SettlementOutcome> {
  let refund: RefundRunSummary | null = null;
  if (settled.refundJobs.length > 0) {
    const { partialRefundTossPaymentByAdmin } = await import("@/lib/payment-ledger");
    refund = await runSettlementTossRefunds(prisma, { settlementId: settled.settlementId, adminUserId, refundToss: partialRefundTossPaymentByAdmin });
  }
  let carryApplied = 0;
  if (settled.mode === "CARRY" && settled.paidTotal > 0) {
    carryApplied = (await applyOpenPauseCarries(prisma as any, { studentId: settled.studentId }).catch((error) => {
      console.error("[admin-change-request] 이월 차감 실패(다음 크론에서 다시)", error instanceof Error ? error.name : "");
      return { applied: 0, amount: 0 };
    })).amount;
  }
  return { mode: settled.mode, paidTotal: settled.paidTotal, unpaidTotal: settled.unpaidTotal, refund, carryApplied };
}

/**
 * 이미 승인된 휴원의 수강료 처리(승인 때 고르지 않았거나 신청함에서 승인만 한 건). 원장 화면 «수강료 처리» 버튼.
 * 처리 실행·잠금·재계산은 승인 때와 같은 executePauseSettlementInTx. 학부모에게는 «SETTLED» 앱 알림 한 번.
 */
export async function settleApprovedPause(input: { adminUserId: string; requestId: string; settlement: PauseSettlementChoice }) {
  const classDatesFor = await loadClassDatesFor();
  let settled: ExecutedSettlement;
  try {
    settled = await prisma.$transaction(async (tx) => {
      const result = await executePauseSettlementInTx(tx as any, {
        requestId: input.requestId, adminUserId: input.adminUserId,
        mode: input.settlement?.mode, expectedPreviewKey: input.settlement?.expectedPreviewKey, classDatesFor, decidedSince: PAUSE_SETTLEMENT_SINCE,
      });
      // 처리 실패면 트랜잭션 전체를 되돌린다(감액 일부만 남지 않게)
      if (!result.ok) throw new SettlementRejected(result.message);
      return result;
    }, { timeout: 30_000 });
  } catch (error) {
    const rejected = settlementErrorMessage(error);
    if (rejected) return { ok: false as const, message: rejected };
    throw error;
  }
  const outcome = await finishSettlement(settled, input.adminUserId);
  // 승인 알림은 이미 나갔다 → 처리 결과만 따로(«없음»이면 보낼 말이 없어 안에서 건너뛴다)
  const notificationStatus = await notifyParentOfEnrollmentChange(input.requestId, "SETTLED");
  return { ok: true as const, settlement: outcome, notificationStatus };
}

/** 토스 부분 취소 다시 시도(결과 확인 중·실패 줄). 같은 줄은 같은 표식·멱등 키라 두 번 취소되지 않는다. */
export async function retryPauseSettlementRefunds(input: { adminUserId: string; settlementId: string }) {
  const { partialRefundTossPaymentByAdmin } = await import("@/lib/payment-ledger");
  const refund = await runSettlementTossRefunds(prisma, { settlementId: input.settlementId, adminUserId: input.adminUserId, refundToss: partialRefundTossPaymentByAdmin });
  return { ok: true as const, refund };
}

/**
 * 적용일이 된 승인 건을 처리한다(매일 크론 + 늦게 승인한 직후).
 *
 * 원장 결정(2026-10-05, 선택지 A):
 * - 휴원(PAUSE)·퇴원(WITHDRAW): 사이트 수강 상태를 바로 바꾸고, 운영 원장에는
 *   홈페이지=완료 / 시트·랠리즈=확인 필요(PENDING)로 남긴다. 관리자 즉시 변경(updateEnrollmentStatus)과 같은 모델이다.
 * - 반 변경(CLASS_CHANGE)·예상 밖 상태: 지금처럼 3개 시스템 검증 대기(HELD) 원장만 만든다.
 *
 * 이중 적용 방지: 신청 행 FOR UPDATE 잠금 → 조건 재확인 → idempotencyKey(`enrollment-change:<id>`) 유일 제약.
 * 승인 직후 호출과 크론이 동시에 돌아도, 늦은 쪽은 잠금이 풀린 뒤 "이미 처리됨"으로 빠진다.
 */
export type DueEnrollmentChangeSummary = { applied: number; held: number; appliedIds: string[] };

export async function applyDueEnrollmentChangesWithSummary(): Promise<DueEnrollmentChangeSummary> {
  const due = await prisma.$queryRawUnsafe<{ id: string }[]>(
    `SELECT id FROM "EnrollmentChangeRequest" r WHERE status = 'APPROVED'
      AND "appliedAt" IS NULL AND "effectiveFrom" <= (now() AT TIME ZONE 'Asia/Seoul')::date
      AND NOT EXISTS (SELECT 1 FROM "OperationsCommand" c
        WHERE c."idempotencyKey" = 'enrollment-change:' || r.id)
      ORDER BY "effectiveFrom" LIMIT 200`,
  );
  const summary: DueEnrollmentChangeSummary = { applied: 0, held: 0, appliedIds: [] };
  for (const candidate of due) {
    try {
    const outcome = await prisma.$transaction(async (tx) => {
      // 신청 행을 잠그고 조건을 다시 본다. 다른 실행이 먼저 적용했으면 status 가 APPLIED 라 여기서 빠진다.
      const rows = await tx.$queryRawUnsafe<any[]>(
        `SELECT *, to_char("effectiveFrom", 'YYYY-MM-DD') AS "effectiveDate"
         FROM "EnrollmentChangeRequest" WHERE id = $1 AND status = 'APPROVED'
         AND "appliedAt" IS NULL FOR UPDATE`, candidate.id);
      const row = rows[0];
      if (!row) return "SKIPPED" as const;
      const key = `enrollment-change:${row.id}`;
      if (await tx.operationsCommand.findUnique({ where: { idempotencyKey: key } })) return "SKIPPED" as const;
      // 수강 행도 잠근다. 관리자가 같은 순간 상태를 바꿔도 아래 조건부 UPDATE 와 엇갈리지 않는다.
      const enrollmentRows = await tx.$queryRawUnsafe<Array<{ id: string; studentId: string; classId: string; status: string; className: string }>>(
        `SELECT e.id, e."studentId", e."classId", e.status, c.name AS "className"
           FROM "Enrollment" e JOIN "Class" c ON c.id = e."classId"
          WHERE e.id = $1 FOR UPDATE OF e`, row.enrollmentId);
      const enrollment = enrollmentRows[0] ?? null;
      const student = await tx.student.findUnique({ where: { id: row.studentId }, select: { parentId: true, name: true } });
      // 본인 자녀로 제출한 동일 요청만 학부모 확인 근거로 인정한다.
      let parentConfirmed = Boolean(student?.parentId && student.parentId === row.requestedByUserId);
      if (!parentConfirmed && await childConnectionsAvailable()) {
        const linked = await tx.$queryRawUnsafe<{ id: string }[]>(`SELECT s.id FROM "Student" s WHERE s.id=$1 AND ${await childAccessSql("s", "$2")} AND s."mergedIntoStudentId" IS NULL`, row.studentId, row.requestedByUserId);
        parentConfirmed = linked.length === 1;
      }
      let classChangeProblem: string | null = null;
      if (row.kind === "CLASS_CHANGE" && enrollment) {
        const target = row.toClassId ? await tx.class.findUnique({
          where: { id: row.toClassId }, include: { program: true, _count: { select: { enrollments: { where: { status: "ACTIVE" } } } } },
        }) : null;
        if (!target || target.program.deletedAt || target.id === row.fromClassId) classChangeProblem = "희망 반이 유효하지 않음";
        else if (target._count.enrollments >= target.capacity) classChangeProblem = "희망 반 정원 초과: 관리자 재확인 필요";
      }
      // 적용/보류 판정은 순수 함수 한 곳에서 한다(테스트가 실제로 실행해 확인).
      const plan = planDueEnrollmentChange({
        kind: row.kind, studentId: row.studentId, fromClassId: row.fromClassId,
        enrollment, parentConfirmed, classChangeProblem,
      });
      const actor = row.decidedByUserId;
      if (!actor) throw new Error("수강 변경 승인자 누락");

      if (plan.action === "APPLY" && enrollment) {
        // 기대 상태일 때만 바꾼다(조건부 UPDATE). 0건이면 그 사이 누가 바꾼 것이므로 거래 전체를 되돌린다.
        const changed = await tx.$executeRawUnsafe(
          `UPDATE "Enrollment" SET status = $2, "updatedAt" = now() WHERE id = $1 AND status = $3`,
          enrollment.id, plan.nextStatus, plan.expectedStatus);
        if (changed !== 1) throw new Error("ENROLLMENT_STATUS_CONFLICT");
        // 관리자 즉시 변경과 같은 의미: 사이트 반영 완료 = APPLIED + appliedAt.
        const marked = await tx.$executeRawUnsafe(
          `UPDATE "EnrollmentChangeRequest" SET status = 'APPLIED', "appliedAt" = now(), "updatedAt" = now()
            WHERE id = $1 AND status = 'APPROVED' AND "appliedAt" IS NULL`, row.id);
        if (marked !== 1) throw new Error("CHANGE_REQUEST_CONFLICT");
        await insertAutoAppliedLedger(tx, {
          key, row, actor, studentName: student?.name ?? null, enrollment, nextStatus: plan.nextStatus,
        });
        return "APPLIED" as const;
      }

      // 반 변경·예상 밖 상태는 사이트를 건드리지 않고 HELD 원장만 남긴다(기존 동작 그대로).
      const reason = plan.action === "HOLD" ? plan.reason : DEFAULT_HOLD_REASON;
      await tx.operationsRequest.create({ data: {
        sourceText: `수강 변경 신청 ${row.id}`, targetMonth: row.effectiveDate.slice(0, 7),
        status: "HELD", requestedByUserId: actor,
        commands: { create: {
          idempotencyKey: key, sourceText: `수강 변경 신청 ${row.id}`,
          studentId: row.studentId, studentName: student?.name ?? null, kind: row.kind, effectiveMonth: row.effectiveDate.slice(0, 7),
          confidence: "HIGH", status: "HELD", holdReason: reason,
          beforeJson: { enrollmentId: row.enrollmentId, classId: enrollment?.classId ?? null, status: enrollment?.status ?? null },
          afterJson: { enrollmentChangeRequestId: row.id, fromClassId: row.fromClassId,
            toClassId: row.toClassId, parentConfirmed, effectiveDate: row.effectiveDate },
          billingStatus: "HELD", notificationStatus: "HELD",
          // 시트·랠리즈 은퇴(기본) 상태면 그 칸은 처음부터 SKIPPED(+표식). 홈페이지는 PENDING(사이트 반영이 남았다).
          syncAttempts: { create: ["SHEET", "RALLYZ", "WEBSITE"].map(target => ({ target, ...initialSyncAttempt(target, isSheetSyncRetired(process.env), isRallyzSyncRetired(process.env)) })) },
        }},
        auditLogs: { create: { action: "ENROLLMENT_CHANGE_SYNC_HELD", actorType: "ADMIN", actorUserId: actor,
          detailsJson: { enrollmentChangeRequestId: row.id, reason } } },
      }});
      return "HELD" as const;
    });
    if (outcome === "APPLIED") {
      summary.applied += 1;
      summary.appliedIds.push(candidate.id);
      // 적용일에 실제로 바뀐 순간 학부모에게 «휴원이 시작됐어요» 앱 알림. 실패는 안에서 삼킨다(적용은 이미 끝났다).
      await notifyParentOfEnrollmentChange(candidate.id, "APPLIED");
    } else if (outcome === "HELD") summary.held += 1;
    } catch {
      // 한 건이 실패해도 나머지는 계속한다. 실패한 건은 그대로 APPROVED 라 다음 크론에서 다시 시도된다.
      // 개인정보나 원문 오류는 로그에 남기지 않는다.
      console.error("[applyDueEnrollmentChanges] 적용 또는 운영 원장 등록 실패", candidate.id);
    }
  }
  return summary;
}

/** 실제로 사이트에 적용한 건수를 돌려준다(보류 원장 작성은 세지 않는다). */
export async function applyDueEnrollmentChanges(): Promise<number> {
  return (await applyDueEnrollmentChangesWithSummary()).applied;
}

type RawTx = {
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
};

/**
 * 자동 적용한 휴원·퇴원을 운영 원장에 남긴다.
 * 홈페이지 = 이미 완료(SUCCEEDED),
 * 시트 = 은퇴 상태(기본)면 건너뜀(SKIPPED·SHEET_RETIRED), 스위치를 "0" 으로 되돌리면 확인 필요(PENDING).
 * 랠리즈 = 은퇴 상태(기본, 2026-11-14)면 건너뜀(SKIPPED·RALLYZ_RETIRED), 스위치를 "0" 으로 되돌리면 확인 필요(PENDING).
 * 둘 다 건너뜀이면 남은 확인이 없으므로 요청·명령을 처음부터 끝난 상태(SYNCED)로 만든다.
 * 하나라도 PENDING(옛 방식)이면 요청 APPROVED · 명령 PENDING 이라 기존 서버 액션(applyOperationsSheet → recordOperationsExternalCheck)이 그대로 동작하고,
 * 관리자는 「수강 변경 신청」 화면의 "확인 필요" 탭에서 행마다 시트 반영·랠리즈 반영 확인 버튼으로 이어간다.
 * (옛 운영 동기화 화면 /admin/operations-sync 는 폐기돼 /admin 으로 돌려보낸다.)
 * (공용 enqueueWebsiteOperationsEventInTransaction 은 키가 해시라 `enrollment-change:<id>` 를 유지할 수 없어 쓰지 않는다.)
 */
async function insertAutoAppliedLedger(tx: RawTx, input: {
  key: string;
  row: any;
  actor: string;
  studentName: string | null;
  enrollment: { id: string; classId: string; status: string; className: string };
  nextStatus: "PAUSED" | "WITHDRAWN" | "ACTIVE"; // ACTIVE = 학부모 복귀 신청 승인분
}) {
  const { key, row, actor, enrollment } = input;
  const requestId = crypto.randomUUID();
  const commandId = crypto.randomUUID();
  const month = String(row.effectiveDate).slice(0, 7);
  const sourceText = `수강 변경 신청 ${row.id}`;
  // 시트·랠리즈 은퇴(기본) 상태면 그 칸은 처음부터 SKIPPED(+표식) → 남는 확인이 없다.
  const sheetInitial = initialSyncAttempt("SHEET", isSheetSyncRetired(process.env));
  const rallyzInitial = initialSyncAttempt("RALLYZ", false, isRallyzSyncRetired(process.env));
  // 두 칸이 모두 건너뜀이면 원장은 처음부터 끝난 상태(SYNCED). 옛 방식(스위치 "0")이면 PENDING 으로 남아 사람이 확인한다.
  const ledgerStatus = websiteDoneLedgerStatus([sheetInitial.status, rallyzInitial.status]);
  // 시트 반영(applyOperationsSheet)이 읽는 키: fromClassId · effectiveDate · parentConfirmed
  const base = { enrollmentChangeRequestId: row.id, fromClassId: row.fromClassId, toClassId: row.toClassId,
    parentConfirmed: true, effectiveDate: row.effectiveDate };
  await tx.$executeRawUnsafe(
    `INSERT INTO "OperationsRequest"
      (id,"sourceText","targetMonth",status,"requestedByUserId","approvedByUserId","approvedAt","submittedAt")
     VALUES ($1,$2,$3,$5,$4,$4,now(),now())`,
    requestId, sourceText, month, actor, ledgerStatus === "SYNCED" ? "SYNCED" : "APPROVED",
  );
  // idempotencyKey 는 `enrollment-change:<id>` 그대로. 유일 제약이 마지막 이중 적용 방어선이다.
  await tx.$executeRawUnsafe(
    `INSERT INTO "OperationsCommand"
      (id,"requestId","idempotencyKey","sourceText","studentId","studentName",kind,"effectiveMonth",confidence,status,
       "holdReason","beforeJson","afterJson","billingStatus","notificationStatus")
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'HIGH',$11,NULL,$9::jsonb,$10::jsonb,'HELD','HELD')`,
    commandId, requestId, key, sourceText, row.studentId, input.studentName, row.kind, month,
    JSON.stringify({ ...base, enrollmentId: enrollment.id, classId: enrollment.classId, status: enrollment.status,
      enrollments: [{ id: enrollment.id, status: enrollment.status, className: enrollment.className }] }),
    JSON.stringify({ ...base, autoAppliedWebsite: true,
      enrollments: [{ id: enrollment.id, status: input.nextStatus, className: enrollment.className }] }),
    ledgerStatus,
  );
  for (const target of ["SHEET", "RALLYZ", "WEBSITE"]) {
    const websiteDone = target === "WEBSITE";
    const initial = target === "SHEET" ? sheetInitial : target === "RALLYZ" ? rallyzInitial : initialSyncAttempt(target, false);
    await tx.$executeRawUnsafe(
      `INSERT INTO "OperationsSyncAttempt" (id,"commandId",target,status,attempts,"verifiedAt","externalReference")
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      crypto.randomUUID(), commandId, target,
      websiteDone ? "SUCCEEDED" : initial.status, websiteDone ? 1 : 0, websiteDone ? new Date() : null,
      websiteDone ? null : initial.externalReference,
    );
  }
  await tx.$executeRawUnsafe(
    `INSERT INTO "OperationsAuditLog" (id,"requestId",action,"actorType","actorUserId","detailsJson")
     VALUES ($1,$2,'ENROLLMENT_CHANGE_AUTO_APPLIED','SYSTEM',$3,$4::jsonb)`,
    crypto.randomUUID(), requestId, actor,
    JSON.stringify({ enrollmentChangeRequestId: row.id, commandId, enrollmentId: enrollment.id,
      from: enrollment.status, to: input.nextStatus, sheet: sheetInitial.status, rallyz: rallyzInitial.status, notificationsSent: false }),
  );
}

/**
 * 반 변경 차액 청구서를 발행한다(원장이 눌러야 발행된다 — 원장 결정).
 *
 * 금액은 화면이 보낸 값을 쓰지 않고 **여기서 다시 계산한다.** 화면 값을 믿으면
 * 브라우저에서 숫자를 바꿔 원하는 금액으로 청구서를 만들 수 있다.
 */
export async function issueProrationInvoice(input: { adminUserId: string; requestId: string; expectedPreviewKey: string }) {
  // 네트워크 일정 조회는 잠금 전에 마치고, 생성과 연결은 하나의 거래로 묶는다.
  const planEvents = await loadAnnualPlanEvents().catch(() => []);
  return prisma.$transaction(async (tx) => {
  const rows = await tx.$queryRawUnsafe<any[]>(
    `SELECT r.id, r.kind, r."studentId", s."parentId", r."fromClassId", r."toClassId", r."invoicedPaymentId", r.status,
            to_char(r."effectiveFrom",'YYYY-MM-DD') AS "effectiveFrom",
            fc.name AS "fromClassName", tc.name AS "toClassName",
            fc."dayOfWeek" AS "fromDay", tc."dayOfWeek" AS "toDay",
            fp.price AS "fromFee", tp.price AS "toFee"
       FROM "EnrollmentChangeRequest" r
       JOIN "Student" s ON s.id = r."studentId"
       LEFT JOIN "Class" fc ON fc.id = r."fromClassId"
       LEFT JOIN "Class" tc ON tc.id = r."toClassId"
       LEFT JOIN "Program" fp ON fp.id = fc."programId"
       LEFT JOIN "Program" tp ON tp.id = tc."programId"
      WHERE r.id = $1 LIMIT 1 FOR UPDATE OF r, s`,
    input.requestId,
  );
  const row = rows[0];
  if (!row) return { ok: false as const, message: "신청을 찾을 수 없습니다." };
  if (row.status !== "APPROVED") return { ok: false as const, message: "승인된 신청만 청구할 수 있습니다." };
  // 두 번 누르면 학부모에게 같은 금액이 두 번 청구된다.
  if (row.invoicedPaymentId) return { ok: false as const, message: "이미 차액 청구서를 발행했습니다." };

  const proration = buildProration(row, planEvents);
  if (!input.expectedPreviewKey || input.expectedPreviewKey !== invoicePreviewKey(row, proration)) {
    return { ok: false as const, message: "미리보기 이후 금액·일정·대상이 변경되었습니다. 새로고침 후 다시 확인해 주세요." };
  }
  if (!proration) return { ok: false as const, message: "반 변경 건만 차액을 청구할 수 있습니다." };
  if (proration.scheduleUnavailable) {
    return { ok: false as const, message: "연간 계획표에 그달 수업일이 없어 자동 계산할 수 없습니다." };
  }
  if (proration.diff <= 0) {
    // 원장 결정: 마이너스는 다음 달 청구에서 차감한다. 환불 청구서를 만들지 않는다.
    return { ok: false as const, message: "추가로 받을 금액이 없습니다. 다음 달 청구에서 차감해 주세요." };
  }

  const [year, month] = proration.yearMonth.split("-").map(Number);
  const description =
    `반 변경 차액 (${proration.yearMonth} · ${row.fromClassName ?? "기존 반"} → ${row.toClassName ?? "새 반"})`;

  const created = await tx.$queryRawUnsafe<{ id: string }[]>(
    // classId 는 비운다. 적용일 전까지 학생은 아직 새 반 소속이 아니라서
    // 반 기준 검증·집계에 잘못 잡힌다. 어느 반 사이인지는 description 에 남긴다.
    `INSERT INTO "Payment" (id, "studentId", "classId", amount, status, "dueDate", year, month, type, description, "createdAt", "updatedAt")
     VALUES (gen_random_uuid()::text, $1, NULL, $2, 'PENDING', $3::timestamp, $4, $5, 'MONTHLY', $6, NOW(), NOW())
     RETURNING id`,
    row.studentId, proration.diff, row.effectiveFrom, year, month, description,
  );

  await tx.$executeRawUnsafe(
    `UPDATE "EnrollmentChangeRequest" SET "invoicedPaymentId" = $2, "updatedAt" = now() WHERE id = $1`,
    input.requestId, created[0].id,
  );

  const invoice = await tx.paymentInvoice.create({ data: {
    paymentId: created[0].id, studentId: row.studentId, parentId: row.parentId,
    invoiceNo: `STIZ-CHANGE-${row.id}`, status: "ISSUED", amount: proration.diff,
    title: description, description,
    dueDate: new Date(`${row.effectiveFrom}T00:00:00+09:00`),
  }});
  await tx.paymentAuditLog.create({ data: {
    paymentId: created[0].id, invoiceId: invoice.id, actorType: "ADMIN", actorId: input.adminUserId,
    action: "ENROLLMENT_PRORATION_INVOICE_ISSUED",
    message: "승인된 미리보기 기준 사이트 차액 청구서 생성. 외부 동기화 및 알림 별도 승인 대기",
    metadata: { requestId: row.id, previewKey: input.expectedPreviewKey, amount: proration.diff,
      notificationStatus: "HELD", sheetStatus: "PENDING", rallyzStatus: "PENDING" },
  }});

  return { ok: true as const, paymentId: created[0].id, amount: proration.diff,
    invoiceId: invoice.id, invoiceStatus: "ISSUED" as const, notificationStatus: "HELD" as const };
  });
}

// ── 승인된 휴원·퇴원의 학부모 «취소 요청» 처리 (2026-11-10 원장 결정 d8) ─────────────────────
//
// 학부모가 수업 탭 타임라인에서 [취소 요청]을 누르면 대상 신청의 cancelRequestStatus 가 PENDING 이 된다
// (새 행이 아니라 대상 신청의 칸 — 적용일 크론·목록·유일 제약이 아무것도 몰라도 되게).
// 원장 승인 = 대상 신청 APPROVED → CANCELED (적용 전·적용일 > KST 오늘에만, 한 문장 UPDATE 의 WHERE 로).
//   적용일 크론은 status='APPROVED' 행만 잠가 반영하므로, 여기서 먼저 CANCELED 가 되면 크론은 건너뛴다.
// 원장 거절 = 취소 요청만 REJECTED, 원래 승인은 그대로 간다.
// 결과는 1단계 알림 경로(앱 알림)로 취소를 요청한 보호자에게.

export type AdminCancelRequestRow = {
  id: string;
  studentName: string;
  kind: string;
  kindLabel: string;
  fromClassName: string | null;
  effectiveFrom: string;
  resumeOn: string | null;
  requestedAt: string | null;
  reason: string | null;
  /** 적용일이 이미 왔거나 반영됐다 — 승인(취소)은 못 하고 거절만 할 수 있다 */
  tooLate: boolean;
};

/** 처리할 취소 요청 목록. 마이그레이션 전이면(칸 없음) 부르는 쪽이 빈 목록으로 받는다. */
export async function getEnrollmentCancelRequests(requestIds: string[] | null = null): Promise<AdminCancelRequestRow[]> {
  const rows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT r.id, s.name AS "studentName", r.kind, fc.name AS "fromClassName",
            to_char(r."effectiveFrom",'YYYY-MM-DD') AS "effectiveFrom",
            to_char(r."resumeOn",'YYYY-MM-DD') AS "resumeOn",
            to_char(r."cancelRequestedAt" AT TIME ZONE 'Asia/Seoul','YYYY-MM-DD HH24:MI') AS "requestedAt",
            r."cancelRequestReason" AS reason,
            (r.status <> 'APPROVED' OR r."appliedAt" IS NOT NULL
              OR r."effectiveFrom" <= (now() AT TIME ZONE 'Asia/Seoul')::date) AS "tooLate"
       FROM "EnrollmentChangeRequest" r
       JOIN "Student" s ON s.id = r."studentId" AND ${notMergedStudent("s")}
       LEFT JOIN "Class" fc ON fc.id = r."fromClassId"
      WHERE r."cancelRequestStatus" = 'PENDING'
        AND ($1::text[] IS NULL OR r.id = ANY($1::text[]))
      ORDER BY r."effectiveFrom", r."cancelRequestedAt"
      LIMIT 100`,
    requestIds,
  );
  return rows.map((row) => ({
    id: row.id,
    studentName: row.studentName,
    kind: row.kind,
    kindLabel: CHANGE_KIND_LABEL[row.kind as ChangeKind] ?? row.kind,
    fromClassName: row.fromClassName ?? null,
    effectiveFrom: row.effectiveFrom,
    resumeOn: row.resumeOn ?? null,
    requestedAt: row.requestedAt ?? null,
    reason: row.reason ?? null,
    tooLate: Boolean(row.tooLate),
  }));
}

export async function decideEnrollmentCancelRequest(input: {
  adminUserId: string;
  requestId: string;
  approve: boolean;
  note?: string | null;
}) {
  const note = (input.note ?? "").trim().slice(0, 500) || null;
  const blocked = { movedMoney: false };
  const rows = await prisma.$transaction(async (tx) => {
    // 휴원 수강료 처리(환불·이월·감액)가 이미 실행된 휴원은 «취소 승인»으로 되돌리지 않는다 — 돈이 이미 움직였다.
    // 신청 행을 먼저 잠근 뒤 확인한다 — 처리 실행(executePauseSettlementInTx)도 같은 행을 잠그므로 둘이 엇갈리지 않는다.
    if (input.approve) {
      await tx.$queryRawUnsafe(`SELECT id FROM "EnrollmentChangeRequest" WHERE id = $1 FOR UPDATE`, input.requestId);
      if (await hasMovedMoneySettlement(tx as any, input.requestId)) {
        blocked.movedMoney = true;
        return [];
      }
    }
    const decided = input.approve
      // 승인 = 대상 신청 취소. 적용 전·적용일 > KST 오늘·아직 운영 원장(적용 명령)이 없을 때만.
      ? await tx.$queryRawUnsafe<any[]>(
          `UPDATE "EnrollmentChangeRequest" r
              SET status = 'CANCELED', "cancelRequestStatus" = 'APPROVED', "cancelDecisionNote" = $3, "updatedAt" = now()
            WHERE r.id = $1 AND r."cancelRequestStatus" = 'PENDING'
              AND r.status = 'APPROVED' AND r."appliedAt" IS NULL
              AND r.kind IN ('PAUSE','WITHDRAW')
              AND r."effectiveFrom" > (now() AT TIME ZONE 'Asia/Seoul')::date
              AND NOT EXISTS (SELECT 1 FROM "OperationsCommand" c WHERE c."idempotencyKey" = 'enrollment-change:' || r.id)
            RETURNING r.id, r."studentId", r.kind, to_char(r."effectiveFrom",'YYYY-MM-DD') AS "effectiveFrom", $2::text AS "adminUserId"`,
          input.requestId, input.adminUserId, note,
        )
      // 거절 = 취소 요청만 닫는다(원래 승인 그대로)
      : await tx.$queryRawUnsafe<any[]>(
          `UPDATE "EnrollmentChangeRequest" r
              SET "cancelRequestStatus" = 'REJECTED', "cancelDecisionNote" = $3, "updatedAt" = now()
            WHERE r.id = $1 AND r."cancelRequestStatus" = 'PENDING'
            RETURNING r.id, r."studentId", r.kind, to_char(r."effectiveFrom",'YYYY-MM-DD') AS "effectiveFrom", $2::text AS "adminUserId"`,
          input.requestId, input.adminUserId, note,
        );
    if (decided[0]) await tx.operationsAuditLog.create({ data: {
      action: "ENROLLMENT_CHANGE_CANCEL_DECIDED", actorType: "ADMIN", actorUserId: input.adminUserId,
      detailsJson: { requestId: input.requestId, studentId: decided[0].studentId, kind: decided[0].kind,
        approved: input.approve, effectiveFrom: decided[0].effectiveFrom, notificationChannel: "APP_ONLY" },
    }});
    return decided;
  });
  if (blocked.movedMoney) {
    return { ok: false as const, message: "이 휴원은 수강료 처리(환불·이월·감액)가 이미 실행돼 여기서 취소할 수 없어요. 수강료를 먼저 정리한 뒤 학원에서 직접 처리해 주세요." };
  }
  if (!rows[0]) {
    return {
      ok: false as const,
      message: input.approve
        ? "취소할 수 없습니다. 적용일이 이미 왔거나 반영됐거나, 이미 처리된 요청입니다."
        : "이미 처리된 요청입니다.",
    };
  }
  const notificationStatus = await notifyParentOfEnrollmentChange(input.requestId, input.approve ? "CANCEL_APPROVED" : "CANCEL_REJECTED");
  return { ok: true as const, notificationStatus };
}
