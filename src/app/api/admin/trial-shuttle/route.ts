import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth-guard";
import {
  assignTrialShuttle,
  countTrialShuttleWaiting,
  getTrialShuttlePanel,
  isTrialShuttleSchemaMissing,
  markTrialShuttleParentSmsSent,
  releaseTrialShuttle,
  reopenTrialShuttleRequest,
  TrialShuttleError,
} from "@/lib/shuttle/trialShuttle";

export const dynamic = "force-dynamic";

// 체험 셔틀 배정(관리자·부원장) API — 배정 패널(TrialShuttleAssignPanel)이 쓴다.
//   GET  ?leadId=…      → 패널이 처음 읽는 값(요청 내용·그날 운행 묶음·지금 배정·문자 초안)
//   GET  ?count=1       → «체험 셔틀 배정 대기 N건»
//   POST { action, leadId, … }
//        assign      { legs }  배정 확정(+ 기사님 알림)
//        release               배정 풀기(→ 배정 대기)
//        unavailable { note }  셔틀 어려움으로 표시
//        reopen                셔틀 어려움 → 다시 배정 대기
//        smsSent               학부모 문자를 보낸 뒤 «보냄» 표시(실제 발송은 수동 문자 장치)
// 권한: 관리자·부원장(requireAdmin). 학부모 문자는 여기서 보내지 않는다 — 자동 발송 없음.
// 오류 응답에 내부 오류 원문을 담지 않는다.

const NO_STORE = { "Cache-Control": "private, no-store" };

function json(body: object, status = 200) {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

function fail(error: unknown, tag: string) {
  if (error instanceof TrialShuttleError) return json({ error: error.message, code: error.code }, error.status);
  if (isTrialShuttleSchemaMissing(error)) return json({ error: "체험 셔틀 기능을 준비 중입니다. 잠시 뒤 다시 열어 주세요.", code: "NOT_READY" }, 503);
  console.error(`[admin trial-shuttle ${tag}]`, error);
  return json({ error: "처리하지 못했습니다. 잠시 뒤 다시 시도해 주세요." }, 500);
}

async function adminOrNull() {
  try { return await requireAdmin(); } catch { return null; }
}

function leadIdOf(value: unknown): string | null {
  return typeof value === "string" && value.trim() && value.length <= 64 ? value.trim() : null;
}

export async function GET(request: NextRequest) {
  const admin = await adminOrNull();
  if (!admin) return json({ error: "관리자 로그인이 필요합니다." }, 401);
  try {
    if (request.nextUrl.searchParams.get("count") === "1") {
      return json({ ok: true, waiting: await countTrialShuttleWaiting() });
    }
    const leadId = leadIdOf(request.nextUrl.searchParams.get("leadId"));
    if (!leadId) return json({ error: "체험 신청을 확인해 주세요." }, 400);
    return json({ ok: true, panel: await getTrialShuttlePanel(leadId) });
  } catch (error) {
    return fail(error, "GET");
  }
}

export async function POST(request: NextRequest) {
  // 다른 사이트에서 관리자 브라우저를 빌려 부르지 못하게(같은 출처 + JSON 만)
  if (request.headers.get("origin") !== request.nextUrl.origin || request.headers.get("sec-fetch-site") === "cross-site") {
    return json({ error: "사이트에서 다시 요청해 주세요." }, 403);
  }
  if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") {
    return json({ error: "요청 형식을 확인해 주세요." }, 415);
  }
  const admin = await adminOrNull();
  if (!admin) return json({ error: "관리자 로그인이 필요합니다." }, 401);

  const body = await request.json().catch(() => null) as { action?: unknown; leadId?: unknown; legs?: unknown; note?: unknown; requestStamp?: unknown } | null;
  const leadId = leadIdOf(body?.leadId);
  if (!leadId) return json({ error: "체험 신청을 확인해 주세요." }, 400);
  try {
    switch (body?.action) {
      case "assign": {
        // requestStamp = 패널이 열 때 받은 요청 도장 — 그 뒤 요청이 바뀌었으면 409(REQUEST_CHANGED)
        const result = await assignTrialShuttle(admin.appUserId ?? null, leadId, body.legs, typeof body.requestStamp === "string" ? body.requestStamp : null);
        return json({ ok: true, driversNotified: result.driversNotified, panel: await getTrialShuttlePanel(leadId) });
      }
      case "release": {
        const result = await releaseTrialShuttle(leadId, "ADMIN_RELEASE");
        return json({ ok: true, driversNotified: result.driversNotified, panel: await getTrialShuttlePanel(leadId) });
      }
      case "unavailable": {
        const result = await releaseTrialShuttle(leadId, "UNAVAILABLE", { adminNote: typeof body.note === "string" ? body.note : null });
        return json({ ok: true, driversNotified: result.driversNotified, panel: await getTrialShuttlePanel(leadId) });
      }
      case "reopen": {
        await reopenTrialShuttleRequest(leadId);
        return json({ ok: true, panel: await getTrialShuttlePanel(leadId) });
      }
      case "smsSent": {
        await markTrialShuttleParentSmsSent(leadId);
        return json({ ok: true, panel: await getTrialShuttlePanel(leadId) });
      }
      default:
        return json({ error: "요청을 확인해 주세요." }, 400);
    }
  } catch (error) {
    return fail(error, "POST");
  }
}
