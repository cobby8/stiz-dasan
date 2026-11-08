// 보강 온 아이를 코치 출석부에서 처리하는 규칙 — 명단 조회·출결 저장이 이 파일 하나를 쓴다.
//
// 왜 필요한가(2026-11-08 원장 승인):
//   보강 예약(MakeupSession)한 아이가 코치 앱 출석부에 안 보여 코치가 출석을 못 찍었고,
//   그래서 보강 예약이 «예약됨»에 머물러 보강권도 줄지 않았다(관리자가 /admin/makeup 에서 따로 눌러야 했다).
//
// 규칙(원장 결정):
//   · 출석·지각  → 그 예약을 «참석(ATTENDED)» → 보강권 «사용 완료(USED)»
//   · 결석       → 보강권을 쓰지 않는다. 이미 참석으로 찍혀 있었으면 «예약됨(BOOKED)»으로 되돌린다
//                  → 보강권도 «예약됨(RESERVED)»으로 돌아간다(되돌림 경로).
//   · 같은 날 같은 반에 예약이 여럿이어도 출석 한 번에 **한 건만** 참석 처리한다(두 번 차감 금지).
//   · 관리자가 정한 «무단 불참(NO_SHOW)»·«취소(CANCELLED)»는 코치 출석이 건드리지 않는다.
//   보강권 상태 전이 자체는 기존 syncCreditForMakeupSession(관리자 보강 상태 변경과 같은 함수)을 재사용한다.
//
// DB 접근은 인자로 받은 db(트랜잭션) 로만 한다 — 테스트가 가짜 db 로 실제 실행해 본다.
import { assertMakeupSessionAllowed, lockCompensation } from "@/lib/billing/absence-compensation-guard";
import { isKstYmd } from "@/lib/datetime/kst";

export type MakeupAttendanceDb = {
  $queryRawUnsafe<T = unknown>(sql: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(sql: string, ...values: unknown[]): Promise<number>;
};

/** 코치 출석부에 «보강»으로 띄우는 예약 상태. 취소·무단불참은 띄우지 않는다. */
export const MAKEUP_ROSTER_STATUSES = ["BOOKED", "ATTENDED"] as const;

/**
 * «이 반·이 날(KST)의 보강 예약» SQL 조건 — 명단 조회와 출결 저장이 같은 조건을 쓴다.
 * makeupDate 는 timestamptz 라 시간대를 «한 번» 걸어 KST 달력 날짜로 비교한다.
 * @param classParam 반 id 자리표시자(예: "$2") · @param dateParam YYYY-MM-DD 자리표시자(예: "$3")
 */
export function makeupOnClassDateSql(alias: string, classParam: string, dateParam: string): string {
  const statuses = MAKEUP_ROSTER_STATUSES.map((s) => `'${s}'`).join(",");
  return `${alias}."makeupClassId" = ${classParam}
     AND (${alias}."makeupDate" AT TIME ZONE 'Asia/Seoul')::date = ${dateParam}::date
     AND ${alias}.status IN (${statuses})`;
}

export type MakeupBooking = { id: string; status: string };
export type MakeupTransition = { id: string; from: "BOOKED" | "ATTENDED"; to: "BOOKED" | "ATTENDED" };

// ── 순수 판정 ──
/**
 * 출결 한 번에 어떤 예약을 어떻게 바꿀지 정한다. bookings 는 만든 순서대로 들어온다.
 * - 출석·지각: 이미 참석 처리된 예약이 하나라도 있으면 아무것도 안 한다(같은 예약·같은 날 두 번 차감 금지).
 *              없으면 가장 먼저 만든 «예약됨» 한 건만 참석으로.
 * - 결석: 참석으로 찍힌 예약을 모두 «예약됨»으로 되돌린다(보강권 사용 취소). 예약됨은 그대로 둔다.
 */
export function planMakeupAttendance(bookings: MakeupBooking[], attendanceStatus: string): MakeupTransition[] {
  if (attendanceStatus === "PRESENT" || attendanceStatus === "LATE") {
    if (bookings.some((b) => b.status === "ATTENDED")) return [];
    const first = bookings.find((b) => b.status === "BOOKED");
    return first ? [{ id: first.id, from: "BOOKED", to: "ATTENDED" }] : [];
  }
  if (attendanceStatus === "ABSENT") {
    return bookings
      .filter((b) => b.status === "ATTENDED")
      .map((b) => ({ id: b.id, from: "ATTENDED" as const, to: "BOOKED" as const }));
  }
  return [];
}

/** 이 학생이 이 반·이 날 보강 예약(예약됨·참석)이 있는가 — 출결 저장 시 «명단 안» 판정용. */
export async function findMakeupBookings(
  db: MakeupAttendanceDb,
  input: { studentId: string; classId: string; dateYmd: string },
  opts: { forUpdate?: boolean } = {},
): Promise<MakeupBooking[]> {
  if (!isKstYmd(input.dateYmd)) return [];
  return db.$queryRawUnsafe<MakeupBooking[]>(
    `SELECT ms.id, ms.status FROM "MakeupSession" ms
      WHERE ms."studentId" = $1 AND ${makeupOnClassDateSql("ms", "$2", "$3")}
      ORDER BY ms."createdAt", ms.id
      ${opts.forUpdate ? "FOR UPDATE" : ""}`,
    input.studentId, input.classId, input.dateYmd,
  );
}

/**
 * 출결에 맞춰 보강 예약 상태를 바꾼다. **트랜잭션 안에서** 부른다(보강·이월 정산과 같은 잠금을 잡는다).
 * 돌려준 전이 목록으로 호출부가 트랜잭션 뒤에 보강권(syncCreditForMakeupSession)을 맞춘다.
 * 이월로 정산된 결석의 보강이면 assertMakeupSessionAllowed 가 CompensationConflict 를 던진다 → 호출부가 기록만 남긴다.
 */
export async function applyMakeupAttendanceInTx(
  db: MakeupAttendanceDb,
  input: { studentId: string; classId: string; dateYmd: string; status: string },
): Promise<MakeupTransition[]> {
  await lockCompensation(db);
  const bookings = await findMakeupBookings(db, input, { forUpdate: true });
  const plan = planMakeupAttendance(bookings, input.status);
  const applied: MakeupTransition[] = [];
  for (const t of plan) {
    // 참석 처리는 «이월 정산된 결석의 보강이 아닌지» 관리자 경로(updateMakeupStatus)와 같은 검사를 거친다.
    if (t.to === "ATTENDED") await assertMakeupSessionAllowed(db, t.id);
    // 조건부 UPDATE — 그 사이 상태가 바뀌었으면 0행이 되어 건너뛴다(두 번 차감 방지의 마지막 방어선).
    const n = await db.$executeRawUnsafe(
      `UPDATE "MakeupSession" SET status = $2, "updatedAt" = NOW() WHERE id = $1 AND status = $3`,
      t.id, t.to, t.from,
    );
    if (Number(n) > 0) applied.push(t);
  }
  return applied;
}
