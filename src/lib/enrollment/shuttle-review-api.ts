import { NextResponse } from "next/server";
import { ShuttleReviewError } from "./shuttle-review";

export function shuttleReviewErrorResponse(error: unknown) {
  if (error instanceof ShuttleReviewError) return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
  const value = error as { code?: string; meta?: { code?: string } };
  if (value?.code === "42P01" || value?.meta?.code === "42P01") return NextResponse.json({ error: "셔틀 검토 기능을 준비 중입니다. 잠시 후 다시 확인해 주세요.", code: "SHUTTLE_REVIEW_UNAVAILABLE" }, { status: 503 });
  if (["40001", "40P01", "23505", "P2034"].includes(value?.code ?? "") || ["40001", "40P01", "23505"].includes(value?.meta?.code ?? "")) return NextResponse.json({ error: "다른 변경이 먼저 저장됐습니다. 새로 확인한 뒤 다시 시도해 주세요.", code: "SHUTTLE_REVIEW_CONFLICT" }, { status: 409 });
  return NextResponse.json({ error: "셔틀 검토 정보를 처리하지 못했습니다. 다시 시도해 주세요.", code: "SHUTTLE_REVIEW_FAILED" }, { status: 500 });
}
export async function shuttleReviewBody(request: Request): Promise<Record<string, unknown>> {
  if (request.headers.get("origin") !== new URL(request.url).origin) throw new ShuttleReviewError("같은 사이트에서 다시 시도해 주세요.", 403, "SHUTTLE_REVIEW_ORIGIN_REQUIRED");
  if (!request.headers.get("content-type")?.includes("application/json")) throw new ShuttleReviewError("요청 형식을 확인해 주세요.");
  const text = await request.text();
  if (text.length > 16_384) throw new ShuttleReviewError("입력 내용이 너무 깁니다.");
  let body: unknown;
  try { body = JSON.parse(text); } catch { throw new ShuttleReviewError("요청 내용을 확인해 주세요."); }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new ShuttleReviewError("요청 내용을 확인해 주세요.");
  return body as Record<string, unknown>;
}
