import { NextRequest } from "next/server";
import { pluginOk, preflight } from "@/lib/pos/pluginAuth";
import { handlePluginRequest } from "@/lib/pos/pluginHttp";
import {
    hasUnknownCancelJob,
    hasUnknownChargeDismissal,
    hasUnknownPendingChargeRequest,
    listCancelJobsForPlugin,
    listChargeDismissalsForPlugin,
    listOpenChargeRequestsForPlugin,
} from "@/lib/pos/chargeRequestService";
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
 *
 * 결제 취소(2026-11-08): 응답에 `cancels`(사이트에서 «결제 취소»를 누른 요청 — 이름 가림, 결제 ID 없음)가 늘 붙는다.
 *   옛 플러그인은 모르는 칸이라 무시한다. 새 플러그인은 `?cancels=1` 을 보내고, 그때만 새 취소 요청으로도 대기를 깨운다
 *   (옛 플러그인을 깨우면 그 일을 못 하면서 1초마다 다시 묻게 된다). known 에 이미 본 취소 요청 id 도 넣는다.
 */
export async function GET(req: NextRequest) {
    return handlePluginRequest(req, async (auth) => {
        const waitSec = parseWaitSeconds(req.nextUrl.searchParams.get("wait"));
        const known = parseKnownIds(req.nextUrl.searchParams.get("known"));
        const wakeOnCancel = req.nextUrl.searchParams.get("cancels") === "1";
        const supportsDismissal = req.nextUrl.searchParams.get("dismiss") === "1";
        const { rows } = await waitForChargeRequests({
            waitSec,
            known,
            listNow: () => listOpenChargeRequestsForPlugin(),
            hasNew: async (ids: string[]) =>
                (supportsDismissal && (await hasUnknownChargeDismissal(auth.tokenId, ids)))
                || (await hasUnknownPendingChargeRequest(ids)) || (wakeOnCancel && (await hasUnknownCancelJob(ids))),
            // 플러그인이 끊으면(시간 초과·POS 종료) 더 기다리지 않는다
            signal: req.signal,
        });
        const [cancels, dismissals] = await Promise.all([
            listCancelJobsForPlugin(),
            supportsDismissal ? listChargeDismissalsForPlugin(auth.tokenId) : Promise.resolve([]),
        ]);
        return pluginOk({ requests: rows, cancels, dismissals, ...(waitSec > 0 ? { waitSec } : {}) });
    });
}

export function OPTIONS(req: NextRequest) {
    return preflight(req);
}
