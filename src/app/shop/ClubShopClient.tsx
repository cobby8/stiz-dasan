"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import FontFreeIcon, { type FontFreeIconName } from "@/components/ui/FontFreeIcon";

type ClubShopProduct = {
  productNo: number;
  name: string;
  price: number;
  image: string;
  url: string;
  purchasable: boolean;
  state: string;
};

type ClubShopResponse = {
  success?: boolean;
  club?: string;
  label?: string;
  count?: number;
  products?: ClubShopProduct[];
  source?: string;
  fetchedAt?: string;
  error?: string;
  missingEnv?: string[];
};

type ShopLoadState = {
  status: "loading" | "ready" | "unavailable";
  statusCode: number | null;
  data: ClubShopResponse | null;
};

function formatPrice(price: number) {
  return `${price.toLocaleString("ko-KR")}원`;
}

function shopMessage(state: ShopLoadState): { icon: FontFreeIconName; title: string; body: string } {
  const error = state.data?.error || "";
  const missingEnv = Boolean(state.data?.missingEnv?.length);

  if (state.statusCode === 503 || missingEnv) {
    return {
      icon: "auto_fix_high",
      title: "클럽샵 준비 중입니다",
      body: "본사에서 다산2호점 진열대를 연결하면 상품이 자동으로 표시됩니다.",
    };
  }

  if (state.statusCode === 400 || state.statusCode === 404 || error.includes("상품을 찾을 수 없습니다")) {
    return {
      icon: "image",
      title: "클럽샵 상품을 준비 중입니다",
      body: "현재 다산2호점에 노출할 상품을 본사에서 확인하고 있습니다. 준비되면 이 화면에 바로 나타납니다.",
    };
  }

  return {
    icon: "error",
    title: "잠시 후 다시 시도해 주세요",
    body: "상품 정보를 불러오는 중 문제가 생겼습니다. 결제나 주문은 실행되지 않았습니다.",
  };
}

export default function ClubShopClient() {
  const [state, setState] = useState<ShopLoadState>({
    status: "loading",
    statusCode: null,
    data: null,
  });

  useEffect(() => {
    let cancelled = false;

    async function loadProducts() {
      setState({ status: "loading", statusCode: null, data: null });
      try {
        const response = await fetch("/api/products/club-shop", {
          headers: { Accept: "application/json" },
        });
        const data = await response.json().catch(() => ({
          success: false,
          error: "상품 정보 형식이 올바르지 않습니다.",
        })) as ClubShopResponse;
        const products = Array.isArray(data.products) ? data.products : [];

        if (!cancelled) {
          setState({
            status: response.ok && data.success === true && products.length > 0 ? "ready" : "unavailable",
            statusCode: response.status,
            data: { ...data, products },
          });
        }
      } catch {
        if (!cancelled) {
          setState({
            status: "unavailable",
            statusCode: null,
            data: { success: false, error: "클럽샵 상품 정보를 불러오지 못했습니다.", products: [] },
          });
        }
      }
    }

    loadProducts();
    return () => {
      cancelled = true;
    };
  }, []);

  const products = useMemo(
    () => (state.data?.products ?? []).filter((product) => product.purchasable && Boolean(product.url)),
    [state.data?.products],
  );

  return (
    <section aria-label="클럽샵 상품 목록">
      <div>
        {state.status === "loading" && <ShopSkeleton />}

        {state.status === "unavailable" && (
          <ShopNotice {...shopMessage(state)} onRetry={() => window.location.reload()} />
        )}

        {state.status === "ready" && products.length === 0 && (
          <ShopNotice
            icon="sports_basketball"
            title="판매 가능한 상품을 준비 중입니다"
            onRetry={() => window.location.reload()}
          />
        )}

        {state.status === "ready" && products.length > 0 && (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {products.map((product) => (
              <ProductCard key={product.productNo} product={product} />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function ProductCard({ product }: { product: ClubShopProduct }) {
  const disabled = !product.purchasable || !product.url;
  const stateLabel = product.state.trim();
  const detailHref = `/shop/product/${product.productNo}`;

  return (
    <article className="public-card min-w-0 overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm transition hover:-translate-y-0.5 hover:shadow-md dark:border-gray-700 dark:bg-gray-800">
      {disabled ? (
        <ProductImage src={product.image} name={product.name} />
      ) : (
        <Link href={detailHref} aria-label={`${product.name} 상품 보기`}>
          <ProductImage src={product.image} name={product.name} />
        </Link>
      )}
      <div className="space-y-3 p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="break-keep text-base font-black text-gray-950 dark:text-white">{product.name}</h3>
          </div>
          {stateLabel && (
            <span className="shrink-0 rounded-full bg-gray-100 px-2.5 py-1 text-xs font-black text-gray-600 dark:bg-gray-800 dark:text-gray-300">
              {stateLabel}
            </span>
          )}
        </div>

        <p className="text-xl font-black text-gray-950 dark:text-white">{formatPrice(product.price)}</p>

        {disabled ? (
          <span className="flex min-h-11 items-center justify-center rounded-xl bg-gray-100 text-sm font-black text-gray-400 dark:bg-gray-800 dark:text-gray-500">
            구매 불가
          </span>
        ) : (
          <Link
            href={detailHref}
            className="flex min-h-11 items-center justify-center gap-2 rounded-lg bg-brand-orange-500 text-sm font-black text-white transition hover:bg-brand-orange-600 dark:bg-brand-neon-lime dark:text-brand-navy-900 dark:hover:bg-lime-400"
          >
            상품 보기
            <FontFreeIcon name="arrow_forward" size={18} />
          </Link>
        )}
      </div>
    </article>
  );
}

function ProductImage({ src, name }: { src: string; name: string }) {
  const [failed, setFailed] = useState(!src);

  return (
    <div className="relative aspect-[4/3] overflow-hidden bg-gray-100 dark:bg-gray-950">
      {!failed && (
        <img
          src={src}
          alt={name}
          className="h-full w-full object-cover"
          loading="lazy"
          onError={() => setFailed(true)}
        />
      )}
      {failed && (
        <div className="flex h-full w-full flex-col items-center justify-center gap-3 bg-[linear-gradient(135deg,var(--color-public-ink),var(--color-public-accent))] p-5 text-center text-white ">
          <img src="/stiz-logo.png" alt="" className="h-12 w-auto rounded bg-white p-2" />
          <p className="break-keep text-sm font-black">상품 이미지 준비 중</p>
        </div>
      )}
    </div>
  );
}

function ShopSkeleton() {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {[0, 1, 2].map((item) => (
        <div key={item} className="overflow-hidden rounded-2xl border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900">
          <div className="aspect-[4/3] animate-pulse bg-gray-100 dark:bg-gray-800" />
          <div className="space-y-3 p-4">
            <div className="h-4 w-3/4 animate-pulse rounded bg-gray-100 dark:bg-gray-800" />
            <div className="h-6 w-1/2 animate-pulse rounded bg-gray-100 dark:bg-gray-800" />
            <div className="h-11 animate-pulse rounded-xl bg-gray-100 dark:bg-gray-800" />
          </div>
        </div>
      ))}
    </div>
  );
}

function ShopNotice({
  icon,
  title,
  body,
  onRetry,
}: {
  icon: FontFreeIconName;
  title: string;
  body?: string;
  onRetry: () => void;
}) {
  return (
    <div className="rounded-2xl border border-dashed border-gray-300 bg-gray-50 px-5 py-8 text-center dark:border-gray-700 dark:bg-gray-900">
      <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-white text-brand-orange-500 shadow-sm dark:bg-gray-800 dark:text-brand-neon-lime">
        <FontFreeIcon name={icon} size={28} />
      </div>
      <h3 className="mt-4 break-keep text-xl font-black text-gray-950 dark:text-white">{title}</h3>
      {body && <p className="mx-auto mt-2 max-w-md break-keep text-sm leading-6 text-gray-600 dark:text-gray-300">{body}</p>}
      <button
        type="button"
        onClick={onRetry}
        className="mt-5 inline-flex min-h-10 items-center justify-center gap-2 rounded-xl border border-gray-200 bg-white px-4 text-sm font-black text-gray-700 transition hover:bg-gray-100 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100 dark:hover:bg-gray-950"
      >
        <FontFreeIcon name="sync" size={18} />
        다시 확인
      </button>
    </div>
  );
}
