import PublicPageLayout from "@/components/PublicPageLayout";
import AnimateOnScroll from "@/components/ui/AnimateOnScroll";
import { buildPublicMetadata } from "@/lib/publicMetadata";
import UniformApplicationForm from "./UniformApplicationForm";

export const revalidate = 60;

export const metadata = buildPublicMetadata({
  title: "유니폼 추가주문 신청 | STIZ 농구교실 다산2호점",
  description: "스티즈 농구교실 다산2호점 유니폼 추가주문을 신청하세요. 형제·자매도 한 번에 접수할 수 있습니다.",
  path: "/apply/uniform",
  imageAlt: "STIZ 농구교실 다산2호점 유니폼 추가주문 신청 미리보기",
});

export default function UniformApplyPage() {
  return (
    <PublicPageLayout>
      <section className="public-page-hero public-page-hero--compact relative overflow-hidden bg-gradient-to-br from-brand-navy-900 via-brand-navy-800 to-brand-navy-900 py-12 text-white md:py-16">
        <div className="relative mx-auto max-w-3xl px-6">
          <AnimateOnScroll>
            <h1 className="mb-3 break-keep text-3xl font-black md:text-4xl">유니폼 추가주문 신청</h1>
            <p className="max-w-xl text-base text-blue-200">
              학부모 정보와 학생별 디자인, 이니셜, 사이즈를 남겨주세요. 형제·자매는 한 신청서에 함께 접수됩니다.
            </p>
          </AnimateOnScroll>
        </div>
      </section>

      <section className="public-content-section bg-gray-50 py-8 dark:bg-gray-900 md:py-12">
        <div className="mx-auto max-w-3xl px-4">
          <UniformApplicationForm />
        </div>
      </section>
    </PublicPageLayout>
  );
}
