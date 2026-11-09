"use client";

import { useState } from "react";
import { CHART_COLORS } from "@/lib/ui/colorValues";

// 선 그래프 컴포넌트 — 매출 추이, 출석률 추이 등에 사용
// 순수 SVG로 구현하여 외부 라이브러리 의존 없음
interface LineChartProps {
    data: { label: string; value: number }[];
    color?: string;       // 선 색상 (Tailwind color 이름이 아닌 hex/rgb)
    height?: number;      // SVG 높이 (px)
    unit?: string;        // 값 뒤에 붙는 단위 (예: "원", "%")
    formatValue?: (v: number) => string; // 값 포맷터 (커스텀)
}

export default function LineChart({
    data,
    color = "var(--brand-accent)",    // 기본: 테마별 브랜드 강조색
    height = 200,
    unit = "",
    formatValue,
}: LineChartProps) {
    // 호버된 데이터 포인트 인덱스
    const [hoverIndex, setHoverIndex] = useState<number | null>(null);

    if (data.length === 0) {
        return <p className="text-sm text-gray-400 py-8 text-center">데이터가 없습니다</p>;
    }

    // SVG 레이아웃 상수
    const padding = { top: 20, right: 20, bottom: 30, left: 10 };
    const width = 500;
    const chartW = width - padding.left - padding.right;
    const chartH = height - padding.top - padding.bottom;

    // Y축 범위 계산 (최소 0, 최대는 데이터 최대값의 1.1배)
    const maxVal = Math.max(...data.map((d) => d.value), 1);
    const yMax = maxVal * 1.1;

    // 데이터 포인트를 SVG 좌표로 변환
    const points = data.map((d, i) => ({
        x: padding.left + (data.length > 1 ? (i / (data.length - 1)) * chartW : chartW / 2),
        y: padding.top + chartH - (d.value / yMax) * chartH,
        ...d,
    }));

    // SVG path의 d 속성 — 직선 연결
    const linePath = points.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`).join(" ");
    const gradientId = `lineGrad-${color.replace(/[^a-zA-Z0-9_-]/g, "") || "accent"}`;

    // 영역 채우기용 path (선 아래 그라데이션)
    const areaPath = `${linePath} L ${points[points.length - 1].x} ${padding.top + chartH} L ${points[0].x} ${padding.top + chartH} Z`;

    // 값 포맷 함수
    const fmt = formatValue ?? ((v: number) => `${v.toLocaleString()}${unit}`);

    return (
        <svg viewBox={`0 0 ${width} ${height}`} className="w-full" preserveAspectRatio="xMidYMid meet">
            {/* 그라데이션 정의 */}
            <defs>
                <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={color} stopOpacity="0.2" />
                    <stop offset="100%" stopColor={color} stopOpacity="0.02" />
                </linearGradient>
            </defs>

            {/* Y축 가이드라인 (수평 점선 3개) */}
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

            {/* 영역 채우기 */}
            <path d={areaPath} fill={`url(#${gradientId})`} />

            {/* 선 */}
            <path d={linePath} fill="none" stroke={color} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />

            {/* 데이터 포인트 (원) */}
            {points.map((p, i) => (
                <g key={i}>
                    {/* 호버 감지 영역 (넓은 투명 원) */}
                    <circle
                        cx={p.x}
                        cy={p.y}
                        r={16}
                        fill="transparent"
                        onMouseEnter={() => setHoverIndex(i)}
                        onMouseLeave={() => setHoverIndex(null)}
                    />
                    {/* 실제 포인트 */}
                    <circle
                        cx={p.x}
                        cy={p.y}
                        r={hoverIndex === i ? 5 : 3}
                        fill={hoverIndex === i ? color : "white"}
                        stroke={color}
                        strokeWidth="2"
                        className="transition-all duration-150"
                    />
                </g>
            ))}

            {/* 호버 시 툴팁 */}
            {hoverIndex !== null && points[hoverIndex] && (
                <g>
                    {/* 수직 가이드라인 */}
                    <line
                        x1={points[hoverIndex].x}
                        y1={padding.top}
                        x2={points[hoverIndex].x}
                        y2={padding.top + chartH}
                        stroke={color}
                        strokeWidth="1"
                        strokeDasharray="3 3"
                        opacity="0.5"
                    />
                    {/* 툴팁 박스 */}
                    <rect
                        x={Math.min(points[hoverIndex].x - 40, width - 90)}
                        y={Math.max(points[hoverIndex].y - 32, 2)}
                        width="80"
                        height="22"
                        rx="4"
                        fill={CHART_COLORS.label}
                        opacity="0.9"
                    />
                    <text
                        x={Math.min(points[hoverIndex].x, width - 50)}
                        y={Math.max(points[hoverIndex].y - 17, 17)}
                        textAnchor="middle"
                        fill="white"
                        fontSize="11"
                        fontWeight="600"
                    >
                        {fmt(points[hoverIndex].value)}
                    </text>
                </g>
            )}

            {/* X축 라벨 */}
            {points.map((p, i) => (
                <text
                    key={i}
                    x={p.x}
                    y={height - 6}
                    textAnchor="middle"
                    fill={CHART_COLORS.axis}
                    fontSize="11"
                >
                    {p.label}
                </text>
            ))}
        </svg>
    );
}
