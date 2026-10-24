import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
    isReviewPriceTier,
    makeReviewOrderId,
    readTossReviewConfig,
    resolveReviewOrder,
    type ReviewProgramPrices,
} from "@/lib/payments/tossReview";

export const dynamic = "force-dynamic";

/**
 * 토스페이먼츠 가맹 심사용 테스트 결제 준비 — 프로그램 화면의 [결제하기] 버튼이 부른다.
 *
 * - 테스트 키(TOSS_REVIEW_*)가 있을 때만 동작한다. 없거나 라이브 키면 404.
 * - 금액은 화면이 아니라 DB 의 프로그램 가격으로 정한다.
 * - 아무것도 저장하지 않는다(읽기 1회). 청구서·납부 기록과 완전히 무관하다.
 */
export async function POST(req: NextRequest) {
    const config = readTossReviewConfig(process.env);
    if (!config) return NextResponse.json({ error: "지금은 온라인 결제를 사용할 수 없습니다." }, { status: 404 });

    let body: { programId?: unknown; tier?: unknown } = {};
    try {
        body = await req.json();
    } catch {
        body = {};
    }
    const programId = typeof body.programId === "string" ? body.programId : "";
    const tier = body.tier;
    if (!programId || !isReviewPriceTier(tier)) {
        return NextResponse.json({ error: "결제할 수업을 다시 선택해 주세요." }, { status: 400 });
    }

    const rows = await prisma.$queryRawUnsafe<ReviewProgramPrices[]>(
        `SELECT name, price, "priceWeek1", "priceWeek2", "priceWeek3", "priceDaily"
           FROM "Program" WHERE id = $1 AND "deletedAt" IS NULL LIMIT 1`,
        programId,
    );
    const order = rows[0] ? resolveReviewOrder(rows[0], tier) : null;
    if (!order) return NextResponse.json({ error: "결제할 수 있는 수업이 아닙니다." }, { status: 400 });

    const configuredOrigin = process.env.NEXT_PUBLIC_SITE_URL?.trim();
    const origin = configuredOrigin && /^https?:\/\//i.test(configuredOrigin)
        ? new URL(configuredOrigin).origin
        : new URL(req.url).origin;

    return NextResponse.json({
        clientKey: config.clientKey,
        // 비회원 결제: 사람마다 새 값. 토스 규칙(영문·숫자·-_=.@ 2~50자)에 맞춘다.
        customerKey: `guest-${randomUUID()}`,
        orderId: makeReviewOrderId(randomUUID()),
        amount: order.amount,
        orderName: order.orderName,
        successUrl: `${origin}/payments/review/success`,
        failUrl: `${origin}/payments/review/fail`,
    });
}
