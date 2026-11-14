import { prisma } from "@/lib/prisma";
import { childAccessSql } from "@/lib/account/child-access";
import { notMergedStudent } from "@/lib/studentVisibility";
import { kstLabel, todayKst } from "@/lib/datetime/kst";
import { getEnrollmentChangeHistory } from "@/lib/enrollment/parent-change-request";
import { parentKindName, shortMd } from "@/lib/enrollment/parentChangeStatus";
import { deriveEnrollmentChangeStatus, deriveShuttleDayStatus } from "@/lib/requests/catalog";
import { REASON_LABEL } from "@/lib/regular/regularAbsenceRules";
import { PARENT_SHUTTLE_DIRECTION_LABEL, PARENT_SHUTTLE_EXCEPTION_KIND_LABEL } from "@/lib/shuttle/dayExceptionRules";
import { absenceCreditLine, sortTimeline, toTimelineView, type ParentTimelineRow, type ParentTimelineView } from "@/lib/requests/parent-timeline-rules";

// ── 학부모 «수업» 탭 신청 내역 타임라인(최근 3개월) — 2026-11-10 원장 결정 설계 B ─────────────
//
// 종류: 수강 변경 · 정규 결석 · 보강 예약 · 셔틀 오늘만 · 방학특강 결석/보강 · 문의.
// 종류·상태 이름은 catalog.ts, 단계·버튼은 parent-timeline-rules.ts. 여기는 표마다 읽어서 한 모양으로 맞출 뿐.
//
// ★ 보안 가드: 모든 조회 = childAccessSql(그 부모의 자녀만) + notMergedStudent(병합된 옛 학생 제외).
//   방학특강 표는 원래 «신청 전화번호»로 묶지만, 여기서는 학생으로 전환된 자리(studentId)만 자녀 권한으로 읽는다.
// 한 표 조회가 실패해도 나머지는 보이게 표마다 빈 목록으로 받는다(오류는 로그만).
// 쓰기 없음. $queryRawUnsafe 만(PgBouncer).

const RECENT = `now() - interval '3 months'`;

function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return String(value ?? "");
}

async function safe<T>(label: string, run: () => Promise<T[]>): Promise<T[]> {
  try {
    return await run();
  } catch (error) {
    // 개인정보·원문 SQL 은 남기지 않는다(표 이름만)
    console.error("[parent-timeline] 조회 실패", label, error instanceof Error ? error.name : "");
    return [];
  }
}

export async function getParentRequestTimeline(parentUserId: string): Promise<ParentTimelineView[]> {
  const today = todayKst();
  const access = await childAccessSql("s", "$1");

  const [changes, absences, makeups, shuttles, seasonalAbsences, seasonalMakeups, inquiries] = await Promise.all([
    // 수강 변경 — 기존 «지난 결과» 조회를 그대로 쓰되 검토 중·적용 전 승인 건도 함께
    // (취소 요청 칸까지 읽다가 실패하면 — 마이그레이션 전 — 칸 없이 다시 읽는다)
    safe("ENROLLMENT_CHANGE", () =>
      getEnrollmentChangeHistory(parentUserId, { includeOpen: true, withCancelRequest: true })
        .catch(() => getEnrollmentChangeHistory(parentUserId, { includeOpen: true }))),
    // 정규 결석(학부모가 신고한 것만 — 관리자 기간 결석·출석부 표시 행은 신청이 아니다)
    safe("REGULAR_ABSENCE", () => prisma.$queryRawUnsafe<any[]>(
      `SELECT ra.id, s.id AS "studentId", s.name AS "studentName", c.name AS "className",
              to_char(ra.date,'YYYY-MM-DD') AS "date", ra.reason, ra.status, ra."createdAt",
              to_char(ra."createdAt" AT TIME ZONE 'Asia/Seoul','YYYY-MM-DD') AS "createdOn",
              -- 신고 즉시 발급된 보강권(2026-11-10) — 키는 보강권 sourceKey 형식 그대로(REGULAR:{반}:{날짜})
              (SELECT mc.status FROM "MakeupCredit" mc
                WHERE mc."studentId" = ra."studentId"
                  AND mc."sourceKey" = 'REGULAR:' || ra."classId" || ':' || to_char(ra.date,'YYYY-MM-DD')
                LIMIT 1) AS "creditStatus"
         FROM "RegularAbsence" ra
         JOIN "Student" s ON s.id = ra."studentId" AND ${notMergedStudent("s")}
         LEFT JOIN "Class" c ON c.id = ra."classId"
        WHERE ${access} AND ra."reportedByUserId" IS NOT NULL AND ra."periodId" IS NULL
          AND (ra."createdAt" >= ${RECENT} OR ra.status = 'REPORTED')
        ORDER BY ra."createdAt" DESC LIMIT 40`,
      parentUserId,
    )),
    // 보강 예약
    safe("MAKEUP", () => prisma.$queryRawUnsafe<any[]>(
      `SELECT m.id, s.id AS "studentId", s.name AS "studentName", c.name AS "className", m.status, m."createdAt",
              to_char(m."makeupDate" AT TIME ZONE 'Asia/Seoul','YYYY-MM-DD') AS "date",
              to_char(m."originalDate" AT TIME ZONE 'Asia/Seoul','YYYY-MM-DD') AS "originalDate",
              to_char(m."createdAt" AT TIME ZONE 'Asia/Seoul','YYYY-MM-DD') AS "createdOn"
         FROM "MakeupSession" m
         JOIN "Student" s ON s.id = m."studentId" AND ${notMergedStudent("s")}
         LEFT JOIN "Class" c ON c.id = m."makeupClassId"
        WHERE ${access} AND (m."createdAt" >= ${RECENT} OR m.status = 'BOOKED')
        ORDER BY m."createdAt" DESC LIMIT 40`,
      parentUserId,
    )),
    // 셔틀 오늘만(승인 없이 바로 반영되는 알림)
    safe("SHUTTLE_DAY", () => prisma.$queryRawUnsafe<any[]>(
      `SELECT x.id, s.id AS "studentId", s.name AS "studentName", x.direction, x.kind, x.location, x."canceledAt", x."createdAt",
              to_char(x."serviceDate",'YYYY-MM-DD') AS "date",
              to_char(x."createdAt" AT TIME ZONE 'Asia/Seoul','YYYY-MM-DD') AS "createdOn"
         FROM "ShuttleDayException" x
         JOIN "Student" s ON s.id = x."studentId" AND ${notMergedStudent("s")}
        WHERE ${access} AND x."createdAt" >= ${RECENT}
        ORDER BY x."createdAt" DESC LIMIT 40`,
      parentUserId,
    )),
    // 방학특강 결석(학생으로 전환된 자리만)
    safe("SEASONAL_ABSENCE", () => prisma.$queryRawUnsafe<any[]>(
      `SELECT ab.id, s.id AS "studentId", s.name AS "studentName", o.title AS "offeringTitle", ab.reason, ab.status, ab."createdAt",
              to_char(sd."startsAt" AT TIME ZONE 'Asia/Seoul','YYYY-MM-DD') AS "date",
              to_char(ab."createdAt" AT TIME ZONE 'Asia/Seoul','YYYY-MM-DD') AS "createdOn"
         FROM "SpecialProgramAbsence" ab
         JOIN "SpecialProgramEnrollmentDate" e ON e.id = ab."enrollmentDateId"
         JOIN "Student" s ON s.id = e."studentId" AND ${notMergedStudent("s")}
         JOIN "SpecialProgramSessionDate" sd ON sd.id = e."sessionDateId"
         JOIN "SpecialProgramOffering" o ON o.id = e."offeringId"
        WHERE ${access} AND ab."reportedByUserId" IS NOT NULL
          AND (ab."createdAt" >= ${RECENT} OR ab.status = 'REPORTED')
        ORDER BY ab."createdAt" DESC LIMIT 40`,
      parentUserId,
    )),
    // 방학특강 보강(학부모가 낸 것)
    safe("SEASONAL_MAKEUP", () => prisma.$queryRawUnsafe<any[]>(
      `SELECT m.id, s.id AS "studentId", s.name AS "studentName", o.title AS "offeringTitle", m.status, m."createdAt",
              to_char(COALESCE(tsd."startsAt", m."targetDate") AT TIME ZONE 'Asia/Seoul','YYYY-MM-DD') AS "date",
              to_char(m."createdAt" AT TIME ZONE 'Asia/Seoul','YYYY-MM-DD') AS "createdOn"
         FROM "SpecialProgramMakeup" m
         JOIN "Student" s ON s.id = m."studentId" AND ${notMergedStudent("s")}
         JOIN "SpecialProgramOffering" o ON o.id = m."offeringId"
         LEFT JOIN "SpecialProgramSessionDate" tsd ON tsd.id = m."targetSessionDateId"
        WHERE ${access} AND m."requestedBy" = 'PARENT'
          AND (m."createdAt" >= ${RECENT} OR m.status IN ('REQUESTED','APPROVED','SCHEDULED'))
        ORDER BY m."createdAt" DESC LIMIT 40`,
      parentUserId,
    )),
    // 문의(학원에 요청하기)
    safe("PARENT_REQUEST", () => prisma.$queryRawUnsafe<any[]>(
      `SELECT r.id, s.id AS "studentId", s.name AS "studentName", r.title, r.status, r."adminNote", r."createdAt",
              to_char(r."createdAt" AT TIME ZONE 'Asia/Seoul','YYYY-MM-DD') AS "createdOn"
         FROM "ParentRequest" r
         JOIN "Student" s ON s.id = r."studentId" AND ${notMergedStudent("s")}
        WHERE ${access} AND (r."createdAt" >= ${RECENT} OR r.status = 'PENDING')
        ORDER BY r."createdAt" DESC LIMIT 40`,
      parentUserId,
    )),
  ]);

  const rows: ParentTimelineRow[] = [];
  for (const r of changes) {
    const name = parentKindName(r.kind);
    const classes = r.toClassName ? `${r.fromClassName ?? "기존 반"} → ${r.toClassName}` : (r.fromClassName ?? "");
    rows.push({
      key: `ENROLLMENT_CHANGE:${r.id}`, kind: "ENROLLMENT_CHANGE", id: r.id, studentId: r.studentId, studentName: r.studentName,
      title: [name, classes].filter(Boolean).join(" · "),
      when: shortMd(r.effectiveFrom) ? `${shortMd(r.effectiveFrom)}부터` : "",
      createdOn: r.createdOn, createdAt: r.createdAt,
      rawStatus: deriveEnrollmentChangeStatus(r.status, r.applied ? "yes" : null),
      details: r.kind === "PAUSE" && r.resumeOn ? [`복귀 예정 ${shortMd(r.resumeOn)}`] : [],
      // 거절 사유만(승인 메모는 내부용일 수 있어 조회에서 이미 뺐다)
      answer: r.decisionNote,
      change: { kind: r.kind, effectiveFrom: r.effectiveFrom, applied: r.applied },
      cancelRequest: r.cancelRequest ?? null,
      openHref: "/mypage/enrollment-change",
    });
  }
  for (const r of absences) {
    rows.push({
      key: `REGULAR_ABSENCE:${r.id}`, kind: "REGULAR_ABSENCE", id: r.id, studentId: r.studentId, studentName: r.studentName,
      title: ["결석", r.className].filter(Boolean).join(" · "), when: kstLabel(r.date),
      createdOn: r.createdOn, createdAt: iso(r.createdAt), rawStatus: r.status,
      details: [
        ...(r.reason ? [`사유 ${REASON_LABEL[r.reason] ?? "기타"}`] : []),
        // 취소된 신고에는 보강권 줄을 붙이지 않는다(회수됨)
        ...(r.status !== "CANCELLED" && absenceCreditLine(r.creditStatus) ? [absenceCreditLine(r.creditStatus)!] : []),
      ],
      answer: null,
      absenceCredit: r.creditStatus ?? null,
      openHref: "/mypage/regular-absence",
    });
  }
  for (const r of makeups) {
    rows.push({
      key: `MAKEUP:${r.id}`, kind: "MAKEUP", id: r.id, studentId: r.studentId, studentName: r.studentName,
      title: ["보강", r.className].filter(Boolean).join(" · "), when: kstLabel(r.date),
      createdOn: r.createdOn, createdAt: iso(r.createdAt), rawStatus: r.status,
      details: r.originalDate ? [`${kstLabel(r.originalDate)} 결석분`] : [], answer: null,
      openHref: "/mypage/makeup",
    });
  }
  for (const r of shuttles) {
    const what = PARENT_SHUTTLE_EXCEPTION_KIND_LABEL[r.kind as keyof typeof PARENT_SHUTTLE_EXCEPTION_KIND_LABEL] ?? "셔틀 변경";
    rows.push({
      key: `SHUTTLE_DAY:${r.id}`, kind: "SHUTTLE_DAY", id: r.id, studentId: r.studentId, studentName: r.studentName,
      title: `셔틀 · ${what}`, when: kstLabel(r.date),
      createdOn: r.createdOn, createdAt: iso(r.createdAt), rawStatus: deriveShuttleDayStatus(r.canceledAt),
      details: [PARENT_SHUTTLE_DIRECTION_LABEL[r.direction as keyof typeof PARENT_SHUTTLE_DIRECTION_LABEL], r.location].filter(Boolean) as string[],
      answer: null, openHref: "/mypage/shuttle",
    });
  }
  for (const r of seasonalAbsences) {
    rows.push({
      key: `SEASONAL_ABSENCE:${r.id}`, kind: "SEASONAL_ABSENCE", id: r.id, studentId: r.studentId, studentName: r.studentName,
      title: ["특강 결석", r.offeringTitle].filter(Boolean).join(" · "), when: kstLabel(r.date),
      createdOn: r.createdOn, createdAt: iso(r.createdAt), rawStatus: r.status,
      details: r.reason ? [`사유 ${REASON_LABEL[r.reason] ?? "기타"}`] : [], answer: null,
      openHref: "/mypage/seasonal",
    });
  }
  for (const r of seasonalMakeups) {
    rows.push({
      key: `SEASONAL_MAKEUP:${r.id}`, kind: "SEASONAL_MAKEUP", id: r.id, studentId: r.studentId, studentName: r.studentName,
      title: ["특강 보강", r.offeringTitle].filter(Boolean).join(" · "), when: r.date ? kstLabel(r.date) : "",
      createdOn: r.createdOn, createdAt: iso(r.createdAt), rawStatus: r.status, details: [], answer: null,
      openHref: "/mypage/seasonal",
    });
  }
  for (const r of inquiries) {
    rows.push({
      key: `PARENT_REQUEST:${r.id}`, kind: "PARENT_REQUEST", id: r.id, studentId: r.studentId, studentName: r.studentName,
      title: ["문의", r.title].filter(Boolean).join(" · "), when: "",
      createdOn: r.createdOn, createdAt: iso(r.createdAt), rawStatus: r.status, details: [],
      // 문의 답변은 학부모에게 보내는 말(홈 «내 문의»에도 보인다)
      // 누르면 그 문의의 대화 화면(이어 쓰기) — 2026-11-14 c3
      answer: r.adminNote ?? null, openHref: `/mypage/requests/${r.id}`,
    });
  }
  return sortTimeline(rows).map((row) => toTimelineView(row, today));
}
