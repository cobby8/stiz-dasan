"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import HqSellerNotice from "@/components/HqSellerNotice";
import { useStoreAppLacks } from "@/components/storeApp/useStoreAppLacks";
import { copyInsteadOfOpening } from "@/lib/outsideLink";

type ClubShopProduct = {
  productNo: number;
  name: string;
  price: number;
  image: string;
  url: string;
  purchasable: boolean;
  state: string;
};

type ProductState =
  | { status: "loading" }
  | { status: "ready"; product: ClubShopProduct; sourceUrl: string }
  | { status: "unavailable"; message: string };

function formatPrice(price: number) {
  return `${price.toLocaleString("ko-KR")}원`;
}

function getTrustedProductUrl(rawUrl: string) {
  try {
    const url = new URL(rawUrl);
    const trustedHosts = new Set(["stiz.kr", "www.stiz.kr"]);

    if (url.protocol !== "https:" || !trustedHosts.has(url.hostname)) {
      return null;
    }

    return url.toString();
  } catch {
    return null;
  }
}

export default function ShopProductFrame({ productNo }: { productNo: string }) {
  const [state, setState] = useState<ProductState>({ status: "loading" });
  const [frameLoading, setFrameLoading] = useState(true);
  // 스토어 앱이 바깥 주소를 못 열면 true — 판정은 @/lib/storeApp 한 곳(앱 새 버전이 caps=links 를 보내면 자동 해제)
  const appCannotOpen = useStoreAppLacks("links");

  useEffect(() => {
    let cancelled = false;

    async function loadProduct() {
      const numericProductNo = Number(productNo);
      if (!Number.isInteger(numericProductNo) || numericProductNo <= 0) {
        setState({ status: "unavailable", message: "상품 주소가 올바르지 않습니다." });
        return;
      }

      try {
        const response = await fetch("/api/products/club-shop", {
          headers: { Accept: "application/json" },
        });
        const data = await response.json() as { products?: ClubShopProduct[] };
        const product = Array.isArray(data.products)
          ? data.products.find((item) => item.productNo === numericProductNo)
          : undefined;
        const sourceUrl = product ? getTrustedProductUrl(product.url) : null;

        if (cancelled) return;

        if (!response.ok || !product) {
          setState({ status: "unavailable", message: "현재 판매 중인 상품을 찾을 수 없습니다." });
          return;
        }

        if (!product.purchasable || !sourceUrl) {
          setState({ status: "unavailable", message: product.state || "현재 구매할 수 없는 상품입니다." });
          return;
        }

        setState({ status: "ready", product, sourceUrl });
      } catch {
        if (!cancelled) {
          setState({ status: "unavailable", message: "상품 정보를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요." });
        }
      }
    }

    loadProduct();
    return () => {
      cancelled = true;
    };
  }, [productNo]);

  return (
    <main className="public-product-frame flex h-dvh min-h-0 flex-col overflow-hidden bg-white text-gray-950 dark:bg-gray-950 dark:text-white">
      <header className="public-product-header flex min-h-16 shrink-0 items-center gap-3 border-b border-gray-200 bg-white px-3 shadow-sm dark:border-gray-800 dark:bg-gray-950 sm:px-5">
        <Link
          href="/shop"
          title="클럽샵으로 돌아가기"
          aria-label="클럽샵으로 돌아가기"
          className="flex h-11 shrink-0 items-center justify-center whitespace-nowrap rounded-lg border border-gray-200 px-3 text-sm font-medium text-gray-800 transition hover:bg-gray-100 dark:border-gray-700 dark:text-white dark:hover:bg-gray-800"
        >
          ← 클럽샵
        </Link>

        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium text-[var(--color-public-muted)] dark:text-brand-neon-lime">STIZ CLUB SHOP</p>
          <div className="flex min-w-0 items-baseline gap-2">
            <h1 className="truncate text-sm font-bold sm:text-base">
              {state.status === "ready" ? state.product.name : state.status === "unavailable" ? "상품을 열 수 없습니다" : "상품 불러오는 중"}
            </h1>
            {state.status === "ready" && (
              <span className="shrink-0 text-xs tabular-nums text-gray-500 dark:text-gray-300 sm:text-sm">
                {formatPrice(state.product.price)}
              </span>
            )}
          </div>
        </div>

        {state.status === "ready" && (
          <a
            href={state.sourceUrl} data-outside-link
            target="_blank"
            rel="noreferrer"
            title="외부 브라우저에서 열기"
            aria-label="외부 브라우저에서 열기"
            className="flex h-11 shrink-0 items-center justify-center whitespace-nowrap rounded-lg border border-gray-200 px-3 text-sm font-medium text-gray-700 transition hover:bg-gray-100 dark:border-gray-700 dark:text-gray-100 dark:hover:bg-gray-800"
          >
            새 창
          </a>
        )}
      </header>

      {/* 아래 구매 화면은 본사 쇼핑몰이다 — 판매자를 학원과 구분해 표시 */}
      <HqSellerNotice compact />

      <section className="relative min-h-0 flex-1" aria-label="클럽샵 상품 상세">
        {state.status === "loading" && <ProductLoading />}

        {state.status === "unavailable" && (
          <div className="flex h-full items-center justify-center p-6">
            <div className="max-w-sm text-center">
              <h2 className="text-lg font-bold">상품을 열 수 없습니다</h2>
              <p className="mt-2 break-keep text-sm leading-6 text-gray-600 dark:text-gray-300">{state.message}</p>
              <Link
                href="/shop"
                className="public-btn-primary mt-5 text-sm"
              >
                상품 목록으로
              </Link>
            </div>
          </div>
        )}

        {/* 스토어 앱(현재 버전)은 본사 쇼핑몰 구매 화면(바깥 주소)을 열지 못한다 → 주소 복사 안내로 바꾼다(d2) */}
        {state.status === "ready" && appCannotOpen && (
          <div className="flex h-full items-center justify-center p-6">
            <div className="max-w-sm text-center">
              <h2 className="text-lg font-bold text-[var(--color-public-ink)]">구매는 휴대폰 브라우저에서 해 주세요</h2>
              <p className="mt-2 break-keep text-sm leading-6 text-[var(--color-public-muted)]">
                앱에서는 본사 쇼핑몰 구매 화면을 열 수 없어요. 주소를 복사해 휴대폰 브라우저에 붙여 넣어 주세요.
              </p>
              <button
                type="button"
                onClick={() => void copyInsteadOfOpening(state.sourceUrl)}
                className="public-btn-primary mt-5 text-sm"
              >
                구매 주소 복사
              </button>
            </div>
          </div>
        )}

        {state.status === "ready" && !appCannotOpen && (
          <>
            {frameLoading && <ProductLoading />}
            <iframe
              src={state.sourceUrl}
              title={`${state.product.name} 구매 화면`}
              className="h-full w-full border-0 bg-white"
              allow="payment *; clipboard-write *"
              referrerPolicy="strict-origin-when-cross-origin"
              onLoad={() => setFrameLoading(false)}
            />
          </>
        )}
      </section>
    </main>
  );
}

function ProductLoading() {
  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center bg-white dark:bg-gray-950">
      <div className="flex items-center gap-3 text-sm font-medium text-gray-600 dark:text-gray-300">
        상품을 불러오고 있습니다
      </div>
    </div>
  );
}
