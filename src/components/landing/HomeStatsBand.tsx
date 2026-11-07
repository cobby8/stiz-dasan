// 홈 4단계 · 검정 숫자 띠(2026-11-07) — 숫자는 DB 실제 집계만 쓴다(getHomeStats). 재원생 수는 넣지 않는다.
// 예전 «안내 4칸»은 띠 아래 한 줄 글로 합쳤다.
export interface HomeStats {
    coaches: number;
    activeClasses: number;
    activeDays: number;
    programs: number;
}

const GUIDE = ["유아부터 성인까지", "평일·주말 수업", "기본기부터 실전까지", "평일 셔틀 상담"];

export default function HomeStatsBand({ stats }: { stats: HomeStats }) {
    const items = [
        { value: stats.coaches, unit: "명", label: "전문 코치" },
        { value: stats.activeClasses, unit: "개", label: "운영 중인 반" },
        { value: stats.activeDays, unit: "일", label: "주간 수업 요일", prefix: "주 " },
        { value: stats.programs, unit: "개", label: "프로그램" },
    ].filter((item) => item.value > 0);
    return (
        <section className="public-home-stats" aria-label="학원 한눈에 보기">
            <div className="public-home-stats__inner">
                {items.length > 0 && (
                    <ul>
                        {items.map((item) => (
                            <li key={item.label}>
                                <strong>{item.prefix}{item.value}<small>{item.unit}</small></strong>
                                <span>{item.label}</span>
                            </li>
                        ))}
                    </ul>
                )}
                <p>{GUIDE.join(" · ")}</p>
            </div>
        </section>
    );
}
