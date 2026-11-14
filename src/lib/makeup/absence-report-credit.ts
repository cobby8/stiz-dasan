import { calcExpiry, makeSourceKey } from "./credit-rules";
import {
  assertRegularMakeupAllowed,
  CompensationConflict,
  lockCompensation,
  type CompensationTransaction,
} from "@/lib/billing/absence-compensation-guard";
import { kstAt, kstHm, todayKst } from "@/lib/datetime/kst";
import { isMakeupChangeOpen } from "@/lib/parent/changeDeadline";

// ── 정규 결석 «신고» 기반 보강권 발급·되돌리기 (2026-11-10 원장 결정 k4) ─────────────────
//
// 원장 결정: «먼저 신고하고 보강을 요청하는 경우도 있으므로 결석 신고 즉시 보강권 발급,
//            신고 취소 후 되돌리는 것까지 고려».
//
// ★ 한 결석에 한 장 — 출결 기반 발급(credit-service.syncCreditForRegularSession)과 **같은 키**를 쓴다.
//   키 = makeSourceKey({ REGULAR, classId, absenceYmd }) = `REGULAR:{classId}:{YYYY-MM-DD}`.
//   출결 세션 id 가 키에 들어가지 않으므로, 신고 시점(세션이 아직 없음)에도 같은 키가 나온다.
//   그래서 나중에 출결이 ABSENT 로 저장되거나 랠리즈 동기화가 돌아도 ("studentId","sourceKey") 유니크에
//   걸려 두 장이 되지 않는다.
//
// 이 파일은 prisma 를 직접 import 하지 않는다 — 호출부가 넘긴 트랜잭션(tx) 안에서만 쓴다.
// 결석 신고 저장과 보강권 발급/회수가 같은 트랜잭션에 묶여야, 한쪽만 남는 반쪽 상태가 생기지 않는다.
// (테스트가 가짜 tx 로 이 파일을 그대로 실행한다)

/** 신고(학생·반·KST 날짜) → 보강권 키. 출결 기반 발급과 같은 함수로 만든다. */
export function regularAbsenceSourceKey(classId: string, absenceYmd: string): string {
  return makeSourceKey({ sourceType: "REGULAR", classId, absenceYmd });
}

// ── 신고 취소 시 보강권 판정(순수) ─────────────────────────────────────────────

/** 결석 신고가 취소될 때 보강권을 어떻게 할지 */
export type CreditOnAbsenceCancel =
  | "NONE"                      // 손대지 않는다(보강권이 없거나, 이미 끝났거나, 출결이 결석으로 확정됨)
  | "REVOKE"                    // 미사용 보강권 회수
  | "CANCEL_BOOKING_AND_REVOKE" // 보강 예약을 취소하고 보강권 회수(학부모가 확인한 경우)
  | "NEED_BOOKING_CONFIRM"      // 보강 예약이 있다 — 학부모 확인이 먼저 필요
  | "BLOCK_USED"                // 이미 보강을 들었다(또는 무단 불참 처리) — 신고 취소를 막는다
  | "BLOCK_PAST_BOOKING";       // 예약한 보강의 취소 마감(수업 시작 1시간 전)이 지났다 — 무단 불참 처리를 우회하지 못하게 막는다

export function decideCreditOnAbsenceCancel(input: {
  /** 누가 취소하나 — 학부모(PARENT) / 관리자(ADMIN) */
  actor: "PARENT" | "ADMIN";
  /** 그 결석의 보강권 상태(없으면 null) */
  creditStatus: string | null;
  /** 그 수업 출결이 이미 «결석»으로 저장됐나 — 그렇다면 실제로 결석했으므로 보강권은 그대로 둔다 */
  attendanceAbsent: boolean;
  /** 예약된 보강의 취소 마감이 지났나(보강 수업 시작 1시간 전 — 학부모 보강 취소와 같은 함수 isMakeupChangeOpen) */
  bookingPast: boolean;
  /** 학부모가 «보강 예약도 함께 취소돼요»를 확인했나 */
  confirmBookingCancel: boolean;
}): CreditOnAbsenceCancel {
  const status = input.creditStatus;
  // 보강권이 없거나 이미 끝난(만료·회수) 것은 손대지 않는다
  if (!status || status === "EXPIRED" || status === "REVOKED") return "NONE";
  // 출결이 결석으로 확정됐다 = 신고와 상관없이 실제 결석. 보강권은 정당하다(중복 발급도, 회수도 없음)
  if (input.attendanceAbsent) return "NONE";

  if (status === "USED" || status === "NO_SHOW") {
    // 학부모: 이미 보강을 들었는데 결석을 없던 일로 하면 수업을 한 번 더 받은 셈 → 막고 안내
    // 관리자: 기존 회수 규칙(USED·NO_SHOW 는 건드리지 않음)과 같게 — 취소는 허용, 보강권은 그대로
    return input.actor === "PARENT" ? "BLOCK_USED" : "NONE";
  }
  if (status === "RESERVED") {
    // 관리자: 기존 규칙(예약 중인 보강권은 회수하지 않는다 — 예약을 먼저 정리)과 같게
    if (input.actor === "ADMIN") return "NONE";
    if (input.bookingPast) return "BLOCK_PAST_BOOKING";
    return input.confirmBookingCancel ? "CANCEL_BOOKING_AND_REVOKE" : "NEED_BOOKING_CONFIRM";
  }
  if (status === "AVAILABLE") return "REVOKE";
  return "NONE";
}

/** 판정 → 학부모에게 돌려줄 오류 코드(라우트·카카오가 한국어 문구로 바꾼다) */
export const ABSENCE_CANCEL_ERROR: Partial<Record<CreditOnAbsenceCancel, string>> = {
  NEED_BOOKING_CONFIRM: "MAKEUP_BOOKING_CONFIRM_REQUIRED",
  BLOCK_USED: "MAKEUP_ALREADY_USED",
  BLOCK_PAST_BOOKING: "MAKEUP_BOOKING_PAST",
};

// ── 트랜잭션 안에서 쓰는 쓰기 함수 ─────────────────────────────────────────────

/**
 * 결석 신고 → 보강권 발급(멱등). 호출부 트랜잭션 안에서 부른다.
 *
 * - 이미 있으면(출결로 먼저 발급됐거나 같은 신고를 다시 보냄) 아무것도 하지 않는다.
 * - 예전에 신고 취소·출결 정정으로 **회수(REVOKED)** 된 같은 결석이면 다시 «사용 가능»으로 되살린다.
 *   (신고 → 취소 → 다시 신고, 또는 신고 취소 후 실제로 결석한 경우 — 한 결석의 권리는 한 장 그대로)
 *   예약에 묶였던 흔적이 있는 것(makeupSessionId 있음)은 되살리지 않는다.
 * - 이월(CARRY)로 정산된 결석이면 보강권을 만들지 않는다 — 신고 자체는 막지 않는다.
 *
 * 발급 시작일(MAKEUP_CREDIT_ISSUE_FROM_YMD) 판정은 호출부가 한다(그 함수는 prisma 를 import 하는 파일에 있다).
 */
export async function issueCreditForReportedAbsence(
  tx: CompensationTransaction,
  input: { studentId: string; classId: string; absenceYmd: string; note?: string },
): Promise<{ issued: boolean; reason?: "CARRY" | "EXISTS" }> {
  await lockCompensation(tx);
  try {
    await assertRegularMakeupAllowed(tx, { studentId: input.studentId, classId: input.classId, dateYmd: input.absenceYmd });
  } catch (error) {
    if (error instanceof CompensationConflict) return { issued: false, reason: "CARRY" };
    throw error;
  }

  // 결석일 KST 자정 — 출결 기반 발급(credit-service ymdToUtc)과 같은 기준점. 만료도 결석일 기준(약관)
  const absenceAt = new Date(kstAt(input.absenceYmd));
  const expiresAt = calcExpiry(absenceAt);
  const rows = await tx.$queryRawUnsafe<{ id: string }[]>(
    `INSERT INTO "MakeupCredit"
       ("studentId","sourceType","sourceKey","absenceDate","expiresAt",
        "originClassId","originItemId","originSessionId","status","note")
     VALUES ($1,'REGULAR',$2,$3::timestamptz,$4::timestamptz,$5,NULL,NULL,'AVAILABLE',$6)
     ON CONFLICT ("studentId","sourceKey") DO UPDATE
        SET status = 'AVAILABLE', note = EXCLUDED.note, "updatedAt" = now()
      WHERE "MakeupCredit".status = 'REVOKED' AND "MakeupCredit"."makeupSessionId" IS NULL
     RETURNING id`,
    input.studentId,
    regularAbsenceSourceKey(input.classId, input.absenceYmd),
    absenceAt.toISOString(),
    expiresAt.toISOString(),
    input.classId,
    input.note ?? "결석 신고로 발급",
  );
  return rows[0] ? { issued: true } : { issued: false, reason: "EXISTS" };
}

/**
 * 결석 신고 취소 → 보강권 되돌리기. 호출부 트랜잭션 안에서, 결석 행을 CANCELLED 로 바꾼 **같은 트랜잭션**에서 부른다.
 * 막아야 하는 경우(BLOCK_*·NEED_*)는 오류 코드를 던진다 → 트랜잭션이 통째로 되돌아가 신고 취소도 없던 일이 된다.
 */
export async function settleCreditOnAbsenceCancel(
  tx: CompensationTransaction,
  input: {
    actor: "PARENT" | "ADMIN";
    studentId: string;
    classId: string;
    absenceYmd: string;
    confirmBookingCancel?: boolean;
  },
): Promise<{ action: CreditOnAbsenceCancel }> {
  await lockCompensation(tx);
  const sourceKey = regularAbsenceSourceKey(input.classId, input.absenceYmd);

  // 보강권(+ 연결된 예약) — 행 잠금.
  // 2026-11-15 마감 1시간 전 통일: «예약한 보강의 취소 마감이 지났나»를 학부모 보강 취소와 같은 함수로 판정한다
  //   (보강 날짜의 KST 달력 날짜 + 보강 가는 반의 시작 시각 → 수업 시작 1시간 전까지 열림).
  //   예전의 makeupDate < now() 는 저장 시각에 따라 달랐다(관리자가 UTC 자정으로 잡은 보강은 당일 09시까지 «안 지남»).
  //   makeupDate 는 timestamptz 라 변환은 «한 번»만 건다. «지금»은 kst.ts 로 만든 KST 글자다.
  const credits = await tx.$queryRawUnsafe<Array<{ id: string; status: string; makeupSessionId: string | null; bookingYmd: string | null; bookingStartTime: string | null }>>(
    `SELECT mc.id, mc.status, mc."makeupSessionId" AS "makeupSessionId",
            to_char(ms."makeupDate" AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD') AS "bookingYmd",
            bc."startTime" AS "bookingStartTime"
       FROM "MakeupCredit" mc
       LEFT JOIN "MakeupSession" ms ON ms.id = mc."makeupSessionId"
       LEFT JOIN "Class" bc ON bc.id = ms."makeupClassId"
      WHERE mc."studentId" = $1 AND mc."sourceKey" = $2
      LIMIT 1
      FOR UPDATE OF mc`,
    input.studentId, sourceKey,
  );
  const credit = credits[0] ?? null;
  if (!credit) return { action: "NONE" };

  // 그 수업 출결이 이미 결석으로 저장됐나.
  // Session."date" 는 무tz timestamp 에 KST 달력 자정을 담는다 — 변환 없이 글자 그대로 비교(credit-service 와 같은 규칙)
  const absentRows = await tx.$queryRawUnsafe<Array<{ found: number }>>(
    `SELECT 1 AS found
       FROM "Attendance" a
       JOIN "Session" se ON se.id = a."sessionId"
      WHERE a."studentId" = $1 AND se."classId" = $2
        AND to_char(se."date", 'YYYY-MM-DD') = $3
        AND a.status = 'ABSENT'
      LIMIT 1`,
    input.studentId, input.classId, input.absenceYmd,
  );

  const nowMs = Date.now();
  const action = decideCreditOnAbsenceCancel({
    actor: input.actor,
    creditStatus: credit.status,
    attendanceAbsent: absentRows.length > 0,
    // 예약이 없으면 «지남»이 아니다. 있으면 취소 마감(수업 시작 1시간 전)이 지났는지
    bookingPast: credit.bookingYmd
      ? !isMakeupChangeOpen(credit.bookingYmd, credit.bookingStartTime, todayKst(nowMs), kstHm(nowMs))
      : false,
    confirmBookingCancel: input.confirmBookingCancel === true,
  });

  const errorCode = ABSENCE_CANCEL_ERROR[action];
  if (errorCode) throw new Error(errorCode);

  if (action === "REVOKE") {
    await tx.$executeRawUnsafe(
      `UPDATE "MakeupCredit"
          SET status = 'REVOKED', note = $2, "updatedAt" = now()
        WHERE id = $1 AND status = 'AVAILABLE'`,
      credit.id, "결석 신고가 취소되어 회수",
    );
  } else if (action === "CANCEL_BOOKING_AND_REVOKE") {
    // 예약 취소 → 보강권 회수(연결도 끊는다). 같은 트랜잭션이라 예약만 취소되고 권이 남는 일은 없다
    if (credit.makeupSessionId) {
      await tx.$executeRawUnsafe(
        `UPDATE "MakeupSession" SET status = 'CANCELLED', "updatedAt" = now() WHERE id = $1 AND status = 'BOOKED'`,
        credit.makeupSessionId,
      );
    }
    await tx.$executeRawUnsafe(
      `UPDATE "MakeupCredit"
          SET status = 'REVOKED', "makeupSessionId" = NULL, note = $2, "updatedAt" = now()
        WHERE id = $1 AND status = 'RESERVED'`,
      credit.id, "결석 신고가 취소되어 보강 예약과 함께 회수",
    );
  }
  return { action };
}
