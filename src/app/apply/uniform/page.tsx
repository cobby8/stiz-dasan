import PublicPageLayout from "@/components/PublicPageLayout";
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
      <section className="public-page-intro"><div className="public-container"><h1>유니폼 추가 주문</h1><p>형제·자매 유니폼도 한 번에 신청할 수 있습니다.</p></div></section>

      <section className="bg-gray-50 py-8 dark:bg-gray-900 md:py-12">
        <div className="mx-auto max-w-3xl px-4">
          <UniformApplicationForm />
        </div>
      </section>
    </PublicPageLayout>
  );
}
