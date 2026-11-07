/**
 * POS 플러그인 API 공용 — 인증·CORS·오류 응답을 한 곳에서 (라우트 4개가 같이 쓴다)
 * 계약(경로·요청·응답): docs/toss-pos-plugin-plan.md «8. 플러그인 API 계약»
 */

import { NextResponse } from "next/server";
import { authenticatePosPlugin, pluginError, withCors, type PosPluginAuth } from "./pluginAuth";
import { ChargeRequestError, type ChargeErrorCode } from "./chargeRequestService";

/** 실패 사유 → HTTP 상태 */
const STATUS_OF: Record<ChargeErrorCode, number> = {
    NOT_FOUND: 404,
    NOT_ELIGIBLE: 409,
    ALREADY_OPEN: 409,
    NOT_CLAIMABLE: 409,
    CHANGED: 409,
    CODE_EXHAUSTED: 503,
};

/**
 * 인증 → 처리 → CORS 헤더. 처리 중 ChargeRequestError 는 계약된 오류 모양으로,
 * 그 밖의 오류는 500 + 짧은 한국어(내부 문구·SQL 은 내보내지 않는다).
 */
export async function handlePluginRequest(
    req: Request,
    run: (auth: PosPluginAuth) => Promise<NextResponse>,
): Promise<NextResponse> {
    const authed = await authenticatePosPlugin(req);
    if (authed.response) return withCors(req, authed.response);
    try {
        return withCors(req, await run(authed.auth));
    } catch (error) {
        if (error instanceof ChargeRequestError) {
            return withCors(req, pluginError(STATUS_OF[error.code] ?? 409, error.code, error.message));
        }
        console.error("[pos-plugin] 처리 실패:", String((error as Error)?.message ?? error).slice(0, 300));
        return withCors(req, pluginError(500, "SERVER_ERROR", "서버에서 처리하지 못했습니다. 잠시 후 다시 시도해 주세요."));
    }
}

/** 본문 JSON 읽기(64KB 넘으면 거부). 못 읽으면 빈 객체. */
export async function readJsonBody(req: Request): Promise<Record<string, unknown>> {
    const text = await req.text();
    if (text.length > 64_000) return {};
    try {
        const parsed = JSON.parse(text) as unknown;
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    } catch {
        return {};
    }
}
