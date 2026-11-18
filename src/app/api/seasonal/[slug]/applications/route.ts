import { NextResponse } from "next/server";
import { parseApplicationInput, SeasonalError } from "@/lib/seasonal/contracts";
import { submitSeasonalApplication } from "@/lib/seasonal/service";
import { clientIpKey, hashSensitiveRateLimitKey, takePublicRateLimit } from "@/lib/seasonal/public-rate-limit";

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 64 * 1024;
const RATE_WINDOW_MS = 10 * 60 * 1000;

function rateLimited(retryAfterSeconds: number) {
  return NextResponse.json(
    { error: "신청 요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.", code: "RATE_LIMITED" },
    { status: 429, headers: { "Retry-After": String(retryAfterSeconds), "Cache-Control": "no-store" } },
  );
}

export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  try {
    const { slug } = await params;
    const ipKey = clientIpKey(request);
    // IP는 프록시/NAT 환경에서 공유되거나 신뢰도가 낮을 수 있어 보조적인 burst 방어로만 사용합니다.
    // 실제 신청 제한의 핵심은 아래의 정규화된 보호자 전화번호 해시입니다.
    const ipLimit = takePublicRateLimit(`seasonal:ip:${slug}:${ipKey}`, {
      limit: ipKey === "unknown" ? 300 : 120,
      windowMs: RATE_WINDOW_MS,
    });
    if (!ipLimit.allowed) return rateLimited(ipLimit.retryAfterSeconds);

    const declaredLength = Number(request.headers.get("content-length") || 0);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
      throw new SeasonalError("신청 내용이 너무 큽니다.", 413, "REQUEST_TOO_LARGE");
    }
    const rawBody = await request.text();
    if (new TextEncoder().encode(rawBody).byteLength > MAX_BODY_BYTES) {
      throw new SeasonalError("신청 내용이 너무 큽니다.", 413, "REQUEST_TOO_LARGE");
    }
    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch {
      throw new SeasonalError("신청 내용을 확인해 주세요.", 400, "INVALID_JSON");
    }
    const input = parseApplicationInput(body);
    const phoneLimit = takePublicRateLimit(
      `seasonal:phone:${slug}:${hashSensitiveRateLimitKey(input.parent.phone)}`,
      { limit: 8, windowMs: RATE_WINDOW_MS },
    );
    if (!phoneLimit.allowed) return rateLimited(phoneLimit.retryAfterSeconds);

    const result = await submitSeasonalApplication(slug, input);
    return NextResponse.json(result, { status: result.duplicate ? 200 : 201 });
  } catch (error) {
    // details = 화면이 쓸 추가 정보(예: DATES_FULL 의 { fullDates }) — 있을 때만 싣는다
    if (error instanceof SeasonalError) {
      return NextResponse.json(
        { error: error.message, code: error.code, ...(error.details !== undefined ? { details: error.details } : {}) },
        { status: error.status },
      );
    }
    console.error("[seasonal application]", error);
    return NextResponse.json({ error: "신청을 저장하지 못했습니다." }, { status: 500 });
  }
}
