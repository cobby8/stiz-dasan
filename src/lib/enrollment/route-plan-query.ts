import "server-only";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { routeRecipientKey } from "./route-plan-recipient";
import { todayKst, isKstYmd, kstHm, kstDow } from "@/lib/datetime/kst";
import { getShuttleIntakeDashboard, assignShuttleReview } from "./shuttle-review-query";
import { ShuttleReviewError, reviewMonth } from "./shuttle-review";
import { shuttleFingerprint, routeConfirmation, type ShuttleRosterRow } from "./shuttle-progress";
import { recalculatePlan, recommendInsertion, computePlanImpacts, planLocationKey } from "@/lib/shuttle/routePlanning";
import { routeSegmentsWithTmap } from "@/lib/shuttle/tmap";
import type { ShuttleIntakeItem } from "./shuttle-review-types";
import type { PlanRun, PlanStop, PlanLeg, PlanTimeEntry, PlanDeliveredSnapshot, RoutePlanDraft } from "@/lib/shuttle/routePlanningTypes";
export type PlanDb = {
    $queryRawUnsafe<T>(sql: string, ...values: unknown[]): Promise<T>;
    $executeRawUnsafe(sql: string, ...values: unknown[]): Promise<number>;
};
export type PlanStore = PlanDb & {
    $transaction<T>(work: (db: PlanDb) => Promise<T>, options?: {
        isolationLevel: "RepeatableRead" | "Serializable";
        timeout: number;
    }): Promise<T>;
};
type Actor = {
    appUserId: string;
};
type Row = ShuttleRosterRow & {
    studentName?: string | null;
    parentPhone?: string | null;
    studentPhone?: string | null;
    note?: string | null;
    importedAt?: string;
};
type Saved = {
    id: string;
    serviceMonth: string;
    dayOfWeek: string;
    direction: string;
    payload: {
        vehicles?: Record<string, unknown>[];
    };
    classStart: string | null;
    classEnd: string | null;
    savedByUserId?: string | null;
    updatedAt?: string;
};
export type RouteSnapshot = {
    rows: Row[];
    routes: Saved[];
};
type Data = {
    base: RouteSnapshot;
    baseRuns: PlanRun[];
    runs: PlanRun[];
    fingerprint: string;
    reviewFingerprint: string;
    applicationId: string;
    studentId: string;
    baseline: (PlanDeliveredSnapshot & {
        recipientKey: string;
    })[];
};
type DraftRow = {
    id: string;
    reviewId: string;
    driverUserId: string;
    serviceMonth: string;
    effectiveFrom: string;
    status: "DRAFT" | "SUBMITTED" | "CONFIRMED";
    revision: number;
    data: Data;
    updatedAt: string;
};
export type LegEstimator = (run: PlanRun) => Promise<PlanLeg[]>;
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
function fail(message: string, status = 409, code = "ROUTE_PLAN_CONFLICT"): never { throw new ShuttleReviewError(message, status, code); }
const obj = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
const arr = (v: unknown): Record<string, unknown>[] => Array.isArray(v) ? v.map(obj) : [];
const minute = (v: unknown): number | null => {
    if (typeof v === "number" && Number.isInteger(v) && v >= 0 && v < 1440)
        return v;
    const m = typeof v === "string" ? v.match(/\b([01]\d|2[0-3]):([0-5]\d)\b/) : null;
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};
const hhmm = (v: number | null | undefined) => v == null ? null : `${String(Math.floor(v / 60)).padStart(2, "0")}:${String(v % 60).padStart(2, "0")}`;
const today = todayKst;
async function role(db: PlanDb, actor: Actor, adminOnly = false) {
    const rows = await db.$queryRawUnsafe<{
        admin: boolean;
        driver: boolean;
    }[]>(`SELECT (u.role::text IN ('ADMIN','VICE_ADMIN')) AS admin,(u.role::text='DRIVER' OR EXISTS(SELECT 1 FROM "UserRoleGrant" g WHERE g."userId"=u.id AND g.role='DRIVER' AND g.status='ACTIVE')) AS driver FROM "User" u WHERE u.id=$1 AND u."withdrawnAt" IS NULL FOR SHARE OF u`, actor.appUserId);
    const r = rows[0];
    if (!r || (adminOnly ? !r.admin : !r.admin && !r.driver))
        fail("이 작업을 처리할 권한이 없습니다.", 403, "ROUTE_PLAN_FORBIDDEN");
    return r;
}
async function lock(db: PlanDb, key: string) { await db.$queryRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext($1))::text AS "lockResult"`, key); }
async function snapshot(db: PlanDb, month: string, locked = false): Promise<RouteSnapshot> { const rows = await db.$queryRawUnsafe<Row[]>(`SELECT * FROM "RegularShuttleStop" WHERE "serviceMonth"=$1 ORDER BY id${locked ? ' FOR UPDATE' : ''}`, month); const routes = await db.$queryRawUnsafe<Saved[]>(`SELECT * FROM "RegularDispatchRoute" WHERE "serviceMonth"=$1 ORDER BY id${locked ? ' FOR UPDATE' : ''}`, month); return JSON.parse(JSON.stringify({ rows, routes })); }
async function intake(db: PlanDb, actor: Actor, month: string, admin: boolean, reviewId: string, allowStale = false) {
    const adapter = { $queryRawUnsafe: db.$queryRawUnsafe.bind(db), $executeRawUnsafe: db.$executeRawUnsafe.bind(db), $transaction: async <T>(work: (tx: PlanDb) => Promise<T>) => work(db) } as PlanStore;
    let page = 1;
    while (page <= 100) {
        const dashboard = await getShuttleIntakeDashboard(actor, month, admin, adapter, page);
        const item = dashboard.items.find(i => i.review?.id === reviewId);
        if (item) {
            if (item.review?.status === 'STALE' && !allowStale)
                fail("신청 내용이 바뀌었습니다. 다시 검토 요청해 주세요.");
            return item;
        }
        if (!dashboard.hasMore)
            break;
        page++;
    }
    return fail("현재 담당 검토 요청을 찾을 수 없습니다.", 404);
}
async function fleet(db: PlanDb) {
    return db.$queryRawUnsafe<{
        id: string;
        name: string;
        capacity: number;
    }[]>(`SELECT id,name,capacity FROM "ShuttleVehicle" WHERE "isActive"=true ORDER BY id`);
}
async function endpoints(db: PlanDb) { const rows = await db.$queryRawUnsafe<Record<string, unknown>[]>(`SELECT "academyLatitude","academyLongitude","shuttleDepotLatitude","shuttleDepotLongitude" FROM "AcademySettings" LIMIT 1`); const s = rows[0] ?? {}; const point = (id: string, label: string, lat: unknown, lng: unknown) => ({ id, label, lat: typeof lat === 'number' ? lat : NaN, lng: typeof lng === 'number' ? lng : NaN }); return { academy: point('academy', '학원', s.academyLatitude, s.academyLongitude), depot: point('depot', '차고지', s.shuttleDepotLatitude, s.shuttleDepotLongitude) }; }
/** 외부 호출은 명시적 기능 설정이 있을 때만. 기본값은 추정·확정 차단이다. */
export const roadLegEstimator: LegEstimator = async (run) => {
    const nodes = [run.start, ...run.stops, run.end];
    if (process.env.STIZ_ROUTE_PLAN_ROAD_ESTIMATION !== 'enabled')
        return nodes.slice(1).map((p, i) => ({ fromId: nodes[i].id, toId: p.id, minutes: 3, verified: false, provider: 'ESTIMATE' }));
    try {
        const result = await routeSegmentsWithTmap({ start: run.start, end: run.end, waypoints: run.stops });
        return nodes.slice(1).map((p, i) => ({ fromId: nodes[i].id, toId: p.id, minutes: result.segments[i]?.time == null ? 3 : Math.ceil(result.segments[i].time! / 60), verified: result.segments[i]?.time != null, provider: result.segments[i]?.time != null ? 'TMAP' : 'ESTIMATE' }));
    }
    catch {
        return nodes.slice(1).map((p, i) => ({ fromId: nodes[i].id, toId: p.id, minutes: 3, verified: false, provider: 'ESTIMATE' }));
    }
};
async function recalc(runs: PlanRun[], estimator: LegEstimator) { return recalculatePlan(await Promise.all(runs.map(async (r) => ({ ...r, legs: [...await estimator(r), ...await estimator({ ...r, start: r.end, end: r.start, stops: [] })] })))); }
function entries(runs: PlanRun[], studentId: string): PlanTimeEntry[] { return runs.flatMap(r => r.stops.filter(s => s.students.some(p => p.studentId === studentId) && s.etaMin != null).map(s => ({ studentId, dayOfWeek: r.dayOfWeek, direction: r.direction, timeMin: s.etaMin!, locationKey: planLocationKey(s), locationLabel: s.label }))); }
async function delivered(db: PlanDb, month: string): Promise<PlanDeliveredSnapshot[]> {
    const rows = await db.$queryRawUnsafe<{
        studentId: string;
        source: string;
        entries: PlanTimeEntry[];
        recipientKey: string;
        parentId: string;
        phone: string | null;
    }[]>(`SELECT n."studentId",n.source,n.entries,n."recipientKey",s."parentId",u.phone FROM "RegularRouteNoticeSnapshot" n JOIN "Student" s ON s.id=n."studentId" JOIN "User" u ON u.id=s."parentId" WHERE n."serviceMonth"=$1 AND s."mergedIntoStudentId" IS NULL AND u."withdrawnAt" IS NULL ORDER BY (n.source='DELIVERED') DESC,n."createdAt" DESC,n.id DESC`, month);
    const seen = new Set<string>();
    return rows.filter(r => {
        if (seen.has(r.studentId) || !r.phone || r.recipientKey !== routeRecipientKey(r.parentId, r.phone))
            return false;
        seen.add(r.studentId);
        return true;
    }).map(r => ({ studentId: r.studentId, entries: r.entries, source: r.source as 'DELIVERED' | 'ADMIN_CONFIRMED', delivered: r.source === 'DELIVERED', confirmed: r.source === 'ADMIN_CONFIRMED' }));
}
async function recipients(db: PlanDb, ids: string[]) {
    return db.$queryRawUnsafe<{
        studentId: string;
        parentId: string;
        phone: string | null;
    }[]>(`SELECT s.id AS "studentId",s."parentId",u.phone FROM "Student" s JOIN "User" u ON u.id=s."parentId" WHERE s.id=ANY($1::text[]) AND s."mergedIntoStudentId" IS NULL AND u."withdrawnAt" IS NULL`, ids);
}
async function view(db: PlanDb, row: DraftRow): Promise<RoutePlanDraft> {
    const calc = recalculatePlan(row.data.runs), known = await delivered(db, row.serviceMonth);
    const allContacts = await recipients(db, [...new Set(row.data.runs.flatMap(r => r.stops.flatMap(s => s.students.map(p => p.studentId))))]);
    const snapshots = [...known, ...row.data.baseline.filter(b => !known.some(k => k.studentId === b.studentId) && allContacts.some(c => c.studentId === b.studentId && c.phone && routeRecipientKey(c.parentId, c.phone) === b.recipientKey))];
    const scope = new Set(calc.runs.map(r => `${r.dayOfWeek}:${r.direction}`));
    const scopedSnapshots = snapshots.map(b => ({ ...b, entries: b.entries.filter(e => scope.has(`${e.dayOfWeek}:${e.direction}`)) }));
    const impacts = computePlanImpacts(row.data.baseRuns, calc.runs, scopedSnapshots);
    const contacts = await recipients(db, impacts.filter(i => i.notify).map(i => i.studentId));
    const issues = [...calc.issues, ...adjacentIssues(row, calc.runs)];
    const anyOld = await db.$queryRawUnsafe<{
        studentId: string;
    }[]>(`SELECT DISTINCT "studentId" FROM "RegularRouteNoticeSnapshot" WHERE "serviceMonth"=$1 AND "studentId"=ANY($2::text[])`, row.serviceMonth, impacts.map(i => i.studentId));
    for (const i of impacts)
        if (i.studentId !== row.data.studentId && anyOld.some(o => o.studentId === i.studentId) && !snapshots.some(b => b.studentId === i.studentId)) {
            i.baselineRequired = true;
            i.notify = false;
        }
    for (const run of calc.runs)
        if (!run.vehicleId)
            issues.push({ code: "VEHICLE_REQUIRED", message: "원장님이 차량을 선택해 주세요.", runId: run.id });
    for (const impact of impacts)
        if (impact.baselineRequired)
            issues.push({ code: 'BASELINE_REQUIRED', message: `${impact.studentName}: 마지막 학부모 안내 시각의 확인이 필요합니다.` });
    const notices = impacts.filter(i => i.notify).map(i => {
        const phone = contacts.find(p => p.studentId === i.studentId)?.phone?.replace(/\D/g, '') ?? '';
        if (!/^01\d{8,9}$/.test(phone))
            issues.push({ code: 'RECIPIENT_REQUIRED', message: `${i.studentName}: 보호자 연락처를 확인해 주세요.` });
        return { studentId: i.studentId, studentName: i.studentName, recipientLabel: phone ? `보호자 · ${phone.slice(0, 3)}-****-${phone.slice(-4)}` : '연락처 없음', message: `[STIZ 셔틀] ${i.studentName} ${row.effectiveFrom}부터\n${i.legs.map(l => `${["일", "월", "화", "수", "목", "금", "토"][DOW.indexOf(l.dayOfWeek)]} ${l.direction === 'PICKUP' ? '승차' : '하차'} ${hhmm(l.afterMin)} ${l.afterLocation}`).join('\n')}`, reasons: i.reasons };
    });
    const draft: RoutePlanDraft = { id: row.id, reviewId: row.reviewId, applicationId: row.data.applicationId, studentId: row.data.studentId, serviceMonth: row.serviceMonth, effectiveFrom: row.effectiveFrom, revision: row.revision, status: row.status, baseFingerprint: row.data.fingerprint, runs: calc.runs, impacts, notices, issues, canConfirm: row.status === 'SUBMITTED' && calc.canConfirm && issues.length === 0, updatedAt: row.updatedAt };
    draft.noticeDelivery = { enabled: process.env.STIZ_ROUTE_NOTICE_SEND === 'enabled', items: row.status === 'CONFIRMED' ? await db.$queryRawUnsafe<{
            studentId: string;
            status: string;
        }[]>(`SELECT o."studentId",o.status FROM "RegularRouteNoticeOutbox" o JOIN "RegularRoutePlanVersion" v ON v.id=o."versionId" WHERE v."draftId"=$1 ORDER BY o."studentId"`, row.id) : [] };
    draft.previewHash = shuttleFingerprint({ id: row.id, revision: row.revision, effectiveFrom: row.effectiveFrom, runs: draft.runs, notices: draft.notices, recipients: contacts, issues });
    return draft;
}
async function readDraft(db: PlanDb, id: unknown, actor: Actor, admin: boolean, locked = false) {
    if (typeof id !== 'string' || id.length > 100)
        fail("초안을 선택해 주세요.", 400);
    const rows = await db.$queryRawUnsafe<DraftRow[]>(`SELECT d.*,d."updatedAt"::text AS "updatedAt" FROM "RegularRoutePlanDraft" d JOIN "EnrollmentShuttleReview" rev ON rev.id=d."reviewId" AND rev.status<>'SUPERSEDED' AND rev."driverUserId"=d."driverUserId" WHERE d.id=$1${locked ? ' FOR UPDATE OF d' : ''}`, id);
    const row = rows[0];
    if (!row || (!admin && row.driverUserId !== actor.appUserId))
        fail("담당 초안을 찾을 수 없습니다.", 404);
    return row;
}
export async function getRoutePlans(actor: Actor, month: unknown, adminOnly = false, id?: string | null, store: PlanStore = prisma as unknown as PlanStore) {
    const m = reviewMonth(month);
    return store.$transaction(async (db) => {
        const r = await role(db, actor, adminOnly);
        if (id) {
            const row = await readDraft(db, id, actor, r.admin);
            if (row.status === 'CONFIRMED')
                return { draft: await view(db, row) };
            try {
                await intake(db, actor, row.serviceMonth, r.admin, row.reviewId);
                return { draft: await view(db, row) };
            }
            catch (error) {
                if (r.admin && error instanceof ShuttleReviewError && error.status === 409) {
                    const draft = await view(db, row);
                    return { draft: { ...draft, status: 'STALE' as const, canConfirm: false, issues: [...draft.issues, { code: 'SOURCE_CHANGED', message: '최신 명단으로 초안을 다시 만들어 주세요.' }] } };
                }
                throw error;
            }
        }
        const rows = await db.$queryRawUnsafe<DraftRow[]>(`SELECT d.*,d."updatedAt"::text AS "updatedAt" FROM "RegularRoutePlanDraft" d JOIN "EnrollmentShuttleReview" rev ON rev.id=d."reviewId" AND rev.status<>'SUPERSEDED' AND rev."driverUserId"=d."driverUserId" WHERE d."serviceMonth"=$1 AND ($2::boolean OR d."driverUserId"=$3) ORDER BY d."updatedAt" DESC LIMIT 50`, m, r.admin, actor.appUserId);
        const dash = await getShuttleIntakeDashboard(actor, m, r.admin, { $queryRawUnsafe: db.$queryRawUnsafe.bind(db), $executeRawUnsafe: db.$executeRawUnsafe.bind(db), $transaction: async <T>(fn: (tx: PlanDb) => Promise<T>) => fn(db) } as PlanStore);
        return { items: (await Promise.all(rows.map(async (row) => {
                try {
                    if (row.status === 'CONFIRMED')
                        return await view(db, row);
                    await intake(db, actor, row.serviceMonth, r.admin, row.reviewId);
                    return await view(db, row);
                }
                catch (error) {
                    if (r.admin && error instanceof ShuttleReviewError && error.status === 409) {
                        const draft = await view(db, row);
                        return { ...draft, status: 'STALE' as const, canConfirm: false, issues: [...draft.issues, { code: 'SOURCE_CHANGED', message: '최신 명단으로 초안을 다시 만들어 주세요.' }] };
                    }
                    if (error instanceof ShuttleReviewError && [404, 409].includes(error.status))
                        return null;
                    throw error;
                }
            }))).filter((value): value is RoutePlanDraft => value !== null), reviews: dash.items, vehicles: r.admin ? await fleet(db) : [] };
    }, { isolationLevel: 'RepeatableRead', timeout: 20000 });
}
async function createRuns(db: PlanDb, item: ShuttleIntakeItem, base: RouteSnapshot, vehicleId: string | null, admin: boolean) {
    const vehicles = await fleet(db), chosen = vehicles.find(v => v.id === vehicleId), points = await endpoints(db), runs: PlanRun[] = [];
    for (const c of item.classes) {
        for (const direction of ['PICKUP', 'DROPOFF'] as const) {
            const startMin = minute(c.startTime), endMin = minute(c.endTime);
            if (startMin == null || endMin == null)
                fail('수업 시각을 확인해 주세요.');
            const route = base.routes.find(r => r.dayOfWeek === c.dayOfWeek && r.direction === direction);
            const candidates = arr(route?.payload?.vehicles).filter(v => minute(v.classStart ?? route?.classStart) === startMin);
            if (candidates.some(v => v.driverUserId && v.driverUserId !== item.review!.driverUserId))
                fail('다른 기사에게 배정된 운행입니다. 원장님이 담당 운행을 먼저 확인해 주세요.', 409, 'OTHER_DRIVER_ROUTE');
            const selected = candidates.filter(v => v.driverUserId === item.review!.driverUserId || !v.driverUserId);
            if (selected.length > 1)
                fail('같은 수업에 여러 차량이 있습니다. 원장님이 운행을 구분해 주세요.');
            const old = selected[0];
            const oldVehicle = vehicles.find(v => v.id === old?.vehicleId || v.name === old?.vehicleName);
            if (old && !old.driverUserId && !admin)
                fail('저장 운행의 담당 기사를 먼저 확인해 주세요.');
            const vehicle = chosen ?? oldVehicle;
            const roster = base.rows.filter(r => r.weekday === DOW.indexOf(c.dayOfWeek) && r.direction === (direction === 'PICKUP' ? 'BOARD' : 'ALIGHT') && minute(r.classTime) === startMin);
            const stops: PlanStop[] = old ? arr(old.stops).map((s, i) => ({ id: `saved:${route!.id}:${i}`, label: String(s.label ?? ''), lat: typeof s.lat === 'number' ? s.lat : NaN, lng: typeof s.lng === 'number' ? s.lng : NaN, etaMin: minute(s.etaManual ?? s.etaMinutes ?? s.etaLabel), manualMin: minute(s.etaManual), dwellMin: 1, students: arr(s.students).map(p => ({ studentId: String(p.requestId ?? ''), name: String(p.name ?? ''), grade: typeof p.grade === 'string' ? p.grade : null, rosterRowId: roster.find(r => r.studentId === p.requestId)?.id ?? null })).filter(p => p.studentId) })) : roster.map(r => ({ id: `roster:${r.id}`, label: r.stopName, lat: typeof r.latitude === 'number' ? r.latitude : NaN, lng: typeof r.longitude === 'number' ? r.longitude : NaN, etaMin: minute(r.arriveTime), dwellMin: 1, students: [{ studentId: r.studentId ?? '', name: r.studentName ?? '', rosterRowId: r.id }] }));
            if (stops.some(s => s.students.some(p => !p.studentId)))
                fail('명단의 학생 연결을 확인해 주세요.');
            runs.push({ id: `${c.id}:${direction}`, dayOfWeek: c.dayOfWeek, direction, vehicleId: vehicle?.id ?? '', vehicleName: vehicle?.name ?? '차량 선택 필요', driverUserId: item.review!.driverUserId, capacity: vehicle?.capacity ?? 0, start: direction === 'PICKUP' ? points.depot : points.academy, end: direction === 'PICKUP' ? points.academy : points.depot, anchorMin: direction === 'PICKUP' ? startMin - 5 : endMin + 5, classStartMin: startMin, classEndMin: endMin, cleanupMin: 5, stops, legs: [] });
        }
    }
    return runs;
}
async function insertStudent(runs: PlanRun[], item: ShuttleIntakeItem, estimator: LegEstimator) {
    return Promise.all(runs.map(async (run) => {
        if (run.stops.some(s => s.students.some(p => p.studentId === item.studentId)))
            return run;
        const loc = item.locations.find(l => l.kind === run.direction);
        if (!loc)
            fail('승하차 위치 확인이 필요합니다.');
        const incoming: PlanStop = { id: `new:${item.studentId}:${run.id}`, label: loc.name || loc.address, lat: loc.latitude, lng: loc.longitude, etaMin: null, dwellMin: 1, recommended: true, students: [{ studentId: item.studentId, name: item.studentName, grade: item.grade, isNew: true }] };
        const matrix = new Map<string, PlanLeg>();
        for (let index = 0; index <= run.stops.length; index++) {
            const candidate = { ...run, stops: [...run.stops.slice(0, index), incoming, ...run.stops.slice(index)] };
            for (const leg of await estimator(candidate))
                matrix.set(`${leg.fromId}:${leg.toId}`, leg);
        }
        for (const leg of await estimator(run))
            matrix.set(`${leg.fromId}:${leg.toId}`, leg);
        return recommendInsertion({ ...run, legs: [...matrix.values()] }, incoming).run;
    }));
}
async function assertFresh(db: PlanDb, row: DraftRow, actor: Actor, admin: boolean) {
    const item = await intake(db, actor, row.serviceMonth, admin, row.reviewId);
    if (item.fingerprint !== row.data.reviewFingerprint)
        fail('신청·수강·위치·명단이 변경됐습니다. 새 검토 요청으로 다시 만들어 주세요.');
    const current = await snapshot(db, row.serviceMonth, true);
    if (shuttleFingerprint(current) !== row.data.fingerprint)
        fail('다른 배차가 변경됐습니다. 최신 운행을 다시 확인해 주세요.');
    return current;
}
async function persist(db: PlanDb, row: DraftRow) { await db.$executeRawUnsafe(`UPDATE "RegularRoutePlanDraft" SET data=$2::jsonb,status=$3,revision=revision+1,"updatedAt"=clock_timestamp() WHERE id=$1 AND revision=$4`, row.id, JSON.stringify(row.data), row.status, row.revision); row.revision++; row.updatedAt = new Date().toISOString(); return { ok: true, draft: await view(db, row) }; }
async function applyRoutePlan(actor: Actor, input: Record<string, unknown>, adminOnly = false, store: PlanStore = prisma as unknown as PlanStore, estimator: LegEstimator = roadLegEstimator): Promise<{
    ok: boolean;
    draft: RoutePlanDraft;
    versionId?: string;
    reused?: boolean;
}> {
    return store.$transaction(async (db) => {
        const permissions = await role(db, actor, adminOnly), admin = permissions.admin, action = input.action;
        if (action === 'CREATE') {
            if (typeof input.reviewId !== 'string')
                fail('검토 요청을 선택해 주세요.', 400);
            const reviews = await db.$queryRawUnsafe<{
                serviceMonth: string;
            }[]>(`SELECT "serviceMonth" FROM "EnrollmentShuttleReview" WHERE id=$1 AND status<>'SUPERSEDED'`, input.reviewId);
            if (!reviews[0])
                fail('검토 요청을 찾을 수 없습니다.', 404);
            const month = reviewMonth(reviews[0].serviceMonth);
            await lock(db, `route-plan:${month}`);
            await db.$queryRawUnsafe(`SELECT id FROM "EnrollmentShuttleReview" WHERE id=$1 FOR SHARE`, input.reviewId);
            const item = await intake(db, actor, month, admin, input.reviewId);
            const day = typeof input.effectiveFrom === 'string' ? input.effectiveFrom : '';
            if (!isKstYmd(day) || day.slice(0, 7) !== month || day < today() || (item.requestedStartOn && day < item.requestedStartOn.slice(0, 10)))
                fail('오늘 이후의 해당 월 적용일을 선택해 주세요.', 400);
            const startRows = await db.$queryRawUnsafe<{
                startsOn: string | null;
            }[]>(`SELECT max("startsOn")::text AS "startsOn" FROM "Enrollment" WHERE "studentId"=$1 AND "classId"=ANY($2::text[]) AND status='ACTIVE'`, item.studentId, item.classes.map(c => c.id));
            if (startRows[0]?.startsOn && day < startRows[0].startsOn.slice(0, 10))
                fail('수강 개시일 이후를 선택해 주세요.', 400);
            const prior = await db.$queryRawUnsafe<DraftRow[]>(`SELECT *,"updatedAt"::text AS "updatedAt" FROM "RegularRoutePlanDraft" WHERE "reviewId"=$1`, input.reviewId);
            if (prior[0])
                return { ok: true, draft: await view(db, prior[0]) };
            const base = await snapshot(db, month, true);
            if (input.expectedSource && input.expectedSource !== shuttleFingerprint(base))
                fail("견적 중 명단이 바뀌었습니다. 다시 확인해 주세요.");
            const baseRuns = await createRuns(db, item, base, admin && typeof input.vehicleId === 'string' ? input.vehicleId : null, admin);
            await lockBoarded(db, baseRuns, day);
            const calc = await recalc(await insertStudent(baseRuns, item, estimator), estimator);
            const data: Data = { base, baseRuns, runs: calc.runs, fingerprint: shuttleFingerprint(base), reviewFingerprint: item.fingerprint, applicationId: item.applicationId, studentId: item.studentId, baseline: [] };
            const id = randomUUID();
            await db.$executeRawUnsafe(`INSERT INTO "RegularRoutePlanDraft"(id,"reviewId","driverUserId","serviceMonth","effectiveFrom",data) VALUES($1,$2,$3,$4,$5,$6::jsonb)`, id, input.reviewId, item.review!.driverUserId, month, day, JSON.stringify(data));
            return { ok: true, draft: await view(db, { id, reviewId: input.reviewId, driverUserId: item.review!.driverUserId, serviceMonth: month, effectiveFrom: day, status: 'DRAFT', revision: 1, data, updatedAt: new Date().toISOString() }) };
        }
        const row = await readDraft(db, input.id, actor, admin, true);
        await lock(db, `route-plan:${row.serviceMonth}`);
        if (row.status === 'CONFIRMED') {
            if (action === 'CONFIRM' && admin)
                return { ok: true, draft: await view(db, row), reused: true };
            fail('이미 확정한 초안입니다.');
        }
        if (input.revision !== row.revision)
            fail('다른 변경이 먼저 저장됐습니다. 새로 확인해 주세요.');
        if (action === 'REBUILD') {
            if (!admin || input.discardChanges !== true)
                fail('원장님이 기존 조정 초기화를 확인해 주세요.', 403);
            const item = await intake(db, actor, row.serviceMonth, true, row.reviewId, true);
            await db.$executeRawUnsafe(`UPDATE "EnrollmentShuttleReview" SET status='NEEDS_CONFIRMATION' WHERE id=$1`, row.reviewId);
            const adapter = { $queryRawUnsafe: db.$queryRawUnsafe.bind(db), $executeRawUnsafe: db.$executeRawUnsafe.bind(db), $transaction: async <T>(fn: (tx: PlanDb) => Promise<T>) => fn(db) } as PlanStore;
            const assigned = await assignShuttleReview(actor, { applicationId: item.applicationId, serviceMonth: row.serviceMonth, driverUserId: row.driverUserId, expectedFingerprint: item.fingerprint }, adapter);
            return applyRoutePlan(actor, { action: 'CREATE', reviewId: assigned.id, effectiveFrom: input.effectiveFrom, vehicleId: input.vehicleId }, true, adapter, approximateEstimator);
        }
        await db.$queryRawUnsafe(`SELECT id FROM "EnrollmentShuttleReview" WHERE id=$1 FOR SHARE`, row.reviewId);
        await assertFresh(db, row, actor, admin);
        await assertBoardedUnchanged(db, row);
        if (action === 'UPDATE') {
            if (row.status !== 'DRAFT')
                fail('제출한 초안은 원장님 확인을 기다려 주세요.');
            if (!Array.isArray(input.orders) || input.orders.length > 100)
                fail('운행 순서를 확인해 주세요.', 400);
            const orders = input.orders.map(obj);
            if (orders.length !== row.data.runs.length || new Set(orders.map(o => o.runId)).size !== orders.length)
                fail('모든 운행을 한 번씩 전달해 주세요.', 400);
            row.data.runs = row.data.runs.map(run => {
                const order = orders.find(o => o.runId === run.id);
                if (!order || !Array.isArray(order.stopIds) || order.stopIds.length !== run.stops.length || new Set(order.stopIds).size !== run.stops.length || order.stopIds.some(id => !run.stops.some(s => s.id === id)))
                    fail('정류장 누락·중복을 확인해 주세요.', 400);
                const manual = obj(order.manualTimes);
                return { ...run, stops: order.stopIds.map(id => {
                        const s = run.stops.find(s => s.id === id)!;
                        const v = Object.hasOwn(manual, s.id) ? manual[s.id] : s.manualMin;
                        if (v != null && (typeof v !== 'number' || minute(v) == null))
                            fail('시각을 확인해 주세요.', 400);
                        if (s.locked && ((order.stopIds as unknown[]).indexOf(id) !== run.stops.indexOf(s) || v !== s.manualMin))
                            fail("이미 운행한 정류장의 순서·시각은 바꿀 수 없습니다.");
                        return { ...s, manualMin: v as number | null | undefined };
                    }) };
            });
            row.data.runs = (await recalc(row.data.runs, estimator)).runs;
            return persist(db, row);
        }
        if (action === 'SET_VEHICLE') {
            if (!admin)
                fail('원장님만 차량을 지정할 수 있습니다.', 403);
            const vehicle = (await fleet(db)).find(v => v.id === input.vehicleId);
            if (!vehicle)
                fail('운영 중인 차량을 선택해 주세요.', 400);
            row.data.runs = row.data.runs.map(r => ({ ...r, vehicleId: vehicle.id, vehicleName: vehicle.name, capacity: vehicle.capacity }));
            row.data.runs = (await recalc(row.data.runs, estimator)).runs;
            return persist(db, row);
        }
        if (action === 'BASELINE') {
            if (!admin)
                fail('원장님만 안내 기준을 확인할 수 있습니다.', 403);
            const preview = await view(db, row);
            const ids = input.acknowledgeStudentIds;
            if (!Array.isArray(ids) || !ids.length || ids.some(id => typeof id !== 'string' || !preview.impacts.some(i => i.studentId === id && i.baselineRequired)))
                fail('안내 기준 확인 대상이 바뀌었습니다.', 400);
            for (const studentId of ids as string[]) {
                const contact = (await recipients(db, [studentId]))[0];
                if (!contact?.phone)
                    fail('현재 보호자 연락처를 먼저 확인해 주세요.');
                row.data.baseline.push({ studentId, recipientKey: routeRecipientKey(contact.parentId, contact.phone), delivered: false, source: 'ADMIN_CONFIRMED', confirmed: true, entries: entries(row.data.baseRuns, studentId) });
            }
            return persist(db, row);
        }
        if (action === 'RETURN_TO_DRIVER') {
            if (!admin)
                fail('원장님만 재조정을 요청할 수 있습니다.', 403);
            if (row.status !== 'SUBMITTED')
                fail('제출된 초안을 선택해 주세요.');
            row.status = 'DRAFT';
            return persist(db, row);
        }
        if (action === 'SUBMIT') {
            if (!permissions.driver || row.driverUserId !== actor.appUserId)
                fail('지정 기사님만 검토를 제출할 수 있습니다.', 403);
            if (row.status !== 'DRAFT')
                return { ok: true, draft: await view(db, row) };
            row.status = 'SUBMITTED';
            return persist(db, row);
        }
        if (action === 'CONFIRM') {
            if (row.effectiveFrom < today())
                fail('적용일이 지났습니다. 오늘 이후의 새 초안으로 검토해 주세요.');
            if (!admin)
                fail('원장님만 배차를 최종 확정할 수 있습니다.', 403);
            const preview = await view(db, row);
            if (!preview.canConfirm || input.previewHash !== preview.previewHash)
                fail('미확인 항목과 학부모 안내 대상을 다시 확인해 주세요.');
            return confirm(db, row, preview, actor);
        }
        return fail('작업 종류를 확인해 주세요.', 400);
    }, { isolationLevel: 'Serializable', timeout: 30000 });
}
async function confirm(db: PlanDb, row: DraftRow, preview: RoutePlanDraft, actor: Actor) {
    await db.$queryRawUnsafe(`SELECT set_config('stiz.route_plan_writing','1',true)::text AS enabled`);
    const versionId = randomUUID(), after: RouteSnapshot = JSON.parse(JSON.stringify(row.data.base));
    const touched = new Set<string>();
    for (const run of preview.runs) {
        if (!run.vehicleId)
            fail('원장님이 차량을 선택해 주세요.');
        let position = Math.min(...after.rows.filter(r => r.weekday === DOW.indexOf(run.dayOfWeek) && r.direction === (run.direction === 'PICKUP' ? 'BOARD' : 'ALIGHT') && minute(r.classTime) === run.classStartMin).map(r => r.sortOrder ?? 0), 10000);
        for (const stop of run.stops) {
            for (const rider of stop.students) {
                let roster = after.rows.find(r => r.id === rider.rosterRowId) || after.rows.find(r => r.studentId === rider.studentId && r.weekday === DOW.indexOf(run.dayOfWeek) && r.direction === (run.direction === 'PICKUP' ? 'BOARD' : 'ALIGHT') && minute(r.classTime) === run.classStartMin);
                if (!roster) {
                    roster = { id: randomUUID(), serviceMonth: row.serviceMonth, weekday: DOW.indexOf(run.dayOfWeek), direction: run.direction === 'PICKUP' ? 'BOARD' : 'ALIGHT', studentId: rider.studentId, studentName: rider.name, stopName: stop.label };
                    after.rows.push(roster);
                }
                Object.assign(roster, { arriveTime: hhmm(stop.etaMin), classTime: `${hhmm(run.classStartMin)}~${hhmm(run.classEndMin)}`, stopName: stop.label, latitude: stop.lat, longitude: stop.lng, sortOrder: position++ });
                rider.rosterRowId = roster.id;
                touched.add(roster.id);
            }
        }
        let route = after.routes.find(r => r.dayOfWeek === run.dayOfWeek && r.direction === run.direction);
        if (!route) {
            route = { id: randomUUID(), serviceMonth: row.serviceMonth, dayOfWeek: run.dayOfWeek, direction: run.direction, classStart: hhmm(run.classStartMin), classEnd: hhmm(run.classEndMin), payload: { vehicles: [] } };
            after.routes.push(route);
        }
        const vehicles = arr(route.payload.vehicles), candidate = vehicles.findIndex(v => minute(v.classStart ?? route!.classStart) === run.classStartMin && (v.driverUserId === row.driverUserId || !v.driverUserId));
        const vehicle = { ...(candidate >= 0 ? vehicles[candidate] : {}), index: candidate >= 0 ? candidate + 1 : vehicles.length + 1, vehicleId: run.vehicleId, vehicleName: run.vehicleName, driverUserId: run.driverUserId, capacity: run.capacity, classStart: hhmm(run.classStartMin), classEnd: hhmm(run.classEndMin), timeGroupLabel: hhmm(run.classStartMin), provider: 'TMAP', passengers: run.stops.reduce((n, s) => n + s.students.length, 0), over: false, departTime: run.departMin, arriveTime: run.arriveMin, stops: run.stops.map(s => ({ label: s.label, lat: s.lat, lng: s.lng, etaMinutes: s.etaMin, etaManual: s.manualMin ?? null, etaLabel: hhmm(s.etaMin), approx: false, students: s.students.map(p => ({ requestId: p.studentId, name: p.name, grade: p.grade ?? null })) })) };
        if (candidate >= 0)
            vehicles[candidate] = vehicle;
        else
            vehicles.push(vehicle);
        route.payload = { ...route.payload, vehicles };
    }
    // 同じ 월의 확정 순서를 역전시키면 최신 저장본과 날짜별 조회가 달라지므로 차단한다.
    const versions = await db.$queryRawUnsafe<{
        effectiveFrom: string;
    }[]>(`SELECT "effectiveFrom" FROM "RegularRoutePlanVersion" WHERE "serviceMonth"=$1 ORDER BY "effectiveFrom" DESC LIMIT 1 FOR UPDATE`, row.serviceMonth);
    if (versions[0] && versions[0].effectiveFrom > row.effectiveFrom)
        fail('더 나중 날짜의 확정이 있습니다. 적용일을 다시 확인해 주세요.');
    for (const id of touched) {
        const r = after.rows.find(r => r.id === id)!;
        await db.$executeRawUnsafe(`INSERT INTO "RegularShuttleStop"(id,"serviceMonth",weekday,direction,"studentId","studentName","classTime","arriveTime","stopName",latitude,longitude,"sortOrder") VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT(id) DO UPDATE SET "classTime"=EXCLUDED."classTime","arriveTime"=EXCLUDED."arriveTime","stopName"=EXCLUDED."stopName",latitude=EXCLUDED.latitude,longitude=EXCLUDED.longitude,"sortOrder"=EXCLUDED."sortOrder"`, r.id, r.serviceMonth, r.weekday, r.direction, r.studentId, r.studentName ?? null, r.classTime ?? null, r.arriveTime ?? null, r.stopName, r.latitude ?? null, r.longitude ?? null, r.sortOrder ?? 0);
    }
    for (const route of after.routes) {
        if (!preview.runs.some(r => r.dayOfWeek === route.dayOfWeek && r.direction === route.direction))
            continue;
        const rows = after.rows.filter(r => DOW[r.weekday] === route.dayOfWeek && r.direction === (route.direction === 'PICKUP' ? 'BOARD' : 'ALIGHT'));
        route.payload = { ...route.payload, confirmation: { ...routeConfirmation(route, rows), confirmedAt: new Date().toISOString() } } as Saved['payload'];
        await db.$executeRawUnsafe(`INSERT INTO "RegularDispatchRoute"(id,"serviceMonth","dayOfWeek",direction,payload,"classStart","classEnd","savedByUserId","createdAt","updatedAt") VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8,now(),clock_timestamp()) ON CONFLICT("serviceMonth","dayOfWeek",direction) DO UPDATE SET payload=EXCLUDED.payload,"classStart"=EXCLUDED."classStart","classEnd"=EXCLUDED."classEnd","savedByUserId"=EXCLUDED."savedByUserId","updatedAt"=EXCLUDED."updatedAt"`, route.id, row.serviceMonth, route.dayOfWeek, route.direction, JSON.stringify(route.payload), route.classStart, route.classEnd, actor.appUserId);
    }
    await db.$executeRawUnsafe(`INSERT INTO "RegularRoutePlanVersion"(id,"draftId","serviceMonth","effectiveFrom","beforeSnapshot","afterSnapshot","confirmedByUserId") VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7)`, versionId, row.id, row.serviceMonth, row.effectiveFrom, JSON.stringify(row.data.base), JSON.stringify(after), actor.appUserId);
    const priorSnapshots = await delivered(db, row.serviceMonth);
    const phones = await recipients(db, preview.notices.map(n => n.studentId));
    for (const notice of preview.notices) {
        const phone = phones.find(p => p.studentId === notice.studentId)?.phone?.replace(/\D/g, '');
        if (!phone)
            fail('보호자 연락처가 변경됐습니다.');
        await db.$executeRawUnsafe(`INSERT INTO "RegularRouteNoticeOutbox"(id,"versionId","studentId","recipientPhone",message,entries,"recipientKey") VALUES($1,$2,$3,$4,$5,$6::jsonb,$7)`, randomUUID(), versionId, notice.studentId, phone, notice.message, JSON.stringify(mergeNoticeEntries(priorSnapshots.find(s => s.studentId === notice.studentId)?.entries ?? [], preview.runs, notice.studentId)), routeRecipientKey(phones.find(p => p.studentId === notice.studentId)!.parentId, phone));
    }
    for (const baseline of row.data.baseline)
        await db.$executeRawUnsafe(`INSERT INTO "RegularRouteNoticeSnapshot"(id,"studentId","serviceMonth",source,entries,"confirmedByUserId","recipientKey") VALUES($1,$2,$3,'ADMIN_CONFIRMED',$4::jsonb,$5,$6)`, randomUUID(), baseline.studentId, row.serviceMonth, JSON.stringify(baseline.entries), actor.appUserId, baseline.recipientKey);
    await db.$executeRawUnsafe(`UPDATE "EnrollmentShuttleReview" SET status='PROPOSED',proposals=$2::jsonb,"reviewedAt"=clock_timestamp() WHERE id=$1`, row.reviewId, JSON.stringify(preview.runs.map(r => ({ dayOfWeek: r.dayOfWeek, direction: r.direction, time: hhmm(r.stops.find(s => s.students.some(p => p.studentId === row.data.studentId))?.etaMin) }))));
    row.status = 'CONFIRMED';
    row.data.runs = preview.runs;
    return { ...await persist(db, row), versionId };
}
/** 날짜별 조회는 확정 전 자료도 보존한다. 첫 적용일 이전은 첫 버전의 before를 쓴다. */
export async function getDatedRouteSnapshot(serviceMonth: string, viewDate: string, db: PlanDb = prisma): Promise<RouteSnapshot | null> {
    const tables = await db.$queryRawUnsafe<{
        present: string | null;
    }[]>(`SELECT to_regclass('public."RegularRoutePlanVersion"')::text AS present`);
    if (!tables[0]?.present)
        return null;
    const versions = await db.$queryRawUnsafe<{
        effectiveFrom: string;
        beforeSnapshot: RouteSnapshot;
        afterSnapshot: RouteSnapshot;
        confirmedAt: string;
    }[]>(`SELECT "effectiveFrom","beforeSnapshot","afterSnapshot","confirmedAt"::text AS "confirmedAt" FROM "RegularRoutePlanVersion" WHERE "serviceMonth"=$1 ORDER BY "effectiveFrom" DESC,"confirmedAt" DESC,id DESC`, serviceMonth);
    if (!versions.length)
        return null;
    const effective = versions.find(v => v.effectiveFrom <= viewDate);
    const changes = await db.$queryRawUnsafe<{
        snapshot: RouteSnapshot;
        observedAt: string;
        effectiveFrom: string;
    }[]>(`SELECT snapshot,"effectiveFrom","observedAt"::text AS "observedAt" FROM "RegularRouteLegacyChange" WHERE "serviceMonth"=$1 AND "effectiveFrom"<=$2 ORDER BY "effectiveFrom" DESC,"observedAt" DESC,id DESC LIMIT 1`, serviceMonth, viewDate);
    if (changes[0] && (!effective || changes[0].effectiveFrom > effective.effectiveFrom || (changes[0].effectiveFrom === effective.effectiveFrom && new Date(changes[0].observedAt).getTime() > new Date(effective.confirmedAt).getTime())))
        return changes[0].snapshot;
    return effective?.afterSnapshot ?? versions[versions.length - 1].beforeSnapshot;
}
async function lockBoarded(db: PlanDb, runs: PlanRun[], effectiveFrom: string) {
    if (effectiveFrom !== today())
        return;
    const boarded = await db.$queryRawUnsafe<{
        shuttleRequestId: string;
    }[]>(`SELECT "shuttleRequestId" FROM "ShuttleBoarding" WHERE "serviceDate"=$1 AND direction='REGULAR'`, effectiveFrom);
    const ids = new Set(boarded.map(b => b.shuttleRequestId));
    const nowMinute = minute(kstHm(new Date()));
    for (const run of runs)
        if (run.dayOfWeek === DOW[kstDow(today())])
            for (const stop of run.stops)
                if (nowMinute != null && stop.etaMin != null && stop.etaMin <= nowMinute)
                    for (const rider of stop.students)
                        if (rider.rosterRowId)
                            ids.add(rider.rosterRowId);
    for (const run of runs)
        for (const stop of run.stops)
            if (stop.students.some(p => p.rosterRowId && ids.has(p.rosterRowId))) {
                stop.locked = true;
                stop.manualMin = stop.etaMin;
            }
}
function mergeNoticeEntries(prior: PlanTimeEntry[], runs: PlanRun[], studentId: string) { const keys = new Set(runs.map(r => `${r.dayOfWeek}:${r.direction}`)); return [...prior.filter(e => !keys.has(`${e.dayOfWeek}:${e.direction}`)), ...entries(runs, studentId)]; }
function adjacentIssues(row: DraftRow, runs: PlanRun[]) {
    const issues: {
        code: string;
        message: string;
        runId: string;
    }[] = [];
    for (const run of runs) {
        if (!run.vehicleId || run.departMin == null || run.arriveMin == null)
            continue;
        for (const route of row.data.base.routes.filter(r => r.dayOfWeek === run.dayOfWeek)) {
            for (const v of arr(route.payload.vehicles)) {
                const cs = minute(v.classStart ?? route.classStart);
                if (runs.some(r => r.dayOfWeek === route.dayOfWeek && r.direction === route.direction && r.classStartMin === cs))
                    continue;
                if (v.driverUserId !== run.driverUserId && v.vehicleId !== run.vehicleId && v.vehicleName !== run.vehicleName)
                    continue;
                const depart = minute(v.departTime), arrive = minute(v.arriveTime);
                if (depart == null || arrive == null) {
                    issues.push({ code: 'ADJACENT_RUN_REQUIRED', message: '같은 차량·기사님의 다른 운행 출발·종료 시각을 확인해 주세요.', runId: run.id });
                    continue;
                }
                if (run.departMin < arrive && run.arriveMin > depart)
                    issues.push({ code: 'RUN_OVERLAP', message: '같은 차량·기사님의 다른 교시 운행과 겹칩니다.', runId: run.id });
                else {
                    const academy = run.direction === 'PICKUP' ? run.end : run.start, depot = run.direction === 'PICKUP' ? run.start : run.end;
                    const preceding = arrive <= run.departMin;
                    const from = preceding ? (route.direction === 'PICKUP' ? academy : depot) : run.end;
                    const to = preceding ? run.start : (route.direction === 'PICKUP' ? depot : academy);
                    const same = from.lat === to.lat && from.lng === to.lng;
                    const leg = run.legs.find(l => l.fromId === from.id && l.toId === to.id);
                    if (!same && (!leg?.verified || leg.provider === 'ESTIMATE'))
                        issues.push({ code: 'ADJACENT_TRANSFER_REQUIRED', message: '다른 교시 운행까지 실제 이동 시간을 확인해 주세요.', runId: run.id });
                    else if ((preceding ? arrive : run.arriveMin) + (same ? 0 : leg!.minutes) > (preceding ? run.departMin : depart))
                        issues.push({ code: 'RUN_OVERLAP', message: '다른 교시 출발지까지 이동할 시간이 부족합니다.', runId: run.id });
                }
            }
        }
        // 저장되지 않은 회차와 시간이 겹쳐도 기존 명단을 무시하고 확정하지 않는다.
        for (const other of row.data.base.rows.filter(r => r.weekday === DOW.indexOf(run.dayOfWeek) && ['BOARD', 'ALIGHT'].includes(r.direction))) {
            const otherClass = minute(other.classTime);
            if (otherClass == null || runs.some(r => r.dayOfWeek === run.dayOfWeek && r.classStartMin === otherClass))
                continue;
            const t = minute(other.arriveTime);
            if (t != null && t >= run.departMin && t <= run.arriveMin)
                issues.push({ code: 'ADJACENT_ROSTER_REQUIRED', message: '같은 시간대의 다른 수업 명단이 있습니다. 차량·담당 운행을 먼저 확정해 주세요.', runId: run.id });
        }
    }
    return issues;
}
async function assertBoardedUnchanged(db: PlanDb, row: DraftRow) {
    if (row.effectiveFrom !== today())
        return;
    const boarded = await db.$queryRawUnsafe<{
        shuttleRequestId: string;
    }[]>(`SELECT "shuttleRequestId" FROM "ShuttleBoarding" WHERE "serviceDate"=$1 AND direction='REGULAR'`, row.effectiveFrom);
    const passed: Array<{
        shuttleRequestId: string;
    }> = [];
    const nowMinute = minute(kstHm(new Date()));
    for (const run of row.data.baseRuns)
        if (run.dayOfWeek === DOW[kstDow(today())])
            for (const stop of run.stops)
                if (nowMinute != null && stop.etaMin != null && stop.etaMin <= nowMinute)
                    for (const rider of stop.students)
                        if (rider.rosterRowId)
                            passed.push({ shuttleRequestId: rider.rosterRowId });
    for (const b of [...boarded, ...passed]) {
        for (const original of row.data.baseRuns) {
            const index = original.stops.findIndex(s => s.students.some(p => p.rosterRowId === b.shuttleRequestId));
            if (index < 0)
                continue;
            const before = original.stops[index], run = row.data.runs.find(r => r.id === original.id), after = run?.stops[index];
            if (!after || after.id !== before.id || after.etaMin !== before.etaMin || planLocationKey(after) !== planLocationKey(before))
                fail('이미 운행한 정류장이 초안과 달라졌습니다. 최신 명단으로 다시 만들어 주세요.');
            after.locked = true;
            after.manualMin = before.etaMin;
        }
    }
}
const approximateEstimator: LegEstimator = async (run) => [run.start, ...run.stops, run.end].slice(1).map((p, i) => ({ fromId: [run.start, ...run.stops][i].id, toId: p.id, minutes: 3, verified: false, provider: 'ESTIMATE' }));
/** 도로 견적은 DB 트랜잭션 밖에서만 실행하고 저장 직전에 자료 버전을 다시 확인한다. */
export async function mutateRoutePlan(actor: Actor, input: Record<string, unknown>, adminOnly = false, store: PlanStore = prisma as unknown as PlanStore, estimator: LegEstimator = roadLegEstimator): Promise<{
    ok: boolean;
    draft: RoutePlanDraft;
    versionId?: string;
    reused?: boolean;
}> {
    if (!['CREATE', 'UPDATE', 'SET_VEHICLE'].includes(String(input.action)))
        return applyRoutePlan(actor, input, adminOnly, store, estimator);
    const dryStore: PlanStore = { ...store, $transaction: async (work, options) => store.$transaction(db => work({ $queryRawUnsafe: db.$queryRawUnsafe.bind(db), $executeRawUnsafe: async () => 0 }), options) };
    const prepared = await applyRoutePlan(actor, input, adminOnly, dryStore, approximateEstimator);
    const edgeKey = (a: {
        id: string;
        lat: number;
        lng: number;
    }, b: {
        id: string;
        lat: number;
        lng: number;
    }) => `${a.id}@${a.lat},${a.lng}>${b.id}@${b.lat},${b.lng}`;
    const requests = new Map<string, {
        run: PlanRun;
        from: PlanRun['start'];
        to: PlanRun['start'];
    }>();
    for (const run of prepared.draft.runs) {
        const points = [run.start, ...run.stops, run.end];
        for (let i = 1; i < points.length; i++)
            requests.set(edgeKey(points[i - 1], points[i]), { run, from: points[i - 1], to: points[i] });
        requests.set(edgeKey(run.end, run.start), { run, from: run.end, to: run.start });
        const incoming = run.stops.find(s => s.students.some(p => p.studentId === prepared.draft.studentId && p.isNew));
        if (incoming) {
            const old = points.filter(p => p.id !== incoming.id);
            for (let i = 1; i < old.length; i++)
                requests.set(edgeKey(old[i - 1], old[i]), { run, from: old[i - 1], to: old[i] });
            for (const point of old) {
                requests.set(edgeKey(point, incoming), { run, from: point, to: incoming });
                requests.set(edgeKey(incoming, point), { run, from: incoming, to: point });
            }
        }
    }
    if (requests.size > 500)
        fail('운행을 나누어 검토해 주세요.', 400);
    const jobs = [...requests.entries()], results = new Map<string, PlanLeg>();
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(4, jobs.length) }, async () => {
        while (next < jobs.length) {
            const [key, { run, from, to }] = jobs[next++];
            const answer = await estimator({ ...run, start: from, end: to, stops: [] });
            const leg = answer.find(l => l.fromId === from.id && l.toId === to.id);
            if (leg)
                results.set(key, leg);
        }
    }));
    const cached: LegEstimator = async (run) => { const points = [run.start, ...run.stops, run.end]; return points.slice(1).map((p, i) => {const key=edgeKey(points[i],p);if(!requests.has(key))fail('견적 중 운행 위치가 바뀌었습니다. 최신 명단으로 다시 확인해 주세요.');return results.get(key)??{fromId:points[i].id,toId:p.id,minutes:3,verified:false,provider:'ESTIMATE'};}); };
    return applyRoutePlan(actor, { ...input, expectedSource: prepared.draft.baseFingerprint }, adminOnly, store, cached);
}
/** 기존 운행 편집이 미래 계획을 덮지 않도록 지정일의 기준을 기록한다. */
export async function saveDatedDriverOrderOverride(db: PlanDb, serviceMonth: string, date: string, updates: Array<{
    rowIds: string[];
    sortOrder: number;
    arriveTime: string | null;
}>, routes: Array<{
    id: string;
    direction: string;
    payload: Record<string, unknown>;
}>): Promise<boolean> {
    const dated = await getDatedRouteSnapshot(serviceMonth, date, db);
    if (!dated)
        return false;
    const future = await db.$queryRawUnsafe<{
        id: string;
    }[]>(`SELECT id FROM "RegularRoutePlanVersion" WHERE "serviceMonth"=$1 AND "effectiveFrom">$2 LIMIT 1`, serviceMonth, date);
    if (!future.length)
        return false;
    for (const update of updates)
        for (const id of update.rowIds) {
            const row = dated.rows.find(r => r.id === id);
            if (!row)
                fail('해당 날짜 명단이 바뀌었습니다.');
            row.sortOrder = update.sortOrder;
            row.arriveTime = update.arriveTime;
        }
    for (const route of routes) {
        const saved = dated.routes.find(r => r.id === route.id);
        if (!saved)
            fail('해당 날짜 노선이 바뀌었습니다.');
        saved.payload = route.payload;
    }
    await db.$executeRawUnsafe(`INSERT INTO "RegularRouteLegacyChange"(id,"serviceMonth","effectiveFrom",snapshot) VALUES($1,$2,$3,$4::jsonb)`, randomUUID(), serviceMonth, date, JSON.stringify(dated));
    const readback = await getDatedRouteSnapshot(serviceMonth, date, db);
    if (!readback || shuttleFingerprint(readback) !== shuttleFingerprint(dated))
        fail('저장 결과를 확인하지 못했습니다.');
    return true;
}
