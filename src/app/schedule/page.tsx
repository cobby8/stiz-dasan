import { getAcademySettings, getClassSlotOverrides, getCustomClassSlots, getPrograms, getSheetSlotCache } from "@/lib/queries";
import { buildMergedSlots } from "@/lib/mergeSlots";
import { getScheduleSlotAdminData } from "@/lib/scheduleSlotPayload";
import PublicPageLayout from "@/components/PublicPageLayout";
import ScheduleClient from "./ScheduleClient";
import CTABanner from "@/components/landing/CTABanner";
import { buildPublicMetadata } from "@/lib/publicMetadata";
import { publicScheduleSlots } from "./publicSchedulePresentation";

// searchParams 없음 → ISR 정적 캐싱 (5분) 활성화
// 프로그램 필터는 ScheduleClient(클라이언트)에서 useSearchParams()로 처리
export const revalidate = 300;
export const metadata = buildPublicMetadata({
    title: "수업시간표 | STIZ 농구교실 다산2호점",
    description: "스티즈 농구교실 다산2호점 요일별 수업 시간표와 프로그램별 클래스 시간을 확인하세요.",
    path: "/schedule",
});

export default async function SchedulePage() {
    const [settings, dbScheduleData, programs] = await Promise.all([
        getAcademySettings(),
        getScheduleSlotAdminData(),
        getPrograms(),
    ]);

    const phone = (settings as any).contactPhone || "010-0000-0000";

    const scheduleData = dbScheduleData ?? await (async () => {
        const [cachedSlots, overridesList, customSlotsList] = await Promise.all([
            getSheetSlotCache(),
            getClassSlotOverrides(),
            getCustomClassSlots(),
        ]);
        return {
            slots: cachedSlots ?? [],
            overrides: overridesList,
            customSlots: customSlotsList,
        };
    })();

    // 공통 함수로 시트 슬롯 + 오버라이드 + 커스텀 슬롯 병합
    const allSlots = publicScheduleSlots(buildMergedSlots(scheduleData.slots, scheduleData.overrides, scheduleData.customSlots));

    return (
        <PublicPageLayout>
            {/* 페이지 히어로 — about/programs와 동일한 그라데이션 + 장식 도형 패턴 */}
            <section className="public-page-intro"><div className="public-container"><h1>수업 시간표</h1><p>요일별 수업 시간과 담당 코치를 확인하세요.</p></div></section>

            {/* 필터 탭 + 시간표 그리드 (클라이언트 컴포넌트 — useSearchParams 사용) */}
            <ScheduleClient
                programs={(programs as any[]).filter((p) => allSlots.some((slot) => slot.programId === p.id)).map((p) => ({ id: p.id, name: p.name }))}
                allSlots={allSlots}
                phone={phone}
            />

            {/* CTA 배너 — 공통 CTABanner 재사용 */}
            <CTABanner
                title="원하시는 시간대가 없으신가요?"
                subtitle="문의해 주시면 최대한 맞춰드리겠습니다"
                phone={phone}
                primaryLabel="체험 수업 신청"
                primaryHref="/apply/trial"
            />
        </PublicPageLayout>
    );
}
