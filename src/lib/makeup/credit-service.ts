import { prisma } from "@/lib/prisma";
import { calcExpiry, makeSourceKey } from "./credit-rules";
import { assertRegularMakeupAllowed, lockCompensation } from "@/lib/billing/absence-compensation-guard";

// 보강권 발급·회수 — 출결이 바뀔 때 호출된다.
//
// 설계 원칙 두 가지:
//   ① **출결 저장을 절대 방해하지 않는다.**
//      보강권 발급이 실패해도 출결은 저장돼야 한다. 선생님이 수업 중에 쓰는 화면인데
//      부수 기능 때문에 출결이 안 찍히면 더 큰 문제다. 그래서 호출부에서 try/catch 로
//      격리하고, 여기서도 예외를 삼키지 않고 던져 로그에 남긴다.
//   ② **한 결석에 한 장.** sourceKey 유니크 인덱스가 최종 방어선이고,
//      코드에서는 ON CONFLICT 로 조용히 넘어간다(출결을 여러 번 눌러도 안전).

/** KST 기준 YYYY-MM-DD. 결석일은 날짜 단위로 다룬다. */
function kstYmd(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(d);
}

/** YYYY-MM-DD → 그 날 KST 자정의 UTC 시각. 만료 계산 기준점을 날짜로 고정한다. */
function ymdToUtc(ymd: string): Date {
  return new Date(`${ymd}T00:00:00+09:00`);
}

// ── 발급 시작일 판정(외부 의존 없는 순수 블록 — 테스트가 이 구간만 잘라 실행한다) ──
/**
 * 이 날짜(KST 결석일) 이후의 결석부터만 보강권을 발급한다.
 * 이유: 정규 결석 보강권이 버그로 한 장도 발급되지 않다가 2026-10-05 에 고쳐졌다.
 *       원장 결정("앞으로만")에 따라, 그 전 결석은 출결을 다시 저장하거나 랠리즈 동기화를
 *       다시 돌려도 소급 발급하지 않는다. 회수(출석·지각으로 정정)는 날짜와 상관없이 기존대로 한다.
 */
export const MAKEUP_CREDIT_ISSUE_FROM_YMD = "2026-10-05";

/** 결석일(YYYY-MM-DD)이 발급 시작일 이상인가. 같은 형식 문자열은 글자 비교가 곧 날짜 비교다. */
export function isMakeupCreditIssuableYmd(absenceYmd: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(absenceYmd) && absenceYmd >= MAKEUP_CREDIT_ISSUE_FROM_YMD;
}
// ── 발급 시작일 판정 끝 ──

export type IssueResult = { issued: boolean; creditId?: string; reason?: string };

/**
 * 결석 → 보강권 발급. 이미 있으면 아무것도 하지 않는다(멱등).
 *
 * @param absenceYmd 결석일(YYYY-MM-DD, KST). **만료는 이 날짜 기준**으로 계산된다.
 */
export async function issueMakeupCredit(input: {
  studentId: string;
  sourceType: "REGULAR" | "SEASONAL";
  sourceKey: string;
  absenceYmd: string;
  originClassId?: string | null;
  originItemId?: string | null;
  originSessionId?: string | null;
  note?: string | null;
}): Promise<IssueResult> {
  const absenceAt = ymdToUtc(input.absenceYmd);
  const expiresAt = calcExpiry(absenceAt);

  const rows = await prisma.$transaction(async tx => {
    await lockCompensation(tx);
    if (input.sourceType === "REGULAR" && input.originClassId) {
      await assertRegularMakeupAllowed(tx, { studentId: input.studentId, classId: input.originClassId, dateYmd: input.absenceYmd });
    }
    return tx.$queryRawUnsafe<{ id: string }[]>(
    `INSERT INTO "MakeupCredit"
       ("studentId","sourceType","sourceKey","absenceDate","expiresAt",
        "originClassId","originItemId","originSessionId","status","note")
     VALUES ($1,$2,$3,$4::timestamptz,$5::timestamptz,$6,$7,$8,'AVAILABLE',$9)
     ON CONFLICT ("studentId","sourceKey") DO NOTHING
     RETURNING id`,
    input.studentId, input.sourceType, input.sourceKey,
    absenceAt.toISOString(), expiresAt.toISOString(),
    input.originClassId ?? null, input.originItemId ?? null, input.originSessionId ?? null,
    input.note ?? null,
    );
  });

  if (rows[0]) return { issued: true, creditId: rows[0].id };
  return { issued: false, reason: "이미 발급된 결석입니다." };
}

/**
 * 결석이 취소되어(출석·지각으로 정정) 보강권을 거둬들인다.
 *
 * ⚠️ **아직 안 쓴 것만** 회수한다. 이미 보강을 다녀왔거나(USED) 예약 후 불참(NO_SHOW)한 건은
 *    건드리지 않는다 — 이미 자리를 썼는데 권리를 없애면 학원이 손해를 떠안는 꼴이고,
 *    반대로 되살리면 학부모가 두 번 쓰게 된다.
 *    예약 중(RESERVED)인 것도 회수하지 않는다. 예약을 먼저 취소해야 한다.
 */
export async function revokeMakeupCredit(input: {
  studentId: string;
  sourceKey: string;
  note?: string | null;
}): Promise<{ revoked: number }> {
  const n = await prisma.$executeRawUnsafe(
    `UPDATE "MakeupCredit"
        SET "status" = 'REVOKED',
            "note" = COALESCE($3, "note"),
            "updatedAt" = now()
      WHERE "studentId" = $1 AND "sourceKey" = $2
        AND "status" = 'AVAILABLE'`,
    input.studentId, input.sourceKey, input.note ?? null,
  );
  return { revoked: Number(n) };
}

/**
 * 출결 상태에 따라 보강권을 맞춰 준다. 출결 저장 직후에 호출한다.
 *
 * ABSENT → 발급(결석일이 MAKEUP_CREDIT_ISSUE_FROM_YMD 이상일 때만) / 그 외(PRESENT·LATE) → 회수.
 * 지각(LATE)은 결석이 아니므로 보강권을 주지 않는다(약관: "결석으로 수업의 결손").
 */
export async function syncMakeupCreditForAttendance(input: {
  studentId: string;
  status: string;
  sourceType: "REGULAR" | "SEASONAL";
  sourceKey: string;
  absenceYmd: string;
  originClassId?: string | null;
  originItemId?: string | null;
  originSessionId?: string | null;
}): Promise<{ action: "issued" | "revoked" | "none" }> {
  if (input.status === "ABSENT") {
    // 발급 시작일 전 결석은 발급하지 않는다(정규·특강 좌석 모두 이 함수를 거친다).
    if (!isMakeupCreditIssuableYmd(input.absenceYmd)) return { action: "none" };
    const r = await issueMakeupCredit(input);
    return { action: r.issued ? "issued" : "none" };
  }
  const r = await revokeMakeupCredit({
    studentId: input.studentId,
    sourceKey: input.sourceKey,
    note: `출결이 ${input.status} 로 정정되어 회수`,
  });
  return { action: r.revoked > 0 ? "revoked" : "none" };
}

/**
 * 보강 예약의 상태(BOOKED/ATTENDED/NO_SHOW/CANCELLED)를 보강권에 반영한다.
 *
 * 예약 화면에서 보강권과 MakeupSession 을 연결해 뒀으므로, 관리자가 보강 출결을
 * 찍으면 그 한 장의 운명이 정해진다.
 *
 *   ATTENDED  → USED     보강을 다녀왔으니 소진
 *   NO_SHOW   → NO_SHOW  약관: "예약 후 무단 불참 시 사용한 것으로 처리"
 *   CANCELLED → AVAILABLE 약관: "미리 취소하면 보강권 유지" — 연결을 끊고 되돌린다
 *   BOOKED    → RESERVED  되돌림(상태를 잘못 찍었다가 고치는 경우)
 *
 * 연결된 보강권이 없으면(이 기능 이전에 만들어진 예약) 조용히 넘어간다.
 */
export async function syncCreditForMakeupSession(input: {
  makeupSessionId: string;
  status: string;
}): Promise<{ action: string }> {
  const nextStatus =
    input.status === "ATTENDED" ? "USED"
    : input.status === "NO_SHOW" ? "NO_SHOW"
    : input.status === "CANCELLED" ? "AVAILABLE"
    : input.status === "BOOKED" ? "RESERVED"
    : null;
  if (!nextStatus) return { action: "none" };

  if (nextStatus === "AVAILABLE") {
    // 취소 — 보강권을 되돌리고 예약과의 연결을 끊는다.
    const n = await prisma.$executeRawUnsafe(
      `UPDATE "MakeupCredit"
          SET status='AVAILABLE', "makeupSessionId"=NULL, "updatedAt"=now()
        WHERE "makeupSessionId" = $1 AND status <> 'REVOKED'`,
      input.makeupSessionId,
    );
    return { action: Number(n) > 0 ? "restored" : "none" };
  }

  const n = await prisma.$executeRawUnsafe(
    `UPDATE "MakeupCredit" SET status=$2, "updatedAt"=now() WHERE "makeupSessionId" = $1 AND status <> 'REVOKED'`,
    input.makeupSessionId, nextStatus,
  );
  return { action: Number(n) > 0 ? nextStatus : "none" };
}

/**
 * 기간이 지난 보강권을 소멸시킨다(매일 1회 크론).
 *
 * ⚠️ **AVAILABLE 인 것만** 소멸시킨다. 예약(RESERVED)까지 태우면, 만료일 직전에
 *    예약해 둔 보강을 다녀오기도 전에 권리가 사라진다. 예약은 이미 자리를 잡았으니
 *    출결(ATTENDED/NO_SHOW)로 끝나야 한다.
 *
 * 경계는 학부모에게 유리하게 — 만료일 당일 자정까지는 남겨 둔다(`expiresAt < now`).
 */
export async function expireOverdueCredits(): Promise<{ expired: number }> {
  const n = await prisma.$executeRawUnsafe(
    `UPDATE "MakeupCredit"
        SET status='EXPIRED', "updatedAt"=now()
      WHERE status='AVAILABLE' AND "expiresAt" < now()`,
  );
  return { expired: Number(n) };
}

/** 정규 수업 출결용 — 세션에서 반·날짜를 읽어 키를 만든다. */
export async function syncCreditForRegularSession(input: {
  sessionId: string;
  studentId: string;
  status: string;
}): Promise<{ action: string }> {
  // ⚠️ "Session" 에는 "startsAt" 컬럼이 없다(2026-10-05 운영 DB 확인) — 예전 코드는 이 SELECT 가
  //    매번 터져 정규 결석 보강권이 한 장도 발급되지 않았다.
  //    "date" 는 무(無)tz timestamp 에 KST 달력 날짜 자정을 그대로 담는다. 그래서 시간대 변환
  //    (AT TIME ZONE) 없이 그 날짜 글자를 그대로 꺼내면 결석일이 된다. 변환을 걸면 하루 밀린다.
  const rows = await prisma.$queryRawUnsafe<{ classId: string; absenceYmd: string | null }[]>(
    `SELECT "classId", to_char("date", 'YYYY-MM-DD') AS "absenceYmd" FROM "Session" WHERE id = $1 LIMIT 1`,
    input.sessionId,
  );
  const row = rows[0];
  if (!row || !row.absenceYmd) return { action: "none" };

  // 결석일(YYYY-MM-DD) — 발급 키·absenceDate·만료일이 모두 이 한 값에서 나온다.
  const absenceYmd = row.absenceYmd;
  return syncMakeupCreditForAttendance({
    studentId: input.studentId,
    status: input.status,
    sourceType: "REGULAR",
    sourceKey: makeSourceKey({ sourceType: "REGULAR", classId: row.classId, absenceYmd }),
    absenceYmd,
    originClassId: row.classId,
    originSessionId: input.sessionId,
  });
}

/** 방학특강 좌석 출결용 — 좌석에서 날짜·수강항목을 읽어 키를 만든다. */
export async function syncCreditForSeasonalSeat(input: {
  enrollmentDateId: string;
  studentId: string;
  status: string;
}): Promise<{ action: string }> {
  const rows = await prisma.$queryRawUnsafe<{ itemId: string; startsAt: Date | string }[]>(
    `SELECT e."applicationItemId" AS "itemId", sd."startsAt"
       FROM "SpecialProgramEnrollmentDate" e
       JOIN "SpecialProgramSessionDate" sd ON sd.id = e."sessionDateId"
      WHERE e.id = $1 LIMIT 1`,
    input.enrollmentDateId,
  );
  const row = rows[0];
  if (!row) return { action: "none" };

  const absenceYmd = kstYmd(row.startsAt instanceof Date ? row.startsAt : new Date(row.startsAt));
  return syncMakeupCreditForAttendance({
    studentId: input.studentId,
    status: input.status,
    sourceType: "SEASONAL",
    // 좌석 id 자체가 "그 학생의 그 날 수업"을 유일하게 가리킨다.
    sourceKey: makeSourceKey({ sourceType: "SEASONAL", enrollmentDateId: input.enrollmentDateId }),
    absenceYmd,
    originItemId: row.itemId,
    originSessionId: input.enrollmentDateId,
  });
}
