import { NextRequest } from "next/server";
import { pluginOk, preflight } from "@/lib/pos/pluginAuth";
import { handlePluginRequest } from "@/lib/pos/pluginHttp";
import { getChargeRequestPaymentStateForPlugin } from "@/lib/pos/chargeRequestService";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POS 플러그인 — 결제 요청의 납부 상태 조회(읽기 전용). { status, paid }
 * startPayment 가 결제 «뒤»에 오류를 돌려줄 때, 오류 안내 전에 웹훅이 이미 납부를 기록했는지 확인한다.
 * 아무것도 바꾸지 않는다. 이 POS 가 가져간 요청만 보인다.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    return handlePluginRequest(req, async (auth) => pluginOk(await getChargeRequestPaymentStateForPlugin(id, auth.tokenId)));
}

export function OPTIONS(req: NextRequest) {
    return preflight(req);
}
