import { getAcademySettings, getClassSlotOverrides, getCustomClassSlots, getPrograms, getSheetSlotCache } from "@/lib/queries";
import { buildMergedSlots } from "@/lib/mergeSlots";
import { getScheduleSlotAdminData } from "@/lib/scheduleSlotPayload";
import PublicPageLayout from "@/components/PublicPageLayout";
import ScheduleClient from "./ScheduleClient";
import AnimateOnScroll from "@/components/ui/AnimateOnScroll";
import CTABanner from "@/components/landing/CTABanner";
import { buildPublicMetadata } from "@/lib/publicMetadata";

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
    const allSlots = buildMergedSlots(scheduleData.slots, scheduleData.overrides, scheduleData.customSlots);

    return (
        <PublicPageLayout>
            {/* 페이지 히어로 — about/programs와 동일한 그라데이션 + 장식 도형 패턴 */}
            <section className="relative overflow-hidden bg-gradient-to-br from-brand-navy-900 via-brand-navy-800 to-brand-navy-900 dark:from-black dark:via-gray-900 dark:to-black text-white py-12 md:py-14 transition-colors duration-300">
                {/* 배경 장식 도형들 — 시각적 깊이감 */}
                <div className="absolute inset-0 pointer-events-none">
                    <div className="absolute right-0 top-0 w-72 h-72 border-[20px] border-white/5 dark:border-brand-neon-cobalt/10 rounded-full translate-x-1/3 -translate-y-1/3 transition-colors duration-300" />
                    <div className="absolute left-0 bottom-0 w-48 h-48 border-[15px] border-brand-orange-500/10 dark:border-brand-neon-lime/10 rounded-full -translate-x-1/4 translate-y-1/4 transition-colors duration-300" />
                </div>
                <div className="max-w-6xl mx-auto px-6 md:px-4 relative">
                    <AnimateOnScroll>
                        <p className="text-brand-orange-500 dark:text-brand-neon-lime text-sm font-bold uppercase tracking-widest mb-3">SCHEDULE</p>
                        <h1 className="text-4xl md:text-5xl font-black mb-4 break-keep">수업시간표</h1>
                        <p className="text-blue-200 text-lg max-w-xl">요일별 수업 시간과 담당 코치를 확인하세요.</p>
                    </AnimateOnScroll>
                </div>
            </section>

            {/* 필터 탭 + 시간표 그리드 (클라이언트 컴포넌트 — useSearchParams 사용) */}
            <ScheduleClient
                programs={(programs as any[]).map((p) => ({ id: p.id, name: p.name }))}
                allSlots={allSlots}
                phone={phone}
            />

            {/* CTA 배너 — 공통 CTABanner 재사용 */}
            <CTABanner
                title="원하시는 시간대가 없으신가요?"
                subtitle="문의해 주시면 최대한 맞춰드리겠습니다"
                phone={phone}
                primaryLabel="체험 수업 신청"
                primaryHref="/apply"
            />
        </PublicPageLayout>
    );
}
