import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { withCronAlert } from "@/lib/cron/withCronAlert";
import { resolveSyncRange, runShopOrderSync, ShopOrderSyncError } from "@/lib/uniform/shopOrderSync";

export const dynamic = "force-dynamic";

/**
 * 소명엔비씨 쇼핑몰 유니폼 주문 동기화 (매시 17분 · vercel.json).
 *
 * 왜 필요한가: 학부모가 stiz.kr(카페24)에서 직접 낸 유니폼 주문을 학부모 «아이 기록 → 유니폼 신청 내역»에
 * 사이트 주문과 함께 보여 주려고, 소명엔비씨 창구에서 받아 UniformShopOrder·UniformShopOrderItem 에 upsert 한다.
 *
 * 기간: 기본 «오늘 포함 최근 80일»(소명엔비씨 창구 최대치 — 14일이면 그 뒤 주문 상태가 멈춘다. 이유는 CLUB_ORDERS_DEFAULT_DAYS 주석).
 *       80일보다 오래된 주문 채우기는 ?from=YYYY-MM-DD&to=YYYY-MM-DD(최대 80일 길이)로 여러 번 부른다. ?days=N(1~80)도 된다.
 * 응답: 기간·받은 건수·저장 건수·«빠져서 취소로 표시한 품목 수»만(전화번호·이름 없음). 실패하면 500 + 사유 글자(비밀값·개인정보 없음) — 아무것도 저장·삭제하지 않는다.
 */
async function handleGet(req: NextRequest) {
  // 기존 cron 과 같은 CRON_SECRET 확인
  const secret = process.env.CRON_SECRET;
  if (process.env.NODE_ENV !== "development" && (!secret || req.headers.get("authorization") !== `Bearer ${secret}`)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const q = req.nextUrl.searchParams;
  const range = resolveSyncRange({ nowMs: Date.now(), days: q.get("days"), from: q.get("from"), to: q.get("to") });
  if ("error" in range) return NextResponse.json({ ok: false, error: range.error }, { status: 400 });

  try {
    const result = await runShopOrderSync(prisma, range);
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    // 우리가 만든 사유 글자만 그대로 — 그 밖(DB 오류 등)은 원문을 내보내지 않는다(값이 섞일 수 있다)
    const reason = error instanceof ShopOrderSyncError ? error.message : "저장 실패";
    console.error("[uniform-shop-sync] 실패", reason, error instanceof ShopOrderSyncError ? "" : error instanceof Error ? error.name : "");
    return NextResponse.json({ ok: false, from: range.from, to: range.to, error: reason }, { status: 500 });
  }
}

// 실패(500)하면 원장 슬랙으로 한 줄 알림 — 같은 작업은 1시간에 1번(d4)
export const GET = withCronAlert("uniform-shop-sync", handleGet);
