import { getAcademySettings } from "@/lib/queries";
import { getAvailableTrialSlots, getTrialLeadForEnrollByAccessCode } from "@/app/actions/public";
import PublicPageLayout from "@/components/PublicPageLayout";
import AnimateOnScroll from "@/components/ui/AnimateOnScroll";
import EnrollApplicationForm from "./EnrollApplicationForm";
import { buildPublicMetadata } from "@/lib/publicMetadata";

export const revalidate = 60;

export const metadata = buildPublicMetadata({
    title: "수강 신청 | STIZ 농구교실 다산2호점",
    description: "스티즈 농구교실 다산2호점 수강 신청. 간단한 정보 입력으로 우리 아이의 농구 수업을 시작하세요.",
    path: "/apply/enroll",
    imageAlt: "STIZ 농구교실 다산2호점 수강 신청 미리보기",
});

export default async function EnrollApplyPage({
    searchParams,
}: {
    searchParams: Promise<{ access?: string; link?: string }>;
}) {
    const params = await searchParams;
    const accessCode = params.access || null;

    const [trialData, slots, settings] = await Promise.all([
        accessCode ? getTrialLeadForEnrollByAccessCode(accessCode) : Promise.resolve(null),
        getAvailableTrialSlots(),
        getAcademySettings() as Promise<any>,
    ]);

    // 수강신청은 항상 자체 신청 폼을 사용한다(외부 폼으로 리다이렉트하지 않는다).
    const phone = settings?.contactPhone || "010-0000-0000";

    return (
        <PublicPageLayout>
            <section className="relative overflow-hidden bg-gradient-to-br from-brand-navy-900 via-brand-navy-800 to-brand-navy-900 py-12 text-white md:py-16">
                <div className="pointer-events-none absolute inset-0">
                    <div className="absolute right-0 top-0 h-72 w-72 translate-x-1/3 -translate-y-1/3 rounded-full border-[20px] border-white/5 transition-colors duration-300 dark:border-brand-neon-cobalt/10" />
                    <div className="absolute bottom-0 left-0 h-48 w-48 -translate-x-1/4 translate-y-1/4 rounded-full border-[15px] border-brand-orange-500/10 transition-colors duration-300 dark:border-brand-neon-lime/10" />
                </div>
                <div className="relative mx-auto max-w-3xl px-6">
                    <AnimateOnScroll>
                        <p className="mb-3 text-sm font-bold uppercase tracking-widest text-brand-orange-500 dark:text-brand-neon-lime">ENROLLMENT</p>
                        <h1 className="mb-3 break-keep text-3xl font-black md:text-4xl">수강 신청</h1>
                        <p className="max-w-xl text-base text-blue-200">
                            {trialData
                                ? "체험수업 정보가 자동으로 채워졌습니다. 확인 후 추가 정보를 입력해주세요."
                                : "간단한 정보를 입력하고 원하는 수업 시간을 선택하세요."}
                        </p>
                    </AnimateOnScroll>
                </div>
            </section>

            <section className="bg-gray-50 py-8 dark:bg-gray-900 md:py-12">
                <div className="mx-auto max-w-2xl px-4">
                    <EnrollApplicationForm
                        availableSlots={slots}
                        contactPhone={phone}
                        trialData={trialData}
                        accessCode={accessCode}
                    />
                </div>
            </section>
        </PublicPageLayout>
    );
}
