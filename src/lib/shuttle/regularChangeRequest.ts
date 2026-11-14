import { Prisma } from "@prisma/client";
import { childAccessSql } from "@/lib/account/child-access";
import { prisma } from "@/lib/prisma";
import { notMergedStudent } from "@/lib/studentVisibility";
import { todayKst } from "@/lib/datetime/kst";
import { SHUTTLE_LOCATION_CONSENT_VERSION } from "@/lib/seasonal/contracts";
import { upsertStudentShuttleLocation } from "@/lib/students/student-shuttle-location-upsert";
import { RegularLocationLinkError, validateRegularLocation, type RegularLocationInput } from "@/lib/shuttle/regularLocationLink";
import { applyLocationToRosterInTx, flushRosterNotices, lockRosterForLocationInTx } from "./regularRosterEdit";
import {
  REGULAR_CHANGE_KIND_LABEL,
  REGULAR_CHANGE_MESSAGE,
  ROSTER_DIRECTION,
  canCancelRegularChange,
  koreanMonthDay,
  planRegularChangeApply,
  regularChangeDateRange,
  regularChangeStatusLine,
  regularChangeSummary,
  validateRegularChange,
  weekdayOfClassDay,
  type RegularChangeContext,
  type RegularChangeDirection,
  type RegularChangeKind,
} from "@/lib/shuttle/regularChangeRules";

// ── 셔틀 타는 곳·내리는 곳 «앞으로 계속» 바꾸기 신청(2026-11-14 결정표 c5) ─────────────
//
// 흐름: 학부모 신청(확인 중) → 원장 승인 → 적용 시작일에 셔틀 명단 반영 / 반려(사유) / 학부모 취소(확인 중일 때만).
// 기존 토큰 링크(/shuttle/location/<토큰>)는 제출 즉시 «학생 위치»만 저장하고 명단은 원장이 학생 위치를 저장할 때 바뀐다.
// 이 신청은 그 «원장 반영»을 승인 버튼으로 바꾼 것이다 — 위치 검증은 링크와 같은 함수(validateRegularLocation),
// 명단 반영은 관리자 학생 위치 저장과 같은 함수(applyLocationToRosterInTx)를 쓴다.
//
// ★ 보안 가드(반드시 유지):
//   1) IDOR — 학생이 그 부모의 자녀인지 SQL(childAccessSql)로 재검증. 화면이 보낸 요일·명단 상황을 믿지 않는다.
//   2) 승인 전에는 명단(RegularShuttleStop)·학생 위치(StudentShuttleLocation)에 아무것도 쓰지 않는다.
//   3) 표가 아직 없으면(마이그레이션 전) 조회는 «쓸 수 없음»으로, 쓰기는 거절로 끝난다 — 화면은 죽지 않는다.

const TABLE = `"ShuttleRegularChangeRequest"`;
const REGULAR_CLASS_FILTER = `c."dayOfWeek" <> 'Seasonal'`;

type Db = {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
};

/** 마이그레이션(20261115120000)이 적용됐는가 */
export async function regularChangeAvailable(db: Db = prisma as unknown as Db): Promise<boolean> {
  try {
    const rows = await db.$queryRawUnsafe<Array<{ found: string | null }>>(
      `SELECT to_regclass('public."ShuttleRegularChangeRequest"')::text AS found`,
    );
    return Boolean(rows[0]?.found);
  } catch {
    return false;
  }
}

/** 그 달 «이하»의 최신 명단 달에 올라 있는 칸 — 학부모 정규 셔틀 조회(childShuttleQuery)와 같은 기준 */
const ROSTER_CELLS_SQL = `SELECT r."studentId", r.weekday, r.direction, r."stopName"
   FROM "RegularShuttleStop" r
  WHERE r."studentId" = ANY($1::text[])
    AND r.direction IN ('BOARD','ALIGHT')
    AND r."serviceMonth" = (SELECT max(m."serviceMonth") FROM "RegularShuttleStop" m WHERE m."serviceMonth" <= $2)
  ORDER BY r.weekday, r.direction`;

type RosterCell = { studentId: string; weekday: number; direction: string; stopName: string | null };

function toDirection(rosterDirection: string): RegularChangeDirection {
  return rosterDirection === "BOARD" ? "PICKUP" : "DROPOFF";
}

async function readRosterCells(db: Db, studentIds: readonly string[], today: string): Promise<RosterCell[]> {
  if (studentIds.length === 0) return [];
  const rows = await db.$queryRawUnsafe<RosterCell[]>(ROSTER_CELLS_SQL, [...studentIds], today.slice(0, 7));
  return rows.map((r) => ({ studentId: String(r.studentId), weekday: Number(r.weekday), direction: String(r.direction), stopName: r.stopName ?? null }));
}

function contextOf(today: string, classDays: readonly (string | null)[], cells: readonly RosterCell[]): RegularChangeContext {
  return {
    today,
    classWeekdays: [...new Set(classDays.map(weekdayOfClassDay).filter((w): w is number => w !== null))],
    roster: cells.map((c) => ({ weekday: c.weekday, direction: toDirection(c.direction) })),
  };
}

export type RegularChangePlace = { name: string | null; address: string | null; roadAddress: string | null; latitude: number; longitude: number };

export type RegularChangeRow = {
  id: string;
  studentId: string;
  kind: RegularChangeKind;
  directions: RegularChangeDirection[];
  weekdays: number[] | null;
  effectiveFrom: string;
  status: string;
  /** «등원·하원 위치 바꾸기 · 월·수» */
  summary: string;
  /** «확인 중 / 승인됨(12월 1일부터) / 반려: 사유» */
  statusText: string;
  statusTone: "warning" | "success" | "danger" | "muted";
  canCancel: boolean;
  pickupName: string | null;
  dropoffName: string | null;
  createdOn: string;
};

export type RegularChangeChild = {
  studentId: string;
  studentName: string;
  /** 정규 반(다니는 중·휴원 중)의 요일(0=일 … 6=토) */
  classWeekdays: number[];
  /** 지금 셔틀 명단의 칸 — 요일·방향·정류장 이름 */
  roster: Array<{ weekday: number; direction: RegularChangeDirection; stopName: string | null }>;
  /** 저장돼 있는 위치(지도 첫 화면용) */
  pickup: RegularChangePlace | null;
  dropoff: RegularChangePlace | null;
};

export type RegularChangeOptions = {
  available: boolean;
  minEffectiveFrom: string;
  maxEffectiveFrom: string;
  consentVersion: string;
  children: RegularChangeChild[];
  requests: RegularChangeRow[];
};

function placeNameOf(json: unknown): string | null {
  if (!json || typeof json !== "object") return null;
  const raw = json as Record<string, unknown>;
  const pick = [raw.name, raw.roadAddress, raw.address].find((v) => typeof v === "string" && v.trim());
  return typeof pick === "string" ? pick.trim() : null;
}

function toRow(r: any): RegularChangeRow {
  const directions = (Array.isArray(r.directions) ? r.directions : []).filter((d: unknown): d is RegularChangeDirection => d === "PICKUP" || d === "DROPOFF");
  const weekdays = Array.isArray(r.weekdays) && r.weekdays.length > 0 ? r.weekdays.map(Number) : null;
  const line = regularChangeStatusLine({ status: r.status, effectiveFrom: r.effectiveFrom, decisionNote: r.decisionNote });
  return {
    id: String(r.id), studentId: String(r.studentId), kind: r.kind, directions, weekdays,
    effectiveFrom: r.effectiveFrom, status: r.status,
    summary: regularChangeSummary({ kind: r.kind, directions, weekdays }),
    statusText: line.text, statusTone: line.tone, canCancel: canCancelRegularChange(r.status),
    pickupName: placeNameOf(r.pickupJson), dropoffName: placeNameOf(r.dropoffJson),
    createdOn: r.createdOn ?? "",
  };
}

const REQUEST_COLUMNS = `r.id, r."studentId", r.kind, r.directions, r.weekdays, r."pickupJson", r."dropoffJson",
        to_char(r."effectiveFrom",'YYYY-MM-DD') AS "effectiveFrom", r.status, r."decisionNote", r.note,
        to_char(r."createdAt" AT TIME ZONE 'Asia/Seoul','YYYY-MM-DD') AS "createdOn"`;

/** 학부모 «계속 바꾸기» 화면 자료 — 내 아이(정규 반이 있는)·지금 명단·저장된 위치·최근 신청 */
export async function getRegularChangeOptions(parentUserId: string, db: Db = prisma as unknown as Db): Promise<RegularChangeOptions> {
  const today = todayKst();
  const range = regularChangeDateRange(today);
  const base = { minEffectiveFrom: range.min, maxEffectiveFrom: range.max, consentVersion: SHUTTLE_LOCATION_CONSENT_VERSION };
  if (!(await regularChangeAvailable(db))) return { available: false, ...base, children: [], requests: [] };

  const access = await childAccessSql("s", "$1");
  const kids = await db.$queryRawUnsafe<Array<{ studentId: string; studentName: string; classDays: string[] }>>(
    `SELECT s.id AS "studentId", s.name AS "studentName", array_agg(DISTINCT c."dayOfWeek") AS "classDays"
       FROM "Student" s
       JOIN "Enrollment" e ON e."studentId" = s.id AND e.status IN ('ACTIVE','PAUSED')
       JOIN "Class" c ON c.id = e."classId" AND ${REGULAR_CLASS_FILTER}
      WHERE ${access} AND ${notMergedStudent("s")}
      GROUP BY s.id, s.name
      ORDER BY s.name`,
    parentUserId,
  );
  const ids = kids.map((k) => k.studentId);
  const [cells, places, requests] = await Promise.all([
    readRosterCells(db, ids, today),
    ids.length === 0 ? Promise.resolve([]) : db.$queryRawUnsafe<Array<{ studentId: string; kind: string } & RegularChangePlace>>(
      `SELECT "studentId", kind, name, address, "roadAddress", latitude, longitude
         FROM "StudentShuttleLocation" WHERE "studentId" = ANY($1::text[]) AND kind IN ('PICKUP','DROPOFF')`,
      ids,
    ),
    ids.length === 0 ? Promise.resolve([]) : db.$queryRawUnsafe<any[]>(
      // 아직 끝나지 않은 건(확인 중·승인)은 오래돼도, 끝난 건은 최근 3개월만
      `SELECT ${REQUEST_COLUMNS}
         FROM ${TABLE} r
        WHERE r."studentId" = ANY($1::text[])
          AND (r.status IN ('PENDING','APPROVED') OR r."updatedAt" >= now() - interval '3 months')
        ORDER BY r."createdAt" DESC
        LIMIT 30`,
      ids,
    ),
  ]);
  const placeOf = (studentId: string, kind: string): RegularChangePlace | null => {
    const p = places.find((x) => x.studentId === studentId && x.kind === kind);
    if (!p || p.latitude == null || p.longitude == null) return null;
    return { name: p.name ?? null, address: p.address ?? null, roadAddress: p.roadAddress ?? null, latitude: Number(p.latitude), longitude: Number(p.longitude) };
  };
  return {
    available: true, ...base,
    children: kids.map((k) => {
      const mine = cells.filter((c) => c.studentId === k.studentId);
      const ctx = contextOf(today, k.classDays ?? [], mine);
      return {
        studentId: k.studentId, studentName: k.studentName,
        classWeekdays: [...ctx.classWeekdays].sort((a, b) => a - b),
        roster: mine.map((c) => ({ weekday: c.weekday, direction: toDirection(c.direction), stopName: c.stopName })),
        pickup: placeOf(k.studentId, "PICKUP"), dropoff: placeOf(k.studentId, "DROPOFF"),
      };
    }),
    requests: requests.map(toRow),
  };
}

export type SubmitRegularChangeInput = {
  studentId?: unknown;
  kind?: unknown;
  directions?: unknown;
  weekdays?: unknown;
  effectiveFrom?: unknown;
  note?: unknown;
  pickup?: unknown;
  dropoff?: unknown;
  consentVersion?: unknown;
};

type TxDb = Db & { $transaction?: never };
type RootDb = Db & { $transaction<T>(fn: (tx: TxDb) => Promise<T>): Promise<T> };

export async function submitRegularChangeRequest(
  parentUserId: string,
  input: SubmitRegularChangeInput,
  db: RootDb = prisma as unknown as RootDb,
) {
  const studentId = typeof input.studentId === "string" ? input.studentId.trim() : "";
  if (!studentId) return { ok: false as const, message: "아이를 다시 선택해 주세요." };
  if (!(await regularChangeAvailable(db))) return { ok: false as const, message: "지금은 신청을 받을 수 없어요. 잠시 후 다시 시도해 주세요." };

  const directions = Array.isArray(input.directions) ? input.directions : [];
  const stop = input.kind === "STOP";
  // 위치 값은 토큰 링크 제출과 같은 검증(장소명 필수·좌표 범위·주소) — 고른 방향 것만 받는다.
  let pickup: RegularLocationInput | null = null;
  let dropoff: RegularLocationInput | null = null;
  try {
    if (!stop && directions.includes("PICKUP") && input.pickup != null) pickup = validateRegularLocation(input.pickup);
    if (!stop && directions.includes("DROPOFF") && input.dropoff != null) dropoff = validateRegularLocation(input.dropoff);
  } catch (error) {
    if (error instanceof RegularLocationLinkError) return { ok: false as const, message: error.message };
    throw error;
  }

  const today = todayKst();
  const access = await childAccessSql("s", "$2");
  try {
    const result = await db.$transaction(async (tx) => {
      // 가드1 + 줄 세우기: 내 아이인지 확인하며 학생 행을 잠근다(같은 아이의 동시 신청이 차례로 들어온다).
      const students = await tx.$queryRawUnsafe<Array<{ id: string; name: string }>>(
        `SELECT s.id, s.name FROM "Student" s
          WHERE s.id = $1 AND ${access} AND ${notMergedStudent("s")}
          FOR UPDATE OF s`,
        studentId, parentUserId,
      );
      const student = students[0];
      if (!student) return { ok: false as const, message: "본인 자녀만 신청할 수 있습니다." };

      const classes = await tx.$queryRawUnsafe<Array<{ dayOfWeek: string }>>(
        `SELECT c."dayOfWeek" FROM "Enrollment" e JOIN "Class" c ON c.id = e."classId" AND ${REGULAR_CLASS_FILTER}
          WHERE e."studentId" = $1 AND e.status IN ('ACTIVE','PAUSED')`,
        studentId,
      );
      if (classes.length === 0) return { ok: false as const, message: "지금 다니는 반이 있어야 셔틀을 신청할 수 있어요." };
      const cells = await readRosterCells(tx, [studentId], today);
      const checked = validateRegularChange({
        kind: input.kind, directions: input.directions, weekdays: input.weekdays,
        effectiveFrom: input.effectiveFrom, note: input.note,
        hasPickup: Boolean(pickup), hasDropoff: Boolean(dropoff),
        consent: input.consentVersion === SHUTTLE_LOCATION_CONSENT_VERSION,
      }, contextOf(today, classes.map((c) => c.dayOfWeek), cells));
      if (!checked.ok) return { ok: false as const, message: REGULAR_CHANGE_MESSAGE[checked.error] };
      const value = checked.value;

      const open = await tx.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT id FROM ${TABLE} WHERE "studentId" = $1 AND status = 'PENDING' LIMIT 1`, studentId,
      );
      if (open.length > 0) return { ok: false as const, message: "이미 확인 중인 신청이 있어요. 취소한 뒤 다시 신청해 주세요." };

      const id = crypto.randomUUID();
      await tx.$executeRawUnsafe(
        `INSERT INTO ${TABLE}
           (id, "studentId", "requestedByUserId", kind, directions, weekdays, "pickupJson", "dropoffJson", "effectiveFrom", note, "consentVersion")
         VALUES ($1, $2, $3, $4, $5::text[], $6::int[], $7::jsonb, $8::jsonb, $9::date, $10, $11)`,
        id, studentId, parentUserId, value.kind, value.directions, value.weekdays,
        value.kind !== "STOP" && pickup ? JSON.stringify(pickup) : null,
        value.kind !== "STOP" && dropoff ? JSON.stringify(dropoff) : null,
        value.effectiveFrom, value.note, value.kind === "STOP" ? null : SHUTTLE_LOCATION_CONSENT_VERSION,
      );
      return { ok: true as const, id, value, studentName: student.name };
    });
    if (!result.ok) return result;

    // 원장 알림 — 앱 알림(인앱·푸시)만. 실패해도 신청은 남는다.
    try {
      const { notifyOperationalStaff } = await import("@/lib/operational-staff-notification");
      await notifyOperationalStaff({
        type: "SHUTTLE_REGULAR_CHANGE",
        title: "셔틀 계속 바꾸기 신청",
        message: `${result.studentName} 학생 ${regularChangeSummary(result.value)} · ${koreanMonthDay(result.value.effectiveFrom)}부터 · 승인 전에는 명단이 바뀌지 않습니다.`,
        linkUrl: "/admin/shuttle/regular",
        includeCoach: false,
      });
    } catch (error) {
      console.error("[shuttle-regular-change] 원장 알림 실패:", error instanceof Error ? error.name : "");
    }
    return { ok: true as const, id: result.id };
  } catch (error) {
    // 부분 유니크(아이당 확인 중 1건)가 마지막 방어선
    const conflict = error as { code?: string; meta?: { code?: string } };
    if (conflict?.code === "P2002" || conflict?.meta?.code === "23505" || conflict?.code === "23505") {
      return { ok: false as const, message: "이미 확인 중인 신청이 있어요. 취소한 뒤 다시 신청해 주세요." };
    }
    throw error;
  }
}

/** 학부모 취소 — 원장이 결정하기 전(확인 중)인 내 아이 신청만. 한 문장 UPDATE 로 확인과 쓰기를 같이 한다. */
export async function cancelRegularChangeRequest(parentUserId: string, requestId: unknown, db: Db = prisma as unknown as Db) {
  const id = typeof requestId === "string" ? requestId.trim() : "";
  if (!id) return { ok: false as const, message: "취소할 신청을 찾을 수 없습니다." };
  if (!(await regularChangeAvailable(db))) return { ok: false as const, message: "취소할 신청을 찾을 수 없습니다." };
  const changed = Number(await db.$executeRawUnsafe(
    `UPDATE ${TABLE} r SET status = 'CANCELED', "updatedAt" = now()
       FROM "Student" s
      WHERE r."studentId" = s.id AND ${await childAccessSql("s", "$1")} AND ${notMergedStudent("s")}
        AND r.id = $2 AND r.status = 'PENDING'`,
    parentUserId, id,
  ));
  if (changed === 0) return { ok: false as const, message: "이미 처리된 신청은 취소할 수 없어요." };
  return { ok: true as const };
}

// ── 원장 화면 ────────────────────────────────────────────────────────────────

export type AdminRegularChangeRow = RegularChangeRow & {
  studentName: string;
  note: string | null;
  pickupAddress: string | null;
  dropoffAddress: string | null;
  /** 지금 명단의 그 아이 정류장(바뀌기 전) — «월 등원 ○○» */
  currentStops: string[];
  /** 승인됐지만 아직 명단 반영 전일 때의 할 일 한 줄(없으면 null) */
  todo: string | null;
};

function addressOf(json: unknown): string | null {
  if (!json || typeof json !== "object") return null;
  const raw = json as Record<string, unknown>;
  const pick = [raw.roadAddress, raw.address].find((v) => typeof v === "string" && v.trim());
  return typeof pick === "string" ? pick.trim() : null;
}

const WEEKDAY_KO = ["일", "월", "화", "수", "목", "금", "토"];

/** 원장 목록 — 처리할 것(확인 중·승인 뒤 반영 전) 전부 + 최근 끝난 것 몇 건. 표가 없으면 빈 목록. */
export async function listRegularChangeRequests(db: Db = prisma as unknown as Db): Promise<AdminRegularChangeRow[]> {
  if (!(await regularChangeAvailable(db))) return [];
  const today = todayKst();
  const rows = await db.$queryRawUnsafe<any[]>(
    `SELECT ${REQUEST_COLUMNS}, s.name AS "studentName"
       FROM ${TABLE} r
       JOIN "Student" s ON s.id = r."studentId" AND ${notMergedStudent("s")}
      WHERE r.status IN ('PENDING','APPROVED') OR r."updatedAt" >= now() - interval '14 days'
      ORDER BY (r.status = 'PENDING') DESC, (r.status = 'APPROVED') DESC, r."createdAt" DESC
      LIMIT 60`,
  );
  const cells = await readRosterCells(db, [...new Set(rows.map((r) => String(r.studentId)))], today);
  return rows.map((r) => {
    const row = toRow(r);
    const mine = cells.filter((c) => c.studentId === row.studentId);
    const plan = row.status === "APPROVED"
      ? planRegularChangeApply({
          kind: row.kind, effectiveFrom: row.effectiveFrom, today, directions: row.directions, weekdays: row.weekdays,
          roster: mine.map((c) => ({ weekday: c.weekday, direction: toDirection(c.direction) })),
        })
      : null;
    const todo = !plan ? null
      : plan.action === "WAIT" ? `${koreanMonthDay(row.effectiveFrom)}에 반영 예정`
      : plan.action === "KEEP_OPEN" ? plan.reason
      : "곧 반영됩니다";
    return {
      ...row, studentName: r.studentName, note: r.note ?? null,
      pickupAddress: addressOf(r.pickupJson), dropoffAddress: addressOf(r.dropoffJson),
      currentStops: mine.map((c) => `${WEEKDAY_KO[c.weekday] ?? ""} ${c.direction === "BOARD" ? "등원" : "하원"} ${c.stopName ?? ""}`.trim()),
      todo,
    };
  });
}

/**
 * 원장 승인·반려. 승인 = 예약(적용 시작일에 반영 — 이미 지났으면 바로 아래에서 반영한다).
 * 확인 중(PENDING)일 때만 바뀐다 — 학부모가 먼저 취소했으면 «이미 처리됨».
 * ⚠️ 권한 확인을 하지 않는다 — 부르는 쪽(서버 액션 → requireAdmin)이 책임진다.
 */
export async function decideRegularChangeRequest(input: { adminUserId: string; requestId: string; approve: boolean; note?: string | null }) {
  if (!(await regularChangeAvailable())) return { ok: false as const, message: "신청을 찾을 수 없어요." };
  const note = (input.note ?? "").trim().slice(0, 300) || null;
  // 반려는 사유가 있어야 한다 — 학부모 화면에 «반려: 사유»로 그대로 보인다.
  if (!input.approve && !note) return { ok: false as const, message: "반려 사유를 적어 주세요. 학부모에게 그대로 보입니다." };
  const decided = await prisma.$queryRawUnsafe<Array<{ id: string; studentId: string; requestedByUserId: string; kind: string; directions: string[]; weekdays: number[] | null; effectiveFrom: string; studentName: string; pickupJson: unknown; dropoffJson: unknown }>>(
    `UPDATE ${TABLE} r
        SET status = $2, "decidedByUserId" = $3, "decidedAt" = now(), "decisionNote" = $4, "updatedAt" = now()
       FROM "Student" s
      WHERE r."studentId" = s.id AND ${notMergedStudent("s")} AND r.id = $1 AND r.status = 'PENDING'
      RETURNING r.id, r."studentId", r."requestedByUserId", r.kind, r.directions, r.weekdays, r."pickupJson", r."dropoffJson",
                to_char(r."effectiveFrom",'YYYY-MM-DD') AS "effectiveFrom", s.name AS "studentName"`,
    input.requestId, input.approve ? "APPROVED" : "REJECTED", input.adminUserId, note,
  );
  const row = decided[0];
  if (!row) return { ok: false as const, message: "이미 처리된 신청입니다." };

  // «이용 시작» 승인: 셔틀을 아예 안 타던 아이면 신청한 위치를 학생 위치로 저장해 둔다 —
  // 원장이 명단 화면 «학생 추가»를 열면 이 위치가 미리 채워진다(명단 자체는 원장이 넣는다). 실패해도 승인은 그대로.
  if (input.approve && row.kind === "START") {
    await saveStartLocations(row).catch((error) => {
      console.error("[shuttle-regular-change] 이용 시작 위치 저장 실패", row.id, error instanceof Error ? error.name : "");
    });
  }

  // 학부모 앱 알림(문자·알림톡 아님) — 신청자가 지금도 그 아이 보호자일 때만. 실패해도 결정은 그대로.
  await notifyParentOfRegularChange({
    requestId: row.id, studentId: row.studentId, recipientUserId: row.requestedByUserId, studentName: row.studentName,
    approved: input.approve, effectiveFrom: row.effectiveFrom, note,
    summary: regularChangeSummary({ kind: row.kind, directions: row.directions, weekdays: row.weekdays && row.weekdays.length > 0 ? row.weekdays : null }),
  });

  // 적용 시작일이 이미 왔으면 바로 반영한다(매일 cron 과 같은 함수 — 신청 행 잠금으로 한 번만 적용된다).
  const applied = input.approve ? await applyDueRegularChanges({ onlyId: row.id }) : null;
  return { ok: true as const, appliedNow: Boolean(applied?.appliedIds.includes(row.id)) };
}

/** «이용 시작» 승인 때: 명단에 한 칸도 없는 아이만, 신청한 위치를 학생 위치(StudentShuttleLocation)로 저장한다. */
async function saveStartLocations(row: { studentId: string; directions: string[]; pickupJson: unknown; dropoffJson: unknown }) {
  const cells = await readRosterCells(prisma as unknown as Db, [row.studentId], todayKst());
  // 이미 다른 요일에 타고 있으면 그 아이의 기준 위치가 따로 있다 — 덮어쓰지 않는다.
  if (cells.length > 0) return;
  for (const direction of ["PICKUP", "DROPOFF"] as const) {
    if (!row.directions.includes(direction)) continue;
    const place = (direction === "PICKUP" ? row.pickupJson : row.dropoffJson) as RegularLocationInput | null;
    if (!place || typeof place.latitude !== "number" || typeof place.longitude !== "number") continue;
    await upsertStudentShuttleLocation(prisma, {
      studentId: row.studentId, kind: direction, name: place.name, address: place.address, roadAddress: place.roadAddress,
      latitude: place.latitude, longitude: place.longitude, placeId: place.placeId, source: place.source,
      accuracyMeters: place.accuracyMeters, confirmedAt: new Date(), consentVersion: SHUTTLE_LOCATION_CONSENT_VERSION,
    });
  }
}

async function notifyParentOfRegularChange(input: {
  requestId: string; studentId: string; recipientUserId: string; studentName: string;
  approved: boolean; effectiveFrom: string; note: string | null; summary: string;
}) {
  try {
    const access = await prisma.$queryRawUnsafe<{ id: string }[]>(
      `SELECT s.id FROM "Student" s WHERE s.id = $1 AND ${await childAccessSql("s", "$2")} AND ${notMergedStudent("s")} LIMIT 1`,
      input.studentId, input.recipientUserId,
    );
    if (access.length !== 1) return;
    const { deliverOperationalNotification } = await import("@/lib/operational-notification-delivery");
    const shortNote = input.note && input.note.length > 80 ? `${input.note.slice(0, 80)}…` : input.note;
    await deliverOperationalNotification({
      stableEventKey: `shuttle-regular-change:${input.requestId}:${input.approved ? "APPROVED" : "REJECTED"}`,
      eventType: "SHUTTLE_REGULAR_CHANGE",
      trigger: `SHUTTLE_REGULAR_CHANGE_${input.approved ? "APPROVED" : "REJECTED"}`,
      studentId: input.studentId,
      recipientUserId: input.recipientUserId,
      title: "셔틀 계속 바꾸기 신청 결과",
      message: input.approved
        ? `${input.studentName} ${input.summary} 신청이 승인됐어요(${koreanMonthDay(input.effectiveFrom)}부터)`
        : `${input.studentName} ${input.summary} 신청이 반려됐어요${shortNote ? `: ${shortNote}` : ""}`,
      linkUrl: "/mypage/shuttle/regular",
      audienceScope: "EXTERNAL",
    });
  } catch (error) {
    // 개인정보·원문 오류는 남기지 않는다(신청 id 만)
    console.error("[shuttle-regular-change] 학부모 앱 알림 실패", input.requestId, error instanceof Error ? error.name : "");
  }
}

export type DueRegularChangeSummary = { applied: number; waiting: number; appliedIds: string[] };

/**
 * 승인된 신청 중 적용 시작일이 된 것을 명단에 반영한다(매일 cron + 승인 직후).
 * - 위치 바꾸기(CHANGE): 관리자 학생 위치 저장과 같은 규칙(applyLocationToRosterInTx)으로 그 아이 칸의 정류장을 맞춘다.
 *   «모든 요일»이면 학생 위치(StudentShuttleLocation)도 새 위치로 — 다음에 명단을 다시 만들 때도 새 위치가 기준이 된다.
 *   요일을 골랐으면 그 요일 칸만 바꾸고 학생 위치는 그대로 둔다(다른 요일의 기준 위치다).
 * - 이용 시작·중단: 차량·순서를 정하거나 빼는 일은 원장이 명단 화면에서 한다. 여기서는 끝났는지만 확인해 닫는다.
 * 이미 반영한 건은 건너뛴다(신청 행 잠금 + status 조건) — 두 번 실행돼도 안전하다.
 */
export async function applyDueRegularChanges(options: { onlyId?: string } = {}): Promise<DueRegularChangeSummary> {
  const summary: DueRegularChangeSummary = { applied: 0, waiting: 0, appliedIds: [] };
  if (!(await regularChangeAvailable())) return summary;
  const due = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
    `SELECT id FROM ${TABLE}
      WHERE status = 'APPROVED' AND "appliedAt" IS NULL
        AND "effectiveFrom" <= (now() AT TIME ZONE 'Asia/Seoul')::date
        AND ($1::text IS NULL OR id = $1)
      ORDER BY "effectiveFrom", "createdAt" LIMIT 200`,
    options.onlyId ?? null,
  );
  for (const candidate of due) {
    try {
      const outcome = await prisma.$transaction(async (tx) => {
        // 명단 잠금을 트랜잭션 첫 쿼리로(관리자 위치 저장과 같은 순서 — 잠금을 기다리는 동안 커밋된 명단 행까지 본다)
        const lockedLaterMonths = await lockRosterForLocationInTx(tx);
        const rows = await tx.$queryRawUnsafe<any[]>(
          `SELECT id, "studentId", kind, directions, weekdays, "pickupJson", "dropoffJson", "decidedByUserId",
                  to_char("effectiveFrom",'YYYY-MM-DD') AS "effectiveFrom"
             FROM ${TABLE} WHERE id = $1 AND status = 'APPROVED' AND "appliedAt" IS NULL FOR UPDATE`,
          candidate.id,
        );
        const row = rows[0];
        if (!row) return { state: "SKIPPED" as const, notices: [] };
        const today = todayKst();
        const weekdays: number[] | null = Array.isArray(row.weekdays) && row.weekdays.length > 0 ? row.weekdays.map(Number) : null;
        const directions: RegularChangeDirection[] = (row.directions ?? []).filter((d: string) => d === "PICKUP" || d === "DROPOFF");
        const cells = await readRosterCells(tx as unknown as Db, [row.studentId], today);
        const plan = planRegularChangeApply({
          kind: row.kind, effectiveFrom: row.effectiveFrom, today, directions, weekdays,
          roster: cells.map((c) => ({ weekday: c.weekday, direction: toDirection(c.direction) })),
        });
        if (plan.action === "WAIT" || plan.action === "KEEP_OPEN") return { state: "WAITING" as const, notices: [] };

        const result: Record<string, unknown> = { action: plan.action };
        const notices = [];
        if (plan.action === "APPLY_LOCATION") {
          const months: unknown[] = [];
          for (const direction of directions) {
            const place = (direction === "PICKUP" ? row.pickupJson : row.dropoffJson) as RegularLocationInput | null;
            if (!place || typeof place.latitude !== "number" || typeof place.longitude !== "number" || !place.name) continue;
            if (!weekdays) {
              // 모든 요일 = 그 아이의 기준 위치가 바뀐 것 → 학생 위치도 같은 트랜잭션에서 새 위치로
              await upsertStudentShuttleLocation(tx, {
                studentId: row.studentId, kind: direction, name: place.name, address: place.address, roadAddress: place.roadAddress,
                latitude: place.latitude, longitude: place.longitude, placeId: place.placeId, source: place.source,
                accuracyMeters: place.accuracyMeters, confirmedAt: new Date(), consentVersion: SHUTTLE_LOCATION_CONSENT_VERSION,
              });
            }
            const roster = await applyLocationToRosterInTx(
              tx, row.decidedByUserId ?? null,
              { studentId: row.studentId, kind: direction, name: place.name, latitude: place.latitude, longitude: place.longitude },
              undefined, lockedLaterMonths, weekdays ?? undefined,
            );
            notices.push(...roster.notices);
            months.push({ direction: ROSTER_DIRECTION[direction], updated: roster.updated, appliedMonths: roster.appliedMonths });
          }
          result.months = months;
        }
        const marked = await tx.$executeRawUnsafe(
          `UPDATE ${TABLE} SET status = 'APPLIED', "appliedAt" = now(), "applyResultJson" = $2::jsonb, "updatedAt" = now()
            WHERE id = $1 AND status = 'APPROVED' AND "appliedAt" IS NULL`,
          row.id, JSON.stringify(result),
        );
        if (Number(marked) !== 1) throw new Error("SHUTTLE_REGULAR_CHANGE_CONFLICT");
        return { state: "APPLIED" as const, notices };
        // ReadCommitted: 잠금 뒤 쿼리마다 최신 커밋을 본다(관리자 위치 저장 updateStudentShuttleLocation 과 같은 이유)
      }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
      if (outcome.state === "APPLIED") {
        summary.applied += 1;
        summary.appliedIds.push(candidate.id);
        // 기사님 알림은 커밋 뒤에(실패해도 반영은 그대로) — 명단을 손으로 고쳤을 때와 같은 알림
        await flushRosterNotices(outcome.notices).catch(() => undefined);
      } else if (outcome.state === "WAITING") summary.waiting += 1;
    } catch (error) {
      // 한 건이 실패해도 나머지는 계속한다. 실패한 건은 APPROVED 로 남아 다음 실행에서 다시 시도된다.
      console.error("[shuttle-regular-change] 적용 실패", candidate.id, error instanceof Error ? error.name : "");
    }
  }
  return summary;
}

/** 종류 이름(원장 화면 표시용) */
export function regularChangeKindLabel(kind: string): string {
  return REGULAR_CHANGE_KIND_LABEL[kind as RegularChangeKind] ?? "셔틀 신청";
}
