"use client";
import React from "react";
import { useNode } from "@craftjs/core";
import { useLandingData } from "../LandingPageDataContext";
import Image from "next/image";
import Link from "next/link";

export const HeaderFooterWidget = () => {
    const { connectors: { connect, drag }, selected } = useNode((node) => ({
        selected: node.events.selected,
    }));
    const { isEditor, programs } = useLandingData();

    // Default settings to show, would normally come from Context
    const settings = {
        contactPhone: "010-0000-0000",
        address: "경기도 남양주시 다산동 스티즈 체육관"
    };

    if (isEditor) {
        return (
            <div
                ref={(ref) => { if (ref) connect(drag(ref)); }}
                style={{ outline: selected ? "2px solid #ea580c" : "none" }}
                className="w-full"
            >
                {/* Visual Fake Header */}
                <div className="bg-brand-navy-900 text-white text-xs py-1 text-center font-bold">에디터 상단 GNB 영역 (고정 연동)</div>
                <header className="bg-white dark:bg-gray-800 shadow border-b border-gray-100 dark:border-gray-800 p-4">
                    <div className="flex items-center justify-between pointer-events-none opacity-50">
                        <div className="flex gap-2 items-center">
                            <div className="w-8 h-8 bg-gray-200 rounded shrink-0"></div>
                            <span className="font-bold">다산2호점 로고영역</span>
                        </div>
                        <div className="flex gap-4 text-sm font-bold text-gray-400">
                            <span>소개</span>
                            <span>프로그램</span>
                            <span>시간표</span>
                        </div>
                    </div>
                </header>

                <div className="bg-gray-100 dark:bg-gray-800 p-8 text-center text-sm text-gray-500 dark:text-gray-400 border-y border-dashed border-gray-300">
                    ⬆️ 헤더 상단 영역<br /><br />
                    (이 영역 아래에 블록을 추가하세요)<br /><br />
                    ⬇️ 푸터 하단 영역
                </div>

                {/* Visual Fake Footer */}
                <footer className="bg-gray-900 text-gray-300 p-6 opacity-50 pointer-events-none">
                    <div className="font-bold text-white mb-2">하단 푸터 정보 영역 (고정 연동)</div>
                    <div className="text-xs space-y-1">
                        <div>상담문의: {settings.contactPhone}</div>
                        <div>주소: {settings.address}</div>
                        <div>학부모 로그인 | 원장님 로그인</div>
                    </div>
                </footer>
            </div>
        )
    }

    return null; // Public page renders these directly in LandingPageClient outside the Canvas, so nothing needs to be rendered natively here. If wanted, we could move them inside. But currently LandingPageClient maps them outside editor.
};

HeaderFooterWidget.craft = {
    displayName: "헤더/푸터 위젯",
};
