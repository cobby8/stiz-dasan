// 비율 막대(가로 한 줄을 여러 칸으로 나눔) — 2026-11-13 대시보드·통계 개편
// 왜 CSS 인가: 칸 너비만 %로 나누면 되는 그림이라 SVG 계산이 필요 없고, 글자 크기·줄바꿈이 화면 폭을 따라간다.
// 색은 CHART_COLORS / var(--color-academy-*) 토큰만 받는다(하드코딩 색 금지).

export type StackedSegment = {
    label: string;
    value: number;
    /** var(--color-academy-*) 토큰 */
    color: string;
};

export default function StackedBar({
    segments,
    height = 10,
    showLegend = true,
    unit = "명",
    ariaLabel,
}: {
    segments: StackedSegment[];
    height?: number;
    showLegend?: boolean;
    unit?: string;
    /** 화면 낭독용 이름(예: «유니폼 상태 비율») */
    ariaLabel?: string;
}) {
    const total = segments.reduce((sum, s) => sum + Math.max(0, s.value), 0);
    // 화면 낭독기는 막대 그림 대신 이 문장을 읽는다
    const summary = segments.map((s) => `${s.label} ${s.value}${unit}`).join(", ");

    return (
        <div>
            <div
                role="img"
                aria-label={`${ariaLabel ? `${ariaLabel}: ` : ""}${summary}`}
                className="flex w-full overflow-hidden rounded-full bg-[var(--color-academy-soft)]"
                style={{ height }}
            >
                {total > 0 && segments.map((s) =>
                    s.value > 0 ? (
                        <div key={s.label} title={`${s.label} ${s.value}${unit}`} style={{ width: `${(s.value / total) * 100}%`, background: s.color }} />
                    ) : null,
                )}
            </div>
            {showLegend && (
                <ul className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-[var(--color-academy-muted)]">
                    {segments.map((s) => (
                        <li key={s.label} className="inline-flex items-center gap-1 tabular-nums">
                            <span className="inline-block h-2 w-2 shrink-0 rounded-sm" style={{ background: s.color }} aria-hidden="true" />
                            {s.label} <b className="font-bold text-[var(--color-academy-ink)]">{s.value}</b>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}
