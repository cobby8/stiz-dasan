import { NextResponse } from "next/server";

const CLUB_SHOP_API_URL = "https://custom.stiz.kr/api/products/club-shop?club=dasan";

export const revalidate = 300;

function cacheHeaders(status: number) {
  if (status < 200 || status >= 300) {
    return {
      "Cache-Control": "no-store",
    };
  }

  const ttl = 300;
  return {
    "Cache-Control": `public, max-age=${Math.min(ttl, 60)}, s-maxage=${ttl}, stale-while-revalidate=600`,
  };
}

export async function GET() {
  try {
    const response = await fetch(CLUB_SHOP_API_URL, {
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    const text = await response.text();
    const body = text ? JSON.parse(text) : { success: false, error: "상품 정보를 불러오지 못했습니다." };

    return NextResponse.json(body, {
      status: response.status,
      headers: cacheHeaders(response.status),
    });
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: error instanceof SyntaxError
          ? "상품 정보 형식이 올바르지 않습니다."
          : "클럽샵 상품 정보를 불러오지 못했습니다.",
      },
      { status: 502, headers: cacheHeaders(502) },
    );
  }
}
