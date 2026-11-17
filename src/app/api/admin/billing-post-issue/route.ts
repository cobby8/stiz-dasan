/**
 * 청구 준비 «승인 대기» 세 번째 묶음 «발행 뒤 바뀐 청구»(2026-11-17).
 * GET  = 목록(퇴원·반 이동과 어긋난 미납 청구 + 결제된 청구 안내 + 반 변경 차감 제안)
 * POST = { action: "APPROVE", key, kind, paymentId, currentAmount, proposedAmount } 한 줄 승인(취소·금액 변경)
 *        { action: "DISMISS", key } 다시 안 뜨게 기록
 * 원장(ADMIN)만 — requireOwner 가 부원장을 거절한다. 쓰기는 청구 준비와 같은 스위치(STIZ_BILLING_WORKBENCH_WRITES_ENABLED).
 * 학부모 알림·문자는 보내지 않는다.
 */
import { NextRequest, NextResponse } from "next/server";
import { revalidatePath, revalidateTag } from "next/cache";
import { requireOwner } from "@/lib/auth-guard";
import { prisma } from "@/lib/prisma";
import { WorkbenchError } from "@/lib/billing/workbench";
import { loadWorkbenchCalendar } from "@/lib/billing/workbench-calendar";
import { getMonthlyClassDates } from "@/lib/enrollment/monthlyClassDates";
import { POST_ISSUE_SINCE_MONTH } from "@/lib/billing/post-issue-rules";
import { approvePostIssueChange, dismissPostIssueChange, readPostIssueView, type ClassDatesFor, type PostIssueDb } from "@/lib/billing/post-issue-service";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store, max-age=0" };
const enabled = () => process.env.STIZ_BILLING_WORKBENCH_WRITES_ENABLED === "true";
const db = prisma as unknown as PostIssueDb;
const fail = (e: unknown) => {
  if (!(e instanceof WorkbenchError)) console.error("[billing-post-issue] 처리 실패", e instanceof Error ? e.name : "");
  return NextResponse.json({ error: e instanceof WorkbenchError ? e.message : "발행 뒤 바뀐 청구를 처리하지 못했습니다. 다시 조회해 주세요.", refreshRequired: e instanceof WorkbenchError ? e.refreshRequired : false },
    { status: e instanceof WorkbenchError ? e.status : 500, headers });
};

/** 연간 계획표 수업일 — 못 읽으면 null(반 변경 차액 줄만 «확인 필요»가 되고 나머지는 그대로 보인다) */
async function classDatesFor(): Promise<ClassDatesFor | null> {
  const calendar = await loadWorkbenchCalendar().catch(() => null);
  return calendar ? (ym, dow) => getMonthlyClassDates(calendar.events, ym, dow) : null;
}

const readView = async () => readPostIssueView(db, { classDatesFor: await classDatesFor(), writesEnabled: enabled(), sinceYmd: `${POST_ISSUE_SINCE_MONTH}-01` });

export async function GET() {
  try { await requireOwner(); } catch { return NextResponse.json({ error: "원장 권한이 필요합니다." }, { status: 403, headers }); }
  try { return NextResponse.json(await readView(), { headers }); } catch (e) { return fail(e); }
}

export async function POST(request: NextRequest) {
  let admin; try { admin = await requireOwner(); } catch { return NextResponse.json({ error: "원장 권한이 필요합니다." }, { status: 403, headers }); }
  try {
    if (!enabled()) throw new WorkbenchError("청구 준비 저장은 운영 적용 승인 전까지 잠겨 있습니다.", 503);
    // 다른 사이트에서 보낸 요청 거절(청구 준비 저장과 같은 확인)
    if (request.headers.get("origin") !== request.nextUrl.origin || request.headers.get("sec-fetch-site") === "cross-site") throw new WorkbenchError("사이트에서 다시 요청해 주세요.", 403);
    if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/json") throw new WorkbenchError("요청 형식을 확인해 주세요.", 415);
    const text = await request.text();
    if (text.length > 4096) throw new WorkbenchError("요청 내용이 너무 큽니다.", 413);
    let body: Record<string, unknown>;
    try { body = JSON.parse(text); } catch { throw new WorkbenchError("요청 형식을 확인해 주세요."); }
    const { action, ...rest } = body ?? {};
    const result = action === "APPROVE" ? await approvePostIssueChange(db, rest, admin.appUserId, enabled())
      : action === "DISMISS" ? await dismissPostIssueChange(db, rest, admin.appUserId, enabled())
      : null;
    if (!result) throw new WorkbenchError("요청 내용을 확인해 주세요.");
    // 청구를 취소·수정했으면 청구·수납·통계·학생 상세·학부모 화면 캐시를 비운다(관리자 «청구서 삭제·수정»과 같은 범위)
    if (action === "APPROVE") {
      revalidatePath("/admin/finance"); revalidatePath("/admin/stats"); revalidatePath("/admin/students/[id]", "page"); revalidatePath("/mypage");
      revalidateTag("admin-finance", { expire: 0 }); revalidateTag("admin-stats", { expire: 0 });
    }
    return NextResponse.json({ result, view: await readView() }, { headers });
  } catch (e) { return fail(e); }
}
