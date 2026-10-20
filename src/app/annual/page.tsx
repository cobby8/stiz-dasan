import { getAcademySettings, getClasses, getAnnualEvents } from "@/lib/queries";
import { fetchGoogleCalendarEvents } from "@/lib/googleCalendar";
import {
    getMonthClassSchedule,
    computeClassDatesFromRange,
    parseAcademicYearMonth,
    WEEK_START_RE,
    OPEN_RE,
    CLOSE_RE,
    CLOSED_RE,
} from "@/lib/classSchedule";
import PublicPageLayout from "@/components/PublicPageLayout";
import AnnualEventsClient, { SerializedEvent } from "./AnnualEventsClient";
import AnimateOnScroll from "@/components/ui/AnimateOnScroll";
import CTABanner from "@/components/landing/CTABanner";
import { buildPublicMetadata } from "@/lib/publicMetadata";

// ISR: 5분 캐시 (Vercel 엣지 CDN 서빙). admin revalidatePath("/annual") 호출 시 즉각 무효화.
export const revalidate = 300;

export const metadata = buildPublicMetadata({
    title: "연간일정표 | STIZ 농구교실 다산2호점",
    description: "스티즈 농구교실 다산2호점 연간 행사 일정. 대회, 방학, 특별행사 및 정기 일정을 확인하세요.",
    path: "/annual",
});

const CATEGORY_STYLES: Record<string, { dot: string }> = {
    대회: { dot: "bg-orange-500" },
    방학: { dot: "bg-red-500" },
    특별행사: { dot: "bg-purple-500" },
    정기행사: { dot: "bg-blue-500" },
    일반: { dot: "bg-green-500" },
};

// Class.dayOfWeek("Mon","Tue"…) → JS getDay() 숫자
const DOW_MAP: Record<string, number> = { Sun:0, Mon:1, Tue:2, Wed:3, Thu:4, Fri:5, Sat:6 };

export default async function AnnualPage() {
    // DB 일정도 함께 조회하여 구글 캘린더 이벤트와 합침
    const [settings, classes, dbEvents] = await Promise.all([
        getAcademySettings() as Promise<any>,
        getClasses() as Promise<any[]>,
        getAnnualEvents() as Promise<any[]>,
    ]);

    const phone = settings.contactPhone || "010-0000-0000";
    const icsUrl = settings.googleCalendarIcsUrl as string | null;

    // 구글 캘린더 이벤트 fetch
    const googleEvents = icsUrl ? await fetchGoogleCalendarEvents(icsUrl) : [];

    // ── 구글 이벤트 직렬화 (Date → ISO string) ──
    const googleSerialized: SerializedEvent[] = googleEvents.map((e) => {
        // "n월 개강/종강/n주차" 이벤트는 제목의 n월을 수강월로 사용 (실제 날짜와 무관)
        const academicRE = OPEN_RE.test(e.title) ? OPEN_RE
                         : CLOSE_RE.test(e.title) ? CLOSE_RE
                         : WEEK_START_RE.test(e.title) ? WEEK_START_RE
                         : null;
        const parsed = academicRE ? parseAcademicYearMonth(e.title, academicRE, e.date) : null;
        return {
            id: e.id,
            title: e.title,
            date: e.date.toISOString(),
            endDate: e.endDate?.toISOString(),
            description: e.description,
            category: e.category,
            isAllDay: e.isAllDay,
            url: e.url,
            source: "google" as const,
            academicYear:  parsed?.academicYear,
            academicMonth: parsed?.academicMonth,
        };
    });

    // ── DB 이벤트를 동일 SerializedEvent 형식으로 변환 ──
    const dbSerialized: SerializedEvent[] = dbEvents.map((e: any) => ({
        id: String(e.id),
        title: e.title,
        date: new Date(e.date).toISOString(),
        endDate: e.endDate ? new Date(e.endDate).toISOString() : undefined,
        description: e.description ?? undefined,
        category: e.category ?? "일반",
        isAllDay: true,       // DB 이벤트는 기본 종일 이벤트 취급
        source: "db" as const,
    }));

    // ── 중복 제거: 같은 날짜(YYYY-MM-DD) + 제목이면 구글 이벤트 우선 ──
    // 구글 캘린더에 이미 등록된 일정을 관리자가 DB에도 넣은 경우를 방지
    const googleKeySet = new Set(
        googleSerialized.map((e) => `${e.date.slice(0, 10)}|${e.title}`)
    );
    const uniqueDbEvents = dbSerialized.filter(
        (e) => !googleKeySet.has(`${e.date.slice(0, 10)}|${e.title}`)
    );

    // ── 합치고 날짜순 정렬 ──
    const allEvents: SerializedEvent[] = [
        ...googleSerialized,
        ...uniqueDbEvents,
    ].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

    // ── 서버에서 월별 수업일자 계산 ──────────────────────────────────
    // 1. Class 레코드에서 수업 요일(숫자) 도출
    const classDays: number[] = [
        ...new Set(
            classes
                .map((c: any) => DOW_MAP[c.dayOfWeek])
                .filter((n: number | undefined) => n !== undefined)
        ),
    ].sort((a, b) => a - b);

    // ── 수업일자 계산 (두 방식 모두 지원) ────────────────────────────────────
    // yearlySchedules: { 수강연도: { 수강월(0-11): { 요일(0-6): [ISO날짜...] } } }
    const yearlySchedules: Record<number, Record<number, Record<number, string[]>>> = {};

    if (classDays.length > 0) {
        // 1. "학원 휴무" 이벤트 날짜 수집 (다일 이벤트 포함, UTC 기준)
        const closedDateSet = new Set<string>();
        for (const ev of allEvents) {
            if (!CLOSED_RE.test(ev.title)) continue;
            const start = new Date(ev.date);
            const end   = ev.endDate ? new Date(ev.endDate) : new Date(start);
            const cur   = new Date(start);
            while (cur.getTime() <= end.getTime()) {
                closedDateSet.add(`${cur.getUTCFullYear()}-${String(cur.getUTCMonth()+1).padStart(2,"0")}-${String(cur.getUTCDate()).padStart(2,"0")}`);
                cur.setUTCDate(cur.getUTCDate() + 1);
            }
        }

        // 2. "n월 개강 / n월 종강" 이벤트 수집 → 방식 A (범위 기반)
        const openByAYM:  Record<string, string> = {}; // key → ISO 개강일
        const closeByAYM: Record<string, string> = {}; // key → ISO 종강일
        for (const ev of allEvents) {
            for (const [re, store] of [[OPEN_RE, openByAYM], [CLOSE_RE, closeByAYM]] as const) {
                const parsed = parseAcademicYearMonth(ev.title, re, new Date(ev.date));
                if (parsed) store[`${parsed.academicYear}-${parsed.academicMonth}`] = ev.date.slice(0, 10);
            }
        }

        // 3. "n월 n주차 시작" 이벤트 수집 → 방식 B (fallback)
        const weekStartsByAYM: Record<string, { date: string }[]> = {};
        for (const ev of allEvents) {
            const parsed = parseAcademicYearMonth(ev.title, WEEK_START_RE, new Date(ev.date));
            if (!parsed) continue;
            const key = `${parsed.academicYear}-${parsed.academicMonth}`;
            if (!weekStartsByAYM[key]) weekStartsByAYM[key] = [];
            weekStartsByAYM[key].push({ date: ev.date });
        }

        // 4. 두 방식을 합쳐서 yearlySchedules 계산
        const allKeys = new Set([...Object.keys(openByAYM), ...Object.keys(weekStartsByAYM)]);
        for (const key of allKeys) {
            const [yearStr, monStr] = key.split("-");
            const year = Number(yearStr), mon = Number(monStr);
            if (!yearlySchedules[year]) yearlySchedules[year] = {};

            const allWeekdays = [1, 2, 3, 4, 5, 6]; // 월~토
            if (openByAYM[key] && closeByAYM[key]) {
                // 방식 A: 개강~종강 범위 기반 (공휴일 자동 제외)
                yearlySchedules[year][mon] = computeClassDatesFromRange(
                    openByAYM[key], closeByAYM[key], allWeekdays, closedDateSet,
                );
            } else if (weekStartsByAYM[key]) {
                // 방식 B: n주차 시작 이벤트 기반 (fallback)
                yearlySchedules[year][mon] = getMonthClassSchedule(
                    weekStartsByAYM[key], allWeekdays, closedDateSet,
                );
            }
        }
    }

    const categories = Object.keys(CATEGORY_STYLES);

    return (
        <PublicPageLayout>
            {/* 페이지 히어로 — about/programs/schedule과 동일한 그라데이션 + 장식 도형 패턴 */}
            <section className="relative overflow-hidden bg-gradient-to-br from-brand-navy-900 via-brand-navy-800 to-brand-navy-900 dark:from-black dark:via-gray-900 dark:to-black text-white py-12 md:py-14 transition-colors duration-300">
                {/* 배경 장식 도형들 */}
                <div className="absolute inset-0 pointer-events-none">
                    <div className="absolute right-0 top-0 w-72 h-72 border-[20px] border-white/5 dark:border-brand-neon-cobalt/10 rounded-full translate-x-1/3 -translate-y-1/3 transition-colors duration-300" />
                    <div className="absolute left-0 bottom-0 w-48 h-48 border-[15px] border-brand-orange-500/10 dark:border-brand-neon-lime/10 rounded-full -translate-x-1/4 translate-y-1/4 transition-colors duration-300" />
                </div>
                <div className="max-w-6xl mx-auto px-6 md:px-4 relative">
                    <AnimateOnScroll>
                        <p className="text-brand-orange-500 dark:text-brand-neon-lime text-sm font-bold uppercase tracking-widest mb-3">ANNUAL SCHEDULE</p>
                        <h1 className="text-4xl md:text-5xl font-black mb-4 break-keep">연간일정표</h1>
                        <p className="text-blue-200 text-lg max-w-xl">대회, 방학, 특별 행사 일정을 확인하세요.</p>
                    </AnimateOnScroll>
                </div>
            </section>

            {/* 범례(Legend) — 디자인 개선: pill 뱃지 스타일로 카테고리 표시 */}
            <section className="py-5 bg-white dark:bg-gray-900 border-b border-gray-100 dark:border-gray-800 transition-colors duration-300">
                <div className="max-w-6xl mx-auto px-4">
                    <div className="flex flex-wrap gap-2.5 items-center">
                        <span className="text-sm font-bold text-gray-400 mr-1">구분</span>
                        {categories.map((cat) => (
                            <div key={cat} className="inline-flex items-center gap-1.5 bg-gray-50 dark:bg-gray-800 px-3 py-1.5 rounded-full border border-gray-100 dark:border-gray-700 transition-colors">
                                <span className={`w-2.5 h-2.5 rounded-full ${CATEGORY_STYLES[cat].dot}`}></span>
                                <span className="text-xs font-bold text-gray-600 dark:text-gray-300">{cat}</span>
                            </div>
                        ))}
                    </div>
                </div>
            </section>

            {/* Events (Client Component - handles year filter, schedule toggle) */}
            <AnnualEventsClient
                allEvents={allEvents}
                classDays={classDays}
                yearlySchedules={yearlySchedules}
            />

            {/* CTA 배너 — 공통 CTABanner 재사용 */}
            <CTABanner
                title="더 궁금한 점이 있으신가요?"
                subtitle="일정에 대해 문의해 주시면 자세히 안내해 드립니다"
                phone={phone}
                primaryLabel="체험 수업 신청"
                primaryHref="/apply"
            />
        </PublicPageLayout>
    );
}
