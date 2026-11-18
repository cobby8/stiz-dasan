import { getAcademySettings } from "@/lib/queries";
import { getAvailableTrialSlots } from "@/app/actions/public";
import PublicPageLayout from "@/components/PublicPageLayout";
import AnimateOnScroll from "@/components/ui/AnimateOnScroll";
import { buildPublicMetadata } from "@/lib/publicMetadata";
import TrialManageClient from "./TrialManageClient";

export const revalidate = 60;

export const metadata = {
    ...buildPublicMetadata({
        title: "체험 신청 확인·변경 | STIZ 농구교실 다산2호점",
        description: "체험수업 신청 때 적은 아이 이름과 휴대폰 번호로 신청을 확인하고 일정 변경·취소를 할 수 있습니다.",
        path: "/apply/trial/manage",
        imageAlt: "STIZ 농구교실 다산2호점 체험 신청 확인",
    }),
    // 개인 신청 조회 화면이라 검색에 싣지 않는다
    robots: { index: false, follow: false },
};

export default async function TrialManagePage() {
    const [slots, settings] = await Promise.all([getAvailableTrialSlots(), getAcademySettings()]);
    const phone = settings?.contactPhone || "010-0000-0000";

    return (
        <PublicPageLayout>
            <section className="public-page-hero public-page-hero--compact relative overflow-hidden bg-gradient-to-br from-[var(--color-public-dark)] via-[var(--color-public-dark)] to-[var(--color-public-dark)] py-12 text-white md:py-16">
                <div className="relative mx-auto max-w-3xl px-6">
                    <AnimateOnScroll>
                        <h1 className="mb-3 break-keep text-3xl font-[700] md:text-4xl">체험 신청 확인·변경</h1>
                        <p className="max-w-xl text-base text-white/80">신청할 때 적은 아이 이름과 휴대폰 번호로 신청을 불러와 일정을 바꾸거나 취소할 수 있어요.</p>
                    </AnimateOnScroll>
                </div>
            </section>

            <section className="public-content-section bg-[var(--color-public-tint)] py-8 dark:bg-[var(--color-public-paper)] md:py-12">
                <div className="mx-auto max-w-2xl px-4">
                    <TrialManageClient availableSlots={slots} contactPhone={phone} />
                </div>
            </section>
        </PublicPageLayout>
    );
}
