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
      <section className="relative overflow-hidden bg-gradient-to-br from-brand-navy-900 via-brand-navy-800 to-brand-navy-900 py-12 text-white md:py-16">
        <div className="pointer-events-none absolute inset-0">
          <div className="absolute right-0 top-0 h-72 w-72 translate-x-1/3 -translate-y-1/3 rounded-full border-[20px] border-white/5 transition-colors duration-300 dark:border-brand-neon-cobalt/10" />
          <div className="absolute bottom-0 left-0 h-48 w-48 -translate-x-1/4 translate-y-1/4 rounded-full border-[15px] border-brand-orange-500/10 transition-colors duration-300 dark:border-brand-neon-lime/10" />
        </div>
        <div className="relative mx-auto max-w-5xl px-6">
          <AnimateOnScroll>
            <p className="mb-3 text-sm font-bold uppercase tracking-widest text-brand-orange-500 dark:text-brand-neon-lime">SHOP</p>
            <h1 className="break-keep text-3xl font-black md:text-4xl">스티즈 클럽샵</h1>
          </AnimateOnScroll>
        </div>
      </section>

      <section className="bg-gray-50 py-6 dark:bg-gray-900 md:py-8">
        <div className="mx-auto max-w-5xl px-4">
          {/* 실제 판매자(본사) 표시 — 학원 사업자와 구분 */}
          <HqSellerNotice />
          <ClubShopClient />
        </div>
      </section>
    </PublicPageLayout>
  );
}
