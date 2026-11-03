import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth-guard";
import { koreaServiceMonth } from "@/lib/regular/serviceMonth";
import { assignShuttleReview, getShuttleIntakeDashboard } from "@/lib/enrollment/shuttle-review-query";
import { shuttleReviewBody, shuttleReviewErrorResponse } from "@/lib/enrollment/shuttle-review-api";

export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  let actor;
  try { actor = await requireAdmin(); } catch { return NextResponse.json({ error: "관리자 로그인이 필요합니다." }, { status: 401 }); }
  try { const params = new URL(request.url).searchParams; return NextResponse.json(await getShuttleIntakeDashboard(actor, params.get("month") ?? koreaServiceMonth(), true, undefined, params.get("page")), { headers: { "Cache-Control": "no-store" } }); }
  catch (error) { return shuttleReviewErrorResponse(error); }
}
export async function POST(request: Request) {
  let actor;
  try { actor = await requireAdmin(); } catch { return NextResponse.json({ error: "관리자 로그인이 필요합니다." }, { status: 401 }); }
  try { return NextResponse.json({ ok: true, ...await assignShuttleReview(actor, await shuttleReviewBody(request)) }, { headers: { "Cache-Control": "no-store" } }); }
  catch (error) { return shuttleReviewErrorResponse(error); }
}
