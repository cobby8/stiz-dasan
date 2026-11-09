"use client";

import { CHART_COLORS } from "@/lib/ui/colorValues";

// 도넛 차트 컴포넌트 — 전환율, 수납률 등 비율 표시에 사용
// 순수 SVG로 구현, 중앙에 퍼센트 값 표시
interface DonutChartProps {
    value: number;         // 현재 값 (예: 전환된 수)
    max: number;           // 최대 값 (예: 전체 체험 수)
    label?: string;        // 중앙 하단 라벨
    color?: string;        // 도넛 색상 (hex)
    size?: number;         // SVG 크기 (px)
    strokeWidth?: number;  // 도넛 두께
}

export default function DonutChart({
    value,
    max,
    label = "",
    color = "var(--brand-accent)",
    size = 140,
    strokeWidth = 14,
}: DonutChartProps) {
    // 비율 계산 (0~100%)
    const rate = max > 0 ? Math.round((value / max) * 100) : 0;

    // SVG 원의 반지름과 둘레
    const center = size / 2;
    const radius = (size - strokeWidth) / 2;
    const circumference = 2 * Math.PI * radius;

    // 채워진 부분의 stroke-dashoffset 계산
    // dashoffset이 0이면 전부 채워짐, circumference이면 빈 원
    const offset = circumference - (rate / 100) * circumference;

    return (
        <div className="flex flex-col items-center gap-2">
            <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
                {/* 배경 원 (회색 트랙) */}
                <circle
                    cx={center}
                    cy={center}
                    r={radius}
                    fill="none"
                    stroke={CHART_COLORS.track}
                    strokeWidth={strokeWidth}
                />

                {/* 값 원 (컬러 트랙) — 12시 방향에서 시작하도록 회전 */}
                <circle
                    cx={center}
                    cy={center}
                    r={radius}
                    fill="none"
                    stroke={color}
                    strokeWidth={strokeWidth}
                    strokeLinecap="round"
                    strokeDasharray={circumference}
                    strokeDashoffset={offset}
                    transform={`rotate(-90 ${center} ${center})`}
                    className="transition-all duration-700 ease-out"
                />

                {/* 중앙 퍼센트 텍스트 */}
                <text
                    x={center}
                    y={center - 4}
                    textAnchor="middle"
                    dominantBaseline="middle"
                    fill={CHART_COLORS.center}
                    fontSize={size * 0.2}
                    fontWeight="800"
                >
                    {rate}%
                </text>

                {/* 중앙 하단 서브 텍스트 (value/max) */}
                <text
                    x={center}
                    y={center + size * 0.14}
                    textAnchor="middle"
                    dominantBaseline="middle"
                    fill={CHART_COLORS.axis}
                    fontSize={size * 0.09}
                >
                    {value}/{max}
                </text>
            </svg>

            {/* 라벨 */}
            {label && (
                <span className="text-xs font-medium text-gray-500 dark:text-gray-400">{label}</span>
            )}
        </div>
    );
}
