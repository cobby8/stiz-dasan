import { createHash, timingSafeEqual } from "node:crypto";
import type { Prisma } from "@prisma/client";

export type TrackingDb = Pick<Prisma.TransactionClient, "$queryRawUnsafe" | "$executeRawUnsafe">;
export class MobileTrackingError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}
export const mobileTrackingEnabled = () => process.env.DRIVER_MOBILE_TRACKING_ENABLED === "true";
export const SESSION_LIFETIME_MS = 12 * 60 * 60 * 1000;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const SECRET = /^[0-9a-f]{64}$/i;
export const hashSecret = (secret: string) => createHash("sha256").update(secret).digest("hex");
export function secretMatches(secret: string, hash: string) {
  return SECRET.test(secret) && /^[0-9a-f]{64}$/i.test(hash) && timingSafeEqual(Buffer.from(hashSecret(secret), "hex"), Buffer.from(hash, "hex"));
}
export async function lockTrackingToken(db: TrackingDb, token: string) {
  await db.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, `driver-mobile:${token}`);
}
export async function assertMobileSchema(db: TrackingDb) {
  const rows = await db.$queryRawUnsafe<{ ready: boolean }[]>(`SELECT to_regclass('public."DriverMobileTrackingSession"') IS NOT NULL AS ready`);
  if (!rows[0]?.ready) throw new MobileTrackingError(503, "MOBILE_TRACKING_SCHEMA_REQUIRED");
}
// 웹의 늦은 요청이 종료된 앱 운행을 되살리지 않도록 만료 전에는 앱 소유권을 유지한다.
export async function assertLegacyTrackingAllowed(db: TrackingDb, token: string) {
  await assertMobileSchema(db);
  await lockTrackingToken(db, token);
  const sessions = await db.$queryRawUnsafe<{ id: string }[]>(`SELECT id FROM "DriverMobileTrackingSession" WHERE token=$1 AND "expiresAt">now() LIMIT 1`, token);
  if (sessions.length) throw new MobileTrackingError(409, "NATIVE_TRACKING_OWNS_RUN");
}
export type MobileSession = {
  id: string; token: string; secretHash: string; deviceId: string;
  state: "ACTIVE" | "STOPPED" | "EXPIRED"; expiresAt: Date;
  lastSequence: number; capturedAt: Date | null; lastSentAt: Date | null; accuracy: number | null;
};
export function locationInput(body: Record<string, unknown>, now: number) {
  const { sequence, capturedAt, lat, lng, accuracy, speed, heading } = body;
  const time = typeof capturedAt === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(capturedAt) ? Date.parse(capturedAt) : NaN;
  if (!Number.isSafeInteger(sequence) || (sequence as number) < 1 || (sequence as number) > 2147483647 || !Number.isFinite(time) ||
    typeof lat !== "number" || !Number.isFinite(lat) || lat < -90 || lat > 90 ||
    typeof lng !== "number" || !Number.isFinite(lng) || lng < -180 || lng > 180 ||
    typeof accuracy !== "number" || !Number.isFinite(accuracy) || accuracy < 0 ||
    (speed != null && (typeof speed !== "number" || !Number.isFinite(speed) || speed < 0)) ||
    (heading != null && (typeof heading !== "number" || !Number.isFinite(heading) || heading < 0 || heading >= 360))) {
    throw new MobileTrackingError(400, "INVALID_LOCATION");
  }
  if (now - time > 30_000 || time - now > 5_000) throw new MobileTrackingError(409, "LOCATION_NOT_FRESH");
  return { sequence: sequence as number, capturedAt: new Date(time), lat, lng, accuracy, speed: speed ?? null, heading: heading ?? null };
}
