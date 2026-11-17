import { NextRequest } from "next/server";
import { pluginError, pluginOk, preflight } from "@/lib/pos/pluginAuth";
import { handlePluginRequest, readJsonBody } from "@/lib/pos/pluginHttp";
import { normalizePosNotReadyReason, reportChargeNotReadyFromPlugin } from "@/lib/pos/chargeRequestService";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POS 플러그인 — 새 요청을 바로 못 열었다는 참고 보고 { reason: "busy" | "draft_not_empty" }.
 * 대기(PENDING) 요청의 메시지 칸에만 남기고 상태·돈은 바꾸지 않는다. 플러그인은 POS 가 비면 다시 연다.
 * 관리자 «현장 결제» 창이 이 값을 보고 «POS 화면에 다른 주문이 있어요»를 띄운다(2026-11-17).
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    return handlePluginRequest(req, async () => {
        const body = await readJsonBody(req);
        const reason = normalizePosNotReadyReason(body.reason);
        if (!reason) return pluginError(400, "BAD_REQUEST", "reason 은 busy·draft_not_empty 중 하나여야 합니다.");
        return pluginOk(await reportChargeNotReadyFromPlugin({ requestId: id, reason }));
    });
}

export function OPTIONS(req: NextRequest) {
    return preflight(req);
}
