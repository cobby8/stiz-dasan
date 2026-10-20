import { getAcademySettings } from "@/lib/queries";
import { getAvailableTrialSlots, getTrialLeadForEnrollByAccessCode } from "@/app/actions/public";
import PublicPageLayout from "@/components/PublicPageLayout";
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
            <section className="public-page-intro"><div className="public-container"><h1>수강 신청</h1><p>{trialData ? "체험수업 정보를 확인하고 추가 정보를 입력해 주세요." : "학생과 보호자, 희망 수업 정보를 입력해 주세요."}</p></div></section>

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
