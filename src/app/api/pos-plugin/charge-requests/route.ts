import { NextRequest } from "next/server";
import { pluginOk, preflight } from "@/lib/pos/pluginAuth";
import { handlePluginRequest } from "@/lib/pos/pluginHttp";
import { hasUnknownPendingChargeRequest, listOpenChargeRequestsForPlugin } from "@/lib/pos/chargeRequestService";
import { parseKnownIds, parseWaitSeconds, waitForChargeRequests } from "@/lib/pos/plugin-long-poll.mjs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// 롱폴링(최대 20초 대기) + 인증·조회 여유 — 함수가 중간에 잘리지 않게 30초
export const maxDuration = 30;

/**
 * POS 플러그인 — 열린(대기·가져감) 현장 결제 요청 목록.
 * 매장 토큰(Authorization: Bearer) 필수. 이 API 로는 납부 처리를 할 수 없다.
 * (탭에서 미납을 골라 만드는 길은 POST /api/pos-plugin/unpaid/{paymentId}/charge)
 *
 * 롱폴링(2026-11-08): `?wait=초`(0~20, 기본 0 = 예전처럼 바로 답) · `?known=id,id`(이미 알림 띄운 대기 요청).
 *   wait>0 이면 모르는 대기 요청이 생길 때까지 약 1초 간격으로 확인하다가 바로 답하고, 없으면 wait 초 뒤 답한다.
 *   응답 모양은 같고 `waitSec`(실제 적용한 초)만 더 붙는다 — 플러그인은 이 칸으로 «새 서버»인지 안다.
 */
export async function GET(req: NextRequest) {
    return handlePluginRequest(req, async () => {
        const waitSec = parseWaitSeconds(req.nextUrl.searchParams.get("wait"));
        const known = parseKnownIds(req.nextUrl.searchParams.get("known"));
        const { rows } = await waitForChargeRequests({
            waitSec,
            known,
            listNow: () => listOpenChargeRequestsForPlugin(),
            hasNew: (ids: string[]) => hasUnknownPendingChargeRequest(ids),
            // 플러그인이 끊으면(시간 초과·POS 종료) 더 기다리지 않는다
            signal: req.signal,
        });
        return pluginOk(waitSec > 0 ? { requests: rows, waitSec } : { requests: rows });
    });
}

export function OPTIONS(req: NextRequest) {
    return preflight(req);
}
