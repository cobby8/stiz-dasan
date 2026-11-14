import { childAccessSql } from "@/lib/account/child-access";
import { prisma } from "@/lib/prisma";
import { createHash } from "node:crypto";
import { notMergedStudent } from "@/lib/studentVisibility";
import { earliestUsableFrom, parentUsableEnrollmentSql, resumeFromSql, resumeNotice, usableOn } from "@/lib/enrollment/resumeWindow";
import { CHANGE_CLOSED_MESSAGE, isShuttleChangeOpen } from "@/lib/parent/changeDeadline";
import { kstDow, kstHm, todayKst } from "@/lib/datetime/kst";
import { summarizeDeliveryStatus, type DeliveryStatusRow, type DeliveryStatusSummary } from "@/lib/parent-staff-status";
import {
  SHUTTLE_EXCEPTION_MESSAGE,
  validateShuttleException,
  type ShuttleDirection,
  type ShuttleExceptionKind,
} from "@/lib/shuttle/dayExceptionRules";

// ── 학부모의 "오늘만" 셔틀 변경 ──────────────────────────────────────────────
//
// 결석 신고와 같은 성격이다: 승인 없이 바로 반영하고 원장에게는 알림만 보낸다.
// 기사님 화면이 그날 명단을 만들 때 이 표를 함께 읽는다.
//
// ★ 보안 가드:
//   1) IDOR — studentId 가 그 부모의 자녀인지 SQL 로 재검증.
//      (2026-11-14 복귀 예정) 대상 = 다니는 학생 + «복귀 승인된 휴원» 학생(resumeWindow 한 곳의 규칙).
//      다니는 반 없이 복귀 예정뿐이면 복귀일 이후 날짜만 받는다 — 서버가 다시 본다.
//   2) 날짜는 서버 기준(KST)으로 판정 — 클라이언트 시계를 믿으면 지난 날도 바꿀 수 있다.
//   3) 같은 학생·날짜·방향에 살아있는 예외는 한 건(DB 부분 유니크가 최종 방어선).
//   4) 마감(2026-11-15 마감 통일·날짜 바꾸기) — 신청·취소·날짜 바꾸기 모두 서버가 막는다.
//      기준 = 그 학생이 그 날짜(요일)에 듣는 반의 가장 이른 시작 시각(Class.startTime).
//      등원·하원·둘 다 모두 그 1시간 전까지(2026-11-15 마감 1시간 전 통일 — 원장 결정). 그 날짜에 수업이 없으면 전날까지. 지난 날짜는 항상 닫힘.
//      ※ 학원(원장·부원장)이 대신 넣는 길은 admin-shuttle-exception.ts — 거기는 마감을 적용하지 않는다.
//      예전에는 취소에 시각·날짜 검사가 없어 지난 날짜·운행이 끝난 뒤에도 취소됐다.
//      판정 함수는 결석·보강과 함께 쓰는 @/lib/parent/changeDeadline 하나다.

function kstTodayYmd(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

// «지금»을 KST 글자(날짜·시각)로 — 마감 판정에 넣는다(서버는 UTC 로 돈다. 달력 값은 kst.ts 에서만)
function kstNow(): { ymd: string; hm: string } {
  const nowMs = Date.now();
  return { ymd: todayKst(nowMs), hm: kstHm(nowMs) };
}

/** Class.dayOfWeek("Mon"…) → 요일 번호(0=일 … 6=토) */
const DOW_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

type ClassTimeRow = { studentId: string; dayOfWeek: string | null; startTime: string | null; status: string; resumeFrom: string | null };

/**
 * 학생들이 «쓸 수 있는» 수강 반의 요일·시작 시각(다니는 반 + 복귀 승인된 휴원 반 — resumeWindow 공용 규칙).
 * 셔틀 마감의 기준 시각을 구하는 데만 쓴다. 소유 검사는 호출부가 이미 끝낸 학생 id 만 넘긴다.
 */
async function loadClassTimes(studentIds: string[]): Promise<Map<string, ClassTimeRow[]>> {
  const out = new Map<string, ClassTimeRow[]>();
  if (studentIds.length === 0) return out;
  const rows = await prisma.$queryRawUnsafe<ClassTimeRow[]>(
    `SELECT e."studentId" AS "studentId", c."dayOfWeek" AS "dayOfWeek", c."startTime" AS "startTime",
            e.status AS status, ${resumeFromSql("e")} AS "resumeFrom"
       FROM "Enrollment" e
       JOIN "Class" c ON c.id = e."classId"
      WHERE e."studentId" = ANY($1::text[]) AND ${parentUsableEnrollmentSql("e")}`,
    studentIds,
  );
  for (const row of rows) {
    const list = out.get(row.studentId) ?? [];
    list.push(row);
    out.set(row.studentId, list);
  }
  return out;
}

/** 그 날짜(요일)에 그 학생이 듣는 반들의 시작 시각. 복귀 예정 반은 복귀일 이후 날짜에만 센다. */
function startTimesOn(rows: readonly ClassTimeRow[] | undefined, ymd: string): (string | null)[] {
  const dow = kstDow(ymd);
  return (rows ?? [])
    .filter((row) => DOW_INDEX[String(row.dayOfWeek)] === dow && usableOn(row.status, row.resumeFrom ?? null, ymd))
    .map((row) => row.startTime ?? null);
}

/** 지금 그 날짜·방향의 셔틀 변경을 신청·취소·옮길 수 있나(서버 강제와 화면 표시가 같은 함수) */
function shuttleOpen(rows: readonly ClassTimeRow[] | undefined, ymd: string, direction: string, now: { ymd: string; hm: string }): boolean {
  // 방향(direction)은 마감에 영향을 주지 않는다(등원·하원·둘 다 같은 1시간 전) — 호출부 모양을 그대로 두려고 인자만 받는다
  void direction;
  return isShuttleChangeOpen(ymd, startTimesOn(rows, ymd), now.ymd, now.hm);
}

export type ShuttleExceptionRow = {
  id: string;
  studentId: string;
  studentName: string;
  serviceDate: string;
  direction: string;
  kind: string;
  location: string | null;
  note: string | null;
  notificationStatus?: DeliveryStatusSummary | null;
  // 지금 취소·날짜 바꾸기를 받을 수 있나(마감 전인가). false 면 화면이 버튼 대신 «학원으로 연락» 글을 보인다.
  // 서버도 같은 함수로 다시 막는다 — 이 값은 화면 표시용일 뿐이다.
  changeOpen?: boolean;
};

export type ShuttleExceptionOptions = {
  today: string;
  maxDate: string;
  // usableFrom: 다니는 반 없이 «복귀 예정»뿐인 자녀의 복귀일("YYYY-MM-DD") — 그날부터 신청할 수 있다. 다니는 자녀는 null
  children: { studentId: string; studentName: string; usableFrom: string | null }[];
  upcoming: ShuttleExceptionRow[];
};

export async function getShuttleExceptionOptions(parentUserId: string): Promise<ShuttleExceptionOptions> {
  const today = kstTodayYmd();
  const { addDays, MAX_DAYS_AHEAD } = await import("@/lib/shuttle/dayExceptionRules");

  const enrollRows = await prisma.$queryRawUnsafe<{ studentId: string; studentName: string; status: string; resumeFrom: string | null }[]>(
    // 셔틀은 정규 수강생만 탄다. 지금 다니는 자녀 + 복귀가 승인된 자녀(2026-11-14 복귀 예정)만 보여준다.
    `SELECT s.id AS "studentId", s.name AS "studentName", e.status AS status, ${resumeFromSql("e")} AS "resumeFrom"
       FROM "Student" s
       JOIN "Enrollment" e ON e."studentId" = s.id AND ${parentUsableEnrollmentSql("e")}
      WHERE ${await childAccessSql("s", "$1")} AND ${notMergedStudent("s")}
      ORDER BY s.name, s.id`,
    parentUserId,
  );
  // 수강 행 → 자녀 한 줄(이름순 유지). 다니는 반이 하나라도 있으면 제한 없음, 전부 복귀 예정이면 가장 이른 복귀일부터.
  const byStudent = new Map<string, { studentName: string; rows: { status: string; resumeFrom: string | null }[] }>();
  for (const row of enrollRows) {
    const entry = byStudent.get(row.studentId) ?? { studentName: row.studentName, rows: [] };
    entry.rows.push({ status: row.status, resumeFrom: row.resumeFrom ?? null });
    byStudent.set(row.studentId, entry);
  }
  const children = [...byStudent.entries()].map(([studentId, entry]) => ({
    studentId, studentName: entry.studentName, usableFrom: earliestUsableFrom(entry.rows),
  }));

  const upcoming = await prisma.$queryRawUnsafe<ShuttleExceptionRow[]>(
    `SELECT x.id, x."studentId", s.name AS "studentName",
            to_char(x."serviceDate",'YYYY-MM-DD') AS "serviceDate",
            x.direction, x.kind, x.location, x.note
       FROM "ShuttleDayException" x
       JOIN "Student" s ON s.id = x."studentId"
      WHERE ${await childAccessSql("s", "$1")} AND ${notMergedStudent("s")} AND x."canceledAt" IS NULL
        AND x."serviceDate" >= $2::date
      ORDER BY x."serviceDate", s.name`,
    parentUserId, today,
  );

  // 예정된 변경마다 «지금 바꿀 수 있나» — 그 학생이 그 날짜에 듣는 반의 시작 시각으로 판정한다
  const now = kstNow();
  const classTimes = await loadClassTimes([...new Set(upcoming.map((row) => row.studentId))]);

  return {
    today,
    maxDate: addDays(today, MAX_DAYS_AHEAD),
    children,
    upcoming: await Promise.all(upcoming.map(async (row) => ({
      id: row.id,
      studentId: row.studentId,
      studentName: row.studentName,
      serviceDate: row.serviceDate,
      direction: row.direction,
      kind: row.kind,
      location: row.location ?? null,
      note: row.note ?? null,
      notificationStatus: await readShuttleNotificationStatus(row.id, "SUBMITTED", shuttleEventVersion(row)),
      changeOpen: shuttleOpen(classTimes.get(row.studentId), row.serviceDate, row.direction, now),
    }))),
  };
}

export type SubmitShuttleExceptionInput = {
  studentId?: string;
  serviceDate?: unknown;
  direction?: unknown;
  kind?: unknown;
  location?: unknown;
  note?: unknown;
};

type PreparedShuttleChange = {
  studentId: string;
  studentName: string;
  serviceDate: string;
  direction: ShuttleDirection;
  kind: ShuttleExceptionKind;
  location: string | null;
  note: string | null;
  classTimes: ClassTimeRow[];
};

/**
 * 신청 내용 검증(소유·수강·날짜 범위·방향·장소·복귀일) — 새 신청과 «날짜 바꾸기»가 같은 검사를 지난다.
 * 마감은 여기서 보지 않는다(호출부가 shuttleOpen 으로 본다 — 옮기기는 옛 날짜·새 날짜 두 번).
 */
async function prepareShuttleChange(
  parentUserId: string,
  input: SubmitShuttleExceptionInput,
): Promise<{ ok: false; message: string } | { ok: true; value: PreparedShuttleChange }> {
  const studentId = typeof input.studentId === "string" ? input.studentId.trim() : "";
  if (!studentId) return { ok: false as const, message: "자녀를 선택해 주세요." };

  // 가드1: 그 부모의 자녀이고 지금 다니는(또는 복귀가 승인된) 학생인지 재검증.
  // 수강 행을 모두 읽는다 — 복귀 예정뿐이면 아래에서 날짜를 복귀일과 비교해야 한다(2026-11-14 복귀 예정).
  const owned = await prisma.$queryRawUnsafe<{ id: string; name: string; status: string; resumeFrom: string | null }[]>(
    `SELECT s.id, s.name, e.status AS status, ${resumeFromSql("e")} AS "resumeFrom"
       FROM "Student" s
       JOIN "Enrollment" e ON e."studentId" = s.id AND ${parentUsableEnrollmentSql("e")}
      WHERE s.id = $1 AND ${await childAccessSql("s", "$2")} AND ${notMergedStudent("s")}`,
    studentId, parentUserId,
  );
  if (!owned[0]) return { ok: false as const, message: "본인 자녀만 신청할 수 있습니다." };

  // 가드2: 날짜 판정은 서버 시계(KST)로 한다.
  const checked = validateShuttleException(input, { today: kstTodayYmd() });
  if (!checked.ok) return { ok: false as const, message: SHUTTLE_EXCEPTION_MESSAGE[checked.error] };
  const direction: ShuttleDirection = checked.direction;
  const kind: ShuttleExceptionKind = checked.kind;

  const serviceDate = String(input.serviceDate);
  // 가드2-2: 복귀 예정뿐인 학생은 복귀일 이후 날짜만(그 전은 아직 휴원이라 셔틀 명단에 없다). 화면을 믿지 않고 서버가 막는다.
  const usableFrom = earliestUsableFrom(owned.map((row) => ({ status: row.status, resumeFrom: row.resumeFrom ?? null })));
  if (usableFrom && serviceDate < usableFrom) return { ok: false as const, message: `${resumeNotice(usableFrom)}.` };
  const location = kind === "LOCATION" ? String(input.location).trim().slice(0, 200) : null;
  const note = typeof input.note === "string" ? input.note.trim().slice(0, 300) || null : null;

  // 마감 판정에 쓸 반 시각(소유 검사를 통과한 학생 id 로만 읽는다)
  const classTimes = (await loadClassTimes([studentId])).get(studentId) ?? [];
  return { ok: true as const, value: { studentId, studentName: owned[0].name, serviceDate, direction, kind, location, note, classTimes } };
}

type RawDb = Pick<typeof prisma, "$queryRawUnsafe">;

/**
 * 저장 — 같은 내용이 이미 있으면 손대지 않는다(changed=false). 새 신청과 «날짜 바꾸기»가 같은 문장을 쓴다(db = prisma 또는 트랜잭션).
 */
// (관리자 대신 입력 admin-shuttle-exception.ts 도 이 함수를 쓴다 — 저장 문장을 두 벌 만들지 않는다. 세 번째 인자 = 입력한 사람 id)
export async function saveShuttleException(
  db: RawDb,
  v: Pick<PreparedShuttleChange, "studentId" | "serviceDate" | "direction" | "kind" | "location" | "note">,
  parentUserId: string,
) {
  // 가드3: 같은 날·같은 방향에 이미 있으면 덮어쓴다(학부모가 마음을 바꾼 것).
  // 두 건이 살아 있으면 기사님이 무엇을 따를지 모른다.
  const saved = await db.$queryRawUnsafe<{ id: string; changed: boolean }[]>(
    `WITH guard AS MATERIALIZED (
       SELECT pg_advisory_xact_lock(hashtextextended($1||'|'||$2||'|'||$3, 0))
     ), existing AS (
       SELECT x.id FROM "ShuttleDayException" x CROSS JOIN guard
        WHERE x."studentId"=$1 AND x."serviceDate"=$2::date AND x.direction=$3
          AND x.kind=$4 AND x.location IS NOT DISTINCT FROM $5 AND x.note IS NOT DISTINCT FROM $6
          AND x."canceledAt" IS NULL
        LIMIT 1
     ), canceled AS (
       UPDATE "ShuttleDayException"
          SET "canceledAt" = now(), "updatedAt" = now()
        WHERE "studentId" = $1 AND "serviceDate" = $2::date AND direction = $3
          AND "canceledAt" IS NULL
          AND NOT EXISTS (SELECT 1 FROM existing)
     ), inserted AS (
       INSERT INTO "ShuttleDayException"
        ("studentId","serviceDate","direction","kind","location","note","requestedByUserId")
       SELECT $1,$2::date,$3,$4,$5,$6,$7 WHERE NOT EXISTS (SELECT 1 FROM existing)
       RETURNING id
     ) SELECT id, true AS changed FROM inserted
       UNION ALL SELECT id, false AS changed FROM existing`,
    v.studentId, v.serviceDate, v.direction, v.kind, v.location, v.note, parentUserId,
  );
  return saved;
}

export async function submitShuttleException(parentUserId: string, input: SubmitShuttleExceptionInput) {
  const prepared = await prepareShuttleChange(parentUserId, input);
  if (!prepared.ok) return prepared;
  const v = prepared.value;
  const { studentId, serviceDate, direction, kind, location, note } = v;

  // 가드4(2026-11-15): 마감 — 등원·하원·둘 다 모두 수업 시작 1시간 전까지. 화면을 믿지 않고 서버가 막는다.
  if (!shuttleOpen(v.classTimes, serviceDate, direction, kstNow())) return { ok: false as const, message: CHANGE_CLOSED_MESSAGE };

  const saved = await saveShuttleException(prisma, v, parentUserId);
  if (!saved[0]) return { ok: false as const, message: "셔틀 변경을 저장하지 못했습니다." };
  if (!saved[0].changed) return { ok: true as const, id: saved[0].id, notification: null, noOp: true as const,
    notificationStatus: await readShuttleNotificationStatus(saved[0].id, "SUBMITTED", shuttleEventVersion({ direction, kind, location, note })) };

  const notification = await notifyAdminsOfShuttleException({
    studentName: v.studentName,
    studentId,
    serviceDate,
    direction,
    kind,
    location,
    recordId: saved[0].id,
    eventVersion: shuttleEventVersion({ direction, kind, location, note }),
  });

  return { ok: true as const, id: saved[0].id, notification,
    notificationStatus: await readShuttleNotificationStatus(saved[0].id, "SUBMITTED", shuttleEventVersion({ direction, kind, location, note })) };
}

/** 이 부모 자녀의 신청 한 건(취소됐어도 읽는다) — 취소·날짜 바꾸기의 마감 판정용. 남의 자녀 것은 0행. */
async function readOwnedException(parentUserId: string, id: string) {
  const rows = await prisma.$queryRawUnsafe<{
    id: string; studentId: string; serviceDate: string; direction: string; kind: string;
    location: string | null; note: string | null; canceled: boolean;
  }[]>(
    `SELECT x.id, x."studentId" AS "studentId", to_char(x."serviceDate",'YYYY-MM-DD') AS "serviceDate",
            x.direction, x.kind, x.location, x.note, (x."canceledAt" IS NOT NULL) AS canceled
       FROM "ShuttleDayException" x
       JOIN "Student" s ON s.id = x."studentId"
      WHERE x.id = $1 AND ${await childAccessSql("s", "$2")} AND ${notMergedStudent("s")}
      LIMIT 1`,
    id, parentUserId,
  );
  return rows[0] ?? null;
}

export async function cancelShuttleException(parentUserId: string, exceptionId: string) {
  const id = exceptionId?.trim();
  if (!id) return { ok: false as const, message: "취소할 신청을 찾을 수 없습니다." };

  type CanceledException = {
    id: string;
    studentId: string; studentName: string; serviceDate: string;
    direction: string; kind: string; location: string | null;
  };
  // 마감(2026-11-15): 살아 있는 내 신청이면 그 날짜·방향의 마감을 먼저 본다 — 지난 날짜·운행 뒤 취소를 막는다.
  // 내 자녀의 신청으로 읽히지 않으면(없는 id·남의 자녀) 여기서 끝낸다 — 마감 검사를 건너뛰는 길을 두지 않는다.
  // (이미 취소된 것은 아래 기존 길이 그대로 «성공 noOp»로 답한다. 소유 조건은 아래 UPDATE 에도 그대로 있다)
  const current = await readOwnedException(parentUserId, id);
  if (!current) return { ok: false as const, message: "취소할 신청을 찾을 수 없습니다." };
  if (!current.canceled) {
    const classTimes = (await loadClassTimes([current.studentId])).get(current.studentId);
    if (!shuttleOpen(classTimes, current.serviceDate, current.direction, kstNow())) {
      return { ok: false as const, message: CHANGE_CLOSED_MESSAGE };
    }
  }

  // 취소 UPDATE와 알림에 필요한 원본 확보를 한 문장으로 처리해 IDOR·경합 틈을 만들지 않는다.
  const canceled = await prisma.$queryRawUnsafe<CanceledException[]>(
      `UPDATE "ShuttleDayException" x
          SET "canceledAt" = now(), "updatedAt" = now()
         FROM "Student" s
        WHERE x."studentId" = s.id AND ${await childAccessSql("s", "$1")}
          AND x.id = $2 AND x."canceledAt" IS NULL
        RETURNING x.id, x."studentId" AS "studentId", s.name AS "studentName",
                  to_char(x."serviceDate",'YYYY-MM-DD') AS "serviceDate",
                  x.direction, x.kind, x.location`,
      parentUserId, id,
  );
  if (canceled.length === 0) {
    // 동일 취소 재요청은 실패가 아니다. 다른 부모의 기록 여부는 공개하지 않는다.
    const existing = await getParentShuttleExceptionStatus(parentUserId, id);
    if (existing?.canceled) return { ok: true as const, id, noOp: true as const, notification: null, notificationStatus: existing.notificationStatus };
    return { ok: false as const, message: "취소할 신청을 찾을 수 없습니다." };
  }
  const row = canceled[0];
  const notification = await notifyAdminsOfShuttleException({
    action: "CANCELED",
    studentName: row.studentName,
    studentId: row.studentId,
    serviceDate: row.serviceDate,
    direction: row.direction,
    kind: row.kind,
    location: row.location,
    recordId: row.id,
    eventVersion: "canceled",
  });
  return { ok: true as const, id, notification, notificationStatus: await readShuttleNotificationStatus(id, "CANCELED", "canceled") };
}

/** 트랜잭션 안에서 던져 «옮기기»를 통째로 되돌린다(메시지는 학부모에게 그대로 보인다) */
class ShuttleMoveRefusal extends Error {}

// ── «날짜 바꾸기» (2026-11-15 마감 통일·날짜 바꾸기) ────────────────────────────────────
// 옛 신청 취소 + 새 날짜 신청을 한 트랜잭션으로 한다. 실패하면 전부 되돌아가 옛 신청이 그대로 남는다.
//   · 방향·종류·장소·한마디는 옛 신청 그대로, 날짜만 바뀐다.
//   · 마감은 옛 날짜·새 날짜 양쪽에 적용한다.
//   · 새 날짜에 같은 방향 신청이 이미 있으면 기존 덮어쓰기 규칙 그대로(같은 내용이면 손대지 않음).
//   · 알림은 기존 두 통(취소 + 새 신청)을 그대로 쓴다 — 날짜마다 담당 기사님이 달라 한 통으로 합치지 않는다.
//     키가 신청 행 id 라, 같은 옮기기를 다시 눌러도(두 번째는 «찾을 수 없음»으로 거절) 중복 발송되지 않는다.
export async function moveShuttleException(parentUserId: string, input: { id?: unknown; serviceDate?: unknown }) {
  const id = typeof input?.id === "string" ? input.id.trim() : "";
  if (!id) return { ok: false as const, message: "바꿀 신청을 찾을 수 없습니다." };

  // 소유 확인 + 옛 신청 내용(취소된 것·남의 것은 여기서 끝)
  const current = await readOwnedException(parentUserId, id);
  if (!current || current.canceled) return { ok: false as const, message: "바꿀 신청을 찾을 수 없습니다." };
  if (input.serviceDate === current.serviceDate) return { ok: false as const, message: "지금 신청한 날짜와 같습니다. 다른 날짜를 골라 주세요." };

  // 새 날짜 검증 — 새 신청과 같은 검사(소유·수강·날짜 범위·복귀일)
  const prepared = await prepareShuttleChange(parentUserId, {
    studentId: current.studentId,
    serviceDate: input.serviceDate,
    direction: current.direction,
    kind: current.kind,
    location: current.kind === "LOCATION" ? current.location : undefined,
    note: current.note ?? undefined,
  });
  if (!prepared.ok) return prepared;
  const v = prepared.value;

  // 마감 — 옛 날짜·새 날짜 양쪽
  const now = kstNow();
  if (!shuttleOpen(v.classTimes, current.serviceDate, current.direction, now) || !shuttleOpen(v.classTimes, v.serviceDate, v.direction, now)) {
    return { ok: false as const, message: CHANGE_CLOSED_MESSAGE };
  }

  const access = await childAccessSql("s", "$1");
  let outcome: { oldRow: { id: string; studentName: string }; saved: { id: string; changed: boolean } };
  try {
    outcome = await prisma.$transaction(async (tx) => {
      // ① 옛 신청 취소 — 살아 있는 내 자녀 것만(그 사이 취소됐으면 0행 → 전체 중단)
      const canceled = await tx.$queryRawUnsafe<{ id: string; studentName: string }[]>(
        `UPDATE "ShuttleDayException" x
            SET "canceledAt" = now(), "updatedAt" = now()
           FROM "Student" s
          WHERE x."studentId" = s.id AND ${access} AND ${notMergedStudent("s")}
            AND x.id = $2 AND x."canceledAt" IS NULL
          RETURNING x.id, s.name AS "studentName"`,
        parentUserId, id,
      );
      if (canceled.length === 0) throw new ShuttleMoveRefusal("바꿀 신청을 찾을 수 없습니다.");
      // ② 새 날짜 저장 — 실패하면 던져서 ①도 되돌린다
      const saved = await saveShuttleException(tx, v, parentUserId);
      if (!saved[0]) throw new ShuttleMoveRefusal("셔틀 변경을 저장하지 못했습니다.");
      return { oldRow: canceled[0], saved: saved[0] };
    });
  } catch (error) {
    if (error instanceof ShuttleMoveRefusal) return { ok: false as const, message: error.message };
    throw error;
  }

  // 알림 ①: 옛 날짜 취소(기존 취소 알림과 같은 키·문구)
  const canceledNotification = await notifyAdminsOfShuttleException({
    action: "CANCELED",
    studentName: outcome.oldRow.studentName,
    studentId: current.studentId,
    serviceDate: current.serviceDate,
    direction: current.direction,
    kind: current.kind,
    location: current.location,
    recordId: current.id,
    eventVersion: "canceled",
  });
  const version = shuttleEventVersion({ direction: v.direction, kind: v.kind, location: v.location, note: v.note });
  // 알림 ②: 새 날짜 신청 — 새 날짜에 같은 내용이 이미 있었으면(changed=false) 새로 알릴 것이 없다
  const notification = outcome.saved.changed
    ? await notifyAdminsOfShuttleException({
        studentName: v.studentName,
        studentId: v.studentId,
        serviceDate: v.serviceDate,
        direction: v.direction,
        kind: v.kind,
        location: v.location,
        recordId: outcome.saved.id,
        eventVersion: version,
      })
    : canceledNotification;

  return {
    ok: true as const, id: outcome.saved.id, movedFrom: current.serviceDate, movedTo: v.serviceDate, notification,
    notificationStatus: await readShuttleNotificationStatus(outcome.saved.id, "SUBMITTED", version),
  };
}

export function shuttleEventVersion(input: { direction: string; kind: string; location: string | null; note: string | null }) {
  return createHash("sha256").update(JSON.stringify({ direction: input.direction, kind: input.kind, location: input.location, note: input.note })).digest("hex");
}

// «받은 사람이 기사님인가» — 알림을 보내는 쪽(operational-staff-notification 의 DRIVER_CONDITION)과 글자까지 같은 조건.
// 주 역할만 보면, 추가 역할(UserRoleGrant)로 기사인 분이 받았는데도 학부모 화면이 «학원에 알렸어요»라고 틀리게 말한다.
// 두 글자가 어긋나지 않게 tests/parent-delivery-view.test.mjs 가 비교한다(보내는 쪽 파일은 건드리지 않는다).
const DRIVER_CONDITION = `(u.role::text='DRIVER' OR EXISTS (SELECT 1 FROM "UserRoleGrant" g WHERE g."userId"=u.id AND g.role='DRIVER' AND g.status='ACTIVE'))`;

async function readShuttleNotificationStatus(id: string, action: "SUBMITTED" | "CANCELED", version: string) {
  try {
    const rows = await prisma.$queryRawUnsafe<DeliveryStatusRow[]>(
      // isDriver = 읽기 전용 컬럼 하나(발송 동작은 그대로). 사용자 행이 없으면(LEFT JOIN) false
      `SELECT d."recipientUserId", d."studentId", d.channel, d.status, d."errorCode", u.role::text AS role,
              COALESCE(u.id IS NOT NULL AND ${DRIVER_CONDITION}, false) AS "isDriver"
       FROM "NotificationDelivery" d LEFT JOIN "User" u ON u.id=d."recipientUserId"
       WHERE d."stableEventKey"=$1 AND d."audienceScope"='INTERNAL'`,
      `shuttle-day-exception:${id}:${action}:${version}`,
    );
    return summarizeDeliveryStatus(rows);
  } catch {
    // 장부 조회 실패를 '기록 없음'으로 바꾸지 않는다. 저장된 신청은 그대로 유지한다.
    return null;
  }
}

/** GET 재확인도 반드시 부모 소유권을 SQL에서 검증한다. 수신자 ID는 응답에 포함하지 않는다. */
export async function getParentShuttleExceptionStatus(parentUserId: string, id: string) {
  const rows = await prisma.$queryRawUnsafe<(ShuttleExceptionRow & { canceled: boolean })[]>(
    `SELECT x.id, x."studentId", s.name AS "studentName", to_char(x."serviceDate",'YYYY-MM-DD') AS "serviceDate",
       x.direction, x.kind, x.location, x.note, (x."canceledAt" IS NOT NULL) AS canceled
     FROM "ShuttleDayException" x JOIN "Student" s ON s.id=x."studentId"
     WHERE x.id=$1 AND ${await childAccessSql("s", "$2")} AND ${notMergedStudent("s")} LIMIT 1`, id, parentUserId,
  );
  const row = rows[0];
  if (!row) return null;
  return { ...row, notificationStatus: await readShuttleNotificationStatus(id, row.canceled ? "CANCELED" : "SUBMITTED", row.canceled ? "canceled" : shuttleEventVersion(row)) };
}

/**
 * 기사님 명단이 읽는 그날 예외 목록.
 *
 * 정규 셔틀 명단(RegularShuttleStop) 행엔 학생 id 가 없을 수 있다(시트 이관 시절 행은 **글자**만 있다).
 * 그래서 결석 매칭과 같은 방식으로 이름·전화로 이어 붙인다.
 */
export async function getShuttleExceptionsForDate(date: string): Promise<
  { name: string; phone: string | null; direction: string; kind: string; location: string | null }[]
> {
  try {
    const rows = await prisma.$queryRawUnsafe<{ name: string; phone: string | null; direction: string; kind: string; location: string | null }[]>(
      `SELECT s.name AS name, u.phone AS phone, x.direction, x.kind, x.location
         FROM "ShuttleDayException" x
         JOIN "Student" s ON s.id = x."studentId"
         LEFT JOIN "User" u ON u.id = s."parentId"
        WHERE x."serviceDate" = $1::date AND x."canceledAt" IS NULL AND ${notMergedStudent("s")}`,
      date,
    );
    return rows
      .map((row) => ({
        name: String(row.name ?? "").trim(),
        phone: (row.phone as string | null) ?? null,
        direction: row.direction,
        kind: row.kind,
        location: row.location ?? null,
      }))
      .filter((row) => row.name.length > 0);
  } catch (error) {
    // 예외 표를 못 읽어도 운행 명단 자체는 떠야 한다.
    console.error("[shuttle day exception] 조회 실패:", error);
    return [];
  }
}

export async function notifyAdminsOfShuttleException(input: {
  action?: "SUBMITTED" | "CANCELED";
  studentName: string;
  studentId: string;
  serviceDate: string;
  direction: string;
  kind: string;
  location: string | null;
  recordId: string;
  eventVersion: string;
  /** 학원(원장·부원장)이 대신 넣은 변경이면 true — 문구 끝에 «학원 입력»을 붙인다(대상·제목은 같다) */
  byAcademy?: boolean;
}) {
  try {
    const { notifyOperationalStaff } = await import("@/lib/operational-staff-notification");
    const { SHUTTLE_DIRECTION_LABEL, SHUTTLE_EXCEPTION_KIND_LABEL } = await import(
      "@/lib/shuttle/dayExceptionRules"
    );
    const what = input.kind === "SKIP"
      ? SHUTTLE_EXCEPTION_KIND_LABEL.SKIP
      : `${SHUTTLE_EXCEPTION_KIND_LABEL.LOCATION} (${input.location ?? "-"})`;
    return await notifyOperationalStaff({
      stableEventKey: `shuttle-day-exception:${input.recordId}:${input.action ?? "SUBMITTED"}:${input.eventVersion}`,
      eventType: `SHUTTLE_DAY_EXCEPTION_${input.action ?? "SUBMITTED"}`,
      studentId: input.studentId,
      type: "SHUTTLE_EXCEPTION",
      title: input.action === "CANCELED" ? "셔틀 당일 변경 취소" : "셔틀 당일 변경",
      message: `${input.studentName} · ${input.serviceDate} · ${SHUTTLE_DIRECTION_LABEL[input.direction as ShuttleDirection] ?? input.direction} · ${what}${input.action === "CANCELED" ? " · 취소" : ""}${input.byAcademy ? " · 학원 입력" : ""}`,
      linkUrl: "/admin/shuttle",
      staffLinkUrl: "/staff/shuttle",
      includeDriver: true,
      driverContext: {
        studentId: input.studentId,
        serviceDate: input.serviceDate,
        direction: input.direction as ShuttleDirection,
      },
    });
  } catch (error) {
    console.error("[parent-shuttle-exception] 원장 알림 실패:", error);
  }
}
