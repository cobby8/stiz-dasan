import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { assertMobileSchema, hashSecret, locationInput, lockTrackingToken, mobileTrackingEnabled, MobileTrackingError, SECRET, secretMatches, SESSION_LIFETIME_MS, UUID, type MobileSession } from "@/lib/shuttle/mobileTracking";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const reply = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

export async function POST(request: Request) {
  if (!mobileTrackingEnabled()) return reply({ error: "MOBILE_TRACKING_DISABLED" }, 503);
  try {
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || typeof body.sessionId !== "string" || !UUID.test(body.sessionId)) return reply({ error: "INVALID_SESSION" }, 400);
    const id = body.sessionId;
    const action = body.action;
    if (!["start", "location", "stop", "status"].includes(String(action))) return reply({ error: "INVALID_ACTION" }, 400);
    const secret = action === "start" ? body.secret : request.headers.get("authorization")?.match(/^Bearer ([0-9a-f]{64})$/i)?.[1];
    if (typeof secret !== "string" || !SECRET.test(secret)) return reply({ error: "INVALID_CREDENTIAL" }, 403);
    return await prisma.$transaction(async (db) => {
      await assertMobileSchema(db);
      let token: string;
      if (action === "start") {
        if (typeof body.token !== "string" || body.token.length > 500 || typeof body.deviceId !== "string" || !UUID.test(body.deviceId)) throw new MobileTrackingError(400, "INVALID_START");
        token = body.token;
      } else {
        const sessions = await db.$queryRawUnsafe<MobileSession[]>(`SELECT * FROM "DriverMobileTrackingSession" WHERE id=$1::uuid`, id);
        if (!sessions[0] || !secretMatches(secret, sessions[0].secretHash)) throw new MobileTrackingError(403, "INVALID_CREDENTIAL");
        token = sessions[0].token;
      }
      await lockTrackingToken(db, token);
      // 삭제된 운행 링크는 기존 앱 세션이 있어도 쓸 수 없다. 공유 잠금으로 동시 삭제와도 순서를 맞춘다.
      const links = await db.$queryRawUnsafe<{ id: string }[]>(`SELECT id FROM "ShuttleRunLink" WHERE token=$1 FOR KEY SHARE`, token);
      if (!links.length) throw new MobileTrackingError(403, "RUN_REVOKED");
      await db.$executeRawUnsafe(`UPDATE "DriverMobileTrackingSession" SET state='EXPIRED' WHERE token=$1 AND state='ACTIVE' AND "expiresAt"<=now()`, token);
      const rows = await db.$queryRawUnsafe<MobileSession[]>(`SELECT * FROM "DriverMobileTrackingSession" WHERE id=$1::uuid FOR UPDATE`, id);
      let session = rows[0];
      const now = Date.now();
      if (action === "start") {
        if (session) {
          if (session.token !== token || session.deviceId !== body.deviceId || !secretMatches(secret, session.secretHash)) throw new MobileTrackingError(409, "SESSION_CONFLICT");
          if (session.state !== "ACTIVE" || new Date(session.expiresAt).getTime() <= now) throw new MobileTrackingError(409, "SESSION_ENDED");
        } else {
          const active = await db.$queryRawUnsafe<{ id: string }[]>(`SELECT id FROM "DriverMobileTrackingSession" WHERE token=$1 AND state='ACTIVE' LIMIT 1`, token);
          if (active.length) throw new MobileTrackingError(409, "RUN_ALREADY_ACTIVE");
          const expiresAt = new Date(now + SESSION_LIFETIME_MS);
          const created = await db.$queryRawUnsafe<MobileSession[]>(`INSERT INTO "DriverMobileTrackingSession" (id,token,"secretHash","deviceId","expiresAt") VALUES ($1::uuid,$2,$3,$4::uuid,$5) RETURNING *`, id, token, hashSecret(secret), body.deviceId, expiresAt);
          session = created[0];
          // 이전 운행의 마지막 위치를 새 운행의 현재 위치처럼 표시하지 않는다.
          await db.$executeRawUnsafe(`UPDATE "DriverLocation" SET sharing=false WHERE token=$1`, token);
        }
        return reply({ ok: true, sessionId: id, expiresAt: new Date(session.expiresAt).toISOString(), lastSequence: session.lastSequence });
      }
      if (!session || !secretMatches(secret, session.secretHash)) throw new MobileTrackingError(403, "INVALID_CREDENTIAL");
      const state = new Date(session.expiresAt).getTime() <= now && session.state === "ACTIVE" ? "EXPIRED" : session.state;
      if (action === "status") return reply({ ok: true, state, lastSentAt: session.lastSentAt, capturedAt: session.capturedAt, accuracy: session.accuracy, expiresAt: session.expiresAt, lastSequence: session.lastSequence });
      if (action === "stop") {
        await db.$executeRawUnsafe(`UPDATE "DriverMobileTrackingSession" SET state='STOPPED',"stoppedAt"=COALESCE("stoppedAt",now()) WHERE id=$1::uuid AND state='ACTIVE'`, id);
        // 다른 새 운행이 시작된 뒤 옛 stop 재시도가 새 위치를 끄지 못하게 한다.
        if (session.state === "ACTIVE") {
          await db.$executeRawUnsafe(`UPDATE "DriverLocation" SET sharing=false WHERE token=$1`, token);
        } else if (session.state === "EXPIRED") {
          // 만료 직후의 마지막 위치도 종료한다. 새 운행이 이미 시작됐다면 그 위치는 보존한다.
          await db.$executeRawUnsafe(`UPDATE "DriverLocation" SET sharing=false WHERE token=$1 AND NOT EXISTS (SELECT 1 FROM "DriverMobileTrackingSession" WHERE token=$1 AND state='ACTIVE')`, token);
        }
        return reply({ ok: true, state: state === "EXPIRED" ? "EXPIRED" : "STOPPED" });
      }
      if (state !== "ACTIVE") throw new MobileTrackingError(409, "SESSION_ENDED");
      const location = locationInput(body, now);
      if (location.sequence <= session.lastSequence || (session.capturedAt && location.capturedAt.getTime() <= new Date(session.capturedAt).getTime())) throw new MobileTrackingError(409, "LOCATION_OUT_OF_ORDER");
      await db.$executeRawUnsafe(`INSERT INTO "DriverLocation" (token,latitude,longitude,accuracy,speed,heading,sharing,"updatedAt") VALUES ($1,$2,$3,$4,$5,$6,true,now()) ON CONFLICT (token) DO UPDATE SET latitude=$2,longitude=$3,accuracy=$4,speed=$5,heading=$6,sharing=true,"updatedAt"=now()`, token, location.lat, location.lng, location.accuracy, location.speed, location.heading);
      const accepted = await db.$queryRawUnsafe<{ lastSentAt: Date }[]>(`UPDATE "DriverMobileTrackingSession" SET "lastSequence"=$2,"capturedAt"=$3,"accuracy"=$4,"lastSentAt"=now() WHERE id=$1::uuid RETURNING "lastSentAt"`, id, location.sequence, location.capturedAt, location.accuracy);
      return reply({ ok: true, state: "ACTIVE", sequence: location.sequence, lastSentAt: accepted[0].lastSentAt });
    });
  } catch (error) {
    if (error instanceof MobileTrackingError) return reply({ error: error.code }, error.status);
    // 스키마 준비 실패도 위치 저장 성공으로 숨기지 않는다. 비밀값/요청은 로그에 남기지 않는다.
    return reply({ error: "MOBILE_TRACKING_UNAVAILABLE" }, 503);
  }
}
