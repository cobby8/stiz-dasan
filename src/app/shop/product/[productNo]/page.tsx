import type { Metadata } from "next";
import PublicSiteTheme from "@/components/PublicSiteTheme";
import ShopProductFrame from "./ShopProductFrame";

export const metadata: Metadata = {
  title: "상품 보기 | STIZ 농구교실 다산2호점",
  description: "스티즈 농구교실 다산2호점 클럽샵 상품을 확인하고 구매합니다.",
};

export default async function ShopProductPage({
  params,
}: {
  params: Promise<{ productNo: string }>;
}) {
  const { productNo } = await params;

  return <PublicSiteTheme><ShopProductFrame productNo={productNo} /></PublicSiteTheme>;
}
