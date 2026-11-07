import { NextRequest } from "next/server";
import { pluginOk, preflight } from "@/lib/pos/pluginAuth";
import { handlePluginRequest } from "@/lib/pos/pluginHttp";
import { claimCancelForPlugin } from "@/lib/pos/chargeRequestService";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POS 플러그인 — «결제 취소할 일» 가져가기(REQUESTED → SENT, 조건부 UPDATE 1행일 때만 성공).
 * 본문은 받지 않는다: 취소할 토스 주문·결제 ID 는 전부 서버 DB 값으로 돌려준다(남의 결제를 취소하게 만드는 조작 방지).
 * ⚠️ 여기서는 환불하지 않는다 — 청구서 환불은 토스 웹훅 + 재조회로만(chargeRequestService.settleCancelForRow).
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    return handlePluginRequest(req, async (auth) => pluginOk({ cancel: await claimCancelForPlugin(id, auth.tokenId) }));
}

export function OPTIONS(req: NextRequest) {
    return preflight(req);
}
