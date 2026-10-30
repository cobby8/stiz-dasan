import PublicPageLayout from "@/components/PublicPageLayout";
import AnimateOnScroll from "@/components/ui/AnimateOnScroll";
import { buildPublicMetadata } from "@/lib/publicMetadata";
import HqSellerNotice from "@/components/HqSellerNotice";
import ClubShopClient from "./ClubShopClient";

export const revalidate = 60;

export const metadata = buildPublicMetadata({
  title: "SHOP | STIZ 농구교실 다산2호점",
  description: "스티즈 농구교실 다산2호점 클럽샵에서 농구공, 훈련 용품, 키즈 제품을 둘러보세요.",
  path: "/shop",
  imageAlt: "STIZ 농구교실 다산2호점 클럽샵 미리보기",
});

export default function ShopPage() {
  return (
    <PublicPageLayout>
      <section className="public-page-hero public-page-hero--compact relative overflow-hidden bg-gradient-to-br from-brand-navy-900 via-brand-navy-800 to-brand-navy-900 py-12 text-white md:py-16">
        <div className="relative mx-auto max-w-5xl px-6">
          <AnimateOnScroll>
            <h1 className="break-keep text-3xl font-black md:text-4xl">스티즈 클럽샵</h1>
          </AnimateOnScroll>
        </div>
      </section>

      <section className="public-content-section bg-gray-50 py-6 dark:bg-gray-900 md:py-8">
        <div className="mx-auto max-w-5xl px-4">
          {/* 실제 판매자(본사) 표시 — 학원 사업자와 구분 */}
          <HqSellerNotice />
          <ClubShopClient />
        </div>
      </section>
    </PublicPageLayout>
  );
}
