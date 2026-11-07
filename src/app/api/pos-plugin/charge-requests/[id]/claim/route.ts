import { NextRequest } from "next/server";
import { pluginOk, preflight } from "@/lib/pos/pluginAuth";
import { handlePluginRequest } from "@/lib/pos/pluginHttp";
import { claimChargeRequestForPlugin } from "@/lib/pos/chargeRequestService";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POS 플러그인 — 요청 가져가기(PENDING → SENT, 조건부 UPDATE 1행일 때만 성공).
 * 본문은 받지 않는다: 금액·면세·메모는 전부 서버 DB 값으로 돌려준다(IDOR·금액 조작 방지).
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    return handlePluginRequest(req, async (auth) => pluginOk({ request: await claimChargeRequestForPlugin(id, auth.tokenId) }));
}

export function OPTIONS(req: NextRequest) {
    return preflight(req);
}
