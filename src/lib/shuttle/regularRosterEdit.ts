import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth-guard";
import { koreaServiceMonth } from "@/lib/regular/serviceMonth";
import { getSavedRegularDispatchRoute } from "@/lib/regular/regularDispatchRoute";
import { DOW_NAMES } from "@/lib/regular/shuttleRosterLogic";
import { pickRegularRouteSource } from "./regularDriverRouteLogic";
import { getSettings } from "@/lib/seasonal/shuttle-optimize";
import { isKoreanCoordinate } from "./academyLocation";
import { dowToWeekday, type EnrolledClass, type GeoPoint } from "./regularRosterPlacementLogic";
import {
  buildAddRows,
  mapPlacementsToMonth,
  planRosterInsert,
  buildCounterpartReorderUpdates,
  buildMoveUpdates,
  buildReorderUpdates,
  catchUpDateRange,
  findCounterpartRows,
  idPairArrays,
  planEnsureMonths,
  remapStopRowIds,
  RosterInputError,
  validateAddInput,
  validateCopyInput,
  validateMoveInput,
  validateRemoveInput,
  validateReorderInput,
  validateStopEditInput,
  normalizeRosterMonth,
  normalizeWeekday,
  type RosterExistingRow,
  type RosterInsertPlan,
  type RosterInsertStep,
  type RosterNewRow,
  type RosterPlacementRow,
  type RosterReorderUpdate,
  type RosterRowIdentity,
  type RosterScope,
} from "./regularRosterEditLogic";

// 셔틀 명단(RegularShuttleStop) 앱 편집 — 원장 전용. 시트 대신 사이트가 명단 원장이다.
// PgBouncer 트랜잭션 모드라 $queryRawUnsafe/$executeRawUnsafe 만 쓴다(ORM 기본 메서드 금지).
// 정규 배차·기사님 화면은 이 표를 그대로 읽으므로(reconcile) 여기서는 명단 행만 고친다.

type Tx = Prisma.TransactionClient;

export { RosterInputError };

/** 같은 달 명단을 동시에 고치면 정렬순서·중복 판정이 엇갈리므로 달 단위로 줄 세운다. */
async function lockMonth(tx: Tx, month: string) {
  await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, `regular-roster:${month}`);
}

/**
 * 여러 달을 함께 고치는 작업(이후 달까지 적용·월 자동 생성·월 복사)끼리 줄 세우는 전체 잠금.
 * 왜: 「10월을 고치는 중」에 「10월→11월 복사」가 끼어들면 11월이 고치기 전 내용으로 만들어질 수 있다.
 * ⚠️ 항상 이 잠금을 먼저 잡고, 달 잠금은 오름차순으로 잡는다(교착 방지).
 */
async function lockAllMonths(tx: Tx) {
  await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, "regular-roster:*");
}

/**
 * 편집 시작 잠금 + 함께 고칠 이후 달 목록.
 * THIS_MONTH 면 이 달만 잠그고 빈 목록, FROM_THIS_MONTH 면 이 달 이후 이미 만들어진 달을 오름차순으로 잠가 돌려준다.
 */
async function lockForEdit(tx: Tx, month: string, scope: RosterScope | undefined): Promise<string[]> {
  if (scope === "THIS_MONTH") {
    await lockMonth(tx, month);
    return [];
  }
  await lockAllMonths(tx);
  await lockMonth(tx, month);
  const rows = await tx.$queryRawUnsafe<{ m: string }[]>(
    `SELECT DISTINCT "serviceMonth" AS m FROM "RegularShuttleStop" WHERE "serviceMonth" > $1 ORDER BY 1`,
    month,
  );
  const later = rows.map((r) => String(r.m));
  for (const m of later) await lockMonth(tx, m);
  return later;
}

/**
 * 이후 달 반영 결과(화면 문구용): 실제로 바뀐 달 / 대응 행이 없어(또는 겹쳐) 건너뛴 달.
 * endPlacedMonths: 학생 추가에서 고른 자리의 기준 정차를 그 달에서 못 찾아 맨 뒤에 넣은 달.
 */
export type RosterScopeResult = { appliedMonths: string[]; skippedMonths: string[]; endPlacedMonths?: string[] };

async function monthRows(tx: Tx, month: string): Promise<RosterExistingRow[]> {
  const rows = await tx.$queryRawUnsafe<Record<string, unknown>[]>(
    `SELECT "id","weekday","direction","classTime","sortOrder","studentId","studentName","parentPhone"
       FROM "RegularShuttleStop" WHERE "serviceMonth"=$1`,
    month,
  );
  return rows.map((r) => ({
    id: String(r.id),
    weekday: Number(r.weekday),
    direction: String(r.direction),
    classTime: (r.classTime as string | null) ?? null,
    sortOrder: Number(r.sortOrder) || 0,
    studentId: (r.studentId as string | null) ?? null,
    studentName: (r.studentName as string | null) ?? null,
    parentPhone: (r.parentPhone as string | null) ?? null, // 반이동 같은 학생 확인용
  }));
}

/** 변경 기록. ShuttleAuditLog 의 노선·차량 연결 칸은 비워 두고 action 으로 구분한다. */
async function audit(tx: Tx, actorId: string | null, action: string, before: unknown, after: unknown) {
  // actorId 는 비울 수 있는 칸이다(자동 생성 = null).
  await tx.$executeRawUnsafe(
    `INSERT INTO "ShuttleAuditLog" ("actorId","action","beforeJSON","afterJSON") VALUES ($1,$2,$3::jsonb,$4::jsonb)`,
    actorId, action, before == null ? null : JSON.stringify(before), after == null ? null : JSON.stringify(after),
  );
}

const ROW_COLUMNS = `"id","serviceMonth","weekday","classTime","arriveTime","stopName","direction","studentName","studentId","studentPhone","parentPhone","note","sortOrder","latitude","longitude"`;

// ── 학생 검색(추가 폼) ───────────────────────────────────────

export type RosterStudentPlace = { name: string | null; address: string; latitude: number; longitude: number };
export type RosterStudentSearchResult = {
  id: string;
  name: string;
  grade: string | null;
  parentPhone: string | null;
  pickup: RosterStudentPlace | null;
  dropoff: RosterStudentPlace | null;
};

/** 이름으로 학생 검색(병합된 학생 제외, 최대 20명). 학생 상세에 저장된 등·하원 좌표가 있으면 함께 준다. */
export async function searchRosterStudents(query: string): Promise<RosterStudentSearchResult[]> {
  await requireAdmin();
  const q = String(query ?? "").trim();
  if (!q) return [];
  if (q.length > 40) throw new RosterInputError("검색어가 너무 깁니다.");
  const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const rows = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(
    `SELECT s."id", s."name", s."grade", u."phone" AS "parentPhone",
            pk."name" AS "pkName", pk."address" AS "pkAddress", pk."latitude" AS "pkLat", pk."longitude" AS "pkLng",
            dr."name" AS "drName", dr."address" AS "drAddress", dr."latitude" AS "drLat", dr."longitude" AS "drLng"
       FROM "Student" s
       LEFT JOIN "User" u ON u."id"=s."parentId"
       LEFT JOIN "StudentShuttleLocation" pk ON pk."studentId"=s."id" AND pk."kind"='PICKUP'
       LEFT JOIN "StudentShuttleLocation" dr ON dr."studentId"=s."id" AND dr."kind"='DROPOFF'
      WHERE s."mergedIntoStudentId" IS NULL AND s."name" ILIKE $1
      ORDER BY s."name" ASC, s."createdAt" ASC
      LIMIT 20`,
    like,
  );
  const place = (name: unknown, address: unknown, lat: unknown, lng: unknown): RosterStudentPlace | null =>
    lat != null && lng != null ? { name: (name as string | null) ?? null, address: String(address ?? ""), latitude: Number(lat), longitude: Number(lng) } : null;
  return rows.map((r) => ({
    id: String(r.id),
    name: String(r.name ?? ""),
    grade: (r.grade as string | null) ?? null,
    parentPhone: (r.parentPhone as string | null) ?? null,
    pickup: place(r.pkName, r.pkAddress, r.pkLat, r.pkLng),
    dropoff: place(r.drName, r.drAddress, r.drLat, r.drLng),
  }));
}

// ── 학생 추가 ───────────────────────────────────────────────

async function insertRosterRows(
  tx: Tx, month: string, rows: RosterNewRow[],
  who: { studentName: string; studentId: string | null; studentPhone: string | null; parentPhone: string | null },
) {
  for (const r of rows) {
    await tx.$executeRawUnsafe(
      `INSERT INTO "RegularShuttleStop"
        ("serviceMonth","weekday","classTime","arriveTime","stopName","direction","studentName","studentId","studentPhone","parentPhone","note","sortOrder","latitude","longitude")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NULL,$11,$12,$13)`,
      month, r.weekday, r.classTime, r.arriveTime, r.stopName, r.direction,
      who.studentName, who.studentId, who.studentPhone, who.parentPhone, r.sortOrder, r.latitude, r.longitude,
    );
  }
}

export async function addRosterStudent(raw: unknown): Promise<{ added: number } & RosterScopeResult> {
  const admin = await requireAdmin();
  const input = validateAddInput(raw);

  // 학생을 골랐으면 이름·전화를 학생/학부모 정보에서 채운다. 이름만 입력했으면 전화 없이 둔다.
  let studentName = input.studentName;
  let studentPhone: string | null = null;
  let parentPhone: string | null = null;
  if (input.studentId) {
    const found = await prisma.$queryRawUnsafe<{ name: string; phone: string | null; parentPhone: string | null; guardianPhone: string | null }[]>(
      `SELECT s."name", s."phone", u."phone" AS "parentPhone",
              (SELECT g."phone" FROM "Guardian" g WHERE g."studentId"=s."id" AND g."phone" IS NOT NULL ORDER BY g."isPrimary" DESC, g."createdAt" ASC LIMIT 1) AS "guardianPhone"
         FROM "Student" s LEFT JOIN "User" u ON u."id"=s."parentId"
        WHERE s."id"=$1 AND s."mergedIntoStudentId" IS NULL LIMIT 1`,
      input.studentId,
    );
    if (!found[0]) throw new RosterInputError("학생을 찾지 못했습니다. 다시 검색해 주세요.");
    studentName = found[0].name;
    studentPhone = found[0].phone ?? null;
    parentPhone = found[0].parentPhone ?? found[0].guardianPhone ?? null;
  }

  const who = { studentName, studentId: input.studentId, studentPhone, parentPhone };
  return prisma.$transaction(async (tx) => {
    const later = await lockForEdit(tx, input.serviceMonth, input.scope);
    // 고른 달은 중복이면 거부(오류 안내), 이후 달은 이미 있는 행만 건너뛰고 나머지를 만든다.
    const existing = await monthPlacementRows(tx, input.serviceMonth);
    // 운행표에서 고른 자리(중간 삽입·합류)를 적용한 실행 단계. 고른 자리가 없으면 예전처럼 그 수업 맨 뒤.
    const plan = planRosterInsert(buildAddRows(input, existing, studentName), input.placements, existing);
    const shifted = await applyInsertPlan(tx, input.serviceMonth, plan, who);
    const { steps } = plan;
    const rows = steps.map((s) => s.row);
    const appliedMonths = [input.serviceMonth];
    const skippedMonths: string[] = [];
    const endPlacedMonths: string[] = [];
    const laterSteps: { month: string; steps: RosterInsertStep[] }[] = [];
    for (const m of later) {
      const laterRows = await monthPlacementRows(tx, m);
      const extra = buildAddRows(input, laterRows, studentName, { skipDuplicates: true });
      if (extra.length === 0) { skippedMonths.push(m); continue; }
      // 그 달에서는 기준 정차의 대응 행(같은 학생·요일·방향·수업) 기준으로 같은 자리에, 없으면 맨 뒤.
      const monthPlan = planRosterInsert(extra, mapPlacementsToMonth(input.placements, existing, laterRows), laterRows);
      await applyInsertPlan(tx, m, monthPlan, who);
      const monthSteps = monthPlan.steps;
      laterSteps.push({ month: m, steps: monthSteps });
      if (monthSteps.some((s) => s.fellBack)) endPlacedMonths.push(m);
      appliedMonths.push(m);
    }
    await audit(tx, admin.appUserId, "REGULAR_ROSTER_ADD", null, {
      serviceMonth: input.serviceMonth, scope: input.scope, appliedMonths, endPlacedMonths, studentId: input.studentId, studentName, rows,
      placements: input.placements ?? [], shifted, spread: plan.spread,
      steps: steps.map((s) => ({ mode: s.mode, shiftFrom: s.shiftFrom, weekday: s.row.weekday, direction: s.row.direction, sortOrder: s.row.sortOrder })),
      laterSteps: laterSteps.map((l) => ({ month: l.month, steps: l.steps.map((s) => ({ mode: s.mode, fellBack: s.fellBack, shiftFrom: s.shiftFrom, weekday: s.row.weekday, direction: s.row.direction, sortOrder: s.row.sortOrder })) })),
    });
    return { added: rows.length, appliedMonths, skippedMonths, endPlacedMonths };
  });
}

/** 학생 추가 삽입 계획용 행(합류 대상의 정류장 이름·시각·좌표 포함). monthRows 는 다른 편집이 공유하므로 따로 읽는다. */
async function monthPlacementRows(tx: Tx, month: string): Promise<RosterPlacementRow[]> {
  const rows = await tx.$queryRawUnsafe<Record<string, unknown>[]>(
    `SELECT "id","weekday","direction","classTime","sortOrder","studentId","studentName","parentPhone","stopName","arriveTime","latitude","longitude"
       FROM "RegularShuttleStop" WHERE "serviceMonth"=$1`,
    month,
  );
  const num = (v: unknown) => (v == null ? null : Number.isFinite(Number(v)) ? Number(v) : null);
  return rows.map((r) => ({
    id: String(r.id),
    weekday: Number(r.weekday),
    direction: String(r.direction),
    classTime: (r.classTime as string | null) ?? null,
    sortOrder: Number(r.sortOrder) || 0,
    studentId: (r.studentId as string | null) ?? null,
    studentName: (r.studentName as string | null) ?? null,
    parentPhone: (r.parentPhone as string | null) ?? null,
    stopName: (r.stopName as string | null) ?? null,
    arriveTime: (r.arriveTime as string | null) ?? null,
    latitude: num(r.latitude),
    longitude: num(r.longitude),
  }));
}

/**
 * 삽입 계획 실행 — ① 칸 안 번호 겹침 벌리기(spread, 행 id 별 새 번호) ② 단계마다 (필요하면) 그 요일의
 * sortOrder ≥ shiftFrom 행을 모두 +1 하고 새 행을 넣는다. 같은 트랜잭션·같은 잠금 안이라 계획 시점 행과 DB 가 같다.
 * 요일 전체를 함께 밀어 다른 수업·방향·운영정차의 상대 순서를 지킨다. 바뀐 기존 행 수를 돌려준다(감사 기록용).
 */
async function applyInsertPlan(
  tx: Tx, month: string, plan: RosterInsertPlan,
  who: { studentName: string; studentId: string | null; studentPhone: string | null; parentPhone: string | null },
): Promise<number> {
  let shifted = 0;
  for (const u of plan.spread) {
    const n = Number(await tx.$executeRawUnsafe(
      `UPDATE "RegularShuttleStop" SET "sortOrder"=$1 WHERE "id"=$2 AND "serviceMonth"=$3`,
      u.sortOrder, u.id, month,
    )) || 0;
    if (n !== 1) throw new RosterInputError("그사이 명단이 바뀌었습니다. 화면을 새로고침한 뒤 다시 시도해 주세요.");
    shifted += n;
  }
  for (const s of plan.steps) {
    if (s.shiftFrom != null) {
      shifted += Number(await tx.$executeRawUnsafe(
        `UPDATE "RegularShuttleStop" SET "sortOrder"="sortOrder"+1 WHERE "serviceMonth"=$1 AND "weekday"=$2 AND "sortOrder">=$3`,
        month, s.row.weekday, s.shiftFrom,
      )) || 0;
    }
    await insertRosterRows(tx, month, [s.row], who);
  }
  return shifted;
}

// ── 학생 추가 화면: 등록 수업·상세 위치·학원 기준점 불러오기(조회 전용) ─────────────

export type RosterStudentContext = {
  student: RosterStudentSearchResult | null;
  /** 다니는(ACTIVE)·휴원(PAUSED) 수강의 요일·시각·상태(병합 학생·삭제된 프로그램·퇴원 제외). */
  enrolled: EnrolledClass[];
  /** 운행 기준점 — 추천 거리 계산용(등원: 차고지 → 학원 / 하원: 학원 → 차고지). 좌표가 이상하면 null. */
  academy: GeoPoint | null;
  depot: GeoPoint | null;
};

/**
 * 학생 추가 모달이 학생을 고르면(또는 모달을 열면) 부른다. 쓰기 없음.
 * studentId 가 비어 있으면(이름만 입력) 학원 기준점만 돌려준다.
 */
export async function getRosterStudentContext(rawStudentId: unknown): Promise<RosterStudentContext> {
  await requireAdmin();
  const studentId = typeof rawStudentId === "string" ? rawStudentId.trim() : "";
  if (studentId.length > 64) throw new RosterInputError("학생 정보가 올바르지 않습니다.");

  // getSettings 는 좌표가 비면 0 이 들어올 수 있어 한국 좌표 범위로 한 번 더 거른다.
  const settings = await getSettings();
  const geo = (g: { lat: number; lng: number } | null): GeoPoint | null =>
    g && Number.isFinite(g.lat) && Number.isFinite(g.lng) && isKoreanCoordinate(g.lat, g.lng) ? { lat: g.lat, lng: g.lng } : null;
  const academy = geo(settings.academy);
  const depot = geo(settings.depot);
  if (!studentId) return { student: null, enrolled: [], academy, depot };

  const found = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(
    // 학부모 전화: 계정 전화, 없으면 대표 보호자 전화(학생 추가 저장과 같은 규칙) — 「이미 타는 셔틀」 이름+전화 판정에 쓴다.
    `SELECT s."id", s."name", s."grade",
            COALESCE(u."phone", (SELECT g."phone" FROM "Guardian" g WHERE g."studentId"=s."id" AND g."phone" IS NOT NULL ORDER BY g."isPrimary" DESC, g."createdAt" ASC LIMIT 1)) AS "parentPhone",
            pk."name" AS "pkName", pk."address" AS "pkAddress", pk."latitude" AS "pkLat", pk."longitude" AS "pkLng",
            dr."name" AS "drName", dr."address" AS "drAddress", dr."latitude" AS "drLat", dr."longitude" AS "drLng"
       FROM "Student" s
       LEFT JOIN "User" u ON u."id"=s."parentId"
       LEFT JOIN "StudentShuttleLocation" pk ON pk."studentId"=s."id" AND pk."kind"='PICKUP'
       LEFT JOIN "StudentShuttleLocation" dr ON dr."studentId"=s."id" AND dr."kind"='DROPOFF'
      WHERE s."id"=$1 AND s."mergedIntoStudentId" IS NULL
      LIMIT 1`,
    studentId,
  );
  const r = found[0];
  if (!r) throw new RosterInputError("학생을 찾지 못했습니다. 다시 검색해 주세요.");
  const place = (name: unknown, address: unknown, lat: unknown, lng: unknown): RosterStudentPlace | null =>
    lat != null && lng != null ? { name: (name as string | null) ?? null, address: String(address ?? ""), latitude: Number(lat), longitude: Number(lng) } : null;
  const student: RosterStudentSearchResult = {
    id: String(r.id),
    name: String(r.name ?? ""),
    grade: (r.grade as string | null) ?? null,
    parentPhone: (r.parentPhone as string | null) ?? null,
    pickup: place(r.pkName, r.pkAddress, r.pkLat, r.pkLng),
    dropoff: place(r.drName, r.drAddress, r.drLat, r.drLng),
  };

  // 수강 등록: Enrollment(학생–반, status) → Class(dayOfWeek "Mon"…, startTime/endTime "HH:MM") → Program.
  // status 는 ACTIVE(다님)·PAUSED(휴원)·WITHDRAWN(퇴원) — 프로젝트 관례(「다니는 수업」= IN ('ACTIVE','PAUSED'))대로 휴원까지.
  // 복귀 직전 휴원생을 미리 배정하려는 것이 주 용도라 휴원을 빼면 안 된다(화면은 휴원을 미리 체크하지 않는다).
  const classes = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(
    `SELECT c."dayOfWeek", c."startTime", c."endTime", c."name" AS "className", p."name" AS "programName", e."status"
       FROM "Enrollment" e
       JOIN "Class" c ON c."id"=e."classId"
       JOIN "Program" p ON p."id"=c."programId"
      WHERE e."studentId"=$1 AND e."status" IN ('ACTIVE','PAUSED') AND p."deletedAt" IS NULL
      ORDER BY c."startTime" ASC`,
    studentId,
  );
  const enrolled: EnrolledClass[] = [];
  for (const c of classes) {
    const weekday = dowToWeekday(c.dayOfWeek as string | null);
    if (weekday == null) continue;
    enrolled.push({
      weekday,
      startTime: String(c.startTime ?? ""),
      endTime: String(c.endTime ?? ""),
      className: (c.className as string | null) ?? null,
      programName: (c.programName as string | null) ?? null,
      status: c.status === "PAUSED" ? "PAUSED" : "ACTIVE",
    });
  }
  return { student, enrolled, academy, depot };
}

// ── 빼기(퇴원·셔틀 중단) ─────────────────────────────────────

/** DB 행(RETURNING·SELECT 결과) → 다른 달 대응 행을 찾는 식별 정보. */
function identityOf(r: Record<string, unknown>): RosterRowIdentity {
  return {
    weekday: Number(r.weekday),
    direction: String(r.direction),
    classTime: (r.classTime as string | null) ?? null,
    studentId: (r.studentId as string | null) ?? null,
    studentName: (r.studentName as string | null) ?? null,
    parentPhone: (r.parentPhone as string | null) ?? null,
  };
}

export async function removeRosterRows(raw: unknown): Promise<{ removed: number } & RosterScopeResult> {
  const admin = await requireAdmin();
  const input = validateRemoveInput(raw);
  return prisma.$transaction(async (tx) => {
    const later = await lockForEdit(tx, input.serviceMonth, input.scope);
    // 학생 등·하원 행만 지운다(학원 경유·복귀 같은 운영 정차는 이 화면에서 지우지 않는다).
    const deleted = await tx.$queryRawUnsafe<Record<string, unknown>[]>(
      `DELETE FROM "RegularShuttleStop"
        WHERE "id" = ANY($1::text[]) AND "serviceMonth"=$2 AND "direction" IN ('BOARD','ALIGHT')
        RETURNING ${ROW_COLUMNS}`,
      input.ids, input.serviceMonth,
    );
    // 일부만 지워지면(다른 달·이미 삭제) 전체를 되돌린다 — 화면과 DB 가 어긋난 상태라서.
    if (deleted.length !== input.ids.length) throw new RosterInputError("일부 행을 이 달 명단에서 찾지 못했습니다. 화면을 새로고침해 주세요.");
    const appliedMonths = [input.serviceMonth];
    const skippedMonths: string[] = [];
    const laterDeleted: Record<string, unknown>[] = [];
    for (const m of later) {
      // 이후 달에서 같은 학생·요일·방향·수업시간 행을 찾아 함께 지운다. 없으면 그 달은 건너뛴다.
      const rows = await monthRows(tx, m);
      const ids = [...new Set(deleted.flatMap((d) => findCounterpartRows(identityOf(d), rows).map((r) => r.id)))];
      if (ids.length === 0) { skippedMonths.push(m); continue; }
      laterDeleted.push(...await tx.$queryRawUnsafe<Record<string, unknown>[]>(
        `DELETE FROM "RegularShuttleStop"
          WHERE "id" = ANY($1::text[]) AND "serviceMonth"=$2 AND "direction" IN ('BOARD','ALIGHT')
          RETURNING ${ROW_COLUMNS}`,
        ids, m,
      ));
      appliedMonths.push(m);
    }
    await audit(tx, admin.appUserId, "REGULAR_ROSTER_REMOVE", { serviceMonth: input.serviceMonth, scope: input.scope, rows: deleted, laterRows: laterDeleted }, { appliedMonths });
    return { removed: deleted.length, appliedMonths, skippedMonths };
  });
}

// ── 반이동 ─────────────────────────────────────────────────

async function applyMoveUpdates(tx: Tx, month: string, updates: { id: string; weekday: number; classTime: string; sortOrder: number }[]) {
  for (const u of updates) {
    await tx.$executeRawUnsafe(
      `UPDATE "RegularShuttleStop" SET "weekday"=$1,"classTime"=$2,"sortOrder"=$3 WHERE "id"=$4 AND "serviceMonth"=$5`,
      u.weekday, u.classTime, u.sortOrder, u.id, month,
    );
  }
}

export async function moveRosterRows(raw: unknown): Promise<{ moved: number } & RosterScopeResult> {
  const admin = await requireAdmin();
  const input = validateMoveInput(raw);
  return prisma.$transaction(async (tx) => {
    const later = await lockForEdit(tx, input.serviceMonth, input.scope);
    const existing = await monthRows(tx, input.serviceMonth);
    const updates = buildMoveUpdates(input.ids, input.weekday, input.classTime, existing);
    const before = existing.filter((r) => input.ids.includes(r.id));
    await applyMoveUpdates(tx, input.serviceMonth, updates);
    const appliedMonths = [input.serviceMonth];
    const skippedMonths: string[] = [];
    const laterUpdates: { month: string; id: string; weekday: number; classTime: string; sortOrder: number }[] = [];
    for (const m of later) {
      // 이후 달의 대응 행(옮기기 전 요일·수업시간 기준)을 같은 자리로 옮긴다.
      const rows = await monthRows(tx, m);
      const ids = [...new Set(before.map((b) => findCounterpartRows(b, rows)[0]?.id).filter((id): id is string => Boolean(id)))];
      if (ids.length === 0) { skippedMonths.push(m); continue; }
      try {
        const monthUpdates = buildMoveUpdates(ids, input.weekday, input.classTime, rows);
        await applyMoveUpdates(tx, m, monthUpdates);
        laterUpdates.push(...monthUpdates.map((u) => ({ month: m, ...u })));
        appliedMonths.push(m);
      } catch (e) {
        // 그 달에 이미 옮겨 갈 자리에 같은 학생이 있으면(따로 고친 달) 그 달만 건너뛴다.
        if (!(e instanceof RosterInputError)) throw e;
        skippedMonths.push(m);
      }
    }
    await audit(tx, admin.appUserId, "REGULAR_ROSTER_MOVE", { serviceMonth: input.serviceMonth, scope: input.scope, rows: before }, { serviceMonth: input.serviceMonth, rows: updates, laterRows: laterUpdates, appliedMonths });
    return { moved: updates.length, appliedMonths, skippedMonths };
  });
}

// ── 정류장 수정(한 행 / 같은 이름 전체) ──────────────────────────

export async function editRosterStop(raw: unknown): Promise<{ updated: number } & RosterScopeResult> {
  const admin = await requireAdmin();
  const input = validateStopEditInput(raw);
  const { stop } = input;
  return prisma.$transaction(async (tx) => {
    const later = await lockForEdit(tx, input.serviceMonth, input.scope);
    const current = await tx.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT "stopName","arriveTime","latitude","longitude","weekday","direction","classTime","studentId","studentName","parentPhone"
         FROM "RegularShuttleStop" WHERE "id"=$1 AND "serviceMonth"=$2`,
      input.id, input.serviceMonth,
    );
    if (!current[0]) throw new RosterInputError("이 달 명단에서 해당 정류장을 찾지 못했습니다. 화면을 새로고침해 주세요.");
    const oldStopName = String(current[0].stopName);

    // 한 달 안에서의 수정: 대상 행(도착시각 포함) + 「같은 이름 전체」면 같은 정류장 이름 행(이름·좌표만).
    // 좌표가 비어 오면(null) 기존 좌표를 유지한다 — 화면에 좌표를 지우는 기능이 없어 null 은 "변경 없음"으로 본다.
    async function applyInMonth(month: string, rowIds: string[]): Promise<number> {
      let n = 0;
      if (rowIds.length > 0) {
        // 도착시각은 학생·요일마다 다르므로 대상 행에만 적용한다.
        n += Number(await tx.$executeRawUnsafe(
          `UPDATE "RegularShuttleStop" SET "stopName"=$1,"arriveTime"=$2,"latitude"=COALESCE($3::double precision,"latitude"),"longitude"=COALESCE($4::double precision,"longitude")
            WHERE "id" = ANY($5::text[]) AND "serviceMonth"=$6`,
          stop.stopName, stop.arriveTime, stop.latitude, stop.longitude, rowIds, month,
        )) || 0;
      }
      if (input.applyToAll) {
        // 같은 달·같은 (옛) 정류장 이름을 쓰는 다른 행도 이름·좌표를 함께 바꾼다(도착시각은 그대로).
        // 새 좌표가 null 이면 각 행의 기존 좌표를 유지한다(좌표 없는 행을 고칠 때 다른 행 좌표까지 지우던 문제 방지).
        n += Number(await tx.$executeRawUnsafe(
          `UPDATE "RegularShuttleStop" SET "stopName"=$1,"latitude"=COALESCE($2::double precision,"latitude"),"longitude"=COALESCE($3::double precision,"longitude")
            WHERE "serviceMonth"=$4 AND "stopName"=$5 AND NOT ("id" = ANY($6::text[]))`,
          stop.stopName, stop.latitude, stop.longitude, month, oldStopName, rowIds,
        )) || 0;
      }
      return n;
    }

    const updated = await applyInMonth(input.serviceMonth, [input.id]);
    const appliedMonths = [input.serviceMonth];
    const skippedMonths: string[] = [];
    for (const m of later) {
      // 이후 달: 같은 학생·요일·방향·수업시간 행을 같은 정류장으로(같은 이름 전체면 그 달의 같은 이름 행도).
      const ids = findCounterpartRows(identityOf(current[0]), await monthRows(tx, m)).map((r) => r.id);
      const n = await applyInMonth(m, ids);
      if (n > 0) appliedMonths.push(m); else skippedMonths.push(m);
    }
    const { stopName, arriveTime, latitude, longitude } = current[0];
    await audit(tx, admin.appUserId, input.applyToAll ? "REGULAR_ROSTER_STOP_RENAME_ALL" : "REGULAR_ROSTER_STOP_EDIT",
      { serviceMonth: input.serviceMonth, id: input.id, stopName, arriveTime, latitude, longitude },
      { serviceMonth: input.serviceMonth, id: input.id, ...stop, applyToAll: input.applyToAll, scope: input.scope, updated, appliedMonths });
    return { updated, appliedMonths, skippedMonths };
  });
}

// ── 기사님 화면 순서·시각(정차 단위) ──────────────────────────────

/** 순서 편집용 행(시각 포함). monthRows 는 다른 편집이 공유하므로 따로 읽는다. */
async function monthRowsWithTime(tx: Tx, month: string): Promise<(RosterExistingRow & { arriveTime: string | null })[]> {
  const rows = await tx.$queryRawUnsafe<Record<string, unknown>[]>(
    `SELECT "id","weekday","direction","classTime","sortOrder","studentId","studentName","parentPhone","arriveTime"
       FROM "RegularShuttleStop" WHERE "serviceMonth"=$1`,
    month,
  );
  return rows.map((r) => ({
    id: String(r.id),
    weekday: Number(r.weekday),
    direction: String(r.direction),
    classTime: (r.classTime as string | null) ?? null,
    sortOrder: Number(r.sortOrder) || 0,
    studentId: (r.studentId as string | null) ?? null,
    studentName: (r.studentName as string | null) ?? null,
    parentPhone: (r.parentPhone as string | null) ?? null,
    arriveTime: (r.arriveTime as string | null) ?? null,
  }));
}

async function applyReorderUpdates(tx: Tx, month: string, updates: RosterReorderUpdate[]): Promise<number> {
  let n = 0;
  for (const u of updates) {
    n += Number(await tx.$executeRawUnsafe(
      `UPDATE "RegularShuttleStop" SET "sortOrder"=$1,"arriveTime"=$2 WHERE "id"=$3 AND "serviceMonth"=$4`,
      u.sortOrder, u.arriveTime, u.id, month,
    )) || 0;
  }
  return n;
}

/**
 * 기사님 화면 순서·시각 저장 — 한 요일·수업·방향 칸의 정차 순서와 정차 시각.
 * 그 칸 학생 행들이 쓰던 sortOrder 번호만 돌려 쓰므로 다른 수업·방향 순서는 바뀌지 않는다.
 * 정차에 속한 모든 행의 시각을 그 정차 시각으로 맞춘다(기사님 화면은 정류장별로 한 시각만 보여 준다).
 */
export async function reorderRosterStops(raw: unknown): Promise<{ updated: number } & RosterScopeResult> {
  const admin = await requireAdmin();
  const input = validateReorderInput(raw);
  return prisma.$transaction(async (tx) => {
    const later = await lockForEdit(tx, input.serviceMonth, input.scope);
    const existing = await monthRowsWithTime(tx, input.serviceMonth);
    const updates = buildReorderUpdates(input, existing);
    const byId = new Map(existing.map((r) => [r.id, r]));
    const updated = await applyReorderUpdates(tx, input.serviceMonth, updates);
    if (updated !== updates.length) throw new RosterInputError("일부 행을 이 달 명단에서 찾지 못했습니다. 화면을 새로고침해 주세요.");

    // 이후 달: 이 달 행(새 순서)마다 대응 행을 찾아 같은 순서·시각으로. 대응 행이 없는 달은 건너뛴다.
    const orderedSource = updates.map((u) => ({ ...byId.get(u.id)!, arriveTime: u.arriveTime }));
    const appliedMonths = [input.serviceMonth];
    const skippedMonths: string[] = [];
    const laterUpdates: ({ month: string } & RosterReorderUpdate)[] = [];
    for (const m of later) {
      const monthUpdates = buildCounterpartReorderUpdates(orderedSource, await monthRows(tx, m));
      if (monthUpdates.length === 0) { skippedMonths.push(m); continue; }
      await applyReorderUpdates(tx, m, monthUpdates);
      laterUpdates.push(...monthUpdates.map((u) => ({ month: m, ...u })));
      appliedMonths.push(m);
    }
    await audit(tx, admin.appUserId, "REGULAR_ROSTER_REORDER",
      { serviceMonth: input.serviceMonth, weekday: input.weekday, classTime: input.classTime, direction: input.direction,
        rows: updates.map((u) => ({ id: u.id, sortOrder: byId.get(u.id)?.sortOrder, arriveTime: byId.get(u.id)?.arriveTime ?? null })) },
      { serviceMonth: input.serviceMonth, scope: input.scope, rows: updates, laterRows: laterUpdates, appliedMonths });
    return { updated, appliedMonths, skippedMonths };
  });
}

// ── 정규 배차 저장 노선 사용 여부(조회 전용) ───────────────────────

/**
 * 그 달·요일의 기사님 화면이 방향별로 무엇을 쓰는지 — 정규 배차 저장 노선(true) / 셔틀 명단 순서(false).
 * 기사님 화면과 같은 판정(getSavedRegularDispatchRoute + pickRegularRouteSource)을 그대로 쓴다. 쓰기 없음.
 */
export async function getRegularRouteStatus(rawMonth: unknown, rawWeekday: unknown): Promise<{ PICKUP: boolean; DROPOFF: boolean }> {
  await requireAdmin();
  const month = normalizeRosterMonth(rawMonth);
  const weekday = normalizeWeekday(rawWeekday);
  const dow = DOW_NAMES[weekday];
  const [pickup, dropoff] = await Promise.all([
    getSavedRegularDispatchRoute(dow, "PICKUP", month),
    getSavedRegularDispatchRoute(dow, "DROPOFF", month),
  ]);
  return { PICKUP: pickRegularRouteSource(pickup) === "SAVED", DROPOFF: pickRegularRouteSource(dropoff) === "SAVED" };
}

// ── 월 복사(수동 「직전 달 복사」 · 자동 생성 공용) ──────────────────

async function monthRowCount(tx: Tx, month: string): Promise<number> {
  const rows = await tx.$queryRawUnsafe<{ n: number }[]>(
    `SELECT COUNT(*)::int AS n FROM "RegularShuttleStop" WHERE "serviceMonth"=$1`, month,
  );
  return Number(rows[0]?.n) || 0;
}

/**
 * 원본 달 명단을 대상 달로 복사하고, 원본 달의 저장 노선(RegularDispatchRoute)도 대상 달에 없으면 함께 복사한다.
 * - 기사님 화면이 새 달에 저장 노선(순서·시각·담당 기사)을 잃지 않게 하려는 것.
 * - 노선 안 학생 식별값은 studentId 라 그대로 쓰되, 학생 계정 없는 이름만 등록 행의 'stop:<행id>' 는
 *   새 행 id 로 바꿔 넣는다(안 바꾸면 새 달에서 그 학생이 노선에서 빠진다).
 * 호출부가 잠금과 「대상 달이 비었는지」 확인을 책임진다.
 */
async function copyMonthInTx(
  tx: Tx, sourceMonth: string, targetMonth: string, currentMonth: string,
): Promise<{ copied: number; routesCopied: number; boardingsMoved: number; driverRequestsMoved: number }> {
  // 새 행 id 를 미리 만들어 (옛 id → 새 id) 짝을 얻는다. src 는 두 번 참조되므로 한 번만 계산(materialize)된다.
  const pairs = await tx.$queryRawUnsafe<{ oldId: string; newId: string }[]>(
    `WITH src AS (
       SELECT gen_random_uuid()::text AS "newId", s.* FROM "RegularShuttleStop" s WHERE s."serviceMonth"=$2
     ), ins AS (
       INSERT INTO "RegularShuttleStop"
         ("id","serviceMonth","weekday","classTime","arriveTime","stopName","direction","studentName","studentId","studentPhone","parentPhone","note","sortOrder","latitude","longitude")
       SELECT "newId",$1,"weekday","classTime","arriveTime","stopName","direction","studentName","studentId","studentPhone","parentPhone","note","sortOrder","latitude","longitude"
         FROM src
       RETURNING "id"
     )
     SELECT src."id" AS "oldId", src."newId" AS "newId" FROM src JOIN ins ON ins."id"=src."newId"`,
    targetMonth, sourceMonth,
  );
  if (pairs.length === 0) return { copied: 0, routesCopied: 0, boardingsMoved: 0, driverRequestsMoved: 0 };
  const idMap = new Map(pairs.map((p) => [String(p.oldId), String(p.newId)]));

  const routes = await tx.$queryRawUnsafe<Record<string, unknown>[]>(
    `SELECT "dayOfWeek","direction","payload","classStart","classEnd","savedByUserId" FROM "RegularDispatchRoute" WHERE "serviceMonth"=$1`,
    sourceMonth,
  );
  let routesCopied = 0;
  for (const r of routes) {
    // 대상 달에 이미 저장 노선이 있으면 덮어쓰지 않는다(그 달에서 따로 저장한 노선 보존).
    routesCopied += Number(await tx.$executeRawUnsafe(
      `INSERT INTO "RegularDispatchRoute" ("serviceMonth","dayOfWeek","direction","payload","classStart","classEnd","savedByUserId")
       VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7)
       ON CONFLICT ("serviceMonth","dayOfWeek","direction") DO NOTHING`,
      targetMonth, r.dayOfWeek, r.direction, JSON.stringify(remapStopRowIds(r.payload, idMap)),
      r.classStart ?? null, r.classEnd ?? null, r.savedByUserId ?? null,
    )) || 0;
  }

  // 따라잡기 생성(대상 달 <= 이번 달)이면, 그 달 날짜에 옛 행 id 로 남은 탑승체크·제외 요청을 새 id 로 옮긴다.
  // (새 달이 생기는 순간 기사님 화면이 새 행 id 를 쓰므로, 안 옮기면 이미 찍은 체크가 미체크로 보이고 중복 기록이 생긴다.)
  let boardingsMoved = 0;
  let driverRequestsMoved = 0;
  const range = catchUpDateRange(targetMonth, currentMonth);
  if (range) {
    const { oldIds, newIds } = idPairArrays(pairs);
    // 탑승체크: 정규(direction='REGULAR')의 shuttleRequestId = 정차 행 id. 새 id 는 방금 만든 값이라 UNIQUE 충돌이 없다.
    boardingsMoved = Number(await tx.$executeRawUnsafe(
      `UPDATE "ShuttleBoarding" b SET "shuttleRequestId"=m."newId"
         FROM unnest($1::text[], $2::text[]) AS m("oldId","newId")
        WHERE b."shuttleRequestId"=m."oldId" AND b."direction"='REGULAR'
          AND b."serviceDate" >= $3 AND b."serviceDate" < $4`,
      oldIds, newIds, range.from, range.to,
    )) || 0;
    // 기사님 「학생 제외」 요청: 정규 기사 화면은 targetId 에 정차 행 id 를 넣는다. 처리 전(PENDING)만 옮긴다.
    driverRequestsMoved = Number(await tx.$executeRawUnsafe(
      `UPDATE "DriverRequest" r SET "targetId"=m."newId"
         FROM unnest($1::text[], $2::text[]) AS m("oldId","newId")
        WHERE r."targetId"=m."oldId" AND r."type"='REMOVE' AND r."status"='PENDING'
          AND r."serviceDate" >= $3 AND r."serviceDate" < $4`,
      oldIds, newIds, range.from, range.to,
    )) || 0;
  }
  return { copied: pairs.length, routesCopied, boardingsMoved, driverRequestsMoved };
}

/** 두 달 잠금 — 전체 잠금 먼저, 달 잠금은 오름차순(교착 방지). */
async function lockMonthsForCopy(tx: Tx, a: string, b: string) {
  await lockAllMonths(tx);
  for (const m of [a, b].sort()) await lockMonth(tx, m);
}

export async function copyRosterMonth(raw: unknown): Promise<{ copied: number; targetMonth: string }> {
  const admin = await requireAdmin();
  const input = validateCopyInput(raw);
  return prisma.$transaction(async (tx) => {
    await lockMonthsForCopy(tx, input.sourceMonth, input.targetMonth);
    // 대상 달에 이미 명단이 있으면 덮어쓰지 않는다(그 달에서 고친 내용이 사라지지 않게).
    if (await monthRowCount(tx, input.targetMonth) > 0) throw new RosterInputError(`${input.targetMonth} 명단이 이미 있습니다. 그 달에서 직접 고쳐 주세요.`);
    const { copied, ...moved } = await copyMonthInTx(tx, input.sourceMonth, input.targetMonth, koreaServiceMonth());
    if (copied === 0) throw new RosterInputError(`${input.sourceMonth} 명단이 비어 있어 복사할 내용이 없습니다.`);
    await audit(tx, admin.appUserId, "REGULAR_ROSTER_COPY_MONTH", { sourceMonth: input.sourceMonth }, { targetMonth: input.targetMonth, copied, ...moved });
    return { copied, targetMonth: input.targetMonth };
  });
}

// ── 월 자동 생성(이번 달·다음 달 항상 준비) ───────────────────────

export type EnsureRosterMonthsResult = {
  currentMonth: string;
  created: { sourceMonth: string; targetMonth: string; copied: number; routesCopied: number; boardingsMoved: number; driverRequestsMoved: number }[];
};

/**
 * 이번 달(KST)과 다음 달 명단이 항상 있게 한다 — 다음 달 수강 변경을 미리 반영할 수 있도록.
 * 없는 달은 그 직전의 가장 최근 달을 복사한다(10월이 없으면 09→10, 그다음 10→11).
 * 이미 있으면 아무것도 안 하고(멱등), 명단이 아예 없으면 만들지 않는다.
 * 매일 크론(/api/cron/regular-shuttle-months)과 셔틀 명단·정규 배차 화면 진입 시 호출된다.
 * ⚠️ 관리자 확인(requireAdmin)을 하지 않는다 — 크론에서도 불러야 하고, 입력 없이 정해진 일만 한다.
 */
export async function ensureRegularRosterMonths(now: Date = new Date()): Promise<EnsureRosterMonthsResult> {
  const currentMonth = koreaServiceMonth(now);
  const months = (await prisma.$queryRawUnsafe<{ m: string }[]>(
    `SELECT DISTINCT "serviceMonth" AS m FROM "RegularShuttleStop"`,
  )).map((r) => String(r.m));
  const created: EnsureRosterMonthsResult["created"] = [];
  // 단계마다 따로 트랜잭션(앞 단계가 끝나야 다음 단계의 원본이 된다).
  for (const step of planEnsureMonths(months, currentMonth)) {
    const done = await prisma.$transaction(async (tx) => {
      await lockMonthsForCopy(tx, step.sourceMonth, step.targetMonth);
      // 잠금을 기다리는 사이 다른 요청(다른 화면·크론)이 이미 만들었으면 손대지 않는다.
      if (await monthRowCount(tx, step.targetMonth) > 0) return null;
      const result = await copyMonthInTx(tx, step.sourceMonth, step.targetMonth, currentMonth);
      if (result.copied === 0) return null;
      await audit(tx, null, "REGULAR_ROSTER_AUTO_MONTH", { sourceMonth: step.sourceMonth }, { targetMonth: step.targetMonth, ...result });
      return { ...step, ...result };
    });
    if (done) created.push(done);
  }
  return { currentMonth, created };
}
