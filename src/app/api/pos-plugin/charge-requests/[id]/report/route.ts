import { NextRequest } from "next/server";
import { pluginError, pluginOk, preflight } from "@/lib/pos/pluginAuth";
import { handlePluginRequest, readJsonBody } from "@/lib/pos/pluginHttp";
import { PLUGIN_REPORT_EVENTS, normalizePluginReportEvent, reportChargeRequestFromPlugin } from "@/lib/pos/chargeRequestService";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POS 플러그인 — 결과 보고 { event: paid|cancel|start_failed (대문자 SENT·PAID·CANCELLED·FAILED·START_FAILED 도 됨), reason?, message? }.
 * ⚠️ 기록용이다. event=paid 를 보내도 청구서는 바뀌지 않는다 — 납부완료는 토스 웹훅 + 재조회로만.
 *    cancel 은 아직 열린 요청을 취소 표시만 한다(돈은 안 움직임). 본문의 금액·토스 ID 는 쓰지 않는다.
 *    같은 요청 + 같은 event 는 한 번만 처리(두 번째는 duplicate: true, 아무것도 안 바뀜).
 * 응답 status 가 PAID 면 서버가 이미 웹훅으로 납부 반영한 것 → POS 에 «사이트 납부완료» 안내.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    return handlePluginRequest(req, async (auth) => {
        const body = await readJsonBody(req);
        const event = normalizePluginReportEvent(body.event);
        if (!event) {
            return pluginError(400, "BAD_REQUEST", `event 는 paid·cancel·start_failed (또는 ${PLUGIN_REPORT_EVENTS.join(", ")}) 중 하나여야 합니다.`);
        }
        const text = typeof body.reason === "string" ? body.reason : typeof body.message === "string" ? body.message : null;
        const result = await reportChargeRequestFromPlugin({ requestId: id, tokenId: auth.tokenId, event, message: text });
        return pluginOk(result);
    });
}

export function OPTIONS(req: NextRequest) {
    return preflight(req);
}
