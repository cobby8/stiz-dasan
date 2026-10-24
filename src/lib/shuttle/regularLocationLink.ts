import { createHash, randomBytes } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { SHUTTLE_LOCATION_CONSENT_VERSION } from "@/lib/seasonal/contracts";

export const REGULAR_LOCATION_PURPOSE = "REGULAR_SHUTTLE_LOCATION" as const;
const LOCATION_SOURCES = new Set(["MAP_PIN", "SEARCH", "CURRENT_LOCATION"]);

export class RegularLocationLinkError extends Error {
  constructor(message: string, public status: number, public code: string) { super(message); }
}

type StoredLocation = {
  kind: "PICKUP" | "DROPOFF"; name: string | null; address: string; roadAddress: string | null;
  latitude: number; longitude: number; placeId: string | null; source: string | null;
  accuracyMeters: number | null; confirmedAt: Date; note: string | null;
};
type ValidLink = { id: string; studentId: string; studentName: string; parentId: string; expiresAt: Date; revokedAt: Date | null };
type LocationDb = {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
  $transaction<T>(fn: (tx: LocationDb) => Promise<T>): Promise<T>;
};
const defaultDb = prisma as unknown as LocationDb;

function tokenHash(token: string) { return createHash("sha256").update(token).digest("hex"); }
function text(value: unknown, max: number) {
  if (value == null) return null;
  if (typeof value !== "string") throw new RegularLocationLinkError("위치 문자열 형식이 올바르지 않습니다.", 400, "INVALID_LOCATION");
  const normalized = value.trim();
  if (normalized.length > max) throw new RegularLocationLinkError("위치 정보가 너무 깁니다.", 400, "INVALID_LOCATION");
  return normalized || null;
}
function numberInRange(value: unknown, min: number, max: number, label: string) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new RegularLocationLinkError(`${label} 값이 올바르지 않습니다.`, 400, "INVALID_COORDINATE");
  }
  return value;
}

export type RegularLocationInput = {
  name: string | null; address: string; roadAddress: string | null; latitude: number; longitude: number;
  placeId: string | null; source: "MAP_PIN" | "SEARCH" | "CURRENT_LOCATION"; accuracyMeters: number | null; note: string | null;
};

export function validateRegularLocation(value: unknown): RegularLocationInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RegularLocationLinkError("위치 정보를 확인해 주세요.", 400, "INVALID_LOCATION");
  const raw = value as Record<string, unknown>;
  const latitude = numberInRange(raw.latitude, -90, 90, "위도");
  const longitude = numberInRange(raw.longitude, -180, 180, "경도");
  const address = text(raw.address, 300);
  const roadAddress = text(raw.roadAddress, 300);
  const name = text(raw.name, 150) ?? roadAddress ?? address;
  if (!address && !roadAddress && !name) throw new RegularLocationLinkError("위치 주소가 필요합니다.", 400, "ADDRESS_REQUIRED");
  const source = text(raw.source, 30);
  if (!source || !LOCATION_SOURCES.has(source)) throw new RegularLocationLinkError("위치 선택 방식을 확인해 주세요.", 400, "INVALID_SOURCE");
  const accuracyMeters = raw.accuracyMeters == null ? null : numberInRange(raw.accuracyMeters, 0, 100_000, "위치 정확도");
  return { name, address: address ?? roadAddress ?? name!, roadAddress, latitude, longitude, placeId: text(raw.placeId, 200), source: source as RegularLocationInput["source"], accuracyMeters, note: text(raw.note, 1000) };
}

function serializeLocations(rows: StoredLocation[]) {
  const serialized = (kind: StoredLocation["kind"]) => {
    const row = rows.find((item) => item.kind === kind);
    // note와 DB 내부 필드는 공개 링크 응답에 포함하지 않는다.
    return row ? {
      kind: row.kind, name: row.name, address: row.address, roadAddress: row.roadAddress,
      latitude: row.latitude, longitude: row.longitude, placeId: row.placeId, source: row.source,
      accuracyMeters: row.accuracyMeters, confirmedAt: row.confirmedAt.toISOString(),
    } : null;
  };
  return { PICKUP: serialized("PICKUP"), DROPOFF: serialized("DROPOFF") };
}

async function readLocations(client: LocationDb, studentId: string) {
  return client.$queryRawUnsafe<StoredLocation[]>(
    `SELECT kind,name,address,"roadAddress",latitude,longitude,"placeId",source,"accuracyMeters","confirmedAt",note
       FROM "StudentShuttleLocation" WHERE "studentId"=$1 AND kind IN ('PICKUP','DROPOFF') ORDER BY kind`, studentId,
  );
}

async function resolveLink(token: string, db: LocationDb = defaultDb): Promise<ValidLink> {
  if (!token || token.length > 200) throw new RegularLocationLinkError("올바르지 않은 링크입니다.", 404, "INVALID");
  const rows = await db.$queryRawUnsafe<ValidLink[]>(
    `SELECT l.id,l."studentId",s.name AS "studentName",l."parentId",l."expiresAt",l."revokedAt"
       FROM "RegularShuttleLocationLink" l JOIN "Student" s ON s.id=l."studentId" AND s."parentId"=l."parentId"
      WHERE l."tokenHash"=$1 AND l.purpose=$2 AND s."mergedIntoStudentId" IS NULL LIMIT 1`, tokenHash(token), REGULAR_LOCATION_PURPOSE,
  );
  const link = rows[0];
  if (!link) throw new RegularLocationLinkError("올바르지 않은 링크입니다.", 404, "INVALID");
  if (link.revokedAt) throw new RegularLocationLinkError("취소된 링크입니다.", 410, "REVOKED");
  if (link.expiresAt.getTime() <= Date.now()) throw new RegularLocationLinkError("사용 기간이 끝난 링크입니다.", 410, "EXPIRED");
  return link;
}

export async function createRegularLocationLink(studentId: string, createdByUserId: string, expiresInDays = 7) {
  if (!studentId) throw new RegularLocationLinkError("학생을 선택해 주세요.", 400, "STUDENT_REQUIRED");
  if (!Number.isInteger(expiresInDays) || expiresInDays < 1 || expiresInDays > 30) throw new RegularLocationLinkError("유효기간은 1~30일이어야 합니다.", 400, "INVALID_EXPIRY");
  const students = await prisma.$queryRawUnsafe<Array<{ id: string; name: string; parentId: string }>>(
    `SELECT id,name,"parentId" FROM "Student" WHERE id=$1 AND "mergedIntoStudentId" IS NULL LIMIT 1`, studentId,
  );
  const student = students[0];
  if (!student) throw new RegularLocationLinkError("학생을 찾을 수 없습니다.", 404, "STUDENT_NOT_FOUND");
  const token = randomBytes(32).toString("base64url");
  const id = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + expiresInDays * 86_400_000);
  await prisma.$transaction(async (tx) => {
    // 학생 행을 잠근 뒤 기존 활성 링크를 모두 취소해 한 학생에게 유효한 링크가 하나만 남게 한다.
    const locked = await tx.$queryRawUnsafe<Array<{ parentId: string }>>(
      `SELECT "parentId" FROM "Student" WHERE id=$1 AND "parentId"=$2 FOR UPDATE`, student.id, student.parentId,
    );
    if (!locked[0]) throw new RegularLocationLinkError("학생과 보호자 관계가 변경되었습니다.", 409, "PARENT_CHANGED");
    await tx.$executeRawUnsafe(
      `INSERT INTO "RegularShuttleLocationLinkAudit" (id,"linkId",action,"detailsJson")
       SELECT gen_random_uuid()::text,id,'LINK_REVOKED',$2::jsonb FROM "RegularShuttleLocationLink"
        WHERE "studentId"=$1 AND purpose=$3 AND "revokedAt" IS NULL AND "expiresAt">now()`,
      student.id, JSON.stringify({ reason: "REISSUED" }), REGULAR_LOCATION_PURPOSE,
    );
    await tx.$executeRawUnsafe(
      `UPDATE "RegularShuttleLocationLink" SET "revokedAt"=now(),"updatedAt"=now()
        WHERE "studentId"=$1 AND purpose=$2 AND "revokedAt" IS NULL AND "expiresAt">now()`, student.id, REGULAR_LOCATION_PURPOSE,
    );
    await tx.$executeRawUnsafe(
      `INSERT INTO "RegularShuttleLocationLink" (id,"studentId","parentId",purpose,"tokenHash","expiresAt","createdByUserId") VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      id, student.id, student.parentId, REGULAR_LOCATION_PURPOSE, tokenHash(token), expiresAt, createdByUserId,
    );
    await tx.$executeRawUnsafe(
      `INSERT INTO "RegularShuttleLocationLinkAudit" (id,"linkId",action,"detailsJson") VALUES ($1,$2,'LINK_CREATED',$3::jsonb)`,
      crypto.randomUUID(), id, JSON.stringify({ purpose: REGULAR_LOCATION_PURPOSE, expiresAt: expiresAt.toISOString() }),
    );
  });
  return { id, token, studentName: student.name, expiresAt: expiresAt.toISOString(), status: "ACTIVE" as const };
}

export async function revokeRegularLocationLink(linkId: string) {
  const changed = await prisma.$transaction(async (tx) => {
    const count = await tx.$executeRawUnsafe(
      `UPDATE "RegularShuttleLocationLink" SET "revokedAt"=now(),"updatedAt"=now()
        WHERE id=$1 AND purpose=$2 AND "revokedAt" IS NULL AND "expiresAt">now()`, linkId, REGULAR_LOCATION_PURPOSE,
    );
    if (count === 1) await tx.$executeRawUnsafe(`INSERT INTO "RegularShuttleLocationLinkAudit" (id,"linkId",action) VALUES ($1,$2,'LINK_REVOKED')`, crypto.randomUUID(), linkId);
    return count;
  });
  if (changed !== 1) throw new RegularLocationLinkError("사용 가능한 링크를 찾지 못했습니다.", 404, "LINK_NOT_FOUND");
}

export async function listRegularLocationLinks(studentId?: string) {
  const rows = await prisma.$queryRawUnsafe<Array<{
    id: string; studentId: string; studentName: string; expiresAt: Date; lastSubmittedAt: Date | null; revokedAt: Date | null; createdAt: Date;
  }>>(
    `SELECT l.id,l."studentId",s.name AS "studentName",l."expiresAt",l."lastSubmittedAt",l."revokedAt",l."createdAt"
       FROM "RegularShuttleLocationLink" l JOIN "Student" s ON s.id=l."studentId" AND s."parentId"=l."parentId"
      WHERE l.purpose=$1 AND ($2::text IS NULL OR l."studentId"=$2)
      ORDER BY l."createdAt" DESC LIMIT 200`, REGULAR_LOCATION_PURPOSE, studentId || null,
  );
  return rows.map((row) => ({
    id: row.id, studentId: row.studentId, studentName: row.studentName,
    status: row.revokedAt ? "REVOKED" : row.expiresAt.getTime() <= Date.now() ? "EXPIRED" : row.lastSubmittedAt ? "SUBMITTED" : "ACTIVE",
    expiresAt: row.expiresAt.toISOString(), lastSubmittedAt: row.lastSubmittedAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null, createdAt: row.createdAt.toISOString(),
  }));
}

export async function getRegularLocationLink(token: string) {
  const link = await resolveLink(token);
  const locations = await readLocations(defaultDb, link.studentId);
  return { status: "ACTIVE" as const, purpose: REGULAR_LOCATION_PURPOSE, studentName: link.studentName, expiresAt: link.expiresAt.toISOString(), locations: serializeLocations(locations) };
}

export async function submitRegularLocations(token: string, input: Record<string, unknown>, db: LocationDb = defaultDb) {
  if (input.purpose !== REGULAR_LOCATION_PURPOSE) throw new RegularLocationLinkError("이 링크의 용도와 맞지 않는 요청입니다.", 400, "PURPOSE_MISMATCH");
  if (input.consentVersion !== SHUTTLE_LOCATION_CONSENT_VERSION) throw new RegularLocationLinkError("최신 위치정보 동의를 확인해 주세요.", 400, "CONSENT_REQUIRED");
  const pickup = input.pickup == null ? null : validateRegularLocation(input.pickup);
  const dropoff = input.dropoff == null ? null : validateRegularLocation(input.dropoff);
  if (!pickup && !dropoff) throw new RegularLocationLinkError("승차 또는 하차 위치를 하나 이상 선택해 주세요.", 400, "LOCATION_REQUIRED");
  const link = await resolveLink(token, db);
  const payloadHash = createHash("sha256").update(JSON.stringify({ pickup, dropoff, consentVersion: SHUTTLE_LOCATION_CONSENT_VERSION })).digest("hex");
  const submittedAt = new Date();
  const rows = await db.$transaction(async (tx) => {
    // 저장 직전 다시 잠가 만료·취소된 링크가 경합 중 사용되는 것을 막는다.
    const claimed = await tx.$queryRawUnsafe<Array<{ id: string; lastPayloadHash: string | null }>>(
      `SELECT id,"lastPayloadHash" FROM "RegularShuttleLocationLink" WHERE id=$1 AND purpose=$2 AND "studentId"=$3 AND "parentId"=$4 AND "revokedAt" IS NULL AND "expiresAt">now() FOR UPDATE`,
      link.id, REGULAR_LOCATION_PURPOSE, link.studentId, link.parentId,
    );
    if (!claimed[0]) throw new RegularLocationLinkError("링크가 만료되었거나 취소되었습니다.", 410, "LINK_INACTIVE");
    // 네트워크 재시도는 같은 위치 행·감사 건수를 늘리지 않고 현재 서버값만 다시 돌려준다.
    if (claimed[0].lastPayloadHash === payloadHash) return readLocations(tx, link.studentId);
    for (const [kind, location] of [["PICKUP", pickup], ["DROPOFF", dropoff]] as const) {
      if (!location) continue;
      await tx.$executeRawUnsafe(
        `INSERT INTO "StudentShuttleLocation" ("studentId",kind,name,address,"roadAddress",latitude,longitude,"placeId",source,"accuracyMeters","confirmedAt","consentVersion",note,"createdAt","updatedAt")
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now(),$11,$12,now(),now())
         ON CONFLICT ("studentId",kind) DO UPDATE SET name=EXCLUDED.name,address=EXCLUDED.address,"roadAddress"=EXCLUDED."roadAddress",latitude=EXCLUDED.latitude,longitude=EXCLUDED.longitude,"placeId"=EXCLUDED."placeId",source=EXCLUDED.source,"accuracyMeters"=EXCLUDED."accuracyMeters","confirmedAt"=now(),"consentVersion"=EXCLUDED."consentVersion",note=EXCLUDED.note,"updatedAt"=now()`,
        link.studentId, kind, location.name, location.address, location.roadAddress, location.latitude, location.longitude,
        location.placeId, location.source, location.accuracyMeters, SHUTTLE_LOCATION_CONSENT_VERSION, location.note,
      );
    }
    await tx.$executeRawUnsafe(`UPDATE "RegularShuttleLocationLink" SET "lastSubmittedAt"=$2,"submissionCount"="submissionCount"+1,"lastPayloadHash"=$3,"updatedAt"=now() WHERE id=$1`, link.id, submittedAt, payloadHash);
    await tx.$executeRawUnsafe(
      `INSERT INTO "RegularShuttleLocationLinkAudit" (id,"linkId",action,"detailsJson") VALUES ($1,$2,'LOCATIONS_SUBMITTED',$3::jsonb)`,
      crypto.randomUUID(), link.id, JSON.stringify({ kinds: [pickup && "PICKUP", dropoff && "DROPOFF"].filter(Boolean), consentVersion: SHUTTLE_LOCATION_CONSENT_VERSION }),
    );
    return readLocations(tx, link.studentId);
  });
  return { ok: true as const, status: "ACTIVE" as const, studentName: link.studentName, expiresAt: link.expiresAt.toISOString(), locations: serializeLocations(rows), submittedAt: submittedAt.toISOString() };
}
