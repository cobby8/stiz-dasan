// 출석부에서 «결석 · 질병·부상»을 표시하는 규칙 — 코치 출석부·관리자 출결 화면이 이 파일 하나를 쓴다.
//
// 왜 필요한가(2026-11-09 원장 승인 «출석 체크 시 질병, 부상 결석 체크 기능 추가»):
//   청구 작업대의 결석 이월(src/lib/billing/workbench-absence.ts)은 RegularAbsence 의 reason='ILLNESS_INJURY'
//   를 보고 «이월 검토 추천»을 띄운다. 그런데 그 행은 학부모 사전 신고로만 생겨서, 당일 아파서 빠진 아이는
//   선생님이 결석을 찍어도 이월 후보에 잡히지 않았다.
//   → 출석부에서 결석을 고를 때 «질병·부상»을 표시하면 같은 테이블·같은 값으로 저장한다(새 컬럼 없음).
//
// 규칙:
//   · 결석 + 질병·부상 표시  → RegularAbsence(학생·반·날짜) 를 reason='ILLNESS_INJURY' 로 만든다(취소된 행이면 되살린다).
//       코치가 찍으면 status='REPORTED'(원장이 결석 관리에서 확정), 관리자가 찍으면 바로 'CONFIRMED'.
//   · 출석·지각으로 바꾸거나 표시를 끄면 → 출석부가 만든 행만 'CANCELLED'(사유도 지워짐).
//   · 학부모가 직접 신고한 행은 출석부가 고치지 않는다(학부모 사유를 덮어쓰면 되돌릴 근거가 사라진다).
//   · 이미 청구 작업대에서 이월·보강으로 정산된 결석이면 손대지 않는다(정산 근거가 바뀌면 이중 보상 위험).
//   이월 적용 자체는 기존대로 원장이 작업대에서 «증빙 확인»을 눌러야 된다 — 여기서는 후보만 만든다.
//
// 출석부가 만든 행의 표시: note = SHEET_ABSENCE_NOTE 이고 reportedByUserId 가 비어 있다.
//   (학부모가 같은 날을 다시 신고하면 reportedByUserId 가 채워져 학부모 행으로 넘어간다)
//
// DB 접근은 인자로 받은 db(트랜잭션) 로만 한다 — 테스트가 가짜 db 로 실제 실행해 본다.
import { lockCompensation } from "@/lib/billing/absence-compensation-guard";
import { isKstYmd } from "@/lib/datetime/kst";
import { holdCreditForIllnessInTx, illnessReviewReady } from "@/lib/regular/illness-carry-tx";

/** 출석부가 만든 결석 행 표시(관리자 결석 관리 화면에서도 출처를 알 수 있게 사람이 읽는 문장). */
export const SHEET_ABSENCE_NOTE = "출석부에서 질병·부상 결석으로 표시";
/** 이월 후보가 되는 사유 값 — 학부모 신고·청구 작업대와 같은 값. */
export const SHEET_ABSENCE_REASON = "ILLNESS_INJURY";

export type AbsenceReasonDb = {
  $queryRawUnsafe<T = unknown>(sql: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(sql: string, ...values: unknown[]): Promise<number>;
};

/** 화면에 내려가는 결석 신고 상태. source=SHEET 는 출석부가 만든 것, PARENT 는 학부모 신고. */
export type AbsenceReportState = { reason: string; status: string; source: "SHEET" | "PARENT" } | null;

export type ExistingAbsence = {
  id: string;
  reason: string;
  status: string;
  note: string | null;
  reportedByUserId: string | null;
  /** 청구 작업대에서 이미 이월·보강으로 정산됐는지 */
  resolved: boolean;
};

/**
 * 결석 사유 요청 값.
 * - "ILLNESS_INJURY": 질병·부상으로 표시
 * - null: 표시 끄기
 * - undefined: 사유는 건드리지 않음(출석·지각이면 출석부가 만든 사유는 지운다)
 */
export type AbsenceReasonIntent = "ILLNESS_INJURY" | null | undefined;

export type AbsencePlanKind = "NONE" | "INSERT" | "REACTIVATE" | "CANCEL" | "BLOCKED_PARENT" | "BLOCKED_RESOLVED";

/** 출석부가 만든 결석 행인가 */
export function isSheetAbsence(row: Pick<ExistingAbsence, "note" | "reportedByUserId">): boolean {
  return row.note === SHEET_ABSENCE_NOTE && !row.reportedByUserId;
}

/** 저장된 행 → 화면 상태(취소된 행은 없는 것과 같다). */
export function absenceReportOf(row: Pick<ExistingAbsence, "reason" | "status" | "note" | "reportedByUserId"> | null): AbsenceReportState {
  if (!row || row.status === "CANCELLED") return null;
  return { reason: row.reason, status: row.status, source: isSheetAbsence(row) ? "SHEET" : "PARENT" };
}

// ── 순수 판정 ──
/** 지금 행과 출결·사유 요청을 보고 무엇을 할지 정한다. */
export function planAttendanceAbsenceReason(
  row: ExistingAbsence | null,
  attendanceStatus: string,
  intent: AbsenceReasonIntent,
): AbsencePlanKind {
  const wantIllness = attendanceStatus === "ABSENT" && intent === SHEET_ABSENCE_REASON;
  // 출석·지각이면 사유가 의미 없다 → 지운다. 결석인데 null 이면 표시를 끈 것.
  const wantClear = attendanceStatus !== "ABSENT" || intent === null;
  if (!wantIllness && !wantClear) return "NONE"; // 결석인데 사유 요청 없음(예: 결석 버튼만 다시 누름)
  const active = Boolean(row && row.status !== "CANCELLED");

  if (wantIllness) {
    if (!row) return "INSERT";
    if (!active) return row.resolved ? "BLOCKED_RESOLVED" : "REACTIVATE";
    if (isSheetAbsence(row)) return "NONE"; // 이미 출석부가 질병·부상으로 표시해 둠
    // 학부모 신고 행 — 이미 질병·부상이면 그대로 두면 되고, 다른 사유면 출석부가 바꾸지 않는다.
    return row.reason === SHEET_ABSENCE_REASON ? "NONE" : "BLOCKED_PARENT";
  }
  // 지우기: 출석부가 만든 살아있는 행만 취소한다.
  if (!row || !active || !isSheetAbsence(row)) return "NONE";
  return row.resolved ? "BLOCKED_RESOLVED" : "CANCEL";
}

async function readAbsence(
  db: AbsenceReasonDb,
  input: { studentId: string; classId: string; dateYmd: string },
  forUpdate: boolean,
): Promise<ExistingAbsence | null> {
  // 정산 테이블이 아직 없는 환경(초기 배포)도 있어 존재를 먼저 본다(absence-compensation-guard 와 같은 방식).
  const found = await db.$queryRawUnsafe<Array<{ found: string | null }>>(
    `SELECT to_regclass('public."BillingAbsenceResolution"')::text AS found`,
  );
  const resolvedSql = found[0]?.found
    ? `EXISTS (SELECT 1 FROM "BillingAbsenceResolution" r WHERE r."absenceId" = ra.id)`
    : `false`;
  const rows = await db.$queryRawUnsafe<ExistingAbsence[]>(
    `SELECT ra.id, ra.reason, ra.status, ra.note, ra."reportedByUserId", ${resolvedSql} AS resolved
       FROM "RegularAbsence" ra
      WHERE ra."studentId" = $1 AND ra."classId" = $2 AND ra.date = $3::date
      LIMIT 1 ${forUpdate ? "FOR UPDATE OF ra" : ""}`,
    input.studentId, input.classId, input.dateYmd,
  );
  return rows[0] ?? null;
}

/**
 * 출석부가 질병·부상으로 표시한 결석의 미사용 보강권을 거둬 둔다(검토 표가 있을 때만 — 마이그레이션 전에는 예전 그대로).
 * 표시를 끄면(출결은 결석 그대로) 뒤이어 도는 보강권 맞춤(syncCreditForRegularSession)이 같은 한 장을 되살린다
 * — 그래서 호출부는 «사유 저장 → 보강권 맞춤» 순서로 부른다.
 */
async function holdSheetIllnessCredit(db: AbsenceReasonDb, key: { studentId: string; classId: string; dateYmd: string }) {
  if (!(await illnessReviewReady(db))) return;
  // 예전에 닫힌 검토 줄(신고 취소 등)이 남아 있으면 지운다 — 닫힌 검토는 신청함에서 빠지므로, 새로 표시한 결석이 다시 «이월 검토»에 뜨게
  await db.$executeRawUnsafe(
    `DELETE FROM "RegularAbsenceCarryReview" r
      USING "RegularAbsence" ra
      WHERE ra.id = r."absenceId" AND ra."studentId" = $1 AND ra."classId" = $2 AND ra.date = $3::date
        AND r.status = 'CLOSED'`,
    key.studentId, key.classId, key.dateYmd,
  );
  await holdCreditForIllnessInTx(db, { studentId: key.studentId, classId: key.classId, absenceYmd: key.dateYmd });
}

/**
 * 출결 저장 뒤 결석 사유를 맞춘다. 반드시 트랜잭션(db) 안에서 부른다 — 보강·이월 정산과 같은 잠금을 잡는다.
 * @param confirmedByUserId 관리자가 찍었으면 그 계정(→ 바로 CONFIRMED). 코치면 null(→ REPORTED).
 * @param actorUserId 처리한 계정(취소 기록용). 없으면 null.
 */
export async function applyAttendanceAbsenceReasonInTx(
  db: AbsenceReasonDb,
  input: {
    studentId: string;
    classId: string;
    dateYmd: string;
    attendanceStatus: string;
    intent: AbsenceReasonIntent;
    confirmedByUserId?: string | null;
    actorUserId?: string | null;
  },
): Promise<{ plan: AbsencePlanKind; report: AbsenceReportState }> {
  if (!isKstYmd(input.dateYmd)) throw new Error("수업 날짜를 확인해 주세요.");
  const key = { studentId: input.studentId, classId: input.classId, dateYmd: input.dateYmd };

  // 1) 잠금 없이 먼저 본다 — 대부분의 출석 저장(전체 출석 포함)은 할 일이 없어 전역 잠금을 잡지 않게.
  const peek = await readAbsence(db, key, false);
  if (planAttendanceAbsenceReason(peek, input.attendanceStatus, input.intent) === "NONE") {
    return { plan: "NONE", report: absenceReportOf(peek) };
  }

  // 2) 바꿀 일이 있으면 정산과 같은 잠금을 잡고 행을 잠근 뒤 다시 판정한다(그 사이 정산·학부모 신고가 끼었을 수 있다).
  await lockCompensation(db);
  const row = await readAbsence(db, key, true);
  const plan = planAttendanceAbsenceReason(row, input.attendanceStatus, input.intent);
  const status = input.confirmedByUserId ? "CONFIRMED" : "REPORTED";

  if (plan === "INSERT") {
    const inserted = await db.$queryRawUnsafe<Array<{ id: string }>>(
      `INSERT INTO "RegularAbsence" ("studentId","classId",date,reason,status,note,"reportedByUserId","resolvedByUserId")
       VALUES ($1,$2,$3::date,$4,$5,$6,NULL,$7)
       ON CONFLICT ("studentId","classId","date") DO NOTHING
       RETURNING id`,
      input.studentId, input.classId, input.dateYmd, SHEET_ABSENCE_REASON, status, SHEET_ABSENCE_NOTE,
      input.confirmedByUserId ?? null,
    );
    if (!inserted[0]) return { plan: "NONE", report: absenceReportOf(await readAbsence(db, key, false)) };
    // 질병·부상으로 표시한 순간, 먼저 나가 있던 미사용 보강권은 거둬 둔다(2026-11-14 a2 — 원장이 신청함에서 이월/보강권을 고른다)
    await holdSheetIllnessCredit(db, key);
    return { plan, report: { reason: SHEET_ABSENCE_REASON, status, source: "SHEET" } };
  }
  if (plan === "REACTIVATE" && row) {
    // 취소된 행(학부모가 취소했거나 출석부가 껐던 것)을 출석부 행으로 되살린다.
    // 관리자 «기간 결석»이 만들었다 취소된 행이면 그 기간 연결(periodId)도 끊는다 — 출석부 행이 되었으니
    // 그 기간의 복귀 처리·등록 취소가 이 행을 건드리면 안 된다. periodId 칸은 기간 결석 표와 같은 마이그레이션에서
    // 생기므로, 표가 있을 때만 끊는다(마이그레이션 전 배포에서도 이 UPDATE 가 깨지지 않게).
    const periodFound = await db.$queryRawUnsafe<Array<{ found: string | null }>>(
      `SELECT to_regclass('public."RegularAbsencePeriod"')::text AS found`,
    );
    const unlinkPeriod = periodFound[0]?.found ? `, "periodId" = NULL` : "";
    const n = await db.$executeRawUnsafe(
      `UPDATE "RegularAbsence"
          SET reason = $2, status = $3, note = $4, "reportedByUserId" = NULL,
              "resolvedByUserId" = $5, "updatedAt" = now()${unlinkPeriod}
        WHERE id = $1 AND status = 'CANCELLED'`,
      row.id, SHEET_ABSENCE_REASON, status, SHEET_ABSENCE_NOTE, input.confirmedByUserId ?? null,
    );
    if (Number(n) === 0) return { plan: "NONE", report: absenceReportOf(row) };
    await holdSheetIllnessCredit(db, key);
    return { plan, report: { reason: SHEET_ABSENCE_REASON, status, source: "SHEET" } };
  }
  if (plan === "CANCEL" && row) {
    // 출석부가 만든 행만(note·reportedByUserId 조건을 UPDATE 에도 걸어 학부모 행을 실수로 지우지 않게).
    const n = await db.$executeRawUnsafe(
      `UPDATE "RegularAbsence"
          SET status = 'CANCELLED', "resolvedByUserId" = COALESCE($2, "resolvedByUserId"), "updatedAt" = now()
        WHERE id = $1 AND status <> 'CANCELLED' AND note = $3 AND "reportedByUserId" IS NULL`,
      row.id, input.actorUserId ?? null, SHEET_ABSENCE_NOTE,
    );
    if (Number(n) === 0) return { plan: "NONE", report: absenceReportOf(row) };
    return { plan, report: null };
  }
  // NONE · BLOCKED_* — 바꾸지 않고 지금 상태를 돌려준다.
  return { plan, report: absenceReportOf(row) };
}

/** 막힌 이유를 화면 문구로. 바꾼 게 없으면 null. */
export function absencePlanMessage(plan: AbsencePlanKind): string | null {
  if (plan === "BLOCKED_PARENT") return "학부모가 다른 사유로 결석 신고한 날이라 질병·부상 표시는 결석 관리에서 바꿔 주세요.";
  if (plan === "BLOCKED_RESOLVED") return "이미 청구에서 이월·보강으로 정산된 결석이라 사유를 바꾸지 않았습니다.";
  return null;
}
