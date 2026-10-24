import { NextResponse } from "next/server";
import { getRegularLocationLink, RegularLocationLinkError, submitRegularLocations } from "@/lib/shuttle/regularLocationLink";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ token: string }> };
const PUBLIC_HEADERS = { "Cache-Control": "no-store, max-age=0", "X-Robots-Tag": "noindex, nofollow" };
function publicJson(body: unknown, init?: { status?: number }) {
  return NextResponse.json(body, { ...init, headers: PUBLIC_HEADERS });
}

function errorResponse(error: unknown) {
  if (error instanceof RegularLocationLinkError) {
    const status = ["EXPIRED", "REVOKED", "LINK_INACTIVE"].includes(error.code) ? error.code === "EXPIRED" ? "EXPIRED" : "REVOKED" : "INVALID";
    return publicJson({ status, error: error.message, code: error.code }, { status: error.status });
  }
  console.error("[regular shuttle location link]", error);
  return publicJson({ status: "INVALID", error: "위치 요청을 처리하지 못했습니다." }, { status: 500 });
}

export async function GET(_request: Request, context: Context) {
  try {
    const { token } = await context.params;
    return publicJson(await getRegularLocationLink(token));
  } catch (error) { return errorResponse(error); }
}

export async function POST(request: Request, context: Context) {
  try {
    const { token } = await context.params;
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new RegularLocationLinkError("위치 요청 형식이 올바르지 않습니다.", 400, "INVALID_REQUEST");
    return publicJson(await submitRegularLocations(token, body as Record<string, unknown>));
  } catch (error) { return errorResponse(error); }
}
