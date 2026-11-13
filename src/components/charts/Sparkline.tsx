// 카드용 작은 추이 그림(높이 32px) — 2026-11-13 대시보드 카드
// 큰 차트(LineChart·BarChart)는 축·호버가 있어 카드 안에서 너무 크다. 카드에서는 «흐름»만 보이면 된다.
// 정확한 숫자는 aria-label 과 «자세히 →»(통계 탭)에서 본다.
import { CHART_COLORS } from "./chartColors";

/** 선 하나(값이 없는 달은 건너뛴다). 값 범위 0~100(%) 기준 */
export default function Sparkline({
    values,
    labels,
    height = 32,
    color = CHART_COLORS.success,
    max = 100,
    ariaLabel,
}: {
    values: (number | null)[];
    labels?: string[];
    height?: number;
    color?: string;
    max?: number;
    ariaLabel?: string;
}) {
    const width = 120;
    const points = values
        .map((v, i) => (v === null ? null : { x: values.length > 1 ? (i / (values.length - 1)) * width : width / 2, y: height - 2 - (Math.max(0, Math.min(v, max)) / max) * (height - 4) }))
        .filter((p): p is { x: number; y: number } => p !== null);
    const summary = values.map((v, i) => `${labels?.[i] ?? i + 1} ${v === null ? "기록 없음" : v}`).join(", ");
    const last = points[points.length - 1];

    return (
        <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className="block w-full" style={{ height }} role="img" aria-label={`${ariaLabel ? `${ariaLabel}: ` : ""}${summary}`}>
            {points.length > 1 && (
                <polyline points={points.map((p) => `${p.x},${p.y}`).join(" ")} fill="none" stroke={color} strokeWidth={2} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
            )}
            {last && <circle cx={last.x} cy={last.y} r={2.5} fill={color} />}
        </svg>
    );
}

/** 월별 두 값을 나란히 세운 작은 막대(신규·퇴원). 높이 32px */
export function MiniPairBars({
    pairs,
    height = 32,
    colors = [CHART_COLORS.series, CHART_COLORS.danger],
    ariaLabel,
}: {
    pairs: { label: string; a: number; b: number }[];
    height?: number;
    colors?: [string, string];
    ariaLabel?: string;
}) {
    const max = Math.max(1, ...pairs.flatMap((p) => [p.a, p.b]));
    const summary = pairs.map((p) => `${p.label} ${p.a}·${p.b}`).join(", ");
    return (
        <div role="img" aria-label={`${ariaLabel ? `${ariaLabel}: ` : ""}${summary}`} className="flex items-end gap-1" style={{ height }}>
            {pairs.map((p) => (
                <div key={p.label} className="flex h-full flex-1 items-end justify-center gap-px" title={`${p.label} ${p.a}·${p.b}`}>
                    <span className="w-1/2 max-w-2 rounded-t-sm" style={{ height: `${(p.a / max) * 100}%`, minHeight: p.a > 0 ? 2 : 0, background: colors[0] }} />
                    <span className="w-1/2 max-w-2 rounded-t-sm" style={{ height: `${(p.b / max) * 100}%`, minHeight: p.b > 0 ? 2 : 0, background: colors[1] }} />
                </div>
            ))}
        </div>
    );
}
