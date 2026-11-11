import { NextRequest } from "next/server";
import { pluginError, pluginOk, preflight } from "@/lib/pos/pluginAuth";
import { handlePluginRequest, readJsonBody } from "@/lib/pos/pluginHttp";
import { normalizePluginDismissOutcome, reportChargeDismissalFromPlugin } from "@/lib/pos/chargeRequestService";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    return handlePluginRequest(req, async (auth) => {
        const body = await readJsonBody(req);
        const outcome = normalizePluginDismissOutcome(body.outcome);
        if (!outcome) return pluginError(400, "BAD_REQUEST", "올바른 미결제 주문 취소 결과가 필요합니다.");
        const reason = typeof body.reason === "string" ? body.reason : null;
        return pluginOk(await reportChargeDismissalFromPlugin({ requestId: id, tokenId: auth.tokenId, outcome, reason }));
    });
}

export function OPTIONS(req: NextRequest) {
    return preflight(req);
}
