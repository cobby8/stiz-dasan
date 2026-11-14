import { childAccessSql } from "@/lib/account/child-access";
import { prisma } from "@/lib/prisma";
import { isMakeupCreditIssuableYmd } from "@/lib/makeup/credit-service";
import {
  issueCreditForReportedAbsence,
  regularAbsenceSourceKey,
  settleCreditOnAbsenceCancel,
} from "@/lib/makeup/absence-report-credit";
import { kstAt, kstHm, todayKst } from "@/lib/datetime/kst";
import { lockCompensation, type CompensationTransaction } from "@/lib/billing/absence-compensation-guard";
import { createHash } from "node:crypto";
import { notMergedStudent } from "@/lib/studentVisibility";
import { BeforeResumeError, parentUsableEnrollmentSql, resumeFromSql, usableOn } from "@/lib/enrollment/resumeWindow";
import { closeIllnessReviewInTx, convertIllnessToMakeupInTx, illnessReviewReady, openIllnessReviewInTx } from "@/lib/regular/illness-carry-tx";
import {
  ILLNESS_REASON,
  canAddEvidence,
  canEditEvidence,
  evidenceAnchorYmdSql,
  evidenceScopeSql,
  evidenceDeadlineYmd,
  illnessReviewLabel,
  isValidReasonText,
  normalizeReasonText,
  type IllnessReviewSource,
} from "@/lib/regular/illnessCarryRules";
import {
  REASON_LABEL,
  DAY_KO,
  isValidReason,
  isYmd,
  isReportableAt,
  isAbsenceChangeOpen,
  computeUpcomingDates,
  ymdToDayIndex,
} from "@/lib/regular/regularAbsenceRules";

// ── 정규 수업 "학부모 사전 결석 신고"(#3 Step B) ──────────────────────────
// 학부모가 자녀의 "아직 오지 않은" 정규 수업일을 사유와 함께 미리 결석 신고/취소한다.
//
// 방학특강(parent-absence.ts)은 좌석(SpecialProgramEnrollmentDate)·전화번호 기준이지만,
// 정규는 "Student.parentId(=로그인 부모 계정)" 기준이고, 실제 좌석 레코드가 없어
// Class 요일/시각으로 "향후 N주 수업일 목록"을 계산해 신고를 받는다.
//
// ★ 3대 보안 가드(반드시 유지):
//   1) IDOR 방어 — studentId 가 그 부모(appUserId)의 자녀인지, classId 가 그 학생의
//      «쓸 수 있는» Enrollment 인지 SQL 로 재검증. 클라이언트가 보낸 값 자체를 신뢰하지 않는다.
//      (2026-11-14 복귀 예정) 쓸 수 있는 수강 = ACTIVE 또는 «복귀 승인된 휴원 반»(resumeWindow 한 곳의 규칙).
//      복귀 예정 반은 복귀일 이후 날짜만 받는다 — 목록·신고·취소 모두 서버가 다시 본다.
//   2) 확정건 보호 — 관리자가 확정(CONFIRMED)한 건은 학부모가 덮어쓰거나 취소하지 못한다
//      (INSERT ... ON CONFLICT DO UPDATE WHERE status<>'CONFIRMED', UPDATE WHERE status='REPORTED').
//   3) 마감 전 + 요일 일치 — 지난 날짜, 그 반 요일과 맞지 않는 날짜는 신고 불가.
//      (2026-11-14 결석 당일 취소·보강 연결) 오늘 수업도 «시작 1시간 전»까지 신고·취소·사유 변경을 받는다.
//      마감 판정은 regularAbsenceRules.isAbsenceChangeOpen 하나 — 신고·취소 양쪽에서 서버가 강제한다.

// 향후 몇 주치 수업일을 보여줄지(기본 4주).
const DEFAULT_WEEKS = 4;
// 신고를 받는 범위도 목록과 같다(2026-11-14 검수) — 화면에서 고를 수 없는 먼 날짜를 API 로 직접 보내
// 건마다 보강권을 받아 가는 길을 막는다. 카카오 결석(ABSENCE_WEEKS)도 4주라 같은 범위다.
export const ABSENCE_REPORT_WEEKS = DEFAULT_WEEKS;

// «지금»을 KST 글자(날짜·시각)로 — 달력 값은 공용 모듈(kst.ts)에서만 만든다(서버는 UTC 로 돈다).
function kstNow(): { ymd: string; hm: string } {
  const nowMs = Date.now();
  return { ymd: todayKst(nowMs), hm: kstHm(nowMs) };
}

// "8/5(화)" 라벨 만들기(표시용).
function dateLabel(ymd: string): string {
  const idx = ymdToDayIndex(ymd);
  const mm = Number(ymd.slice(5, 7));
  const dd = Number(ymd.slice(8, 10));
  const ko = idx == null ? "" : DAY_KO[idx];
  return `${mm}/${dd}(${ko})`;
}

/**
 * 원장 신청함의 «질병·부상 결석»만 보기 — 질병·부상 신고 알림이 여는 곳.
 * 원장은 여기서 사진을 보고 고른다. 사유 글(건강 정보)은 알림 본문에 싣지 않는다.
 */
export const ILLNESS_INBOX_HREF = "/admin/inbox?kind=ILLNESS_CARRY";

export type UpcomingClassDate = {
  studentId: string;
  studentName: string;
  classId: string;
  className: string;
  date: string; // YYYY-MM-DD
  dateLabel: string;
  startTime: string;
  // 이 날짜에 기존 결석 신고가 있으면 그 상태/사유(없으면 null)
  reason: string | null;
  reasonLabel: string | null;
  status: string | null; // REPORTED | CONFIRMED | (CANCELLED 는 조회에서 제외)
  reported: boolean;
  locked: boolean; // 관리자 확정(CONFIRMED)이면 학부모가 못 건드림
  // 지금 신고·취소·사유 변경을 받을 수 있나(수업 시작 1시간 전까지). false 면 화면이 «학원으로 연락» 글을 보인다.
  // 서버도 같은 함수로 다시 막는다 — 이 값은 화면 표시용일 뿐이다.
  changeOpen: boolean;
  // 이 결석의 보강권 상태(AVAILABLE·RESERVED·USED·NO_SHOW, 없으면 null) — 신고 취소 확인 문구·막기에 쓴다
  makeupCredit: string | null;
  // 질병·부상 결석의 이월 검토 상태(PENDING·APPROVED·MAKEUP, 없으면 null) — 줄에 «이월 검토 중» 같은 한 단어로 보인다
  carryReview: string | null;
};

/** 질병·부상 결석 한 건의 이월 검토(학부모 화면 «질병·부상 결석» 칸) */
export type ParentIllnessReview = {
  absenceId: string;
  studentId: string;
  studentName: string;
  classId: string;
  className: string;
  date: string;
  dateLabel: string;
  status: string; // PENDING | APPROVED | MAKEUP
  statusLabel: string;
  /** 사진을 올릴 수 있는 마지막 날 라벨(예: "11/21(토)") */
  deadlineLabel: string;
  /** 지금 사진을 지울 수 있나(검토 중 + 7일 안) */
  canEdit: boolean;
  /** 지금 한 장 더 올릴 수 있나(위 조건 + 3장 미만) */
  canAdd: boolean;
  /** 살아 있는 사진 — mine=내가 올린 것(내 것만 열어 볼 수 있다) */
  photos: { id: string; mine: boolean }[];
  /** «여러 날 결석»의 한 날이면 그 기간 id(하루 결석은 null) — 화면은 같은 기간을 한 줄로 묶어 보인다 */
  periodId: string | null;
  /** 이 줄이 대표하는 결석 수(하루 결석 1, 묶인 기간이면 n) */
  count?: number;
};

/**
 * 이 부모 자녀들의 질병·부상 이월 검토 목록(최근 90일 결석, 최신순).
 * 표가 아직 없거나(마이그레이션 전) 조회가 실패하면 빈 목록 — 결석 화면 자체는 떠야 한다.
 * 사유 글(건강 정보)은 내려보내지 않는다.
 */
export async function getParentIllnessReviews(parentUserId: string): Promise<ParentIllnessReview[]> {
  try {
    const rows = await prisma.$queryRawUnsafe<any[]>(
      `SELECT ra.id AS "absenceId", s.id AS "studentId", s.name AS "studentName",
              ra."classId" AS "classId", c.name AS "className", to_char(ra.date, 'YYYY-MM-DD') AS "date",
              r.status AS status,
              to_char(r."requestedAt" AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD') AS "requestedYmd",
              ra."periodId" AS "periodId",
              -- 여러 날 결석: 기한 기준은 기간의 마지막 결석일, 사진은 기간 한 묶음
              ${evidenceAnchorYmdSql("ra")} AS "anchorYmd",
              COALESCE((SELECT json_agg(json_build_object('id', e.id, 'mine', e."uploadedByUserId" = $1) ORDER BY e."createdAt")
                          FROM "RegularAbsenceEvidence" e
                         WHERE ${evidenceScopeSql("ra", "e")} AND e."removedAt" IS NULL), '[]'::json) AS photos
         FROM "RegularAbsenceCarryReview" r
         JOIN "RegularAbsence" ra ON ra.id = r."absenceId"
         JOIN "Student" s ON s.id = ra."studentId"
         LEFT JOIN "Class" c ON c.id = ra."classId"
        WHERE ${await childAccessSql("s", "$1")} AND ${notMergedStudent("s")}
          AND r.status IN ('PENDING', 'APPROVED', 'MAKEUP')
          AND ra.status <> 'CANCELLED'
          AND ra.date >= ((now() AT TIME ZONE 'Asia/Seoul')::date - 90)
        ORDER BY ra.date DESC, s.name ASC
        LIMIT 30`,
      parentUserId,
    );
    const today = todayKst();
    return rows.map((r) => {
      const photos: { id: string; mine: boolean }[] = (typeof r.photos === "string" ? JSON.parse(r.photos) : r.photos) ?? [];
      // 7일 기준점 = 알린 날과 결석일 중 더 늦은 날(규칙 함수 한 곳)
      const anchorYmd: string = r.anchorYmd ?? r.date;
      const window = { status: r.status, requestedYmd: r.requestedYmd, absenceYmd: anchorYmd, todayYmd: today };
      return {
        absenceId: r.absenceId,
        studentId: r.studentId,
        studentName: r.studentName,
        classId: r.classId,
        className: r.className ?? "",
        date: r.date,
        dateLabel: dateLabel(r.date),
        status: r.status,
        statusLabel: illnessReviewLabel(r.status) ?? "",
        deadlineLabel: dateLabel(evidenceDeadlineYmd(r.requestedYmd, anchorYmd)),
        canEdit: canEditEvidence(window),
        canAdd: canAddEvidence({ ...window, photoCount: photos.length }),
        photos: photos.map((photo) => ({ id: String(photo.id), mine: photo.mine === true })),
        periodId: r.periodId ?? null,
      };
    });
  } catch (error) {
    // 표가 없는 환경(마이그레이션 전)도 여기로 온다 — 이름만 남긴다(사유 글이 로그에 실리지 않게)
    console.error("[parent-regular-absence] 이월 검토 조회 실패(화면은 계속):", error instanceof Error ? error.name : "");
    return [];
  }
}

export type UpcomingChild = {
  studentId: string;
  studentName: string;
  classes: {
    classId: string;
    className: string;
    dayOfWeek: string;
    startTime: string;
    // 복귀 승인된 휴원 반이면 복귀일("YYYY-MM-DD") — 그날 이후 수업만 dates 에 들어 있다. 다니는 반은 null
    resumeFrom: string | null;
    dates: UpcomingClassDate[];
  }[];
};

/** 부모 자녀가 «쓸 수 있는» 수강 반 한 줄(다니는 반 + 복귀 승인된 휴원 반) */
export type ParentUsableClass = {
  studentId: string; studentName: string; classId: string; className: string;
  dayOfWeek: string; startTime: string; enrollmentStatus: string; resumeFrom: string | null;
};

/**
 * 부모 자녀의 «쓸 수 있는» 수강 반 — 하루 알리기 목록과 «여러 날 결석»이 같은 조회·같은 권한 조건을 쓴다.
 * (IDOR: childAccessSql — 로그인 부모의 자녀만. 병합된 학생 제외)
 */
export async function listParentUsableClasses(parentUserId: string): Promise<ParentUsableClass[]> {
  return prisma.$queryRawUnsafe<ParentUsableClass[]>(
    `SELECT s.id AS "studentId", s.name AS "studentName",
            c.id AS "classId", c.name AS "className",
            c."dayOfWeek" AS "dayOfWeek", c."startTime" AS "startTime",
            e.status AS "enrollmentStatus", ${resumeFromSql("e")} AS "resumeFrom"
       FROM "Student" s
       JOIN "Enrollment" e ON e."studentId" = s.id AND ${parentUsableEnrollmentSql("e")}
       JOIN "Class" c ON c.id = e."classId"
      WHERE ${await childAccessSql("s", "$1")} AND ${notMergedStudent("s")}
      ORDER BY s.name ASC, c."startTime" ASC`,
    parentUserId,
  );
}

// ── 1) 다가오는 정규 수업일 목록 ─────────────────────────────────────────
// 부모(appUserId)의 자녀별 ACTIVE Enrollment → 반 요일/시각으로 향후 N주 수업일 생성 +
// 각 날짜에 기존 RegularAbsence(있으면 상태) 조인.
export async function getUpcomingRegularClassDates(
  parentUserId: string,
  weeks: number = DEFAULT_WEEKS,
  // 이미 읽어 둔 이월 검토 목록(화면이 두 목록을 함께 쓸 때 한 번만 읽게). 안 주면 줄의 검토 상태는 비운다
  reviews: ParentIllnessReview[] = [],
): Promise<UpcomingChild[]> {
  const now = kstNow();
  const today = now.ymd;

  // 부모 자녀가 «쓸 수 있는» 수강 반(IDOR: Student.parentId = 로그인 부모).
  // 2026-11-14 복귀 예정: 다니는 반(ACTIVE) + 복귀가 승인된 휴원 반. 복귀 예정 반은 아래에서 복귀일 이후 날짜만 남긴다.
  const enrollRows = await listParentUsableClasses(parentUserId);
  if (enrollRows.length === 0) return [];

  // 이 부모 자녀들의 기존 결석 신고(CANCELLED 제외)를 한 번에 조회해 키로 매핑.
  const absRows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT ra."studentId" AS "studentId", ra."classId" AS "classId",
            to_char(ra.date, 'YYYY-MM-DD') AS "date", ra.reason AS reason, ra.status AS status
       FROM "RegularAbsence" ra
       JOIN "Student" s ON s.id = ra."studentId"
      WHERE ${await childAccessSql("s", "$1")} AND ${notMergedStudent("s")} AND ra.status <> 'CANCELLED'`,
    parentUserId,
  );
  const absByKey = new Map<string, { reason: string; status: string }>();
  for (const a of absRows) {
    absByKey.set(`${a.studentId}|${a.classId}|${a.date}`, { reason: a.reason, status: a.status });
  }

  // 다가오는 결석의 보강권(오늘 KST 자정 이후 결석분만). 키는 보강권 sourceKey 그대로(REGULAR:{반}:{날짜}).
  // 조회 실패는 «보강권 정보 없음»으로 — 신고 화면 자체는 떠야 한다.
  const creditByKey = new Map<string, string>();
  try {
    const creditRows = await prisma.$queryRawUnsafe<Array<{ studentId: string; sourceKey: string; status: string }>>(
      `SELECT mc."studentId" AS "studentId", mc."sourceKey" AS "sourceKey", mc.status
         FROM "MakeupCredit" mc
         JOIN "Student" s ON s.id = mc."studentId"
        WHERE ${await childAccessSql("s", "$1")} AND ${notMergedStudent("s")}
          AND mc."sourceType" = 'REGULAR'
          AND mc.status IN ('AVAILABLE','RESERVED','USED','NO_SHOW')
          AND mc."absenceDate" >= $2::timestamptz`,
      parentUserId, new Date(kstAt(today)).toISOString(),
    );
    for (const c of creditRows) creditByKey.set(`${c.studentId}|${c.sourceKey}`, c.status);
  } catch (error) {
    console.error("[parent-regular-absence] 보강권 조회 실패(화면은 계속):", error instanceof Error ? error.name : "");
  }

  // 질병·부상 결석의 이월 검토 상태(줄에 한 단어로 보인다)
  const reviewByKey = new Map<string, string>();
  for (const review of reviews) reviewByKey.set(`${review.studentId}|${review.classId}|${review.date}`, review.status);

  // 자녀별 → 반별 → 다가오는 날짜 목록으로 조립.
  const childMap = new Map<string, UpcomingChild>();
  for (const r of enrollRows) {
    if (!childMap.has(r.studentId)) {
      childMap.set(r.studentId, { studentId: r.studentId, studentName: r.studentName, classes: [] });
    }
    const child = childMap.get(r.studentId)!;

    // 오늘 수업도 목록에 넣는다(2026-11-14) — 마감 여부는 줄마다 changeOpen 으로 알려 준다
    // 복귀 예정 반은 복귀일 전 날짜를 내보내지 않는다(그날은 아직 휴원이다)
    const resumeFrom: string | null = r.resumeFrom ?? null;
    const dates = computeUpcomingDates(today, r.dayOfWeek, weeks, true)
      .filter((ymd) => usableOn(r.enrollmentStatus, resumeFrom, ymd))
      .map((ymd) => {
      const found = absByKey.get(`${r.studentId}|${r.classId}|${ymd}`);
      const status = found?.status ?? null;
      const reason = found?.reason ?? null;
      return {
        studentId: r.studentId,
        studentName: r.studentName,
        classId: r.classId,
        className: r.className,
        date: ymd,
        dateLabel: dateLabel(ymd),
        startTime: r.startTime,
        reason,
        reasonLabel: reason ? REASON_LABEL[reason] || reason : null,
        status,
        reported: status === "REPORTED" || status === "CONFIRMED",
        locked: status === "CONFIRMED",
        changeOpen: isAbsenceChangeOpen(ymd, r.startTime, now.ymd, now.hm),
        makeupCredit: status ? creditByKey.get(`${r.studentId}|${regularAbsenceSourceKey(r.classId, ymd)}`) ?? null : null,
        // 사유가 질병·부상일 때만(다른 사유로 바뀐 뒤 남은 옛 검토 상태를 보이지 않게)
        carryReview: status && reason === ILLNESS_REASON ? reviewByKey.get(`${r.studentId}|${r.classId}|${ymd}`) ?? null : null,
      } as UpcomingClassDate;
    });

    child.classes.push({
      classId: r.classId,
      className: r.className,
      dayOfWeek: r.dayOfWeek,
      startTime: r.startTime,
      resumeFrom: r.enrollmentStatus === "PAUSED" ? resumeFrom : null,
      dates,
    });
  }

  return Array.from(childMap.values());
}

// 소유권 재검증: studentId 가 부모 자녀이고 classId 가 그 학생이 «쓸 수 있는» 수강인지
// (ACTIVE 또는 복귀 승인된 휴원 반 — 2026-11-14 복귀 예정. 복귀 승인이 없거나 대기 중이면 null 그대로).
// 통과하면 그 반의 dayOfWeek·startTime 과 수강 상태·복귀일을 돌려준다(요일·마감·복귀일 검증에 사용). 아니면 null.
async function verifyOwnershipAndClass(
  parentUserId: string,
  studentId: string,
  classId: string,
): Promise<{ dayOfWeek: string; startTime: string | null; studentName: string; className: string; status: string; resumeFrom: string | null } | null> {
  const rows = await prisma.$queryRawUnsafe<any[]>(
    // 이름은 알림 문구에만 쓴다(원장이 누구 결석인지 바로 알아야 한다).
    `SELECT c."dayOfWeek" AS "dayOfWeek", c."startTime" AS "startTime", s.name AS "studentName", c.name AS "className",
            e.status AS "enrollmentStatus", ${resumeFromSql("e")} AS "resumeFrom"
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
  return rows[0]
    ? {
        dayOfWeek: rows[0].dayOfWeek,
        startTime: rows[0].startTime ?? rows[0].starttime ?? null,
        studentName: rows[0].studentName ?? rows[0].studentname ?? "",
        className: rows[0].className ?? rows[0].classname ?? "",
        status: rows[0].enrollmentStatus ?? rows[0].enrollmentstatus ?? "",
        resumeFrom: rows[0].resumeFrom ?? rows[0].resumefrom ?? null,
      }
    : null;
}

/**
 * 결석 신고·취소를 원장에게 알린다.
 *
 * 지금까지는 신고가 들어와도 아무 알림이 없어 원장이 /admin/absence 를 직접 열어봐야
 * 알 수 있었다. 셔틀 명단은 자동으로 반영되지만 사람은 모르고 지나간다.
 *
 * 알림 실패가 신고 자체를 되돌리면 안 된다 — 학부모는 이미 신고를 마쳤다.
 * 그래서 호출부에서 await 하되 오류는 여기서 삼킨다.
 */
export async function notifyAdminsOfAbsenceChange(input: {
  kind: "REPORTED" | "CANCELED";
  studentName: string;
  className: string;
  classId: string;
  studentId: string;
  date: string;
  reason?: string;
  recordId: string;
  eventVersion: string;
}) {
  try {
    const { notifyOperationalStaff } = await import("@/lib/operational-staff-notification");
    const reasonLabel = input.reason ? REASON_LABEL[input.reason as keyof typeof REASON_LABEL] : null;
    const title = input.kind === "REPORTED" ? "결석 사전 신고" : "결석 신고 취소";
    const message =
      input.kind === "REPORTED"
        ? `${input.studentName} 학생이 ${input.date} ${input.className} 수업에 결석 예정입니다.${reasonLabel ? ` (${reasonLabel})` : ""}`
        : `${input.studentName} 학생의 ${input.date} ${input.className} 결석 신고가 취소되었습니다.`;
    return await notifyOperationalStaff({
      stableEventKey: `regular-absence:${input.recordId}:${input.kind}:${input.eventVersion}`,
      eventType: `REGULAR_ABSENCE_${input.kind}`,
      studentId: input.studentId,
      type: "ABSENCE",
      title,
      message,
      linkUrl: input.kind === "REPORTED" && input.reason === ILLNESS_REASON ? ILLNESS_INBOX_HREF : "/admin/absence",
      staffLinkUrl: "/staff",
      classId: input.classId,
      includeCoach: true,
      includeDriver: true,
      driverContext: { studentId: input.studentId, serviceDate: input.date },
    });
  } catch (error) {
    console.error("[parent-regular-absence] 원장 알림 실패:", error);
  }
}

/**
 * 결석 한 건 저장 + 그 결석의 보강권/이월 검토 처리 — «하루 알리기»와 «여러 날 결석»이 날짜마다 같이 쓰는 거래 본문.
 * 반드시 호출부의 트랜잭션(tx) 안에서 부른다. 소유권·요일·마감·범위 검사는 호출부가 먼저 한다(여기는 저장만).
 *   · 질병·부상(검토 표가 있을 때): 보강권 대신 «이월 검토 중»
 *   · 그 밖: 지금처럼 즉시 보강권
 */
export async function saveReportedAbsenceInTx(
  tx: CompensationTransaction,
  input: {
    studentId: string; classId: string; date: string; reason: string;
    reasonText: string | null; source: Extract<IllnessReviewSource, "PARENT" | "KAKAO">; parentUserId: string;
  },
) {
  const { studentId, classId, date, reason, reasonText, source, parentUserId } = input;
  // 잠금 순서 통일(교착 방지): 작업대 잠금 → 결석 행. 관리자 취소(cancelRegularAbsenceByAdmin)와 같은 순서
  await lockCompensation(tx);
  // INSERT ... ON CONFLICT — 학생·반·날짜당 1건. 관리자 확정(CONFIRMED)건은 학부모가 못 덮게.
  // (가드2) 덮어쓰는 경우는 둘뿐: 취소됐던 신고를 다시 신고 / 신고 상태(REPORTED)에서 «사유 변경».
  //   2026-11-14: 예전 조건은 «사유가 다르면» 만 봐서 확정건도 사유가 다르면 REPORTED 로 되돌아갔다 —
  //   화면에 «사유 변경»이 생기면서 그 구멍이 실제 길이 되므로 REPORTED 조건을 붙였다.
  const saved = await tx.$queryRawUnsafe<{ id: string; eventVersion: string }[]>(
    `INSERT INTO "RegularAbsence"
        ("studentId","classId","date","reason","status","reportedByUserId")
     VALUES ($1,$2,$3::date,$4,'REPORTED',$5)
     ON CONFLICT ("studentId","classId","date") DO UPDATE
        SET reason = EXCLUDED.reason,
            status = 'REPORTED',
            "reportedByUserId" = EXCLUDED."reportedByUserId",
            "updatedAt" = now()
      WHERE "RegularAbsence".status = 'CANCELLED'
         OR ("RegularAbsence".status = 'REPORTED' AND "RegularAbsence".reason IS DISTINCT FROM EXCLUDED.reason)
     RETURNING id, to_char("updatedAt", 'YYYYMMDDHH24MISSUS') AS "eventVersion"`,
    studentId, classId, date, reason, parentUserId,
  );
  let noOp = false;
  if (!saved[0]) {
    const current = await tx.$queryRawUnsafe<{ status: string; reason: string }[]>(
      `SELECT status, reason FROM "RegularAbsence"
        WHERE "studentId"=$1 AND "classId"=$2 AND date=$3::date LIMIT 1`,
      studentId, classId, date,
    );
    if (!(current[0]?.status === "REPORTED" && current[0].reason === reason)) throw new Error("ABSENCE_NOT_CANCELABLE");
    noOp = true; // 같은 신고를 다시 보냄 — 보강권 발급은 멱등이라 아래에서 한 번 더 확인만 한다(이 기능 이전 신고분도 채워진다)
  }
  // 질병·부상(2026-11-14 원장 결정 a2): 보강권을 바로 주지 않고 «이월 검토»로 둔다.
  //   새 신고·사유 변경(→질병·부상) 모두 여기를 지난다. 이미 나간 미사용 보강권은 거둬 두고,
  //   보강을 이미 예약·사용한 결석이면 오류(ILLNESS_MAKEUP_IN_USE)로 저장까지 되돌린다.
  //   검토 표가 아직 없으면(마이그레이션 전) 예전처럼 즉시 보강권 — 신고가 죽지 않게.
  const reviewReady = await illnessReviewReady(tx);
  if (reason === ILLNESS_REASON && reviewReady) {
    // 같은 신고를 다시 보낸 경우(noOp)는 검토를 새로 열지 않는다 — 이 기능 이전에 보강권이 나간 결석은 원장이 신청함에서 고른다(a7)
    const absenceId = saved[0]?.id ?? null;
    if (!absenceId) return { saved: null, noOp, makeupCreditIssued: false, carryReview: null as string | null, absenceId: null as string | null };
    const review = await openIllnessReviewInTx(tx, { absenceId, studentId, classId, absenceYmd: date, reasonText, source });
    // 이미 [보강권으로] 결정이 났던 결석을 다시 질병·부상으로 바꾼 경우 — 그 결정(MAKEUP)을 그대로 따른다
    return { saved: saved[0], noOp, makeupCreditIssued: false, carryReview: review.status as string | null, absenceId: absenceId as string | null };
  }
  // 다른 사유(또는 질병·부상에서 다른 사유로 변경): 열려 있던 검토를 닫고 지금처럼 즉시 보강권
  if (reviewReady && saved[0]) await closeIllnessReviewInTx(tx, saved[0].id);
  // 보강권 — 출결 기반 발급과 같은 키(REGULAR:{반}:{날짜})라 나중에 출결이 결석으로 저장돼도 한 장
  const credit = isMakeupCreditIssuableYmd(date)
    ? await issueCreditForReportedAbsence(tx, { studentId, classId, absenceYmd: date })
    : { issued: false };
  return { saved: saved[0] ?? null, noOp, makeupCreditIssued: credit.issued, carryReview: null as string | null, absenceId: (saved[0]?.id ?? null) as string | null };
}

// ── 2) 사전 결석 신고 ─────────────────────────────────────────────────────
export async function reportRegularAbsence(
  parentUserId: string,
  input: {
    studentId: string; classId: string; date: string; reason: string;
    /** 질병·부상일 때 사유 글(예: 독감). 앱(PARENT)은 필수, 카카오 대화는 받지 못해 비워 둔다 */
    reasonText?: string | null;
    /** 어디서 온 신고인가 — 안 주면 앱(PARENT) */
    source?: Extract<IllnessReviewSource, "PARENT" | "KAKAO">;
  },
) {
  const studentId = input?.studentId?.trim();
  const classId = input?.classId?.trim();
  const date = input?.date?.trim();
  const reason = input?.reason;
  const source = input?.source === "KAKAO" ? "KAKAO" : "PARENT";
  const reasonText = normalizeReasonText(input?.reasonText);

  if (!studentId || !classId) throw new Error("STUDENT_OR_CLASS_MISSING");
  if (!isYmd(date)) throw new Error("INVALID_DATE");
  if (!isValidReason(reason)) throw new Error("INVALID_REASON");
  // 질병·부상(2026-11-14 원장 결정 a1): 앱에서는 사유 글이 필수. 글이 있으면 길이를 본다(카카오는 글 없이 받는다)
  if (reason === ILLNESS_REASON && (source === "PARENT" || reasonText) && !isValidReasonText(reasonText)) {
    throw new Error("ILLNESS_REASON_TEXT_REQUIRED");
  }

  // 가드1: 소유권 + 반 소속 재검증(클라 값 불신뢰).
  const owned = await verifyOwnershipAndClass(parentUserId, studentId, classId);
  if (!owned) throw new Error("NOT_OWNER");

  // 복귀 예정 반(2026-11-14): 복귀일 전 날짜는 아직 휴원이라 받지 않는다 — 화면 목록을 믿지 않고 서버가 다시 본다.
  if (!usableOn(owned.status, owned.resumeFrom, date)) {
    if (owned.resumeFrom) throw new BeforeResumeError(owned.resumeFrom);
    throw new Error("NOT_OWNER");
  }

  // 가드3: 그 반 요일과 일치 + 마감 전(수업 시작 1시간 전까지 — 오늘 수업 포함).
  // 새 신고와 사유 변경(재신고)이 모두 이 길을 지나므로 여기 한 곳에서 막으면 둘 다 막힌다.
  const now = kstNow();
  if (!isReportableAt(date, owned.dayOfWeek, owned.startTime, now.ymd, now.hm)) {
    // 오늘 수업인데 1시간 전이 지난 경우는 «학원으로 연락» 안내가 따로 나가게 코드를 나눈다
    throw new Error(date === now.ymd && ymdToDayIndex(date) != null ? "ABSENCE_CHANGE_CLOSED" : "NOT_REPORTABLE_DATE");
  }

  // 앞날 상한: 목록이 보여 주는 수업일(오늘 포함 4주치) 밖의 날짜는 받지 않는다 — 다니는 반·복귀 예정 반 모두 같은 규칙.
  if (!computeUpcomingDates(now.ymd, owned.dayOfWeek, ABSENCE_REPORT_WEEKS, true).includes(date)) {
    throw new Error("ABSENCE_TOO_FAR");
  }

  // 결석 신고 저장 + 보강권 발급을 한 트랜잭션으로(2026-11-10 원장 결정 k4 — 신고 즉시 보강권).
  // 둘 중 하나만 남는 반쪽 상태(신고는 됐는데 보강권 없음 / 그 반대)를 만들지 않는다.
  const outcome = await prisma.$transaction((tx) => saveReportedAbsenceInTx(tx, { studentId, classId, date, reason, reasonText, source, parentUserId }));
  if (outcome.noOp || !outcome.saved) {
    return { ok: true, reason, notification: null, noOp: true, makeupCreditIssued: outcome.makeupCreditIssued, carryReview: outcome.carryReview, absenceId: outcome.absenceId };
  }
  const saved = [outcome.saved];

  const notification = await notifyAdminsOfAbsenceChange({
    kind: "REPORTED",
    studentName: owned.studentName,
    className: owned.className,
    classId,
    studentId,
    date,
    reason,
    recordId: saved[0].id,
    eventVersion: `${saved[0].eventVersion}-${createHash("sha256").update(reason).digest("hex")}`,
  });

  // absenceId: 화면이 이어서 증빙 사진을 올릴 때 쓴다 / carryReview: 완료 문구 분기(«사진을 확인한 뒤 …»)
  return { ok: true, reason, notification, makeupCreditIssued: outcome.makeupCreditIssued, carryReview: outcome.carryReview, absenceId: outcome.absenceId };
}

// ── 3) 사전 결석 신고 취소 ────────────────────────────────────────────────
// id 또는 (studentId,classId,date) 로 지목. 본인(부모 자녀)의 REPORTED 건만 취소 가능.
// 관리자 확정(CONFIRMED)이면 0행 → 차단. 취소 행은 감사·알림 재조정을 위해 보존한다.
// 보강권(2026-11-10 k4): 같은 트랜잭션에서 그 결석의 보강권을 되돌린다(settleCreditOnAbsenceCancel).
//   미사용 → 회수 / 보강 예약됨 → confirmMakeupCancel 이 true 일 때만 예약 취소 + 회수(아니면 확인 요청 오류)
//   / 이미 보강을 들음·예약일 지남 → 신고 취소 자체를 막는다(오류 → 트랜잭션 전체 되돌림).
export async function cancelRegularAbsence(
  parentUserId: string,
  input: { id?: string; studentId?: string; classId?: string; date?: string; confirmMakeupCancel?: boolean },
) {
  const id = input?.id?.trim();
  const studentId = input?.studentId?.trim();
  const classId = input?.classId?.trim();
  const date = input?.date?.trim();
  const confirmMakeupCancel = input?.confirmMakeupCancel === true;

  // 취소 상태와 알림 근거를 같은 행에 남겨 나중에도 전달 실패를 재조정할 수 있게 한다.
  const returning = `RETURNING s.name AS "studentName", c.name AS "className", ra.id, c.id AS "classId", ra."studentId" AS "studentId",
                              to_char(ra.date,'YYYY-MM-DD') AS "date", c."startTime" AS "startTime",
                              to_char(ra."updatedAt",'YYYYMMDDHH24MISSUS') AS "eventVersion",
                              (SELECT ${resumeFromSql("e")} FROM "Enrollment" e
                                WHERE e."studentId" = ra."studentId" AND e."classId" = ra."classId" LIMIT 1) AS "resumeFrom"`;
  type CanceledRow = { id: string; studentName: string; className: string; classId: string; studentId: string; date: string; startTime: string | null; eventVersion: string; resumeFrom: string | null };
  if (!id && (!studentId || !classId || !isYmd(date || ""))) throw new Error("ABSENCE_NOT_FOUND");
  // 권한 조건(그 부모의 자녀만)은 기존 그대로 — 트랜잭션 밖에서 SQL 조각만 미리 만든다
  const access = await childAccessSql("s", "$1");

  const { canceled, creditAction } = await prisma.$transaction(async (tx) => {
    // 잠금 순서 통일(교착 방지): 작업대 잠금 → 결석 행. 관리자 취소(cancelRegularAbsenceByAdmin)와 같은 순서
    await lockCompensation(tx);
    let canceled: CanceledRow[];
    if (id) {
      // id 로 지목: 그 결석이 이 부모 자녀의 것이고 REPORTED 인 경우만 취소(IDOR 방어).
      canceled = await tx.$queryRawUnsafe<CanceledRow[]>(
        `UPDATE "RegularAbsence" ra
            SET status = 'CANCELLED', "updatedAt" = NOW()
           FROM "Student" s, "Class" c
          WHERE ra."studentId" = s.id
            AND c.id = ra."classId"
            AND ${access}
            AND ra.id = $2
            AND ra.status = 'REPORTED'
          ${returning}`,
        parentUserId, id,
      );
    } else {
      canceled = await tx.$queryRawUnsafe<CanceledRow[]>(
        `UPDATE "RegularAbsence" ra
            SET status = 'CANCELLED', "updatedAt" = NOW()
           FROM "Student" s, "Class" c
          WHERE ra."studentId" = s.id
            AND c.id = ra."classId"
            AND ${access}
            AND ra."studentId" = $2
            AND ra."classId" = $3
            AND ra.date = $4::date
            AND ra.status = 'REPORTED'
          ${returning}`,
        parentUserId, studentId, classId, date,
      );
    }
    if (canceled.length === 0) throw new Error("ABSENCE_NOT_CANCELABLE");

    // 복귀 예정 반(2026-11-14): 복귀일 전 날짜의 신고는 학부모가 건드리지 못한다(신고와 같은 기준).
    // resumeFrom 은 «복귀 승인된 휴원 반»일 때만 값이 있다 — 다니는 반은 NULL 이라 예전과 같다. 던지면 위 UPDATE 도 되돌려진다.
    if (canceled[0].resumeFrom && canceled[0].date < canceled[0].resumeFrom) {
      throw new BeforeResumeError(canceled[0].resumeFrom);
    }

    // 마감 강제(2026-11-14): 수업 시작 1시간 전이 지났으면 취소를 받지 않는다 — 신고와 같은 함수.
    // 트랜잭션 안에서 던지므로 위 UPDATE 도 함께 되돌려진다(화면에서 버튼을 숨기는 것만으로 끝내지 않는다).
    const now = kstNow();
    if (!isAbsenceChangeOpen(canceled[0].date, canceled[0].startTime, now.ymd, now.hm)) {
      throw new Error("ABSENCE_CHANGE_CLOSED");
    }

    // 질병·부상 이월 검토 중이었으면 함께 닫는다(사진은 화면에서 빠지고 파일은 cron 이 지운다)
    if (await illnessReviewReady(tx)) await closeIllnessReviewInTx(tx, canceled[0].id, { canceled: true });

    // 보강권 되돌리기 — 막아야 하면 오류를 던져 위 취소까지 함께 되돌린다
    const settled = await settleCreditOnAbsenceCancel(tx, {
      actor: "PARENT",
      studentId: canceled[0].studentId,
      classId: canceled[0].classId,
      absenceYmd: canceled[0].date,
      confirmBookingCancel: confirmMakeupCancel,
    });
    return { canceled, creditAction: settled.action };
  });

  const notification = await notifyAdminsOfAbsenceChange({
    kind: "CANCELED",
    studentName: canceled[0].studentName,
    className: canceled[0].className,
    classId: canceled[0].classId,
    studentId: canceled[0].studentId,
    date: canceled[0].date,
    recordId: canceled[0].id,
    eventVersion: canceled[0].eventVersion,
  });

  return {
    ok: true,
    notification,
    // 화면 문구용: 보강권 회수 / 보강 예약까지 함께 취소됐는지
    makeupCreditRevoked: creditAction === "REVOKE" || creditAction === "CANCEL_BOOKING_AND_REVOKE",
    makeupBookingCanceled: creditAction === "CANCEL_BOOKING_AND_REVOKE",
  };
}

// ── 4) 결석 신고 «날짜 바꾸기» (2026-11-15 마감 통일·날짜 바꾸기) ─────────────────────────
// 예전에는 «취소한 뒤 다시 신고»였다 — 두 번 누르는 사이에 한쪽만 되는 반쪽 상태가 생길 수 있었다.
// 이제 한 트랜잭션에서 «옛 신고 취소 + 새 날짜 신고»를 함께 한다. 어느 단계든 실패하면 전부 되돌아가
// 옛 신고(와 그 보강권)가 그대로 남는다.
//
// 규칙
//   · 같은 반의 다른 수업일로만(목록에 보이는 4주 범위 안, 그 반 요일, 복귀 예정 반은 복귀일 이후).
//   · 마감(수업 1시간 전)은 옛 날짜·새 날짜 양쪽에 적용한다.
//   · 확정(CONFIRMED)된 신고는 옮길 수 없다(취소와 같은 조건 — REPORTED 만).
//   · 그 결석의 보강권으로 이미 보강이 예약돼 있으면 옮기지 않는다 → «보강 예약을 먼저 취소하거나 바꿔 주세요».
//     (보강을 이미 들었으면 취소와 같은 MAKEUP_ALREADY_USED)
//   · 새 날짜에 이미 신고(또는 확정)가 있으면 옮기지 않는다.
//   · 사유는 옛 신고의 것을 그대로 가져간다.
//   · 보강권: 옛 결석분은 회수, 새 결석분은 발급 — 기존 함수(settleCreditOnAbsenceCancel·issueCreditForReportedAbsence) 그대로.
export async function moveRegularAbsence(
  parentUserId: string,
  input: { studentId?: string; classId?: string; date?: string; toDate?: string },
) {
  const studentId = input?.studentId?.trim();
  const classId = input?.classId?.trim();
  const date = input?.date?.trim() ?? "";
  const toDate = input?.toDate?.trim() ?? "";

  if (!studentId || !classId) throw new Error("STUDENT_OR_CLASS_MISSING");
  if (!isYmd(date) || !isYmd(toDate)) throw new Error("INVALID_DATE");
  if (date === toDate) throw new Error("ABSENCE_MOVE_SAME_DATE");

  // 가드1: 소유권 + 반 소속(취소·신고와 같은 검사)
  const owned = await verifyOwnershipAndClass(parentUserId, studentId, classId);
  if (!owned) throw new Error("NOT_OWNER");

  // 복귀 예정 반: 옛 날짜·새 날짜 모두 복귀일 이후여야 한다
  for (const ymd of [date, toDate]) {
    if (!usableOn(owned.status, owned.resumeFrom, ymd)) {
      if (owned.resumeFrom) throw new BeforeResumeError(owned.resumeFrom);
      throw new Error("NOT_OWNER");
    }
  }

  // 가드3(새 날짜): 그 반 요일 + 마감 전 + 목록 범위(4주) 안 — 새 신고와 같은 기준
  const now = kstNow();
  if (!isReportableAt(toDate, owned.dayOfWeek, owned.startTime, now.ymd, now.hm)) {
    throw new Error(toDate === now.ymd && ymdToDayIndex(toDate) != null ? "ABSENCE_CHANGE_CLOSED" : "NOT_REPORTABLE_DATE");
  }
  if (!computeUpcomingDates(now.ymd, owned.dayOfWeek, ABSENCE_REPORT_WEEKS, true).includes(toDate)) {
    throw new Error("ABSENCE_TOO_FAR");
  }
  // 마감(옛 날짜): 이미 마감된 신고는 옮기지 못한다 — 트랜잭션을 열기 전에 먼저 본다(안에서도 다시 본다)
  if (!isAbsenceChangeOpen(date, owned.startTime, now.ymd, now.hm)) throw new Error("ABSENCE_CHANGE_CLOSED");

  const access = await childAccessSql("s", "$1");
  type MovedRow = { id: string; reason: string; eventVersion: string };

  const outcome = await prisma.$transaction(async (tx) => {
    // 잠금 순서는 신고·취소와 같다(작업대 잠금 → 결석 행)
    await lockCompensation(tx);

    // ① 옛 신고 취소 — 이 부모 자녀의 REPORTED 건만(확정건·남의 자녀는 0행)
    const canceled = await tx.$queryRawUnsafe<MovedRow[]>(
      `UPDATE "RegularAbsence" ra
          SET status = 'CANCELLED', "updatedAt" = NOW()
         FROM "Student" s
        WHERE ra."studentId" = s.id
          AND ${access} AND ${notMergedStudent("s")}
          AND ra."studentId" = $2
          AND ra."classId" = $3
          AND ra.date = $4::date
          AND ra.status = 'REPORTED'
        RETURNING ra.id, ra.reason AS reason, to_char(ra."updatedAt",'YYYYMMDDHH24MISSUS') AS "eventVersion"`,
      parentUserId, studentId, classId, date,
    );
    if (canceled.length === 0) throw new Error("ABSENCE_NOT_CANCELABLE");

    // ② 마감 다시 확인(옛 날짜) — 던지면 위 취소도 되돌려진다
    const inTx = kstNow();
    if (!isAbsenceChangeOpen(date, owned.startTime, inTx.ymd, inTx.hm)) throw new Error("ABSENCE_CHANGE_CLOSED");

    // ③ 새 날짜에 이미 신고·확정이 있으면 옮기지 않는다(취소된 옛 줄은 아래에서 되살린다)
    const target = await tx.$queryRawUnsafe<{ status: string; reason: string }[]>(
      `SELECT status, reason FROM "RegularAbsence"
        WHERE "studentId"=$1 AND "classId"=$2 AND date=$3::date LIMIT 1`,
      studentId, classId, toDate,
    );
    if (target[0] && target[0].status !== "CANCELLED") throw new Error("ABSENCE_MOVE_TARGET_TAKEN");

    // ④ 옛 결석의 보강권 되돌리기 — 보강이 예약돼 있으면(확인 없이) 막힌다 → «보강 예약을 먼저» 안내로 바꿔 던진다
    try {
      await settleCreditOnAbsenceCancel(tx, {
        actor: "PARENT", studentId, classId, absenceYmd: date, confirmBookingCancel: false,
      });
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      if (code === "MAKEUP_BOOKING_CONFIRM_REQUIRED" || code === "MAKEUP_BOOKING_PAST") throw new Error("ABSENCE_MOVE_MAKEUP_BOOKED");
      throw error;
    }

    // ⑤ 새 날짜 신고 — 사유는 옛 신고 그대로. 덮어쓰는 것은 «취소됐던 줄» 뿐이다(③에서 확인)
    const reason = canceled[0].reason;
    const saved = await tx.$queryRawUnsafe<{ id: string; eventVersion: string }[]>(
      `INSERT INTO "RegularAbsence"
          ("studentId","classId","date","reason","status","reportedByUserId")
       VALUES ($1,$2,$3::date,$4,'REPORTED',$5)
       ON CONFLICT ("studentId","classId","date") DO UPDATE
          SET reason = EXCLUDED.reason,
              status = 'REPORTED',
              "reportedByUserId" = EXCLUDED."reportedByUserId",
              "updatedAt" = now()
        WHERE "RegularAbsence".status = 'CANCELLED'
       RETURNING id, to_char("updatedAt", 'YYYYMMDDHH24MISSUS') AS "eventVersion"`,
      studentId, classId, toDate, reason, parentUserId,
    );
    if (!saved[0]) throw new Error("ABSENCE_MOVE_TARGET_TAKEN");
    // «여러 날 결석»의 한 날을 옮긴 경우 새 날짜도 같은 기간에 묶는다(2026-11-15) — 기간에 한 묶음으로 올린 증빙 사진·
    // «복귀했어요»·기간 묶음 승인이 옮긴 날에도 그대로 닿게. 하루 신고(기간 없음)는 아무것도 바뀌지 않는다.
    await tx.$executeRawUnsafe(
      `UPDATE "RegularAbsence" n SET "periodId" = o."periodId", note = o.note
         FROM "RegularAbsence" o
        WHERE n.id = $2 AND o.id = $1 AND o."periodId" IS NOT NULL`,
      canceled[0].id, saved[0].id,
    );

    // ⑥ 질병·부상 이월 검토(2026-11-14)도 새 날짜로 옮긴다 — 날짜를 바꿨다고 보강권이 바로 나가면 «검토 대기» 규칙을 돌아가는 길이 된다.
    //   · 검토 중이던 결석: 올린 사진과 사유 글을 새 결석으로 옮기고 새 날짜에서 다시 «검토 중»(보강권 없음).
    //   · 원장이 이미 [보강권으로] 정한 결석: 그 결정을 새 날짜로 가져간다(보강권 1장).
    //   · 검토 줄이 없던 질병·부상 결석(이 기능 이전 신고): 새 날짜에서 검토를 새로 연다 — 하루 신고와 같은 결과로 통일.
    //   · 다른 사유: 아래 ⑦ 예전 그대로.
    const reviewReady = await illnessReviewReady(tx);
    const oldReview = reviewReady && reason === ILLNESS_REASON
      ? (await tx.$queryRawUnsafe<{ status: string; source: string; reasonText: string | null }[]>(
          `SELECT status, source, "reasonText" FROM "RegularAbsenceCarryReview" WHERE "absenceId" = $1 FOR UPDATE`, canceled[0].id,
        ))[0] ?? null
      : null;
    if (reviewReady && reason === ILLNESS_REASON && oldReview?.status !== "MAKEUP") {
      if (oldReview?.status === "PENDING") {
        await tx.$executeRawUnsafe(
          `UPDATE "RegularAbsenceEvidence" SET "absenceId" = $2 WHERE "absenceId" = $1 AND "removedAt" IS NULL`,
          canceled[0].id, saved[0].id,
        );
      }
      await closeIllnessReviewInTx(tx, canceled[0].id, { canceled: true });
      await openIllnessReviewInTx(tx, {
        absenceId: saved[0].id, studentId, classId, absenceYmd: toDate,
        reasonText: oldReview?.reasonText ?? null, source: oldReview?.source === "KAKAO" ? "KAKAO" : "PARENT",
      });
      return { canceled: canceled[0], saved: saved[0], reason, makeupCreditIssued: false };
    }
    if (reviewReady) await closeIllnessReviewInTx(tx, canceled[0].id, { canceled: true });
    if (oldReview?.status === "MAKEUP") {
      const kept = await convertIllnessToMakeupInTx(tx, { absenceId: saved[0].id, by: "ADMIN", actorUserId: null, issuable: isMakeupCreditIssuableYmd });
      return { canceled: canceled[0], saved: saved[0], reason, makeupCreditIssued: kept.converted && kept.creditIssued };
    }

    // ⑦ 새 결석의 보강권(멱등 — 같은 키면 한 장)
    const credit = isMakeupCreditIssuableYmd(toDate)
      ? await issueCreditForReportedAbsence(tx, { studentId, classId, absenceYmd: toDate })
      : { issued: false };
    return { canceled: canceled[0], saved: saved[0], reason, makeupCreditIssued: credit.issued };
  });

  // 알림 — 기존 알림 두 통을 그대로 쓴다(취소 + 새 신고). 날짜마다 담당 기사님이 다를 수 있어 한 통으로 합치지 않는다.
  // 키는 결석 행 id + 그 행의 변경 시각이라, 같은 옮기기를 다시 눌러도(두 번째는 위에서 거절된다) 중복 발송되지 않는다.
  await notifyAdminsOfAbsenceChange({
    kind: "CANCELED",
    studentName: owned.studentName,
    className: owned.className,
    classId,
    studentId,
    date,
    recordId: outcome.canceled.id,
    eventVersion: outcome.canceled.eventVersion,
  });
  const notification = await notifyAdminsOfAbsenceChange({
    kind: "REPORTED",
    studentName: owned.studentName,
    className: owned.className,
    classId,
    studentId,
    date: toDate,
    reason: outcome.reason,
    recordId: outcome.saved.id,
    eventVersion: `${outcome.saved.eventVersion}-${createHash("sha256").update(String(outcome.reason)).digest("hex")}`,
  });

  return { ok: true, moved: true, from: date, to: toDate, reason: outcome.reason, notification, makeupCreditIssued: outcome.makeupCreditIssued };
}
