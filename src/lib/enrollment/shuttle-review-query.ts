import "server-only";
import { prisma } from "@/lib/prisma";
import { notMergedStudent } from "@/lib/studentVisibility";
import { classRunsShuttle } from "@/lib/billing/workbench-pricing";
import { getEnrollmentShuttleProgress } from "./shuttle-progress-query";
import { ShuttleReviewError, reviewMonth, reviewId, reviewPage, reviewFingerprint, assertReviewFingerprint, parseReviewResponse } from "./shuttle-review";
import type { ShuttleIntakeDashboard, ShuttleIntakeItem, ShuttleReview, ShuttleReviewProposal } from "./shuttle-review-types";

type Db = { $queryRawUnsafe<T>(sql: string, ...values: unknown[]): Promise<T>; $executeRawUnsafe(sql: string, ...values: unknown[]): Promise<number> };
type Store = Db & { $transaction<T>(work: (db: Db) => Promise<T>, options?: { isolationLevel: "RepeatableRead" | "Serializable"; timeout: number }): Promise<T> };
type Actor = { appUserId: string };
type App = { id: string; status: string; convertedStudentId: string; assignedClassId: string; shuttleNeeded: boolean; requestedStartOn: string | null; shuttleTime: string | null; studentName: string; grade: string | null; applicationVersion: string };
type Class = ShuttleIntakeItem["classes"][number] & { enrollmentStartOn: string | null; enrollmentVersion: string; classVersion: string; runsShuttle?: boolean | null };
type Location = ShuttleIntakeItem["locations"][number] & { confirmedAt: string; consentVersion: string | null; locationVersion: string };
type ReviewRow = { id: string; applicationId: string; studentId: string; serviceMonth: string; driverUserId: string; driverName: string; sourceFingerprint: string; status: string; note: string | null; proposals: ShuttleReviewProposal[]; requestedAt: string; reviewedAt: string | null };
const driverCondition = `(u.role::text='DRIVER' OR EXISTS (SELECT 1 FROM "UserRoleGrant" g WHERE g."userId"=u.id AND g.role='DRIVER' AND g.status='ACTIVE'))`;
const appSelect = `SELECT a.id,a.status,a."convertedStudentId",a."assignedClassId",a."shuttleNeeded",a."requestedStartOn"::text,a."shuttleTime",a."updatedAt"::text AS "applicationVersion",s.name AS "studentName",s.grade FROM "EnrollmentApplication" a JOIN "Student" s ON s.id=a."convertedStudentId" WHERE a.status='APPROVED' AND a."shuttleNeeded"=true AND ${notMergedStudent("s")}`;
const reviewSelect = `SELECT r.*,u.name AS "driverName",r."requestedAt"::text AS "requestedAt",r."reviewedAt"::text AS "reviewedAt" FROM "EnrollmentShuttleReview" r JOIN "User" u ON u.id=r."driverUserId"`;

// 역할 캐시가 남아 있어도 회수된 권한이 열리지 않도록 현재 DB 역할을 확인한다.
async function authorize(db: Db, actor: Actor, adminOnly = false) {
  const rows = await db.$queryRawUnsafe<Array<{ admin: boolean; driver: boolean }>>(`SELECT (u.role::text IN ('ADMIN','VICE_ADMIN')) AS admin,${driverCondition} AS driver FROM "User" u WHERE u.id=$1 AND u."withdrawnAt" IS NULL`, actor.appUserId);
  const role = rows[0];
  if (!role || (adminOnly ? !role.admin : !role.admin && !role.driver)) throw new ShuttleReviewError("이 작업을 처리할 권한이 없습니다.", 403, "SHUTTLE_REVIEW_FORBIDDEN");
  return role;
}
async function currentDrivers(db: Db) {
  return db.$queryRawUnsafe<Array<{ id: string; name: string }>>(`SELECT u.id,u.name FROM "User" u WHERE u."withdrawnAt" IS NULL AND ${driverCondition} ORDER BY u.name,u.id`);
}
async function context(db: Db, app: App, month: string, lock = false) {
  const ids = [...new Set(app.assignedClassId.split(",").map(x => x.trim()).filter(Boolean))];
  const enrolled = await db.$queryRawUnsafe<Class[]>(`SELECT c.id,c.name,c."dayOfWeek",c."startTime",c."endTime",c."updatedAt"::text AS "classVersion",e."startsOn"::text AS "enrollmentStartOn",e."updatedAt"::text AS "enrollmentVersion",p."runsShuttle" FROM "Class" c JOIN "Enrollment" e ON e."classId"=c.id JOIN "Program" p ON p.id=c."programId" WHERE e."studentId"=$1 AND c.id=ANY($2::text[]) AND e.status='ACTIVE' ORDER BY c."dayOfWeek",c.id${lock ? ' FOR SHARE OF c,e' : ''}`, app.convertedStudentId, ids);
  if (!ids.length || enrolled.length !== ids.length || enrolled.some(c => !["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].includes(c.dayOfWeek))) throw new ShuttleReviewError("배정 반의 현재 수강 상태를 확인해 주세요.", 409, "SHUTTLE_CLASSES_CHANGED");
  if (app.requestedStartOn && app.requestedStartOn.slice(0,7) > month) throw new ShuttleReviewError("수강을 시작하는 월부터 검토할 수 있습니다.", 409, "SHUTTLE_START_MONTH_REQUIRED");
  if (enrolled.some(c => c.enrollmentStartOn && c.enrollmentStartOn.slice(0,7) > month)) throw new ShuttleReviewError("실제 수강을 시작하는 월부터 검토할 수 있습니다.", 409, "SHUTTLE_START_MONTH_REQUIRED");
  // 셔틀 미운행 반(주말·성인반 등)은 검토 요일·제안 시각·지문에서 뺀다 — 청구 셔틀비·배정 보드와 같은 판정(classRunsShuttle).
  // 지문에 넣는 값은 화면에 보이는 반과 같은 모양(runsShuttle 칸 없음)으로 맞춘다.
  const classes = enrolled.filter(c => classRunsShuttle(c)).map(({ runsShuttle: _runsShuttle, ...c }) => c);
  if (!classes.length) throw new ShuttleReviewError("셔틀을 운행하는 반이 없습니다. 배정 반을 확인해 주세요.", 409, "SHUTTLE_NO_RUNNING_CLASS");
  const locations = await db.$queryRawUnsafe<Location[]>(`SELECT kind,COALESCE(name,'') AS name,address,latitude,longitude,"confirmedAt"::text,"consentVersion","updatedAt"::text AS "locationVersion" FROM "StudentShuttleLocation" WHERE "studentId"=$1 ORDER BY kind${lock ? ' FOR SHARE' : ''}`, app.convertedStudentId);
  const weekdays = [...new Set(classes.map(c => ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].indexOf(c.dayOfWeek)))];
  const roster = await db.$queryRawUnsafe<unknown[]>(`SELECT id,weekday,direction,"studentId","classTime","arriveTime","stopName",latitude,longitude,"sortOrder","importedAt"::text FROM "RegularShuttleStop" WHERE "serviceMonth"=$1 AND weekday=ANY($2::int[]) ORDER BY id${lock ? ' FOR SHARE' : ''}`, month, weekdays);
  const routes = await db.$queryRawUnsafe<unknown[]>(`SELECT id,"dayOfWeek",direction,payload,"updatedAt"::text FROM "RegularDispatchRoute" WHERE "serviceMonth"=$1 AND "dayOfWeek"=ANY($2::text[]) ORDER BY id${lock ? ' FOR SHARE' : ''}`, month, classes.map(c => c.dayOfWeek));
  const fingerprint = reviewFingerprint({ applicationId: app.id, studentId: app.convertedStudentId, studentName: app.studentName, grade: app.grade, month, requestedStartOn: app.requestedStartOn, requestedTime: app.shuttleTime, applicationVersion: app.applicationVersion, classes, locations, roster, routes });
  return { classes, locations, fingerprint };
}
function locationReady(locations: Location[]) {
  return ["PICKUP","DROPOFF"].every(kind => locations.some(l => l.kind === kind && l.consentVersion === "2026-07-21" && Boolean(l.confirmedAt) && Number.isFinite(l.latitude) && Math.abs(l.latitude) <= 90 && Number.isFinite(l.longitude) && Math.abs(l.longitude) <= 180));
}
function reviewView(row: ReviewRow | undefined, fingerprint: string): ShuttleReview | null {
  if (!row) return null;
  const stale = row.sourceFingerprint !== fingerprint;
  return { id: row.id, driverUserId: row.driverUserId, driverName: row.driverName, status: stale ? "STALE" : row.status as ShuttleReview["status"], note: stale ? null : row.note, proposals: stale ? [] : row.proposals, requestedAt: row.requestedAt, reviewedAt: row.reviewedAt };
}
/** READ ONLY: 조회에서 검토 기록·배차·알림을 만들지 않는다. */
export async function getShuttleIntakeDashboard(actor: Actor, monthValue: unknown, adminOnly: boolean, store: Store = prisma, pageValue: unknown = 1): Promise<ShuttleIntakeDashboard> {
  const month = reviewMonth(monthValue), page = reviewPage(pageValue);
  return store.$transaction(async db => {
    const role = await authorize(db, actor, adminOnly);
    const reviews = await db.$queryRawUnsafe<ReviewRow[]>(`${reviewSelect} WHERE r."serviceMonth"=$1 AND r.status<>'SUPERSEDED'${adminOnly ? '' : ' AND r."driverUserId"=$2'} ORDER BY r."requestedAt" DESC`, ...adminOnly ? [month] : [month, actor.appUserId]);
    const found = await db.$queryRawUnsafe<App[]>(`${appSelect} AND (a."requestedStartOn" IS NULL OR to_char(a."requestedStartOn",'YYYY-MM')<=$1)${adminOnly ? '' : ' AND a.id=ANY($2::text[])'} ORDER BY a."createdAt" DESC,a.id LIMIT $${adminOnly ? 2 : 3} OFFSET $${adminOnly ? 3 : 4}`, ...adminOnly ? [month, 51, (page - 1) * 50] : [month, reviews.map(r => r.applicationId), 51, (page - 1) * 50]);
    const hasMore = found.length > 50, apps = found.slice(0, 50);
    const progress = await getEnrollmentShuttleProgress(apps, month, db);
    const items: ShuttleIntakeItem[] = [];
    for (const app of apps) {
      let ctx;
      try { ctx = await context(db, app, month); } catch (error) { if (error instanceof ShuttleReviewError && error.status === 409) continue; throw error; }
      const review = reviewView(reviews.find(r => r.applicationId === app.id && r.studentId === app.convertedStudentId), ctx.fingerprint);
      if (!adminOnly && !review) continue;
      items.push({ applicationId: app.id, studentId: app.convertedStudentId, studentName: app.studentName, grade: app.grade, requestedStartOn: app.requestedStartOn, requestedTime: app.shuttleTime, classes: ctx.classes.map(({ id,name,dayOfWeek,startTime,endTime }) => ({ id,name,dayOfWeek,startTime,endTime })), locations: !adminOnly && review?.status === "STALE" ? [] : ctx.locations.filter(l => l.kind === "PICKUP" || l.kind === "DROPOFF").map(({ kind,name,address,latitude,longitude }) => ({ kind,name,address,latitude,longitude })), fingerprint: ctx.fingerprint, progress: progress[app.id], review });
    }
    return { serviceMonth: month, items, page, hasMore, ...(adminOnly && role.admin ? { drivers: await currentDrivers(db) } : {}) };
  }, { isolationLevel: "RepeatableRead", timeout: 20_000 });
}
export async function assignShuttleReview(actor: Actor, input: Record<string, unknown>, store: Store = prisma) {
  const applicationId = reviewId(input.applicationId), month = reviewMonth(input.serviceMonth), driverUserId = reviewId(input.driverUserId);
  return store.$transaction(async db => {
    await authorize(db, actor, true);
    await db.$queryRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext($1))::text AS "lockResult"`, `shuttle-review:${applicationId}:${month}`);
    const driver = await db.$queryRawUnsafe<Array<{ id: string }>>(`SELECT u.id FROM "User" u WHERE u.id=$1 AND u."withdrawnAt" IS NULL AND ${driverCondition} FOR SHARE OF u`, driverUserId);
    if (!driver.length) throw new ShuttleReviewError("현재 기사 역할이 있는 담당자를 선택해 주세요.", 409, "DRIVER_UNAVAILABLE");
    const apps = await db.$queryRawUnsafe<App[]>(`${appSelect} AND a.id=$1 FOR SHARE OF a,s`, applicationId);
    if (!apps[0]) throw new ShuttleReviewError("승인된 셔틀 신청을 찾을 수 없습니다.", 404, "SHUTTLE_APPLICATION_NOT_FOUND");
    const ctx = await context(db, apps[0], month, true);
    assertReviewFingerprint(input.expectedFingerprint, ctx.fingerprint);
    if (!locationReady(ctx.locations)) throw new ShuttleReviewError("동의가 확인된 승차·하차 위치를 먼저 등록해 주세요.", 409, "SHUTTLE_LOCATION_REQUIRED");
    const old = await db.$queryRawUnsafe<ReviewRow[]>(`${reviewSelect} WHERE r."applicationId"=$1 AND r."serviceMonth"=$2 AND r.status<>'SUPERSEDED' FOR UPDATE OF r`, applicationId, month);
    if (old[0]?.driverUserId === driverUserId && old[0].sourceFingerprint === ctx.fingerprint && old[0].status === "PENDING") return { id: old[0].id, reused: true };
    await db.$executeRawUnsafe(`UPDATE "EnrollmentShuttleReview" SET status='SUPERSEDED',"supersededAt"=now() WHERE "applicationId"=$1 AND "serviceMonth"=$2 AND status<>'SUPERSEDED'`, applicationId, month);
    const rows = await db.$queryRawUnsafe<Array<{ id: string }>>(`INSERT INTO "EnrollmentShuttleReview" ("applicationId","studentId","serviceMonth","driverUserId","sourceFingerprint","requestedByUserId") VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, applicationId, apps[0].convertedStudentId, month, driverUserId, ctx.fingerprint, actor.appUserId);
    return { id: rows[0].id, reused: false };
  }, { isolationLevel: "Serializable", timeout: 20_000 });
}
export async function submitShuttleReview(actor: Actor, input: Record<string, unknown>, store: Store = prisma) {
  const id = reviewId(input.reviewId);
  return store.$transaction(async db => {
    const role = await authorize(db, actor);
    // 관리자는 자신에게 부여된 기사 역할과 담당 지정이 있을 때만 기사 의견을 제출한다.
    if (!role.driver) throw new ShuttleReviewError("담당 기사만 검토 결과를 제출할 수 있습니다.", 403, "SHUTTLE_REVIEW_FORBIDDEN");
    const rows = await db.$queryRawUnsafe<ReviewRow[]>(`${reviewSelect} WHERE r.id=$1 AND r."driverUserId"=$2 AND r.status<>'SUPERSEDED' FOR UPDATE OF r`, id, actor.appUserId);
    const row = rows[0];
    if (!row) throw new ShuttleReviewError("담당 검토 요청을 찾을 수 없습니다.", 404, "SHUTTLE_REVIEW_NOT_FOUND");
    if (row.status !== "PENDING") throw new ShuttleReviewError("이미 검토한 요청입니다. 관리자에게 새 검토 요청을 받아주세요.", 409, "SHUTTLE_REVIEW_ALREADY_DONE");
    const apps = await db.$queryRawUnsafe<App[]>(`${appSelect} AND a.id=$1 AND a."convertedStudentId"=$2 FOR SHARE OF a,s`, row.applicationId, row.studentId);
    if (!apps[0]) throw new ShuttleReviewError("신청 또는 원생 연결이 변경됐습니다.", 409, "STALE_SHUTTLE_REVIEW");
    const ctx = await context(db, apps[0], row.serviceMonth, true);
    assertReviewFingerprint(row.sourceFingerprint, ctx.fingerprint); assertReviewFingerprint(input.expectedFingerprint, ctx.fingerprint);
    const reply = parseReviewResponse(input, [...new Set(ctx.classes.map(c => c.dayOfWeek))], ctx.classes);
    await db.$executeRawUnsafe(`UPDATE "EnrollmentShuttleReview" SET status=$2,note=$3,proposals=$4::jsonb,"reviewedAt"=now() WHERE id=$1`, id, reply.status, reply.note, JSON.stringify(reply.proposals));
    return { id, status: reply.status };
  }, { isolationLevel: "Serializable", timeout: 20_000 });
}
