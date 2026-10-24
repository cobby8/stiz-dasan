import { NextRequest, NextResponse } from "next/server";
import { recordCafe24PaymentWebhook, verifyCafe24PaymentWebhook } from "@/lib/payment-ledger";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
    try {
        const contentLength = Number(req.headers.get("content-length") || 0);
        if (contentLength > 64 * 1024) {
            return NextResponse.json({ error: "웹훅 본문이 너무 큽니다." }, { status: 413 });
        }

        const rawBody = await req.text();
        if (Buffer.byteLength(rawBody, "utf8") > 64 * 1024) {
            return NextResponse.json({ error: "웹훅 본문이 너무 큽니다." }, { status: 413 });
        }

        let payload: unknown;
        try {
            payload = JSON.parse(rawBody);
        } catch {
            return NextResponse.json({ error: "올바른 JSON 웹훅이 아닙니다." }, { status: 400 });
        }

        if (!verifyCafe24PaymentWebhook(payload, req.headers)) {
            return NextResponse.json({ error: "웹훅 서명이 올바르지 않습니다." }, { status: 401 });
        }

        const result = await recordCafe24PaymentWebhook(payload);
        return NextResponse.json(result, { status: result.ok ? 200 : 409 });
    } catch (error) {
        console.error("[payments/cafe24/webhook] failed:", error);
        return NextResponse.json({ error: "카페24 웹훅 처리 중 오류가 발생했습니다." }, { status: 500 });
    }
}
