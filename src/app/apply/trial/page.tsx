import { getAcademySettings } from "@/lib/queries";
import { getAvailableTrialSlots } from "@/app/actions/public";
import PublicPageLayout from "@/components/PublicPageLayout";
import AnimateOnScroll from "@/components/ui/AnimateOnScroll";
import TrialApplicationForm from "./TrialApplicationForm";
import { buildPublicMetadata } from "@/lib/publicMetadata";
import { getTrialFeePublicInfo } from "@/lib/trial-fee/trialFeePaymentService";
import { initialTrialScheduleFromQuery } from "./trialScheduleSelection";

export const revalidate = 60;

export const metadata = buildPublicMetadata({
    title: "체험수업 신청 | STIZ 농구교실 다산2호점",
    description: "스티즈 농구교실 다산2호점 체험수업을 신청하세요. 빈자리가 있는 수업을 선택할 수 있습니다.",
    path: "/apply/trial",
    imageAlt: "STIZ 농구교실 다산2호점 체험수업 신청 미리보기",
});

export default async function TrialApplyPage({ searchParams }: { searchParams: Promise<{ utm_source?: string; utm_medium?: string; day?: string; slot?: string }> }) {
    const params = await searchParams;
    const initialSource = params.utm_source?.toLowerCase() === "naver" && params.utm_medium?.toLowerCase() === "cpc" ? "NAVER_AD" : "";
    const [slots, settings, trialFee] = await Promise.all([
        getAvailableTrialSlots(),
        getAcademySettings(),
        // 체험비 금액(설정값)·온라인 결제 가능 여부 — 꺼져 있으면 예전 계좌 안내
        getTrialFeePublicInfo(),
    ]);

    // 체험수업은 항상 자체 신청 폼을 사용한다(외부 폼으로 리다이렉트하지 않는다).
    const phone = settings?.contactPhone || "010-0000-0000";
    // 시간표 카드의 «체험 신청»으로 들어오면 그 수업의 요일·교시를 초기값으로 넘긴다(없는 수업·마감이면 무시).
    const initialSchedule = initialTrialScheduleFromQuery(params.day, params.slot, slots);

    return (
        <PublicPageLayout>
            <section className="public-page-hero public-page-hero--compact relative overflow-hidden bg-gradient-to-br from-[var(--color-public-dark)] via-[var(--color-public-dark)] to-[var(--color-public-dark)] py-12 text-white md:py-16">
                <div className="relative mx-auto max-w-3xl px-6">
                    <AnimateOnScroll>
                        <h1 className="mb-3 break-keep text-3xl font-black md:text-4xl">체험수업 신청</h1>
                        <p className="max-w-xl text-base text-blue-200">간단한 정보를 입력하고 원하는 수업 시간을 선택하세요.</p>
                    </AnimateOnScroll>
                </div>
            </section>

            <section className="public-content-section bg-[var(--color-public-tint)] py-8 dark:bg-[var(--color-public-paper)] md:py-12">
                <div className="mx-auto max-w-2xl px-4">
                    <TrialApplicationForm availableSlots={slots} contactPhone={phone} initialSource={initialSource} trialFee={trialFee} initialSchedule={initialSchedule} />
                </div>
            </section>
        </PublicPageLayout>
    );
}
