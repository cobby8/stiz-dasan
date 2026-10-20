import { getAcademySettings, getClassSlotOverrides, getCustomClassSlots, getPrograms, getSheetSlotCache } from "@/lib/queries";
import { buildMergedSlots } from "@/lib/mergeSlots";
import { getScheduleSlotAdminData } from "@/lib/scheduleSlotPayload";
import PublicPageLayout from "@/components/PublicPageLayout";
import SimulatorClient from "./SimulatorClient";
import { buildPublicMetadata } from "@/lib/publicMetadata";
import { publicScheduleSlots } from "../schedule/publicSchedulePresentation";

// 공개 페이지이므로 5분 ISR 캐싱 (schedule 페이지와 동일)
export const revalidate = 300;
export const metadata = buildPublicMetadata({
    title: "우리 아이 수업 찾기 | STIZ 농구교실 다산2호점",
    description: "학년과 원하는 요일, 시간을 입력하면 등록 가능한 농구 수업을 자동으로 추천해드립니다.",
    path: "/simulator",
});

export default async function SimulatorPage() {
    // schedule/page.tsx와 동일하게 DB 시간표를 우선 사용하고, 없을 때만 시트 캐시로 fallback
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

    // 프로그램 정보 (이름 매칭용)
    const programList = (programs as any[]).map((p) => ({ id: p.id, name: p.name }));

    return (
        <PublicPageLayout>
            {/* 페이지 히어로 — 다른 서브페이지와 동일한 그라데이션 패턴 */}
            <section className="public-page-intro"><div className="public-container"><h1>우리 아이 수업 찾기</h1><p>학년과 원하는 요일·시간으로 가능한 수업을 찾아보세요.</p></div></section>

            {/* 위저드 UI (클라이언트 컴포넌트) */}
            <SimulatorClient
                allSlots={allSlots}
                programs={programList}
                phone={phone}
            />
        </PublicPageLayout>
    );
}
