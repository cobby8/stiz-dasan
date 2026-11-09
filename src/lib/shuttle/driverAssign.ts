import "server-only";
import { prisma } from "@/lib/prisma";
import { koreaServiceMonth } from "@/lib/regular/serviceMonth";
import { notMergedStudent } from "@/lib/studentVisibility";
import { classRunsShuttle } from "@/lib/billing/workbench-pricing";
import { getSettings } from "@/lib/seasonal/shuttle-optimize";
import { isKoreanCoordinate } from "./academyLocation";
import { addRosterStudentAs } from "./regularRosterEdit";
import { dowToWeekday, type EnrolledClass, type GeoPoint } from "./regularRosterPlacementLogic";
import type { RegularShuttleStop } from "./regularSheet";
import {
  assertLegStillOpen,
  assertReassignStillOpen,
  buildAssignAddInput,
  buildReassignAddInput,
  buildAssignBoard,
  DriverAssignError,
  parseAssignRequest,
  type AssignPlace,
  type AssignStudentInput,
  type AssignStudentPlan,
} from "./driverAssignLogic";

// 기사님 「새 학생 배정」 서버 — 셔틀 신청이 승인됐는데 아직 운행표(RegularShuttleStop)에 없는 칸을 보여 주고 넣는다.
// PgBouncer 트랜잭션 모드라 $queryRawUnsafe 만 쓴다(ORM 기본 메서드 금지).
// 넣기는 원장 학생 추가와 같은 addRosterStudentAs(같은 잠금·삽입 계획·감사 기록)를 쓴다 — 새 쓰기 경로를 만들지 않는다.

export { DriverAssignError };

type Actor = { appUserId: string };

// 기사 역할 판정 — 검토 화면(shuttle-review-query.ts)과 같은 조건(주 역할 DRIVER 또는 승인된 추가 역할 DRIVER).
const driverCondition = `(u.role::text='DRIVER' OR EXISTS (SELECT 1 FROM "UserRoleGrant" g WHERE g."userId"=u.id AND g.role='DRIVER' AND g.status='ACTIVE'))`;

/** 역할 캐시가 남아 있어도 회수된 권한이 열리지 않게 **현재 DB 역할**로 확인한다(DRIVER 또는 ADMIN·VICE_ADMIN). */
export async function authorizeAssign(actor: Actor): Promise<{ admin: boolean; driver: boolean }> {
  const rows = await prisma.$queryRawUnsafe<Array<{ admin: boolean; driver: boolean }>>(
    `SELECT (u.role::text IN ('ADMIN','VICE_ADMIN')) AS admin, ${driverCondition} AS driver
       FROM "User" u WHERE u.id=$1 AND u."withdrawnAt" IS NULL`,
    actor.appUserId,
  );
  const role = rows[0];
  if (!role || (!role.admin && !role.driver)) throw new DriverAssignError("이 작업을 처리할 권한이 없습니다.", 403, "FORBIDDEN");
  // 감사 기록에서 「어느 화면에서 넣었나」를 가르려고 역할을 돌려준다.
  return { admin: Boolean(role.admin), driver: Boolean(role.driver) };
}

/** 'YYYY-MM' 이후(초과)에 이미 만들어진 명단 달 — 「같이 넣기」 문구용. */
async function laterMonths(month: string): Promise<string[]> {
  const rows = await prisma.$queryRawUnsafe<{ m: string }[]>(
    `SELECT DISTINCT "serviceMonth" AS m FROM "RegularShuttleStop" WHERE "serviceMonth" > $1 ORDER BY 1`,
    month,
  );
  return rows.map((r) => String(r.m));
}

/** 그 달 명단 — 기사님 화면·관리자 명단과 같은 순서(요일 → sortOrder → id 바이트 순). 조회 실패는 그대로 던진다(빈 명단으로 착각 금지). */
async function monthStops(month: string): Promise<RegularShuttleStop[]> {
  const rows = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(
    `SELECT "id","serviceMonth","weekday","classTime","arriveTime","stopName","direction","studentName","studentId","studentPhone","parentPhone","note","sortOrder","latitude","longitude"
       FROM "RegularShuttleStop" WHERE "serviceMonth"=$1 ORDER BY "weekday" ASC, "sortOrder" ASC, "id" COLLATE "C" ASC`,
    month,
  );
  return rows.map((r) => toStop(r, month));
}

const WD = ["일", "월", "화", "수", "목", "금", "토"];
function toStop(r: Record<string, unknown>, month: string): RegularShuttleStop {
  return {
    id: String(r.id),
    serviceMonth: String(r.serviceMonth ?? month),
    weekday: Number(r.weekday),
    weekdayLabel: WD[Number(r.weekday)] ?? "",
    classTime: (r.classTime as string | null) ?? null,
    arriveTime: (r.arriveTime as string | null) ?? null,
    stopName: String(r.stopName ?? ""),
    direction: (["BOARD", "ALIGHT", "PIVOT", "RETURN"].includes(String(r.direction)) ? r.direction : "BOARD") as RegularShuttleStop["direction"],
    studentName: (r.studentName as string | null) ?? null,
    studentId: (r.studentId as string | null) ?? null,
    studentPhone: (r.studentPhone as string | null) ?? null,
    parentPhone: (r.parentPhone as string | null) ?? null,
    note: (r.note as string | null) ?? null,
    sortOrder: Number(r.sortOrder) || 0,
    latitude: r.latitude != null ? Number(r.latitude) : null,
    longitude: r.longitude != null ? Number(r.longitude) : null,
  };
}

/** 운행 기준점(학원·차고지) — 좌표가 비거나 이상하면 null(추천은 열린 경로로 계산). */
async function basePoints(): Promise<{ academy: GeoPoint | null; depot: GeoPoint | null }> {
  const settings = await getSettings();
  const geo = (g: { lat: number; lng: number } | null): GeoPoint | null =>
    g && Number.isFinite(g.lat) && Number.isFinite(g.lng) && isKoreanCoordinate(g.lat, g.lng) ? { lat: g.lat, lng: g.lng } : null;
  return { academy: geo(settings.academy), depot: geo(settings.depot) };
}

/**
 * 대상 학생 — 승인된 셔틀 신청(APPROVED + shuttleNeeded + 원생 연결) · 병합 안 된 학생 · 신청 개시월이 그 달 이하.
 * 한 학생에게 신청이 여럿이면 가장 최근 신청(희망 시각)을 쓴다. onlyStudentId 를 주면 그 학생만(저장 재검사).
 * + (2026-11-09) 신청서가 없어도 그 달 명단에 행이 있는 학생(hasApplication=false, 재배정 판정 전용).
 * 수강은 다님(ACTIVE)·휴원(PAUSED) + 개시일이 그 달 말 이전(또는 개시일 없음). 휴원은 칸을 만들지 않고 재배정 판정에만 쓴다.
 * 셔틀 미운행 반(classRunsShuttle=false: 주말·성인반 등)도 칸을 만들지 않아 수업 목록에서 뺀다.
 */
async function loadStudents(month: string, onlyStudentId?: string): Promise<AssignStudentInput[]> {
  const applied = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(
    // 한 학생당 최근 신청 하나(DISTINCT ON) → 바깥에서 최근 신청 순으로 다시 정렬(새 학생이 위로).
    `SELECT * FROM (SELECT DISTINCT ON (a."convertedStudentId") a."convertedStudentId" AS "studentId", a."shuttleTime", s."name", s."grade", a."createdAt",
            COALESCE(u."phone", (SELECT g."phone" FROM "Guardian" g WHERE g."studentId"=s."id" AND g."phone" IS NOT NULL ORDER BY g."isPrimary" DESC, g."createdAt" ASC LIMIT 1)) AS "parentPhone"
       FROM "EnrollmentApplication" a
       JOIN "Student" s ON s."id"=a."convertedStudentId"
       LEFT JOIN "User" u ON u."id"=s."parentId"
      WHERE a."status"='APPROVED' AND a."shuttleNeeded"=true AND a."convertedStudentId" IS NOT NULL AND ${notMergedStudent("s")}
        AND (a."requestedStartOn" IS NULL OR to_char(a."requestedStartOn",'YYYY-MM') <= $1)
        ${onlyStudentId ? `AND a."convertedStudentId"=$2` : ""}
      ORDER BY a."convertedStudentId", a."createdAt" DESC) x
      ORDER BY x."createdAt" DESC, x."studentId"`,
    ...(onlyStudentId ? [month, onlyStudentId] : [month]),
  );
  // 보드 확장(2026-11-09 D4): 신청서가 없어도 그 달 명단에 행이 있는 학생(시트 이관 포함)은 «반 이동 재배정» 판정 재료로 읽는다.
  // 이 학생들은 hasApplication=false 라 «신규» 칸은 뜨지 않는다(신규 판정은 기존 조건 그대로).
  const rostered = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(
    `SELECT s."id" AS "studentId", s."name", s."grade",
            COALESCE(u."phone", (SELECT g."phone" FROM "Guardian" g WHERE g."studentId"=s."id" AND g."phone" IS NOT NULL ORDER BY g."isPrimary" DESC, g."createdAt" ASC LIMIT 1)) AS "parentPhone"
       FROM "Student" s
       LEFT JOIN "User" u ON u."id"=s."parentId"
      WHERE s."id" IN (SELECT DISTINCT r."studentId" FROM "RegularShuttleStop" r WHERE r."serviceMonth"=$1 AND r."studentId" IS NOT NULL)
        AND ${notMergedStudent("s")}
        ${onlyStudentId ? `AND s."id"=$2` : ""}
      ORDER BY s."name", s."id"`,
    ...(onlyStudentId ? [month, onlyStudentId] : [month]),
  );
  const appliedIds = new Set(applied.map((a) => String(a.studentId)));
  // 신청서 학생(최근 신청 순) 먼저, 그다음 명단에만 있는 학생(이름 순).
  const apps: (Record<string, unknown> & { hasApplication: boolean })[] = [
    ...applied.map((a) => Object.assign({}, a, { hasApplication: true })),
    ...rostered.filter((s) => !appliedIds.has(String(s.studentId))).map((s) => Object.assign({}, s, { shuttleTime: null, hasApplication: false })),
  ];
  if (apps.length === 0) return [];
  const ids = apps.map((a) => String(a.studentId));

  // 휴원(PAUSED)도 읽는다 — 재배정 판정이 «휴원 요일 행은 옛 칸이 아님»을 알아야 해서. 칸 만들기·저장 재검사는 다니는 수업만 본다.
  const classes = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(
    `SELECT e."studentId", c."dayOfWeek", c."startTime", c."endTime", c."name" AS "className", p."name" AS "programName", p."runsShuttle", e."status"
       FROM "Enrollment" e
       JOIN "Class" c ON c."id"=e."classId"
       JOIN "Program" p ON p."id"=c."programId"
      WHERE e."studentId"=ANY($1::text[]) AND e."status" IN ('ACTIVE','PAUSED') AND p."deletedAt" IS NULL
        AND (e."startsOn" IS NULL OR to_char(e."startsOn",'YYYY-MM') <= $2)
      ORDER BY c."startTime" ASC`,
    ids, month,
  );
  const places = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(
    `SELECT "studentId","kind","name","address","latitude","longitude" FROM "StudentShuttleLocation"
      WHERE "studentId"=ANY($1::text[]) AND "kind" IN ('PICKUP','DROPOFF')`,
    ids,
  );

  const enrolledBy = new Map<string, EnrolledClass[]>();
  for (const c of classes) {
    // 셔틀을 운행하지 않는 반(주말 반·성인반 등 Program.runsShuttle=false)은 칸을 만들지 않는다 — 청구 셔틀비와 같은 판정.
    // 여기서 빼면 남은 칸·저장 재검사(buildAssignAddInput 의 「그 요일 수업」)가 함께 따라온다.
    if (!classRunsShuttle({ dayOfWeek: c.dayOfWeek as string | null, runsShuttle: c.runsShuttle as boolean | null })) continue;
    const weekday = dowToWeekday(c.dayOfWeek as string | null);
    if (weekday == null) continue;
    const list = enrolledBy.get(String(c.studentId)) ?? [];
    list.push({
      weekday, startTime: String(c.startTime ?? ""), endTime: String(c.endTime ?? ""),
      className: (c.className as string | null) ?? null, programName: (c.programName as string | null) ?? null,
      status: c.status === "PAUSED" ? "PAUSED" : "ACTIVE",
    });
    enrolledBy.set(String(c.studentId), list);
  }
  const placeOf = (studentId: string, kind: string): AssignPlace | null => {
    const p = places.find((x) => String(x.studentId) === studentId && x.kind === kind);
    if (!p || p.latitude == null || p.longitude == null) return null;
    return { name: (p.name as string | null) ?? null, address: String(p.address ?? ""), latitude: Number(p.latitude), longitude: Number(p.longitude) };
  };

  return apps.map((a) => {
      const id = String(a.studentId);
      return {
        studentId: id, name: String(a.name ?? ""), grade: (a.grade as string | null) ?? null,
        wishTime: (a.shuttleTime as string | null) ?? null, parentPhone: (a.parentPhone as string | null) ?? null,
        enrolled: enrolledBy.get(id) ?? [], pickup: placeOf(id, "PICKUP"), dropoff: placeOf(id, "DROPOFF"),
        hasApplication: a.hasApplication,
      };
    });
}

export type DriverAssignBoard = {
  serviceMonth: string;
  /** 「같이 넣기」에 함께 들어갈 이미 만들어진 이후 달. */
  laterMonths: string[];
  students: AssignStudentPlan[];
  openLegCount: number;
};

/** 조회 전용 — 명단·배차·알림을 바꾸지 않는다. */
export async function getDriverAssignBoard(actor: Actor, month: string): Promise<DriverAssignBoard> {
  await authorizeAssign(actor);
  const [students, stops, base, later] = await Promise.all([loadStudents(month), monthStops(month), basePoints(), laterMonths(month)]);
  const plans = buildAssignBoard({ students, stops, academy: base.academy, depot: base.depot });
  return { serviceMonth: month, laterMonths: later, students: plans, openLegCount: plans.reduce((n, s) => n + s.legs.length, 0) };
}

/**
 * 한 칸 넣기 — 클라이언트가 보낸 studentId 만 믿지 않고 서버가 다시 확인한다.
 * ① 현재 DB 역할 ② 그 학생의 승인된 셔틀 신청 ③ 그 요일 다니는 수업 ④ 그 칸이 아직 비었는지 ⑤ 화면을 연 뒤 순서가 그대로인지
 * ⑥ 달 잠금 안에서 ④를 한 번 더(동시에 두 사람이 넣는 경우).
 */
export async function assignDriverCell(actor: Actor, raw: unknown) {
  const role = await authorizeAssign(actor);
  const req = parseAssignRequest(raw);
  // 관리자 정규배차 화면에서 넣은 것만 via 를 ADMIN_DISPATCH 로 남긴다.
  // 화면 표시(source)만 믿지 않고 현재 DB 역할이 관리자일 때만 바꾼다 — 기사님 기록은 그대로 DRIVER_ASSIGN.
  const fromAdminDispatch = role.admin && (raw as { source?: unknown } | null)?.source === "ADMIN_DISPATCH";
  // 기사님은 이번 달·다음 달 운행표에만 넣는다(지난 달·먼 달 명단을 바꾸지 않게).
  const now = koreaServiceMonth();
  const [ny, nm] = now.split("-").map(Number);
  const next = nm === 12 ? `${ny + 1}-01` : `${ny}-${String(nm + 1).padStart(2, "0")}`;
  if (req.month !== now && req.month !== next) throw new DriverAssignError("이번 달·다음 달 운행표에만 넣을 수 있어요.", 409, "MONTH_OUT_OF_RANGE");
  const [students, stops, base] = await Promise.all([loadStudents(req.month, req.studentId), monthStops(req.month), basePoints()]);
  const student = students[0];
  const via = fromAdminDispatch ? "ADMIN_DISPATCH" : "DRIVER_ASSIGN";
  if (req.reassign) {
    // 반 이동 재배정: 신청서가 없어도 명단에 있는 학생이면 된다. 지울 옛 칸은 서버가 다시 계산하고(buildReassignAddInput),
    // 새 칸 추가 + 옛 칸 삭제를 한 트랜잭션으로(addRosterStudentAs replaceRowIds). 잠금 안에서 짝이 그대로인지 한 번 더 본다.
    if (!student) throw new DriverAssignError("명단에 있는 학생이 아니에요.", 404, "NOT_ELIGIBLE");
    const { input, replaceRowIds, pair } = buildReassignAddInput(req, student, stops, base.academy, base.depot);
    const result = await addRosterStudentAs(actor.appUserId, input, {
      via: `${via}_REASSIGN`,
      replaceRowIds,
      guard: (rows) => assertReassignStillOpen(rows as unknown as RegularShuttleStop[], student, pair),
    });
    return { added: result.added, appliedMonths: result.appliedMonths, skippedMonths: result.skippedMonths, replaced: replaceRowIds.length };
  }
  // 신규 칸은 예전처럼 승인 셔틀 신청 학생만.
  if (!student || student.hasApplication === false) throw new DriverAssignError("셔틀 신청이 승인된 학생이 아니에요.", 404, "NOT_ELIGIBLE");
  const input = buildAssignAddInput(req, student, stops, base.academy, base.depot);
  const result = await addRosterStudentAs(actor.appUserId, input, {
    via,
    guard: (rows) => assertLegStillOpen(rows as unknown as RegularShuttleStop[], student, req.weekday, req.direction),
  });
  return { added: result.added, appliedMonths: result.appliedMonths, skippedMonths: result.skippedMonths };
}
