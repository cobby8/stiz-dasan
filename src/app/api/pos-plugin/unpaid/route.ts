import { NextRequest } from "next/server";
import { pluginOk, preflight } from "@/lib/pos/pluginAuth";
import { handlePluginRequest } from "@/lib/pos/pluginHttp";
import { listUnpaidForPlugin } from "@/lib/pos/chargeRequestService";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POS 플러그인 탭 — 미납(수강료·셔틀비) 목록 ?q=이름일부. 최대 30건.
 * 이름은 가린 값(홍*동)·반·청구월·금액만. 전화번호·주소·보호자 정보는 싣지 않는다.
 */
export async function GET(req: NextRequest) {
    return handlePluginRequest(req, async () => {
        const q = req.nextUrl.searchParams.get("q") ?? "";
        return pluginOk({ items: await listUnpaidForPlugin(q) });
    });
}

export function OPTIONS(req: NextRequest) {
    return preflight(req);
}
