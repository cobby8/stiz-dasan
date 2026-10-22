"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import FontFreeIcon from "@/components/ui/FontFreeIcon";
import HqSellerNotice from "@/components/HqSellerNotice";

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
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-gray-200 text-gray-800 transition hover:bg-gray-100 dark:border-gray-700 dark:text-white dark:hover:bg-gray-800"
        >
          <FontFreeIcon name="arrow_back" size={21} />
        </Link>

        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-black text-brand-orange-600 dark:text-brand-neon-lime">STIZ CLUB SHOP</p>
          <div className="flex min-w-0 items-baseline gap-2">
            <h1 className="truncate text-sm font-black sm:text-base">
              {state.status === "ready" ? state.product.name : "상품 불러오는 중"}
            </h1>
            {state.status === "ready" && (
              <span className="shrink-0 text-xs font-bold text-gray-500 dark:text-gray-300 sm:text-sm">
                {formatPrice(state.product.price)}
              </span>
            )}
          </div>
        </div>

        {state.status === "ready" && (
          <a
            href={state.sourceUrl}
            target="_blank"
            rel="noreferrer"
            title="외부 브라우저에서 열기"
            aria-label="외부 브라우저에서 열기"
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-gray-200 text-gray-700 transition hover:bg-gray-100 dark:border-gray-700 dark:text-gray-100 dark:hover:bg-gray-800"
          >
            <FontFreeIcon name="open_in_new" size={20} />
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
              <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-300">
                <FontFreeIcon name="error" size={27} />
              </div>
              <h2 className="mt-4 text-lg font-black">상품을 열 수 없습니다</h2>
              <p className="mt-2 break-keep text-sm leading-6 text-gray-600 dark:text-gray-300">{state.message}</p>
              <Link
                href="/shop"
                className="mt-5 inline-flex min-h-11 items-center justify-center rounded-lg bg-brand-orange-500 px-5 text-sm font-black text-white dark:bg-brand-neon-lime dark:text-brand-navy-900"
              >
                상품 목록으로
              </Link>
            </div>
          </div>
        )}

        {state.status === "ready" && (
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
      <div className="flex items-center gap-3 text-sm font-bold text-gray-600 dark:text-gray-300">
        <FontFreeIcon name="progress_activity" size={24} className="animate-spin text-brand-orange-500 dark:text-brand-neon-lime" />
        상품을 불러오고 있습니다
      </div>
    </div>
  );
}
