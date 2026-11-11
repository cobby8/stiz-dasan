import { NextRequest } from "next/server";
import { pluginOk, preflight } from "@/lib/pos/pluginAuth";
import { handlePluginRequest } from "@/lib/pos/pluginHttp";
import { assertChargeRequestMayStartForPlugin } from "@/lib/pos/chargeRequestService";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    return handlePluginRequest(req, async (auth) => {
        await assertChargeRequestMayStartForPlugin(id, auth.tokenId);
        return pluginOk({ allowed: true });
    });
}

export function OPTIONS(req: NextRequest) {
    return preflight(req);
}
