import { NextRequest } from "next/server";
import { pluginError, pluginOk, preflight } from "@/lib/pos/pluginAuth";
import { handlePluginRequest, readJsonBody } from "@/lib/pos/pluginHttp";
import { createAndClaimBundleForPlugin } from "@/lib/pos/chargeRequestService";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POS 플러그인 탭 «전체 결제» — 같은 학생의 미납 여러 건 { paymentIds: [...] } 으로 «요청 만들기 + 가져가기(SENT)»를 한 번에.
 * 묶음 규칙(같은 학생·최대 10건·500만원·미납만)은 관리자 묶음과 같은 서버 검사. 금액·면세·메모는 전부 서버 DB 값.
 * 응답 모양은 단건(unpaid/[paymentId]/charge)·claim 과 같다.
 */
export async function POST(req: NextRequest) {
    return handlePluginRequest(req, async (auth) => {
        const body = await readJsonBody(req);
        const ids = Array.isArray(body.paymentIds) ? body.paymentIds.filter((v): v is string => typeof v === "string").slice(0, 20) : [];
        if (ids.length === 0) return pluginError(400, "BAD_REQUEST", "paymentIds 가 필요합니다.");
        return pluginOk({ request: await createAndClaimBundleForPlugin(ids, auth.tokenId) });
    });
}

export function OPTIONS(req: NextRequest) {
    return preflight(req);
}
