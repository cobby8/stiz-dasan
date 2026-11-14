// 학부모 «지각·조퇴 알리기»(2026-11-14 원장 결정표 묶음 B) — 서버 전용(알리기·시각 바꾸기·취소·화면 데이터).
// ─────────────────────────────────────────────────────────────────────────────
// 결석 알리기(parent-regular-absence.ts)와 같은 화면에서 쓰지만 성격이 다르다.
//   · 아이는 수업에 온다 → 보강권을 만들지 않는다(이 파일은 보강권·결석 표에 쓰지 않는다 — 테스트가 확인).
//   · 알릴 수 있는 시간: 지각 = 수업 시작 전까지, 조퇴 = 수업 끝나기 전까지(arrivalNoticeRules.isArrivalNoticeOpen).
//   · 승인 없이 바로 반영하고 원장·담당 선생님에게 앱 안 알림만 보낸다(문자·알림톡 없음).
//   · 조퇴(지각)로 알린 날 그 아이가 하원(등원) 셔틀을 타는 아이면 화면이 한 번 묻고, 안 탄다고 하면
//     «셔틀 변경 › 자차»와 같은 기록(ShuttleDayException · SKIP)을 같은 트랜잭션에서 만든다 → 기사님 화면에 반영.
//
// ★ 보안 가드(결석 알리기와 같은 수준):
//   1) IDOR — studentId 가 그 부모의 자녀(childAccessSql)이고 classId 가 그 학생의 «쓸 수 있는» 수강인지 SQL 로 재검증.
//   2) 날짜·시각은 서버 시계(KST)로 판정 — 그 반 요일, 목록 범위(오늘 포함 4주), 복귀 예정 반은 복귀일 이후.
//   3) 한 아이·한 반·하루에 지각 1건 + 조퇴 1건(DB 유일 키) — 다시 알리면 같은 행의 시각만 바뀐다.
//   4) 하루 변경 상한 — 알리기·시각 바꾸기·취소 합계 5번(changeCount). 넘으면 저장·알림 없이 ARRIVAL_CHANGE_LIMIT.
// ★ 표(RegularArrivalNotice)가 아직 없으면: 화면 데이터는 «쓸 수 없음»(입구 숨김), 쓰기는 ARRIVAL_UNAVAILABLE.
// ⚠️ PgBouncer → $queryRawUnsafe / $executeRawUnsafe 만.
import { childAccessSql } from "@/lib/account/child-access";
import { prisma } from "@/lib/prisma";
import { kstDow, kstHm, todayKst } from "@/lib/datetime/kst";
import { notMergedStudent } from "@/lib/studentVisibility";
import { BeforeResumeError, parentUsableEnrollmentSql, resumeFromSql, usableOn } from "@/lib/enrollment/resumeWindow";
import { computeUpcomingDates, dayIndexOf, isYmd, ymdToDayIndex } from "@/lib/regular/regularAbsenceRules";
import { ABSENCE_REPORT_WEEKS, type UpcomingChild } from "@/lib/regular/parent-regular-absence";
import { arrivalNoticeReady } from "@/lib/regular/arrival-notice-read";
import {
  ARRIVAL_KINDS,
  ARRIVAL_NOTICE_NAME,
  arrivalChangeLimitReached,
  arrivalNoticeLabel,
  arrivalTimesConsistent,
  isArrivalKind,
  isArrivalNoticeOpen,
  isValidExpectedTime,
  shuttleAskNeeded,
  shuttleLaterNoticeNeeded,
  shuttleDirectionOf,
  type ArrivalKind,
} from "@/lib/regular/arrivalNoticeRules";
import { MAX_DAYS_AHEAD, addDays } from "@/lib/shuttle/dayExceptionRules";
import { notifyAdminsOfShuttleException, saveShuttleException, shuttleEventVersion } from "@/lib/shuttle/parent-shuttle-exception";

// «지금»을 KST 글자(날짜·시각)로 — 달력 값은 공용 모듈(kst.ts)에서만 만든다(서버는 UTC 로 돈다).
function kstNow(): { ymd: string; hm: string } {
  const nowMs = Date.now();
  return { ymd: todayKst(nowMs), hm: kstHm(nowMs) };
}

/** 결석 알리기 화면의 한 줄(아이·반·날짜)에 붙는 지각·조퇴 정보 */
export type ArrivalNoticeView = {
  kind: ArrivalKind;
  expectedTime: string;
  /** «지각 예정 17:20» */
  label: string;
  /** 함께 만든 «셔틀 안 타요» 기록이 살아 있나 */
  shuttleSkipped: boolean;
};
export type ArrivalDateInfo = {
  endTime: string | null;
  /** 지금 알리거나·바꾸거나·취소할 수 있나(서버도 같은 함수로 다시 막는다 — 화면 표시용) */
  open: Record<ArrivalKind, boolean>;
  /** 알릴 때 셔틀을 물어볼 날인가(조퇴 → 하원 셔틀, 지각 → 등원 셔틀) */
  ask: Record<ArrivalKind, boolean>;
  /** 셔틀 질문이 안 뜨는 먼 날짜인데 그 방향 셔틀을 타는 아이인가 — «셔틀 변경에서 따로 알려 주세요» 한 줄을 보인다 */
  shuttleLater?: Record<ArrivalKind, boolean>;
  notices: ArrivalNoticeView[];
};
export type ParentArrivalScreen = { available: boolean; byKey: Record<string, ArrivalDateInfo> };

const keyOf = (studentId: string, classId: string, date: string) => `${studentId}|${classId}|${date}`;

type RosterRow = { studentId: string; weekday: number; direction: string };
type ExceptionRow = { studentId: string; ymd: string; direction: string; kind: string; id: string };

/** 셔틀 명단(그 달 이하 최신 명단 달)에서 그 학생들의 요일·방향 — 기사님 화면(pickServiceMonthFor)과 같은 기준 */
async function loadRosterDirections(studentIds: string[], month: string): Promise<RosterRow[]> {
  if (studentIds.length === 0) return [];
  return prisma.$queryRawUnsafe<RosterRow[]>(
    `SELECT r."studentId" AS "studentId", r.weekday, r.direction
       FROM "RegularShuttleStop" r
      WHERE r."studentId" = ANY($1::text[])
        AND r.direction IN ('BOARD','ALIGHT')
        AND r."serviceMonth" = (SELECT max(m."serviceMonth") FROM "RegularShuttleStop" m WHERE m."serviceMonth" <= $2)`,
    studentIds, month,
  );
}

/** 그 학생들의 살아 있는 셔틀 변경(날짜 범위) */
async function loadLiveExceptions(studentIds: string[], fromYmd: string, toYmd: string): Promise<ExceptionRow[]> {
  if (studentIds.length === 0) return [];
  return prisma.$queryRawUnsafe<ExceptionRow[]>(
    `SELECT x.id, x."studentId" AS "studentId", to_char(x."serviceDate",'YYYY-MM-DD') AS ymd, x.direction, x.kind
       FROM "ShuttleDayException" x
      WHERE x."studentId" = ANY($1::text[]) AND x."canceledAt" IS NULL
        AND x."serviceDate" >= $2::date AND x."serviceDate" <= $3::date`,
    studentIds, fromYmd, toYmd,
  );
}

/**
 * 셔틀을 물어볼 날인가 — 화면 데이터와 서버 재검증이 같은 재료·같은 규칙(shuttleAskNeeded)을 쓴다.
 * 셔틀 명단·변경 표를 못 읽으면 «묻지 않음»(지각·조퇴 알림 자체는 그대로 된다).
 */
function askFlags(
  studentId: string, date: string, today: string,
  rosterByMonth: Map<string, RosterRow[]>, exceptions: readonly ExceptionRow[],
): Record<ArrivalKind, boolean> {
  const weekday = kstDow(date);
  const rosterDirections = (rosterByMonth.get(date.slice(0, 7)) ?? [])
    .filter((row) => row.studentId === studentId && Number(row.weekday) === weekday)
    .map((row) => row.direction);
  const dayExceptions = exceptions.filter((x) => x.studentId === studentId && x.ymd === date);
  const withinShuttleWindow = date >= today && date <= addDays(today, MAX_DAYS_AHEAD);
  const flag = (kind: ArrivalKind) => shuttleAskNeeded({ kind, rosterDirections, exceptions: dayExceptions, withinShuttleWindow });
  return { LATE: flag("LATE"), EARLY: flag("EARLY") };
}

/**
 * 셔틀 질문이 뜨지 않는 먼 날짜(셔틀 변경을 받는 14일 범위 밖)에 그 방향 셔틀을 타는 아이인가 —
 * 화면이 «셔틀은 셔틀 변경에서 따로 알려 주세요» 한 줄을 보인다. 먼 달의 명단은 아직 없을 수 있어 읽어 둔 가장 늦은 달 명단으로 본다.
 */
function laterFlags(
  studentId: string, date: string, today: string, rosterByMonth: Map<string, RosterRow[]>,
): Record<ArrivalKind, boolean> {
  const weekday = kstDow(date);
  const lastMonth = [...rosterByMonth.keys()].sort().at(-1);
  const roster = rosterByMonth.get(date.slice(0, 7)) ?? (lastMonth ? rosterByMonth.get(lastMonth) : undefined) ?? [];
  const rosterDirections = roster.filter((row) => row.studentId === studentId && Number(row.weekday) === weekday).map((row) => row.direction);
  const withinShuttleWindow = date >= today && date <= addDays(today, MAX_DAYS_AHEAD);
  const flag = (kind: ArrivalKind) => shuttleLaterNoticeNeeded({ kind, rosterDirections, withinShuttleWindow });
  return { LATE: flag("LATE"), EARLY: flag("EARLY") };
}

async function loadShuttleMaterial(studentIds: string[], today: string) {
  const end = addDays(today, MAX_DAYS_AHEAD);
  const months = [...new Set([today.slice(0, 7), end.slice(0, 7)])];
  // 하나씩 차례로 읽는다 — DB 연결 한도(5)를 이 화면 하나가 한꺼번에 차지하지 않게(코드 리뷰 R4)
  const rosterByMonth = new Map<string, RosterRow[]>();
  for (const month of months) rosterByMonth.set(month, await loadRosterDirections(studentIds, month));
  const exceptions = await loadLiveExceptions(studentIds, today, end);
  return { rosterByMonth, exceptions };
}

/**
 * 결석 알리기 화면이 쓰는 지각·조퇴 정보 — 이미 읽어 둔 수업일 목록(내 자녀·쓸 수 있는 반만)에 덧붙인다.
 * 표가 없거나 조회가 실패하면 available=false — 화면은 «늦어요 · 일찍 가요» 입구만 숨기고 그대로 뜬다.
 */
export async function loadParentArrivalScreen(parentUserId: string, children: UpcomingChild[]): Promise<ParentArrivalScreen> {
  try {
    if (!(await arrivalNoticeReady())) return { available: false, byKey: {} };
    const now = kstNow();
    const studentIds = [...new Set(children.map((child) => child.studentId))];
    if (studentIds.length === 0) return { available: true, byKey: {} };

    const noticeRows = await prisma.$queryRawUnsafe<{
      studentId: string; classId: string; date: string; kind: string; expectedTime: string; shuttleLive: boolean;
    }[]>(
      // 권한: 로그인 부모의 자녀만(childAccessSql). 셔틀 기록은 «살아 있는가»만 본다
      `SELECT n."studentId" AS "studentId", n."classId" AS "classId", to_char(n.date,'YYYY-MM-DD') AS date,
              n.kind, n."expectedTime" AS "expectedTime",
              EXISTS (SELECT 1 FROM "ShuttleDayException" x
                       WHERE x.id = n."shuttleExceptionId" AND x."canceledAt" IS NULL) AS "shuttleLive"
         FROM "RegularArrivalNotice" n
         JOIN "Student" s ON s.id = n."studentId"
        WHERE ${await childAccessSql("s", "$1")} AND ${notMergedStudent("s")}
          AND n.status = 'REPORTED' AND n.date >= $2::date`,
      parentUserId, now.ymd,
    );
    // 셔틀 재료는 못 읽어도 알림 기능은 살린다(묻지 않을 뿐)
    const shuttle = await loadShuttleMaterial(studentIds, now.ymd).catch((error) => {
      console.error("[arrival-notice] 셔틀 재료 조회 실패(셔틀은 묻지 않음):", error instanceof Error ? error.name : "");
      return { rosterByMonth: new Map<string, RosterRow[]>(), exceptions: [] as ExceptionRow[] };
    });

    const byKey: Record<string, ArrivalDateInfo> = {};
    for (const child of children) {
      for (const cls of child.classes) {
        for (const d of cls.dates) {
          const endTime = cls.endTime ?? null;
          const notices = noticeRows
            .filter((row) => row.studentId === d.studentId && row.classId === d.classId && row.date === d.date && isArrivalKind(row.kind))
            .map((row): ArrivalNoticeView => ({
              kind: row.kind as ArrivalKind,
              expectedTime: row.expectedTime,
              label: arrivalNoticeLabel(row.kind, row.expectedTime),
              shuttleSkipped: row.shuttleLive === true,
            }))
            // 지각 → 조퇴 순
            .sort((a, b) => ARRIVAL_KINDS.indexOf(a.kind) - ARRIVAL_KINDS.indexOf(b.kind));
          byKey[keyOf(d.studentId, d.classId, d.date)] = {
            endTime,
            open: {
              LATE: isArrivalNoticeOpen("LATE", d.date, d.startTime, endTime, now.ymd, now.hm),
              EARLY: isArrivalNoticeOpen("EARLY", d.date, d.startTime, endTime, now.ymd, now.hm),
            },
            ask: askFlags(d.studentId, d.date, now.ymd, shuttle.rosterByMonth, shuttle.exceptions),
            shuttleLater: laterFlags(d.studentId, d.date, now.ymd, shuttle.rosterByMonth),
            notices,
          };
        }
      }
    }
    return { available: true, byKey };
  } catch (error) {
    console.error("[arrival-notice] 화면 데이터 조회 실패(결석 화면은 계속):", error instanceof Error ? error.name : "");
    return { available: false, byKey: {} };
  }
}

type OwnedClass = {
  dayOfWeek: string; startTime: string | null; endTime: string | null;
  studentName: string; className: string; status: string; resumeFrom: string | null;
};

// 소유권 재검증: studentId 가 부모 자녀이고 classId 가 그 학생이 «쓸 수 있는» 수강인지(결석 알리기와 같은 조건).
async function verifyOwnedClass(parentUserId: string, studentId: string, classId: string): Promise<OwnedClass | null> {
  const rows = await prisma.$queryRawUnsafe<OwnedClass[]>(
    `SELECT c."dayOfWeek" AS "dayOfWeek", c."startTime" AS "startTime", c."endTime" AS "endTime",
            s.name AS "studentName", c.name AS "className",
            e.status AS status, ${resumeFromSql("e")} AS "resumeFrom"
       FROM "Enrollment" e
       JOIN "Student" s ON s.id = e."studentId"
       JOIN "Class" c ON c.id = e."classId"
      WHERE ${await childAccessSql("s", "$1")} AND ${notMergedStudent("s")}
        AND e."studentId" = $2
        AND e."classId" = $3
        AND ${parentUsableEnrollmentSql("e")}
      LIMIT 1`,
    parentUserId, studentId, classId,
  );
  return rows[0] ?? null;
}

/** 원장·담당 선생님에게 앱 안 알림(문자·알림톡 없음). 알림 실패가 저장을 되돌리지 않게 오류는 여기서 삼킨다 */
async function notifyStaffOfArrivalNotice(input: {
  action: "REPORTED" | "CANCELED";
  kind: ArrivalKind; expectedTime: string;
  studentName: string; className: string; classId: string; studentId: string; date: string;
  recordId: string; eventVersion: string;
}) {
  try {
    const { notifyOperationalStaff } = await import("@/lib/operational-staff-notification");
    const name = ARRIVAL_NOTICE_NAME[input.kind];
    const what = input.kind === "LATE" ? `${input.expectedTime} 도착 예정` : `${input.expectedTime}에 나갈 예정`;
    return await notifyOperationalStaff({
      stableEventKey: `arrival-notice:${input.recordId}:${input.action}:${input.eventVersion}`,
      eventType: `ARRIVAL_NOTICE_${input.action}`,
      studentId: input.studentId,
      // 분류는 결석과 같은 «ABSENCE»(출결 묶음) — 이 값은 발송 장부의 trigger 로만 쓰이고, 관리자 «운영 알림 전달 현황»이
      // ABSENCE·SHUTTLE_EXCEPTION 두 묶음만 읽는다. 새 값을 만들면 그 화면에서 지각·조퇴 알림이 보이지 않는다(코드 리뷰 R6).
      type: "ABSENCE",
      title: input.action === "REPORTED" ? `${name} 알림` : `${name} 알림 취소`,
      message: input.action === "REPORTED"
        ? `${input.studentName} 학생이 ${input.date} ${input.className} 수업에 ${name}입니다. (${what})`
        : `${input.studentName} 학생의 ${input.date} ${input.className} ${name} 알림이 취소되었습니다.`,
      linkUrl: "/admin/attendance",
      staffLinkUrl: "/staff",
      classId: input.classId,
      includeCoach: true,
    });
  } catch (error) {
    console.error("[arrival-notice] 원장·선생님 알림 실패:", error instanceof Error ? error.name : "");
  }
}

export type SubmitArrivalNoticeInput = {
  studentId?: unknown; classId?: unknown; date?: unknown; kind?: unknown; expectedTime?: unknown;
  /** «하원(등원) 셔틀도 안 타요»를 골랐나 — 서버가 «물어볼 날»인지 다시 본 뒤에만 셔틀 기록을 만든다 */
  skipShuttle?: unknown;
};

// ── 알리기 · 시각 바꾸기(같은 길 — 이미 알린 줄에서 다른 시각으로 다시 보내면 시각만 바뀐다) ─────────────
export async function submitArrivalNotice(parentUserId: string, input: SubmitArrivalNoticeInput) {
  const studentId = typeof input?.studentId === "string" ? input.studentId.trim() : "";
  const classId = typeof input?.classId === "string" ? input.classId.trim() : "";
  const date = typeof input?.date === "string" ? input.date.trim() : "";
  const expectedTime = typeof input?.expectedTime === "string" ? input.expectedTime.trim() : "";
  if (!studentId || !classId) throw new Error("STUDENT_OR_CLASS_MISSING");
  if (!isYmd(date)) throw new Error("INVALID_DATE");
  if (!isArrivalKind(input?.kind)) throw new Error("ARRIVAL_INVALID_KIND");
  const kind: ArrivalKind = input.kind;
  if (!(await arrivalNoticeReady())) throw new Error("ARRIVAL_UNAVAILABLE");

  // 가드1: 소유권 + 반 소속 재검증(클라 값 불신뢰)
  const owned = await verifyOwnedClass(parentUserId, studentId, classId);
  if (!owned) throw new Error("NOT_OWNER");
  // 복귀 예정 반: 복귀일 전 날짜는 아직 휴원이다
  if (!usableOn(owned.status, owned.resumeFrom, date)) {
    if (owned.resumeFrom) throw new BeforeResumeError(owned.resumeFrom);
    throw new Error("NOT_OWNER");
  }

  // 가드2: 그 반 요일 + 목록 범위(오늘 포함 4주) + 알릴 수 있는 시간(지각 = 시작 전, 조퇴 = 끝나기 전)
  const now = kstNow();
  const dayMatches = dayIndexOf(owned.dayOfWeek) != null && dayIndexOf(owned.dayOfWeek) === ymdToDayIndex(date);
  if (!dayMatches || date < now.ymd) throw new Error("NOT_REPORTABLE_DATE");
  if (!computeUpcomingDates(now.ymd, owned.dayOfWeek, ABSENCE_REPORT_WEEKS, true).includes(date)) throw new Error("ABSENCE_TOO_FAR");
  if (!isArrivalNoticeOpen(kind, date, owned.startTime, owned.endTime, now.ymd, now.hm)) {
    throw new Error(kind === "LATE" ? "ARRIVAL_CLOSED_LATE" : "ARRIVAL_CLOSED_EARLY");
  }
  // 예상 시각은 수업 시간 안(시작 뒤 ~ 끝 전)
  if (!isValidExpectedTime(expectedTime, owned.startTime, owned.endTime)) throw new Error("ARRIVAL_INVALID_TIME");

  // 그날 결석을 알렸으면 지각·조퇴를 받지 않는다(결석을 먼저 취소)
  const absent = await prisma.$queryRawUnsafe<{ id: string }[]>(
    `SELECT id FROM "RegularAbsence"
      WHERE "studentId" = $1 AND "classId" = $2 AND date = $3::date AND status IN ('REPORTED','CONFIRMED') LIMIT 1`,
    studentId, classId, date,
  );
  if (absent[0]) throw new Error("ARRIVAL_ABSENT");

  // 같은 날의 기존 알림(지각·조퇴) — 같은 내용 다시 보내기 판정 + 지각·조퇴 시각 순서 확인
  const existing = await prisma.$queryRawUnsafe<{ kind: string; expectedTime: string; status: string; changeCount: number }[]>(
    `SELECT kind, "expectedTime" AS "expectedTime", status, "changeCount" AS "changeCount" FROM "RegularArrivalNotice"
      WHERE "studentId" = $1 AND "classId" = $2 AND date = $3::date`,
    studentId, classId, date,
  );
  const live = (k: ArrivalKind) => existing.find((row) => row.kind === k && row.status === "REPORTED") ?? null;
  const lateTime = kind === "LATE" ? expectedTime : live("LATE")?.expectedTime ?? null;
  const earlyTime = kind === "EARLY" ? expectedTime : live("EARLY")?.expectedTime ?? null;
  if (!arrivalTimesConsistent(lateTime, earlyTime)) throw new Error("ARRIVAL_TIME_ORDER");

  // 셔틀: «안 타요»를 골랐어도 서버가 «물어볼 날»(명단에 그 방향이 있고 아직 안 탄다고 하지 않은 날)인지 다시 본다
  let wantSkip = false;
  if (input?.skipShuttle === true) {
    const shuttle = await loadShuttleMaterial([studentId], now.ymd).catch(() => null);
    wantSkip = shuttle ? askFlags(studentId, date, now.ymd, shuttle.rosterByMonth, shuttle.exceptions)[kind] : false;
  }

  const same = live(kind);
  if (same && same.expectedTime === expectedTime && !wantSkip) {
    return { ok: true as const, noOp: true as const, kind, expectedTime, shuttleSkipped: false };
  }
  // 하루 변경 상한(알리기·시각 바꾸기·취소 합계 5번) — 넘으면 저장도 알림도 하지 않는다
  if (arrivalChangeLimitReached(existing.map((row) => row.changeCount))) throw new Error("ARRIVAL_CHANGE_LIMIT");

  const direction = shuttleDirectionOf(kind);
  // 셔틀 기록의 한마디 — 학부모 «셔틀 변경» 목록·기사님 알림에서 왜 안 타는지 보이게
  const shuttleNote = kind === "LATE" ? "지각으로 등원 셔틀 안 타요" : "조퇴로 하원 셔틀 안 타요";
  const outcome = await prisma.$transaction(async (tx) => {
    // 한 아이·한 반·하루·종류당 1건 — 취소했던 줄은 되살리고(옛 셔틀 연결은 지운다), 알린 줄은 시각만 바꾼다
    const saved = await tx.$queryRawUnsafe<{ id: string; eventVersion: string }[]>(
      `INSERT INTO "RegularArrivalNotice"
          ("studentId","classId",date,kind,"expectedTime",status,"reportedByUserId","changeCount")
       VALUES ($1,$2,$3::date,$4,$5,'REPORTED',$6,1)
       ON CONFLICT ("studentId","classId",date,kind) DO UPDATE
          SET "expectedTime" = EXCLUDED."expectedTime",
              status = 'REPORTED',
              "reportedByUserId" = EXCLUDED."reportedByUserId",
              "shuttleExceptionId" = CASE WHEN "RegularArrivalNotice".status = 'CANCELLED' THEN NULL
                                          ELSE "RegularArrivalNotice"."shuttleExceptionId" END,
              "changeCount" = "RegularArrivalNotice"."changeCount" + 1,
              "updatedAt" = now()
       RETURNING id, to_char("updatedAt",'YYYYMMDDHH24MISSUS') AS "eventVersion"`,
      studentId, classId, date, kind, expectedTime, parentUserId,
    );
    if (!saved[0]) throw new Error("ARRIVAL_SAVE_FAILED");
    let shuttleId: string | null = null;
    if (wantSkip) {
      // «셔틀 변경 › 자차»와 같은 저장 문장(saveShuttleException) — 기사님 명단은 기존 읽기 경로 그대로 반영된다.
      // 셔틀의 «1시간 전» 마감은 적용하지 않는다: 이 기록은 지각·조퇴 알림에 딸린 것이라 알림의 시간 규칙을 따른다.
      const shuttle = await saveShuttleException(tx, { studentId, serviceDate: date, direction, kind: "SKIP", location: null, note: shuttleNote }, parentUserId);
      if (!shuttle[0]) throw new Error("ARRIVAL_SAVE_FAILED");
      // 새로 만든 기록만 이 알림에 잇는다(이미 있던 같은 기록은 학부모가 따로 낸 것 — 알림을 취소해도 건드리지 않는다)
      if (shuttle[0].changed) {
        shuttleId = shuttle[0].id;
        await tx.$executeRawUnsafe(
          `UPDATE "RegularArrivalNotice" SET "shuttleExceptionId" = $2 WHERE id = $1`,
          saved[0].id, shuttleId,
        );
      }
    }
    return { saved: saved[0], shuttleId };
  });

  await notifyStaffOfArrivalNotice({
    action: "REPORTED", kind, expectedTime,
    studentName: owned.studentName, className: owned.className, classId, studentId, date,
    recordId: outcome.saved.id, eventVersion: `${outcome.saved.eventVersion}-${expectedTime.replace(":", "")}`,
  });
  // 셔틀 기록을 새로 만들었으면 기사님에게도 기존 «셔틀 당일 변경» 알림 그대로
  if (outcome.shuttleId) {
    await notifyAdminsOfShuttleException({
      studentName: owned.studentName, studentId, serviceDate: date, direction, kind: "SKIP", location: null,
      recordId: outcome.shuttleId,
      eventVersion: shuttleEventVersion({ direction, kind: "SKIP", location: null, note: shuttleNote }),
    });
  }
  return { ok: true as const, kind, expectedTime, changed: Boolean(same), shuttleSkipped: Boolean(outcome.shuttleId) };
}

// ── 취소 ─────────────────────────────────────────────────────────────────────
// 본인(부모 자녀)의 알린(REPORTED) 건만. 알릴 수 있는 시간과 같은 규칙으로 막는다(지각 = 시작 전, 조퇴 = 끝나기 전).
// 이 알림과 함께 만든 «셔틀 안 타요» 기록이 살아 있으면 같이 취소한다(아이가 평소대로 셔틀을 탄다).
export async function cancelArrivalNotice(parentUserId: string, input: { studentId?: unknown; classId?: unknown; date?: unknown; kind?: unknown }) {
  const studentId = typeof input?.studentId === "string" ? input.studentId.trim() : "";
  const classId = typeof input?.classId === "string" ? input.classId.trim() : "";
  const date = typeof input?.date === "string" ? input.date.trim() : "";
  if (!studentId || !classId || !isYmd(date) || !isArrivalKind(input?.kind)) throw new Error("ARRIVAL_NOT_FOUND");
  const kind: ArrivalKind = input.kind;
  if (!(await arrivalNoticeReady())) throw new Error("ARRIVAL_UNAVAILABLE");

  // 소유 확인 + 마감 판정에 쓸 반 시각(남의 자녀·없는 알림은 0행)
  const access = await childAccessSql("s", "$1");
  const current = await prisma.$queryRawUnsafe<{
    id: string; expectedTime: string; startTime: string | null; endTime: string | null; studentName: string; className: string;
  }[]>(
    `SELECT n.id, n."expectedTime" AS "expectedTime", c."startTime" AS "startTime", c."endTime" AS "endTime",
            s.name AS "studentName", c.name AS "className"
       FROM "RegularArrivalNotice" n
       JOIN "Student" s ON s.id = n."studentId"
       JOIN "Class" c ON c.id = n."classId"
      WHERE ${access} AND ${notMergedStudent("s")}
        AND n."studentId" = $2 AND n."classId" = $3 AND n.date = $4::date AND n.kind = $5 AND n.status = 'REPORTED'
      LIMIT 1`,
    parentUserId, studentId, classId, date, kind,
  );
  if (!current[0]) throw new Error("ARRIVAL_NOT_FOUND");
  const now = kstNow();
  if (!isArrivalNoticeOpen(kind, date, current[0].startTime, current[0].endTime, now.ymd, now.hm)) {
    throw new Error(kind === "LATE" ? "ARRIVAL_CLOSED_LATE" : "ARRIVAL_CLOSED_EARLY");
  }
  // 하루 변경 상한 — 취소도 한 번으로 센다(알리기·취소를 되풀이해 알림을 쏟아내지 못하게)
  const counts = await prisma.$queryRawUnsafe<{ total: number }[]>(
    `SELECT COALESCE(SUM("changeCount"), 0)::int AS total FROM "RegularArrivalNotice"
      WHERE "studentId" = $1 AND "classId" = $2 AND date = $3::date`,
    studentId, classId, date,
  );
  if (arrivalChangeLimitReached([counts[0]?.total])) throw new Error("ARRIVAL_CHANGE_LIMIT");

  const outcome = await prisma.$transaction(async (tx) => {
    const canceled = await tx.$queryRawUnsafe<{ id: string; shuttleExceptionId: string | null; eventVersion: string }[]>(
      `UPDATE "RegularArrivalNotice"
          SET status = 'CANCELLED', "changeCount" = "changeCount" + 1, "updatedAt" = now()
        WHERE id = $1 AND "studentId" = $2 AND status = 'REPORTED'
        RETURNING id, "shuttleExceptionId" AS "shuttleExceptionId", to_char("updatedAt",'YYYYMMDDHH24MISSUS') AS "eventVersion"`,
      current[0].id, studentId,
    );
    if (!canceled[0]) throw new Error("ARRIVAL_NOT_FOUND");
    // 함께 만든 셔틀 기록(이 학생 것 · 아직 살아 있을 때만)
    const shuttle = canceled[0].shuttleExceptionId
      ? await tx.$queryRawUnsafe<{ id: string; direction: string; kind: string; location: string | null }[]>(
          `UPDATE "ShuttleDayException"
              SET "canceledAt" = now(), "updatedAt" = now()
            WHERE id = $1 AND "studentId" = $2 AND "canceledAt" IS NULL
            RETURNING id, direction, kind, location`,
          canceled[0].shuttleExceptionId, studentId,
        )
      : [];
    return { canceled: canceled[0], shuttle: shuttle[0] ?? null };
  });

  await notifyStaffOfArrivalNotice({
    action: "CANCELED", kind, expectedTime: current[0].expectedTime,
    studentName: current[0].studentName, className: current[0].className, classId, studentId, date,
    recordId: outcome.canceled.id, eventVersion: outcome.canceled.eventVersion,
  });
  if (outcome.shuttle) {
    await notifyAdminsOfShuttleException({
      action: "CANCELED", studentName: current[0].studentName, studentId, serviceDate: date,
      direction: outcome.shuttle.direction, kind: outcome.shuttle.kind, location: outcome.shuttle.location,
      recordId: outcome.shuttle.id, eventVersion: "canceled",
    });
  }
  return { ok: true as const, kind, shuttleRestored: Boolean(outcome.shuttle) };
}
