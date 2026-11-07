/**
 * POS 플러그인 → 우리 서버 인증 (매장 토큰)
 *
 * ■ 규칙 (docs/toss-pos-plugin-plan.md 3장)
 *   - 토큰은 32바이트 무작위. 서버에는 **SHA-256 해시만** 저장한다(원문은 발급 화면에서 한 번만 보여 준다).
 *   - 헤더 `Authorization: Bearer <토큰>`. 비교는 timingSafeEqual(글자별 시간 차로 추측하지 못하게).
 *   - 회전: 새로 발급하면 «직전에 쓰던 토큰 1개»만 남기고 나머지는 끊는다 → 동시에 최대 2개 유효(끊김 없이 교체).
 *   - 남용 제한: 토큰당 분당 60회, 인증 실패는 접속 주소당 분당 10회(인스턴스 메모리 기준).
 *   - 이 토큰으로는 납부 처리를 **할 수 없다**(그런 API 가 없다). 납부 근거는 토스 웹훅 + 재조회뿐.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { clientIpKey, hashSensitiveRateLimitKey, takePublicRateLimit } from "@/lib/seasonal/public-rate-limit";

/** 토큰 앞머리 — 로그·화면에서 «이게 POS 토큰»임을 알아보게 */
export const POS_TOKEN_PREFIX = "stizpos_";
/** 동시에 유효한 토큰 최대 개수(회전 중 끊김 방지) */
export const MAX_ACTIVE_POS_TOKENS = 2;
export const TOKEN_RATE_LIMIT = { limit: 60, windowMs: 60_000 };
export const AUTH_FAIL_RATE_LIMIT = { limit: 10, windowMs: 60_000 };

export function hashPosToken(token: string): string {
    return createHash("sha256").update(token, "utf8").digest("hex");
}

/** 새 토큰 원문 + 저장용 해시·앞글자 */
export function generatePosToken(): { token: string; hash: string; prefix: string } {
    const token = `${POS_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
    return { token, hash: hashPosToken(token), prefix: token.slice(0, POS_TOKEN_PREFIX.length + 4) };
}

/** 헤더에서 토큰 꺼내기. 형식이 아니면 null. */
export function readBearerToken(header: string | null): string | null {
    const match = /^Bearer\s+(\S+)$/i.exec(String(header ?? "").trim());
    if (!match) return null;
    const token = match[1];
    // 형식이 다르면 DB 를 보지도 않는다(길이 상한으로 큰 값 해시 낭비도 막는다).
    if (!token.startsWith(POS_TOKEN_PREFIX) || token.length > 120) return null;
    return token;
}

/** 해시 두 개 같은지(상수 시간). 길이가 다르면 바로 false. */
export function sameHash(a: string, b: string): boolean {
    const x = Buffer.from(a, "utf8");
    const y = Buffer.from(b, "utf8");
    return x.length === y.length && timingSafeEqual(x, y);
}

export type PosPluginAuth = { tokenId: string };

/** 실패 응답(본문 모양은 docs 의 API 계약 그대로) */
export function pluginError(status: number, error: string, message: string, extra: Record<string, unknown> = {}) {
    return NextResponse.json({ ok: false, error, message, ...extra }, { status, headers: { "Cache-Control": "no-store" } });
}

export function pluginOk(body: Record<string, unknown>) {
    return NextResponse.json({ ok: true, ...body }, { headers: { "Cache-Control": "no-store" } });
}

/**
 * 요청 인증 + 남용 제한. 통과하면 { auth }, 아니면 { response }(그대로 돌려주면 된다).
 * 토큰 원문은 로그에 남기지 않는다.
 */
export async function authenticatePosPlugin(req: Request): Promise<{ auth: PosPluginAuth; response?: undefined } | { auth?: undefined; response: NextResponse }> {
    const ipKey = `pos-plugin-fail:${hashSensitiveRateLimitKey(clientIpKey(req))}`;
    const fail = (message: string) => {
        const limited = takePublicRateLimit(ipKey, AUTH_FAIL_RATE_LIMIT);
        if (!limited.allowed) {
            return pluginError(429, "RATE_LIMITED", "요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.", { retryAfterSeconds: limited.retryAfterSeconds });
        }
        return pluginError(401, "UNAUTHORIZED", message);
    };

    const token = readBearerToken(req.headers.get("authorization"));
    if (!token) return { response: fail("매장 토큰이 없거나 형식이 다릅니다.") };

    const hash = hashPosToken(token);
    // 유효한 토큰은 최대 2개라 전부 읽어 상수 시간으로 비교한다.
    const rows = await prisma.$queryRawUnsafe<{ id: string; tokenHash: string }[]>(
        `SELECT id, "tokenHash" FROM "PosPluginToken" WHERE "revokedAt" IS NULL ORDER BY "createdAt" DESC LIMIT 10`,
    );
    const hit = rows.find((r) => sameHash(r.tokenHash, hash));
    if (!hit) return { response: fail("매장 토큰이 맞지 않거나 끊겼습니다.") };

    const limited = takePublicRateLimit(`pos-plugin-token:${hit.id}`, TOKEN_RATE_LIMIT);
    if (!limited.allowed) {
        return { response: pluginError(429, "RATE_LIMITED", "요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.", { retryAfterSeconds: limited.retryAfterSeconds }) };
    }
    // 마지막 사용 시각(1분에 한 번만 써서 쓰기 부담을 줄인다). 실패해도 인증은 통과.
    prisma
        .$executeRawUnsafe(
            `UPDATE "PosPluginToken" SET "lastUsedAt" = now()
              WHERE id = $1 AND ("lastUsedAt" IS NULL OR "lastUsedAt" < now() - interval '1 minute')`,
            hit.id,
        )
        .catch(() => undefined);
    return { auth: { tokenId: hit.id } };
}

/**
 * CORS — 문서로 확인한 플러그인 출처만 허용(환경변수 POS_PLUGIN_ALLOWED_ORIGINS, 쉼표 구분).
 * 목록에 없거나 Origin 이 없으면(서버 간 호출) 허용 헤더를 붙이지 않는다.
 */
export function corsHeaders(req: Request): Record<string, string> {
    const origin = req.headers.get("origin");
    const allowed = String(process.env.POS_PLUGIN_ALLOWED_ORIGINS ?? "")
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean);
    if (!origin || !allowed.includes(origin)) return {};
    return {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Authorization, Content-Type",
        "Access-Control-Max-Age": "600",
        Vary: "Origin",
    };
}

/** 응답에 CORS 헤더를 덧붙인다. */
export function withCors(req: Request, res: NextResponse): NextResponse {
    for (const [k, v] of Object.entries(corsHeaders(req))) res.headers.set(k, v);
    return res;
}

export function preflight(req: Request): NextResponse {
    return new NextResponse(null, { status: 204, headers: corsHeaders(req) });
}

// ───────────────────────────── 토큰 관리(관리자 화면 «POS 연결») ─────────────────────────────

export type PosPluginTokenRow = {
    id: string;
    tokenPrefix: string;
    label: string;
    createdKst: string;
    lastUsedKst: string | null;
    revokedKst: string | null;
    active: boolean;
};

/** 토큰 목록(해시는 내보내지 않는다). 시각은 timestamptz → KST 한 번만. */
export async function listPosPluginTokens(): Promise<PosPluginTokenRow[]> {
    return prisma.$queryRawUnsafe<PosPluginTokenRow[]>(
        `SELECT id, "tokenPrefix", label,
                to_char("createdAt" AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD HH24:MI') AS "createdKst",
                to_char("lastUsedAt" AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD HH24:MI') AS "lastUsedKst",
                to_char("revokedAt" AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD HH24:MI') AS "revokedKst",
                ("revokedAt" IS NULL) AS active
           FROM "PosPluginToken"
          ORDER BY ("revokedAt" IS NULL) DESC, "createdAt" DESC
          LIMIT 20`,
    );
}

/**
 * 새 토큰 발급 = 회전. 새 토큰 + 직전 토큰 1개만 살리고 나머지는 끊는다(동시에 최대 2개).
 * 원문은 이 반환값으로 **한 번만** 화면에 보여 주고 어디에도 저장하지 않는다.
 */
export async function issuePosPluginToken(input: { label: string; adminUserId: string }): Promise<{ token: string; revokedCount: number }> {
    const label = String(input.label ?? "").trim().slice(0, 60) || "POS";
    const { token, hash, prefix } = generatePosToken();
    await prisma.$executeRawUnsafe(
        `INSERT INTO "PosPluginToken" ("tokenHash", "tokenPrefix", label, "createdByUserId") VALUES ($1, $2, $3, $4)`,
        hash,
        prefix,
        label,
        input.adminUserId,
    );
    const revoked = await prisma.$queryRawUnsafe<{ id: string }[]>(
        `UPDATE "PosPluginToken" SET "revokedAt" = now(), "revokedByUserId" = $1
          WHERE "revokedAt" IS NULL
            AND id NOT IN (SELECT id FROM "PosPluginToken" WHERE "revokedAt" IS NULL ORDER BY "createdAt" DESC LIMIT $2::int)
          RETURNING id`,
        input.adminUserId,
        MAX_ACTIVE_POS_TOKENS,
    );
    return { token, revokedCount: revoked.length };
}

/** 토큰 끊기(유출 의심·옛 토큰 정리). 바로 효력 — 인증은 매번 DB 를 본다. */
export async function revokePosPluginToken(input: { tokenId: string; adminUserId: string }): Promise<boolean> {
    const rows = await prisma.$queryRawUnsafe<{ id: string }[]>(
        `UPDATE "PosPluginToken" SET "revokedAt" = now(), "revokedByUserId" = $2
          WHERE id = $1 AND "revokedAt" IS NULL RETURNING id`,
        input.tokenId,
        input.adminUserId,
    );
    return rows.length > 0;
}
