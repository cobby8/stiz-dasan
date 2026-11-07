import { NextRequest } from "next/server";
import { pluginError, pluginOk, preflight } from "@/lib/pos/pluginAuth";
import { handlePluginRequest, readJsonBody } from "@/lib/pos/pluginHttp";
import { normalizePluginCancelResult, reportCancelFromPlugin } from "@/lib/pos/chargeRequestService";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POS 플러그인 — 결제 취소 결과 보고 { result: done|failed, message? }.
 * ⚠️ 기록용이다. done 을 보내도 청구서는 바뀌지 않는다 — 환불은 토스 웹훅 + 재조회로만.
 *    failed 는 사이트 창에 «POS 에서 직접 취소해 주세요» 를 띄우는 표시만 한다. 그 일을 가져간 토큰만 보고할 수 있다.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    return handlePluginRequest(req, async (auth) => {
        const body = await readJsonBody(req);
        const result = normalizePluginCancelResult(body.result);
        if (!result) return pluginError(400, "BAD_REQUEST", "result 는 done·failed 중 하나여야 합니다.");
        const text = typeof body.message === "string" ? body.message : typeof body.reason === "string" ? body.reason : null;
        return pluginOk(await reportCancelFromPlugin({ requestId: id, tokenId: auth.tokenId, result, message: text }));
    });
}

export function OPTIONS(req: NextRequest) {
    return preflight(req);
}
