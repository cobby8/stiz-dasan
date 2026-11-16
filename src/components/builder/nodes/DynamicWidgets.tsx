"use client";
import React from "react";
import { useNode } from "@craftjs/core";
import { useLandingData } from "../LandingPageDataContext";

function SymbolIcon({
    name,
    size = 18,
    className = "",
}: {
    name: string;
    size?: number;
    className?: string;
}) {
    return (
        <span
            className={`material-symbols-outlined leading-none ${className}`}
            style={{ fontSize: `${size}px` }}
            aria-hidden="true"
        >
            {name}
        </span>
    );
}

// Placeholder component for purely admin view when no data is provided or explicitly requested
const PlaceholderBox = ({ icon, title, desc, connect, drag, selected }: any) => (
    <div
        ref={(ref) => { if (ref) connect(drag(ref)); }}
        style={{ outline: selected ? "2px solid #ea580c" : "none" }}
        className="p-8 bg-gray-50 dark:bg-gray-900 border-2 border-dashed border-gray-300 rounded flex flex-col items-center justify-center text-gray-500 dark:text-gray-400 w-full my-4"
    >
        {icon}
        <span className="font-bold">{title}</span>
        <span className="text-sm mt-1">{desc}</span>
    </div>
);

// ---------------------------------------------
// 1. Programs Widget
// ---------------------------------------------
export const ProgramsWidget = () => {
    const { connectors: { connect, drag }, selected } = useNode((node) => ({
        selected: node.events.selected,
    }));
    const { programs, isEditor } = useLandingData();

    if (isEditor) {
        return <PlaceholderBox
            connect={connect} drag={drag} selected={selected}
            icon={<SymbolIcon name="emoji_events" size={48} className="mb-3 text-brand-orange-500 dark:text-brand-neon-lime" />}
            title="프로그램 목록 (자동 연동 위젯)"
            desc="저장 후 실제 홈페이지에서 학원 프로그램 목록으로 자동 변환됩니다."
        />
    }

    return (
        <div ref={(ref) => { if (ref) connect(drag(ref)); }} className="w-full relative py-8">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 md:gap-6 w-full">
                {(!programs || programs.length === 0) ? (
                    <div className="col-span-full text-center py-12 text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-gray-900 rounded-2xl border border-gray-100 dark:border-gray-800">
                        등록된 프로그램 정보가 없습니다. 관리자 페이지에서 추가해주세요.
                    </div>
                ) : (
                    programs.map((program: any, idx: number) => (
                        <div key={program.id} className="border border-gray-200 dark:border-gray-700 rounded-2xl overflow-hidden flex flex-col sm:flex-row shadow-sm hover:shadow-md transition bg-white dark:bg-gray-800 w-full">
                            <div className="w-full sm:w-1/3 h-32 sm:h-auto bg-gray-100 dark:bg-gray-800 relative flex items-center justify-center p-4">
                                <div className={`absolute inset-0 opacity-10 mix-blend-multiply ${idx % 2 === 0 ? 'bg-brand-navy-900' : 'bg-brand-orange-500 dark:bg-brand-neon-lime dark:text-brand-navy-900'}`}></div>
                                {program.targetAge && (
                                    <div className={`absolute top-2 left-2 md:top-4 md:left-4 text-xs font-bold px-2 py-1 rounded shadow-sm ${idx % 2 === 0 ? 'bg-white dark:bg-gray-800 text-gray-900 dark:text-white' : 'bg-brand-orange-500 dark:bg-brand-neon-lime dark:text-brand-navy-900 text-white'}`}>
                                        {program.targetAge}
                                    </div>
                                )}
                                <SymbolIcon name="emoji_events" size={48} className={`opacity-20 ${idx % 2 === 0 ? 'text-brand-navy-900' : 'text-brand-orange-500 dark:text-brand-neon-lime'}`} />
                            </div>
                            <div className="p-4 md:p-6 sm:w-2/3 flex flex-col justify-center">
                                <h3 className="text-lg md:text-2xl font-bold text-gray-900 dark:text-white mb-1 md:mb-2">{program.name}</h3>
                                <p className="text-gray-600 dark:text-gray-300 mb-3 md:mb-4 text-xs md:text-sm leading-relaxed min-h-[40px] line-clamp-2 md:line-clamp-none whitespace-pre-line">
                                    {program.description || '상세 설명이 등록되지 않았습니다.'}
                                </p>
                                <div className="flex flex-col sm:flex-row flex-wrap gap-1.5 md:gap-2">
                                    {program.frequency && <span className="bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300 px-1.5 md:px-2 py-1 rounded text-xs w-fit">빈도: {program.frequency}</span>}
                                    <span className="bg-orange-50 text-brand-orange-600 dark:text-brand-neon-lime font-bold px-1.5 md:px-2 py-1 rounded text-xs border border-orange-100 w-fit">수강료: {program.price.toLocaleString()}원</span>
                                </div>
                            </div>
                        </div>
                    ))
                )}
            </div>
        </div>
    );
};
ProgramsWidget.craft = {
    displayName: "프로그램 목록 위젯",
};

// ---------------------------------------------
// 2. Schedule Widget
// ---------------------------------------------
export const ScheduleWidget = () => {
    const { connectors: { connect, drag }, selected } = useNode((node) => ({
        selected: node.events.selected,
    }));
    const { classes, daysInfo, isEditor } = useLandingData();

    if (isEditor) {
        return <PlaceholderBox
            connect={connect} drag={drag} selected={selected}
            icon={<SymbolIcon name="calendar_month" size={48} className="mb-3 text-brand-navy-900" />}
            title="시간표 테이블 (자동 연동 위젯)"
            desc="저장 후 실제 홈페이지에서 시간표 테이블로 자동 변환됩니다."
        />
    }

    return (
        <div ref={(ref) => { if (ref) connect(drag(ref)); }} className="w-full relative py-8">
            <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-sm border border-gray-200 dark:border-gray-700 overflow-hidden w-full">
                <div className="overflow-x-auto">
                    {(!classes || classes.length === 0) ? (
                        <div className="text-center py-16 text-gray-500 dark:text-gray-400">개설된 클래스 시간표가 없습니다.</div>
                    ) : (
                        <table className="min-w-full divide-y divide-gray-200 text-sm">
                            <thead className="bg-brand-navy-900 text-white">
                                <tr>
                                    <th className="px-6 py-4 text-left font-bold">참조 프로그램</th>
                                    <th className="px-6 py-4 text-left font-bold">반 이름</th>
                                    <th className="px-6 py-4 text-left font-bold">요일</th>
                                    <th className="px-6 py-4 text-left font-bold">시간</th>
                                    <th className="px-6 py-4 text-left font-bold">장소/정원</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-100">
                                {classes.map((cls: any) => (
                                    <tr key={cls.id} className="hover:bg-gray-50 dark:bg-gray-900 transition">
                                        <td className="px-6 py-4 whitespace-nowrap text-gray-500 dark:text-gray-400 font-medium">{cls.program?.name}</td>
                                        <td className="px-6 py-4 whitespace-nowrap"><span className="font-bold text-gray-900 dark:text-white">{cls.name}</span></td>
                                        <td className="px-6 py-4 whitespace-nowrap">
                                            <span className="inline-block px-2 py-1 bg-gray-100 dark:bg-gray-800 rounded text-brand-orange-600 dark:text-brand-neon-lime font-bold">
                                                {daysInfo?.find((d: any) => d.value === cls.dayOfWeek)?.label || cls.dayOfWeek}
                                            </span>
                                        </td>
                                        <td className="px-6 py-4 whitespace-nowrap text-gray-700 dark:text-gray-200 font-medium tracking-tight">
                                            {cls.startTime || '-'} ~ {cls.endTime || '-'}
                                        </td>
                                        <td className="px-6 py-4 whitespace-nowrap text-gray-500 dark:text-gray-400">
                                            {cls.location && <span className="mr-3">{cls.location}</span>}
                                            <span className="bg-gray-100 dark:bg-gray-800 px-2 py-0.5 rounded-full text-xs">정원 {cls.capacity}명</span>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    )}
                </div>
            </div>
        </div>
    );
};
ScheduleWidget.craft = {
    displayName: "시간표 위젯",
};

// ---------------------------------------------
// 3. Coaches Widget
// ---------------------------------------------
export const CoachesWidget = () => {
    const { connectors: { connect, drag }, selected } = useNode((node) => ({
        selected: node.events.selected,
    }));
    const { displayCoaches, isEditor } = useLandingData();

    if (isEditor) {
        return <PlaceholderBox
            connect={connect} drag={drag} selected={selected}
            icon={<SymbolIcon name="groups" size={48} className="mb-3 text-emerald-600" />}
            title="코치진 명단 (자동 연동 위젯)"
            desc="저장 후 실제 홈페이지에서 강사 프로필 카드로 자동 변환됩니다."
        />
    }

    return (
        <div ref={(ref) => { if (ref) connect(drag(ref)); }} className="w-full relative py-8">
            <div className="grid grid-cols-2 md:grid-cols-3 gap-4 md:gap-8 w-full">
                {displayCoaches?.map((coach: any) => (
                    <div key={coach.id} className="p-4 md:p-6 bg-gray-50 dark:bg-gray-900 rounded-2xl border border-gray-100 dark:border-gray-800 hover:shadow-md transition text-center flex flex-col items-center">
                        <div className="w-20 h-20 md:w-24 md:h-24 bg-gray-200 rounded-full mb-4 overflow-hidden relative shadow-sm">
                            {coach.imageUrl ? (
                                // eslint-disable-next-line @next/next/no-img-element
                                <img src={coach.imageUrl} alt={coach.name} className="w-full h-full object-cover" />
                            ) : (
                                <div className="absolute inset-0 flex items-center justify-center text-gray-400">
                                    <SymbolIcon name="groups" size={32} />
                                </div>
                            )}
                        </div>
                        <h3 className="text-base md:text-xl font-bold text-gray-900 dark:text-white mb-1">
                            {coach.name} <span className="block md:inline mt-1 md:mt-0 text-xs md:text-sm font-medium text-brand-orange-500 dark:text-brand-neon-lime">{coach.role}</span>
                        </h3>
                        <p className="text-gray-500 dark:text-gray-400 text-xs md:text-sm whitespace-pre-line break-keep mt-2">
                            {coach.description}
                        </p>
                    </div>
                ))}
            </div>
        </div>
    );
};
CoachesWidget.craft = {
    displayName: "코치진 카드 위젯",
};
