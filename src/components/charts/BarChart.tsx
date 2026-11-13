"use client";

import { useState } from "react";
import { CHART_COLORS } from "./chartColors";

// 막대 그래프 컴포넌트 — 반별 정원, 코치 워크로드 등에 사용
// 순수 SVG로 구현, 호버 시 값 표시
interface BarChartProps {
    // missing = 기록이 없는 칸(0 과 다르다 — 막대 대신 «–»), valueLabel = 막대 위에 늘 보일 값 글자(showValues 일 때)
    data: { label: string; value: number; max?: number; missing?: boolean; valueLabel?: string }[];
    color?: string;        // 막대 색상 (CHART_COLORS 값)
    height?: number;       // SVG 높이 (px)
    unit?: string;         // 값 뒤 단위
    showMax?: boolean;     // max 값 표시 여부 (정원 대비 등)
    // 2026-11-14 학부모 «아이 기록» 출석 막대: 휴대폰에서 글자가 12px 아래로 줄지 않게 그림 폭·글자 크기를 고를 수 있게 하고,
    // 마우스가 없는 휴대폰에서도 값이 보이게 막대 위에 값을 늘 적는다(기본값은 예전 그대로).
    viewWidth?: number;    // SVG 그림 폭(기본 500)
    fontSize?: number;     // 축·값 글자 크기(기본 10)
    showValues?: boolean;  // 막대 위 값 늘 보이기
}

export default function BarChart({
    data,
    color = CHART_COLORS.bar, // 기본: 중간 회색(뜻 없는 계열)
    height = 200,
    unit = "",
    showMax = false,
    viewWidth = 500,
    fontSize = 10,
    showValues = false,
}: BarChartProps) {
    const [hoverIndex, setHoverIndex] = useState<number | null>(null);

    if (data.length === 0) {
        return <p className="text-sm text-[var(--color-academy-faint)] py-8 text-center">데이터가 없습니다</p>;
    }

    // SVG 레이아웃
    const padding = { top: 20, right: 10, bottom: 30, left: 10 };
    const width = viewWidth;
    const chartW = width - padding.left - padding.right;
    const chartH = height - padding.top - padding.bottom;

    // Y축 최대값: max가 있으면 max 중 최대, 없으면 value 중 최대
    const yMax = Math.max(
        ...data.map((d) => (showMax && d.max ? d.max : d.value)),
        1
    ) * 1.1;

    // 막대 너비 계산 (간격 포함)
    const barGap = 8;
    const barWidth = Math.min(40, (chartW - barGap * (data.length + 1)) / data.length);
    const totalBarsWidth = data.length * barWidth + (data.length - 1) * barGap;
    const startX = padding.left + (chartW - totalBarsWidth) / 2;

    return (
        <svg viewBox={`0 0 ${width} ${height}`} className="w-full" preserveAspectRatio="xMidYMid meet">
            {/* Y축 가이드라인 */}
            {[0.25, 0.5, 0.75].map((ratio) => {
                const y = padding.top + chartH * (1 - ratio);
                return (
                    <line
                        key={ratio}
                        x1={padding.left}
                        y1={y}
                        x2={width - padding.right}
                        y2={y}
                        stroke={CHART_COLORS.grid}
                        strokeWidth="1"
                        strokeDasharray="4 4"
                    />
                );
            })}

            {data.map((d, i) => {
                const x = startX + i * (barWidth + barGap);
                const barH = (d.value / yMax) * chartH;
                const y = padding.top + chartH - barH;
                const isHovered = hoverIndex === i;

                // max가 있을 때 max 높이 배경 표시 (정원 대비)
                const maxH = d.max ? (d.max / yMax) * chartH : 0;
                const maxY = padding.top + chartH - maxH;

                return (
                    <g
                        key={i}
                        onMouseEnter={() => setHoverIndex(i)}
                        onMouseLeave={() => setHoverIndex(null)}
                    >
                        {/* max 배경 막대 (정원) */}
                        {showMax && d.max && (
                            <rect
                                x={x}
                                y={maxY}
                                width={barWidth}
                                height={maxH}
                                rx={4}
                                fill={CHART_COLORS.track}
                            />
                        )}

                        {/* 기록 없는 칸 — 막대 대신 «–» (0% 로 보이지 않게) */}
                        {d.missing && (
                            <text x={x + barWidth / 2} y={padding.top + chartH - 4} textAnchor="middle" fill={CHART_COLORS.axis} fontSize={fontSize}>–</text>
                        )}

                        {/* 막대 위 값(늘 보이기) */}
                        {showValues && !d.missing && (
                            <text x={x + barWidth / 2} y={Math.max(fontSize, y - 4)} textAnchor="middle" fill={CHART_COLORS.value} fontSize={fontSize} fontWeight="600">
                                {d.valueLabel ?? `${d.value.toLocaleString()}${unit}`}
                            </text>
                        )}

                        {/* 값 막대 */}
                        {!d.missing && <rect
                            x={x}
                            y={y}
                            width={barWidth}
                            height={Math.max(barH, 1)}
                            rx={4}
                            fill={color}
                            opacity={isHovered ? 1 : 0.8}
                            className="transition-opacity duration-150"
                        />}

                        {/* 호버 시 값 표시 */}
                        {isHovered && !showValues && !d.missing && (
                            <>
                                <rect
                                    x={x + barWidth / 2 - 30}
                                    y={y - 26}
                                    width="60"
                                    height="20"
                                    rx="4"
                                    fill={CHART_COLORS.tooltip}
                                    opacity="0.9"
                                />
                                <text
                                    x={x + barWidth / 2}
                                    y={y - 12}
                                    textAnchor="middle"
                                    fill="white"
                                    fontSize="11"
                                    fontWeight="600"
                                >
                                    {d.value.toLocaleString()}{unit}{showMax && d.max ? `/${d.max}` : ""}
                                </text>
                            </>
                        )}

                        {/* X축 라벨 */}
                        <text
                            x={x + barWidth / 2}
                            y={height - 6}
                            textAnchor="middle"
                            fill={CHART_COLORS.axis}
                            fontSize={fontSize}
                        >
                            {d.label}
                        </text>
                    </g>
                );
            })}
        </svg>
    );
}
