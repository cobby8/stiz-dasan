import PublicPageLayout from "@/components/PublicPageLayout";
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
      <section className="public-page-intro">
        <div className="public-container">
          <h1>스티즈 클럽샵</h1>
          <p>농구용품과 클럽 상품을 둘러보세요.</p>
        </div>
      </section>

      <section className="public-section !py-6">
        <div className="public-container !max-w-5xl">
          {/* 실제 판매자(본사) 표시 — 학원 사업자와 구분 */}
          <HqSellerNotice />
          <ClubShopClient />
        </div>
      </section>
    </PublicPageLayout>
  );
}
