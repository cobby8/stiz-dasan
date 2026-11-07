import { NextRequest } from "next/server";
import { pluginOk, preflight } from "@/lib/pos/pluginAuth";
import { handlePluginRequest } from "@/lib/pos/pluginHttp";
import { createAndClaimForPlugin } from "@/lib/pos/chargeRequestService";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POS 플러그인 탭 — 미납 목록에서 고른 청구서로 «요청 만들기 + 가져가기(SENT)»를 한 번에.
 * 같은 청구서에 열린 요청이 있으면 새로 만들지 않고 그 요청을 가져간다(다른 기기가 이미 가져갔으면 409).
 * 본문은 받지 않는다 — 금액·면세·메모는 전부 서버 DB 값(응답 모양은 claim 과 같다).
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ paymentId: string }> }) {
    const { paymentId } = await params;
    return handlePluginRequest(req, async (auth) => pluginOk({ request: await createAndClaimForPlugin(paymentId, auth.tokenId) }));
}

export function OPTIONS(req: NextRequest) {
    return preflight(req);
}
