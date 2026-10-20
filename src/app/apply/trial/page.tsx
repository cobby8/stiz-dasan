import { getAcademySettings } from "@/lib/queries";
import { getAvailableTrialSlots } from "@/app/actions/public";
import PublicPageLayout from "@/components/PublicPageLayout";
import TrialApplicationForm from "./TrialApplicationForm";
import { buildPublicMetadata } from "@/lib/publicMetadata";

export const revalidate = 60;

export const metadata = buildPublicMetadata({
    title: "체험수업 신청 | STIZ 농구교실 다산2호점",
    description: "스티즈 농구교실 다산2호점 체험수업을 신청하세요. 빈자리가 있는 수업을 선택할 수 있습니다.",
    path: "/apply/trial",
    imageAlt: "STIZ 농구교실 다산2호점 체험수업 신청 미리보기",
});

export default async function TrialApplyPage({ searchParams }: { searchParams: Promise<{ utm_source?: string; utm_medium?: string }> }) {
    const params = await searchParams;
    const initialSource = params.utm_source?.toLowerCase() === "naver" && params.utm_medium?.toLowerCase() === "cpc" ? "NAVER_AD" : "";
    const [slots, settings] = await Promise.all([
        getAvailableTrialSlots(),
        getAcademySettings(),
    ]);

    // 체험수업은 항상 자체 신청 폼을 사용한다(외부 폼으로 리다이렉트하지 않는다).
    const phone = settings?.contactPhone || "010-0000-0000";

    return (
        <PublicPageLayout>
            <section className="public-page-intro"><div className="public-container"><h1>체험수업 신청</h1><p>원하는 수업과 학생 정보를 입력해 주세요.</p></div></section>

            <section className="bg-gray-50 py-8 dark:bg-gray-900 md:py-12">
                <div className="mx-auto max-w-2xl px-4">
                    <TrialApplicationForm availableSlots={slots} contactPhone={phone} initialSource={initialSource} />
                </div>
            </section>
        </PublicPageLayout>
    );
}
