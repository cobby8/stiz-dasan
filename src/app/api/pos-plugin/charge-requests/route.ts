import { NextRequest } from "next/server";
import { pluginOk, preflight } from "@/lib/pos/pluginAuth";
import { handlePluginRequest } from "@/lib/pos/pluginHttp";
import { listOpenChargeRequestsForPlugin } from "@/lib/pos/chargeRequestService";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POS 플러그인 — 열린(대기·가져감) 현장 결제 요청 목록. 워커가 30초마다 부른다.
 * 매장 토큰(Authorization: Bearer) 필수. 이 API 로는 납부 처리를 할 수 없다.
 * (탭에서 미납을 골라 만드는 길은 POST /api/pos-plugin/unpaid/{paymentId}/charge)
 */
export async function GET(req: NextRequest) {
    return handlePluginRequest(req, async () => pluginOk({ requests: await listOpenChargeRequestsForPlugin() }));
}

export function OPTIONS(req: NextRequest) {
    return preflight(req);
}
