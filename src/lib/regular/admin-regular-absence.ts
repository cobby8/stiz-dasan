import { prisma } from "@/lib/prisma";
import { notMergedStudent } from "@/lib/studentVisibility";
import { REASON_LABEL, DAY_KO, ymdToDayIndex } from "@/lib/regular/regularAbsenceRules";

// 정규 수업 사전 결석 — 관리자 조회(#3 Step B).
// requireAdmin 게이트는 호출부(서버 액션/페이지)에서 건다. 여기는 순수 조회만.

const STATUS_LABEL: Record<string, string> = {
  REPORTED: "신고됨",
  CONFIRMED: "확정",
  CANCELLED: "취소",
};

// 보강(MakeupSession) 상태 라벨. 레거시 MakeupSession.status 와 동일 코드값.
const MAKEUP_STATUS_LABEL: Record<string, string> = {
  BOOKED: "예약",
  ATTENDED: "출석",
  NO_SHOW: "노쇼",
  CANCELLED: "취소",
};

export type RegularAbsenceRow = {
  id: string;
  studentId: string;
  classId: string;
  studentName: string;
  className: string;
  date: string; // YYYY-MM-DD
  dateLabel: string;
  startTime: string;
  reason: string;
  reasonLabel: string;
  status: string;
  statusLabel: string;
  reportedAtLabel: string | null;
  // 이 결석에 지정된 보강(MakeupSession, 자연키 매칭) — 없으면 null
  makeupId: string | null;
  makeupClassName: string | null;
  makeupDate: string | null; // YYYY-MM-DD
  makeupDateLabel: string | null;
  makeupStatus: string | null; // BOOKED | ATTENDED | NO_SHOW
  makeupStatusLabel: string | null;
};

export type RegularAbsenceClassOption = { classId: string; className: string };

// 보강 반 선택 드롭다운용 옵션(전체 반).
export type MakeupClassOption = {
  classId: string;
  className: string;
  dayOfWeek: string;
  startTime: string;
  endTime: string;
  programName: string | null;
};

function dateLabel(ymd: string): string {
  const idx = ymdToDayIndex(ymd);
  const mm = Number(ymd.slice(5, 7));
  const dd = Number(ymd.slice(8, 10));
  const ko = idx == null ? "" : DAY_KO[idx];
  return `${mm}/${dd}(${ko})`;
}

function reportedAtLabel(value: Date | string | null): string | null {
  if (!value) return null;
  const d = typeof value === "string" ? new Date(value) : value;
  const f = new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  return `${Number(p.month)}/${Number(p.day)} ${p.hour}:${p.minute}`;
}

// 결석 신고 목록 조회. 날짜/반 필터(옵션). CANCELLED 는 제외.
export async function getRegularAbsences(filter?: {
  date?: string;
  classId?: string;
}): Promise<RegularAbsenceRow[]> {
  const clauses: string[] = [`ra.status <> 'CANCELLED'`];
  const params: any[] = [];
  if (filter?.date) {
    params.push(filter.date);
    clauses.push(`ra.date = $${params.length}::date`);
  }
  if (filter?.classId) {
    params.push(filter.classId);
    clauses.push(`ra."classId" = $${params.length}`);
  }

  const rows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT ra.id AS id,
            ra."studentId" AS "studentId",
            ra."classId" AS "classId",
            s.name AS "studentName",
            c.name AS "className",
            to_char(ra.date, 'YYYY-MM-DD') AS "date",
            c."startTime" AS "startTime",
            ra.reason AS reason,
            ra.status AS status,
            ra."createdAt" AS "createdAt"
       FROM "RegularAbsence" ra
       JOIN "Student" s ON s.id = ra."studentId"
       JOIN "Class" c ON c.id = ra."classId"
      WHERE ${notMergedStudent("s")} AND ${clauses.join(" AND ")}
      ORDER BY ra.date ASC, s.name ASC`,
    ...params,
  );

  // 각 결석에 지정된 보강(MakeupSession)을 자연키(학생·원래반·결석일)로 매칭.
  //   MakeupSession 은 레거시지만 정규 보강용으로 컬럼이 그대로 맞다.
  //   테이블이 아직 없을 수 있어(최초 예약 전) 조회 실패는 무시하고 보강 없음으로 처리.
  const makeupByKey = new Map<string, { id: string; className: string | null; date: string; status: string }>();
  const studentIds = Array.from(new Set(rows.map((r) => r.studentId)));
  if (studentIds.length > 0) {
    try {
      const mkRows = await prisma.$queryRawUnsafe<any[]>(
        `SELECT ms.id AS id,
                ms."studentId" AS "studentId",
                ms."originalClassId" AS "originalClassId",
                to_char(ms."originalDate", 'YYYY-MM-DD') AS "originalDate",
                ms.status AS status,
                to_char(ms."makeupDate", 'YYYY-MM-DD') AS "makeupDate",
                mc.name AS "makeupClassName",
                ms."createdAt" AS "createdAt"
           FROM "MakeupSession" ms
           LEFT JOIN "Class" mc ON mc.id = ms."makeupClassId"
          WHERE ms."studentId" = ANY($1) AND ms.status <> 'CANCELLED'
          ORDER BY ms."createdAt" ASC`,
        studentIds,
      );
      // 같은 자연키에 여러 건이면 최신(createdAt ASC 정렬이므로 마지막)이 남는다.
      for (const m of mkRows) {
        const key = `${m.studentId}|${m.originalClassId}|${m.originalDate}`;
        makeupByKey.set(key, {
          id: m.id,
          className: m.makeupClassName ?? null,
          date: m.makeupDate,
          status: m.status,
        });
      }
    } catch {
      // MakeupSession 테이블 부재 등 → 보강 정보 없이 진행(안전)
    }
  }

  return rows.map((r) => {
    const mk = makeupByKey.get(`${r.studentId}|${r.classId}|${r.date}`) ?? null;
    return {
      id: r.id,
      studentId: r.studentId,
      classId: r.classId,
      studentName: r.studentName,
      className: r.className,
      date: r.date,
      dateLabel: dateLabel(r.date),
      startTime: r.startTime,
      reason: r.reason,
      reasonLabel: REASON_LABEL[r.reason] || r.reason,
      status: r.status,
      statusLabel: STATUS_LABEL[r.status] || r.status,
      reportedAtLabel: reportedAtLabel(r.createdAt),
      makeupId: mk?.id ?? null,
      makeupClassName: mk?.className ?? null,
      makeupDate: mk?.date ?? null,
      makeupDateLabel: mk ? dateLabel(mk.date) : null,
      makeupStatus: mk?.status ?? null,
      makeupStatusLabel: mk ? MAKEUP_STATUS_LABEL[mk.status] || mk.status : null,
    };
  });
}

// 보강 반 선택 드롭다운 옵션 — 전체 반(프로그램명 포함). 관리자가 보강 반을 자유 선택.
export async function getMakeupClassOptions(): Promise<MakeupClassOption[]> {
  const rows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT c.id AS "classId", c.name AS "className",
            c."dayOfWeek" AS "dayOfWeek", c."startTime" AS "startTime", c."endTime" AS "endTime",
            p.name AS "programName"
       FROM "Class" c
       LEFT JOIN "Program" p ON p.id = c."programId"
      ORDER BY c.name ASC`,
  );
  return rows.map((r) => ({
    classId: r.classId,
    className: r.className,
    dayOfWeek: r.dayOfWeek,
    startTime: r.startTime,
    endTime: r.endTime,
    programName: r.programName ?? null,
  }));
}

// 반 필터 드롭다운용 — 결석 신고가 있는 반 목록(중복 제거).
export async function getRegularAbsenceClasses(): Promise<RegularAbsenceClassOption[]> {
  const rows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT DISTINCT c.id AS "classId", c.name AS "className"
       FROM "RegularAbsence" ra
       JOIN "Class" c ON c.id = ra."classId"
      WHERE ra.status <> 'CANCELLED'
      ORDER BY c.name ASC`,
  );
  return rows.map((r) => ({ classId: r.classId, className: r.className }));
}
