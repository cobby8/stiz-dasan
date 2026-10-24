"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import ConfirmSubmitButton from "./ConfirmSubmitButton";
import LazyRichTextEditor from "./LazyRichTextEditor";
import { updateAcademySettings } from "@/app/actions/admin";
import { BODY_FONT_OPTIONS, HEADING_FONT_OPTIONS, type FontOption } from "@/lib/fonts";
import type { MapLocationData } from "@/components/maps/LocationPickerModal";

// 지도 모달은 카카오 지도 SDK를 끌고 오는 무거운 컴포넌트라 실제로 열 때만 불러온다.
const LocationPickerModal = dynamic(() => import("@/components/maps/LocationPickerModal"), { ssr: false });

// ─── 적용 범위 뱃지 ────────────────────────────────────────────────────────────
function AppliesTo({ pages }: { pages: string[] }) {
    return (
        <div className="flex flex-wrap gap-1.5 mt-1 mb-3">
            {pages.map((p) => (
                <span key={p} className="text-[11px] bg-blue-50 text-blue-700 border border-blue-200 px-2 py-0.5 rounded-full font-medium dark:border-blue-500/30 dark:bg-blue-500/10 dark:text-blue-300">
                    📍 {p}
                </span>
            ))}
        </div>
    );
}

// ─── 폰트 선택 카드 ────────────────────────────────────────────────────────────
function FontCard({ option, selected, name, onSelect }: {
    option: FontOption;
    selected: boolean;
    name: string;
    onSelect: (key: string) => void;
}) {
    return (
        <label
            className={`cursor-pointer rounded-xl border-2 p-3.5 transition-all flex flex-col gap-1.5 ${
                selected ? "border-brand-orange-500 bg-orange-50 shadow-sm dark:border-brand-neon-lime dark:bg-brand-neon-lime/10" : "border-gray-200 bg-white hover:border-gray-300 dark:border-gray-700 dark:bg-gray-800 dark:hover:border-gray-500"
            }`}
            onClick={() => onSelect(option.key)}
        >
            <input type="radio" name={name} value={option.key} checked={selected} onChange={() => onSelect(option.key)} className="sr-only" />
            <div className="flex items-center gap-2">
                <span className="text-xs font-bold text-gray-800 dark:text-gray-100">{option.name}</span>
                {option.tag && (
                    <span className="text-[10px] bg-brand-orange-500 dark:bg-brand-neon-lime dark:text-brand-navy-900 text-white px-1.5 py-0.5 rounded-full font-bold">{option.tag}</span>
                )}
                {selected && <span className="ml-auto text-brand-orange-500 dark:text-brand-neon-lime text-sm">✓</span>}
            </div>
            <p style={{ fontFamily: option.css === "inherit" ? undefined : option.css }} className="text-sm text-gray-600 dark:text-gray-300 leading-snug truncate">
                {option.sample}
            </p>
            <p className="text-[10px] text-gray-400 dark:text-gray-500">{option.nameEn}</p>
        </label>
    );
}

// ─── 섹션 헤더 ────────────────────────────────────────────────────────────────
function SectionHeader({ title }: { title: string }) {
    return (
        <h2 className="text-xl font-bold text-brand-navy-900 border-b-2 border-brand-orange-500 dark:border-brand-neon-lime pb-2 mb-2 inline-block dark:text-white">
            {title}
        </h2>
    );
}

function AdminSettingsLoadingFallback() {
    return (
        <div className="space-y-6">
            <div>
                <div className="h-8 w-48 animate-pulse rounded bg-gray-200 dark:bg-gray-700" />
                <div className="mt-2 h-4 w-96 max-w-full animate-pulse rounded bg-gray-100 dark:bg-gray-800" />
            </div>

            <div className="grid gap-6 xl:grid-cols-[280px_minmax(0,1fr)]">
                <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-800">
                    <div className="space-y-2">
                        {Array.from({ length: 7 }).map((_, index) => (
                            <div
                                key={index}
                                className={`h-10 animate-pulse rounded-lg ${
                                    index === 0 ? "bg-gray-200 dark:bg-gray-700" : "bg-gray-100 dark:bg-gray-700"
                                }`}
                            />
                        ))}
                    </div>
                </div>

                <div className="space-y-5">
                    {Array.from({ length: 4 }).map((_, sectionIndex) => (
                        <div
                            key={sectionIndex}
                            className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-700 dark:bg-gray-800"
                        >
                            <div className="h-6 w-40 animate-pulse rounded bg-gray-200 dark:bg-gray-700" />
                            <div className="mt-5 grid gap-4 md:grid-cols-2">
                                {Array.from({ length: 4 }).map((__, fieldIndex) => (
                                    <div key={fieldIndex}>
                                        <div className="h-4 w-24 animate-pulse rounded bg-gray-100 dark:bg-gray-700" />
                                        <div className="mt-2 h-11 animate-pulse rounded-lg bg-gray-100 dark:bg-gray-700" />
                                    </div>
                                ))}
                            </div>
                            <div className="mt-5 h-28 animate-pulse rounded-lg bg-gray-100 dark:bg-gray-700" />
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
}

// ─── 메인 컴포넌트 ────────────────────────────────────────────────────────────
export default function AdminSettingsClient({
    initialSettings,
    fetchError,
}: {
    initialSettings?: any;
    fetchError?: boolean;
}) {
    const hasInitialData = initialSettings !== undefined || fetchError === true;
    const [settings, setSettings] = useState<any>(initialSettings ?? null);
    const [loading, setLoading] = useState(!hasInitialData);
    const [fetchErrorState, setFetchErrorState] = useState(fetchError === true);
    const [actionError, setActionError] = useState<string | null>(null);
    const [saveSuccess, setSaveSuccess] = useState(false);
    const [saving, setSaving] = useState(false);
    const savingRef = useRef(false);
    const [bodyFont, setBodyFont] = useState<string>(settings?.siteBodyFont || "system");
    const [headingFont, setHeadingFont] = useState<string>(
        HEADING_FONT_OPTIONS.some(f => f.key === settings?.siteHeadingFont)
            ? settings.siteHeadingFont
            : "same-as-body"
    );
    const [introText, setIntroText] = useState<string>(settings?.introductionText || "");
    const [philosophyText, setPhilosophyText] = useState<string>(settings?.philosophyText || "");
    const [facilitiesText, setFacilitiesText] = useState<string>(settings?.facilitiesText || "");
    const [facilityImages, setFacilityImages] = useState<string[]>(() => {
        try {
            if (settings?.facilitiesImagesJSON) return JSON.parse(settings.facilitiesImagesJSON);
        } catch {}
        return [];
    });
    // 셔틀 노선의 출발지·도착지로 쓰는 학원 위치. 지도에서 찍거나 직접 고칠 수 있다.
    const [academyPin, setAcademyPin] = useState({
        name: settings?.academyPlaceName || "",
        address: settings?.academyAddress || "",
        latitude: settings?.academyLatitude || "",
        longitude: settings?.academyLongitude || "",
    });
    const [academyPickerOpen, setAcademyPickerOpen] = useState(false);
    const bodyFontCss = BODY_FONT_OPTIONS.find(f => f.key === bodyFont)?.css ?? "";
    const headingFontCss = headingFont === "same-as-body"
        ? bodyFontCss
        : (HEADING_FONT_OPTIONS.find(f => f.key === headingFont)?.css ?? bodyFontCss);

    const loadSettings = useCallback(async () => {
        setLoading(true);
        setFetchErrorState(false);
        try {
            const response = await fetch("/api/admin/settings");
            if (!response.ok) throw new Error("Failed to load settings.");
            const data = (await response.json()) as { settings: any; fetchError?: boolean };
            setSettings(data.settings ?? null);
            setFetchErrorState(data.fetchError === true);
        } catch (error) {
            console.error("Failed to load academy settings:", error);
            setSettings(null);
            setFetchErrorState(true);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        if (hasInitialData) return;
        void loadSettings();
    }, [hasInitialData, loadSettings]);

    useEffect(() => {
        setBodyFont(settings?.siteBodyFont || "system");
        setHeadingFont(
            HEADING_FONT_OPTIONS.some(f => f.key === settings?.siteHeadingFont)
                ? settings.siteHeadingFont
                : "same-as-body"
        );
        setIntroText(settings?.introductionText || "");
        setPhilosophyText(settings?.philosophyText || "");
        setFacilitiesText(settings?.facilitiesText || "");
        // 셔틀 기준 학원 위치. 좌표는 TEXT로 저장되므로 문자열 그대로 입력칸에 넣는다.
        setAcademyPin({
            name: settings?.academyPlaceName || "",
            address: settings?.academyAddress || "",
            latitude: settings?.academyLatitude || "",
            longitude: settings?.academyLongitude || "",
        });
        try {
            setFacilityImages(settings?.facilitiesImagesJSON ? JSON.parse(settings.facilitiesImagesJSON) : []);
        } catch {
            setFacilityImages([]);
        }
    }, [settings]);

    if (loading && !settings && !fetchErrorState) {
        return <AdminSettingsLoadingFallback />;
    }

    async function saveBasicSettings(formData: FormData) {
        if (savingRef.current || fetchErrorState || loading) return;
        savingRef.current = true;
        setSaving(true);
        setActionError(null);
        setSaveSuccess(false);
        try {
            const data: any = {};
            formData.forEach((value, key) => {
                if (typeof value === "string") data[key] = value;
            });
            data.instagramAutoPublishEnabled = formData.get("instagramAutoPublishEnabled") === "true";
            data.introductionText = introText;
            data.philosophyText = philosophyText;
            data.facilitiesText = facilitiesText;
            data.facilitiesImagesJSON = JSON.stringify(facilityImages.filter(u => u.trim()));
            data.siteBodyFont = bodyFont;
            data.siteHeadingFont = headingFont;
            await updateAcademySettings(data);
            setSaveSuccess(true);
        } catch (e: any) {
            setSaveSuccess(false);
            setActionError(e.message || "저장 중 오류가 발생했습니다.");
        } finally {
            savingRef.current = false;
            setSaving(false);
        }
    }

    return (
        <div className="flex-1 overflow-y-auto p-8 bg-gray-50 dark:bg-gray-900">
            {fetchErrorState && (
                <div className="bg-red-50 text-red-600 p-4 rounded-lg font-medium border border-red-200 mb-6 text-sm dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300">
                    데이터베이스 연결에 문제가 발생했습니다. 잠시 후 다시 시도하고, 계속되면 관리자에게 문의해 주세요.
                </div>
            )}
            {saveSuccess && (
                <div className="bg-green-50 text-green-700 p-4 rounded-lg font-medium border border-green-200 mb-4 text-sm flex justify-between items-center dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300">
                    <span>✓ 저장되었습니다. 폰트 변경은 새로고침 후 반영됩니다.</span>
                    <button onClick={() => setSaveSuccess(false)} className="text-green-400 hover:text-green-600 font-bold ml-4">✕</button>
                </div>
            )}
            {actionError && (
                <div className="bg-red-50 text-red-600 p-4 rounded-lg font-medium border border-red-200 mb-4 text-sm flex justify-between items-center dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300">
                    <span>⚠ {actionError}</span>
                    <button onClick={() => setActionError(null)} className="text-red-400 hover:text-red-600 font-bold ml-4">✕</button>
                </div>
            )}

            <div className="max-w-3xl mx-auto space-y-8 bg-white dark:bg-gray-800 p-8 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700">
                <form onSubmit={(event) => {
                    // 실패해도 React 폼 자동 초기화가 입력값을 지우지 않도록 직접 제출한다.
                    event.preventDefault();
                    void saveBasicSettings(new FormData(event.currentTarget));
                }} onChange={() => setSaveSuccess(false)} inert={saving || fetchErrorState || loading} aria-busy={saving} className="space-y-8">
                    <fieldset disabled={saving || fetchErrorState || loading} className="min-w-0 space-y-8 border-0 p-0">

                    {/* ── 폰트 설정 ───────────────────────────────────────── */}
                    <section>
                        <SectionHeader title="글꼴(폰트) 설정" />
                        <AppliesTo pages={["홈페이지 전체 (모든 페이지)"]} />

                        {/* 폰트 미리보기 */}
                        <div className="bg-gray-900 rounded-xl p-5 mb-6 text-white space-y-1">
                            <p className="text-xs text-gray-400 mb-2 font-mono">PREVIEW</p>
                            <p style={{ fontFamily: headingFontCss }} className="text-2xl font-black">STIZ 농구교실 다산2호점</p>
                            <p style={{ fontFamily: bodyFontCss }} className="text-sm text-gray-300 leading-relaxed">
                                아이들의 가능성을 이끌어드립니다. 전문 코치진의 체계적인 지도로 농구의 즐거움을 경험하세요.
                            </p>
                        </div>

                        <div className="mb-6">
                            <label className="block text-sm font-bold text-gray-700 dark:text-gray-200 mb-3">
                                본문 폰트
                            </label>
                            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                                {BODY_FONT_OPTIONS.map(opt => (
                                    <FontCard key={opt.key} option={opt} selected={bodyFont === opt.key} name="siteBodyFont" onSelect={setBodyFont} />
                                ))}
                            </div>
                        </div>

                        <div>
                            <label className="block text-sm font-bold text-gray-700 dark:text-gray-200 mb-3">
                                제목 폰트
                            </label>
                            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                                {HEADING_FONT_OPTIONS.map(opt => (
                                    <FontCard key={opt.key} option={opt} selected={headingFont === opt.key} name="siteHeadingFont" onSelect={setHeadingFont} />
                                ))}
                            </div>
                        </div>
                    </section>

                    {/* ── 학원 소개 문구 ───────────────────────────────────── */}
                    <section className="pt-6 border-t border-gray-100 dark:border-gray-800">
                        <SectionHeader title="학원 소개 문구" />

                        <div className="space-y-5">
                            {/* 메인 타이틀 */}
                            <div>
                                <label className="block text-sm font-bold text-gray-700 dark:text-gray-200 mb-1">
                                    메인 타이틀
                                </label>
                                <AppliesTo pages={["홈페이지 메인 히어로 제목"]} />
                                <input
                                    name="introductionTitle"
                                    type="text"
                                    defaultValue={settings?.introductionTitle || ""}
                                    placeholder="예: 다산신도시 No.1 스티즈농구교실"
                                    className="w-full border border-gray-300 rounded-lg p-2.5 text-sm bg-gray-50 focus:bg-white dark:focus:bg-gray-700 dark:bg-gray-800 focus:ring-2 focus:ring-brand-orange-500 dark:focus:ring-brand-neon-lime transition"
                                />
                            </div>

                            {/* 원장 인사말 */}
                            <div>
                                <label className="block text-sm font-bold text-gray-700 dark:text-gray-200 mb-1">
                                    원장 인사말 / 학원 소개
                                </label>
                                <AppliesTo pages={["홈페이지 메인 히어로 소개 문구", "학원소개 페이지 원장 인사말"]} />
                                <LazyRichTextEditor
                                    value={introText}
                                    onChange={(value) => { setIntroText(value); setSaveSuccess(false); }}
                                    placeholder={"안녕하세요, 스티즈 농구교실 다산2호점입니다.\n\n아이들이 농구를 통해 협동심과 건강한 체력을 기를 수 있도록 최선을 다해 지도합니다."}
                                />
                            </div>
                        </div>
                    </section>

                    {/* ── 교육 이념 ──────────────────────────────────────── */}
                    <section className="pt-6 border-t border-gray-100 dark:border-gray-800">
                        <SectionHeader title="교육 이념" />
                        <AppliesTo pages={["학원소개 페이지 (원장 인사말 아래)"]} />
                        <p className="text-xs text-gray-400 mb-2">
                            비워두면 섹션이 숨겨집니다.
                        </p>
                        <LazyRichTextEditor
                            value={philosophyText}
                            onChange={(value) => { setPhilosophyText(value); setSaveSuccess(false); }}
                            placeholder={"우리 학원은 농구를 통해 아이들의 체력, 협동심, 리더십을 길러줍니다.\n\n모든 수업은 연령과 실력에 맞춘 단계별 커리큘럼으로 진행됩니다."}
                        />
                    </section>

                    {/* ── 시설 소개 ──────────────────────────────────────── */}
                    <section className="pt-6 border-t border-gray-100 dark:border-gray-800">
                        <SectionHeader title="시설 소개" />
                        <AppliesTo pages={["학원소개 페이지 (코치진 아래)"]} />

                        <div className="space-y-4">
                            <div>
                                <label className="block text-sm font-bold text-gray-700 dark:text-gray-200 mb-1">시설 설명</label>
                                <p className="text-xs text-gray-400 mb-2">비워두면 섹션이 숨겨집니다.</p>
                                <LazyRichTextEditor
                                    value={facilitiesText}
                                    onChange={(value) => { setFacilitiesText(value); setSaveSuccess(false); }}
                                    placeholder="최신 시설과 안전한 환경에서 수업이 진행됩니다."
                                />
                            </div>

                            <div>
                                <label className="block text-sm font-bold text-gray-700 dark:text-gray-200 mb-1">시설 사진 URL</label>
                                <p className="text-xs text-gray-400 mb-2">
                                    이미지 URL을 한 줄에 하나씩 입력합니다.
                                </p>
                                {facilityImages.map((url, i) => (
                                    <div key={i} className="flex gap-2 mb-2">
                                        <input
                                            type="url"
                                            value={url}
                                            onChange={(e) => {
                                                const next = [...facilityImages];
                                                next[i] = e.target.value;
                                                setFacilityImages(next);
                                            }}
                                            placeholder="https://..."
                                            className="flex-1 border border-gray-300 rounded-lg p-2 text-sm bg-gray-50 focus:bg-white dark:focus:bg-gray-700 dark:bg-gray-800 focus:ring-2 focus:ring-brand-orange-500 dark:focus:ring-brand-neon-lime transition font-mono"
                                        />
                                        <button
                                            type="button"
                                            onClick={() => setFacilityImages(facilityImages.filter((_, j) => j !== i))}
                                            className="text-red-400 hover:text-red-600 px-2 font-bold text-lg"
                                        >
                                            ✕
                                        </button>
                                    </div>
                                ))}
                                <button
                                    type="button"
                                    onClick={() => setFacilityImages([...facilityImages, ""])}
                                    className="text-sm text-brand-orange-500 dark:text-brand-neon-lime font-bold hover:underline"
                                >
                                    + 사진 URL 추가
                                </button>
                            </div>
                        </div>
                    </section>

                    {/* ── 포토갤러리 관리 안내 ─────────────────────────────── */}
                    <section className="pt-6 border-t border-gray-100 dark:border-gray-800">
                        <SectionHeader title="포토 갤러리" />
                        <AppliesTo pages={["홈페이지 메인 활동 사진", "포토갤러리 페이지"]} />
                        <div className="rounded-xl border border-blue-100 dark:border-blue-900/50 bg-blue-50/70 dark:bg-blue-950/20 p-4">
                            <Link
                                href="/admin/gallery"
                                prefetch={false}
                                className="inline-flex items-center justify-center rounded-lg bg-brand-navy-900 px-4 py-2 text-sm font-bold text-white hover:bg-gray-800 transition"
                            >
                                사진/영상 갤러리 관리로 이동
                            </Link>
                        </div>
                    </section>

                    {/* ── 연락처 ───────────────────────────────────────────── */}
                    <section className="pt-6 border-t border-gray-100 dark:border-gray-800">
                        <SectionHeader title="연락처 및 위치" />
                        <AppliesTo pages={["모든 페이지 헤더 전화버튼", "학원소개 페이지 CTA", "홈 푸터"]} />

                        <div className="space-y-4">
                            <div>
                                <label className="block text-sm font-bold text-gray-700 dark:text-gray-200 mb-1">대표 전화번호</label>
                                <input
                                    name="contactPhone"
                                    type="text"
                                    defaultValue={settings?.contactPhone || ""}
                                    placeholder="010-0000-0000"
                                    className="w-full border border-gray-300 rounded-lg p-2.5 text-sm bg-gray-50 focus:bg-white dark:focus:bg-gray-700 dark:bg-gray-800 focus:ring-2 focus:ring-brand-orange-500 dark:focus:ring-brand-neon-lime transition"
                                />
                            </div>
                            <div>
                                <label className="block text-sm font-bold text-gray-700 dark:text-gray-200 mb-1">운영시간</label>
                                <input
                                    name="operatingHours"
                                    type="text"
                                    defaultValue={settings?.operatingHours || ""}
                                    placeholder="평일 13:00~21:00 / 토 09:00~18:00 (일요일·공휴일 휴무)"
                                    className="w-full border border-gray-300 rounded-lg p-2.5 text-sm bg-gray-50 focus:bg-white dark:focus:bg-gray-700 dark:bg-gray-800 focus:ring-2 focus:ring-brand-orange-500 dark:focus:ring-brand-neon-lime transition"
                                />
                                <p className="text-xs text-gray-400 mt-1.5">비워두면 기본 운영시간이 표시됩니다. 모든 공개 페이지의 상단 바와 푸터에 함께 반영됩니다.</p>
                            </div>
                            <div>
                                <label className="block text-sm font-bold text-gray-700 dark:text-gray-200 mb-1">오시는 길 (주소)</label>
                                <input
                                    name="address"
                                    type="text"
                                    defaultValue={settings?.address || ""}
                                    placeholder="경기도 남양주시 다산동 ..."
                                    className="w-full border border-gray-300 rounded-lg p-2.5 text-sm bg-gray-50 focus:bg-white dark:focus:bg-gray-700 dark:bg-gray-800 focus:ring-2 focus:ring-brand-orange-500 dark:focus:ring-brand-neon-lime transition"
                                />
                            </div>

                            {/* ── 셔틀 기준 학원 위치 ──────────────────────────
                                위 "오시는 길"은 홈페이지에 보여주는 안내 문구라 자유롭게 바꿀 수 있다.
                                반면 여기 좌표는 셔틀 노선의 출발지·도착지와 T맵 경로 계산의 기준점이라
                                문구가 바뀌어도 흔들리면 안 되므로 별도 항목으로 관리한다. */}
                            <div className="rounded-xl border border-gray-200 p-4 dark:border-gray-700">
                                <div className="flex flex-wrap items-start justify-between gap-2">
                                    <div>
                                        <p className="text-sm font-bold text-gray-700 dark:text-gray-200">셔틀 기준 학원 위치</p>
                                        <p className="text-xs text-gray-400 mt-1">셔틀 노선 만들기의 &quot;학원으로 채우기&quot;와 반별 자동배치가 이 좌표를 사용합니다.</p>
                                    </div>
                                    <button
                                        type="button"
                                        onClick={() => setAcademyPickerOpen(true)}
                                        className="min-h-10 rounded-lg border border-gray-300 bg-gray-50 px-3 text-xs font-bold text-gray-800 hover:bg-gray-100 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100 dark:hover:bg-gray-700 transition"
                                    >
                                        지도에서 선택
                                    </button>
                                </div>
                                <div className="grid gap-3 sm:grid-cols-2 mt-3">
                                    <div className="sm:col-span-2">
                                        <label className="block text-xs font-bold text-gray-600 dark:text-gray-300 mb-1">학원 이름</label>
                                        <input
                                            name="academyPlaceName"
                                            type="text"
                                            value={academyPin.name}
                                            onChange={(e) => setAcademyPin(p => ({ ...p, name: e.target.value }))}
                                            placeholder="스티즈농구교실 다산2호점"
                                            className="w-full border border-gray-300 rounded-lg p-2.5 text-sm bg-gray-50 focus:bg-white dark:focus:bg-gray-700 dark:bg-gray-800 focus:ring-2 focus:ring-brand-orange-500 dark:focus:ring-brand-neon-lime transition"
                                        />
                                    </div>
                                    <div className="sm:col-span-2">
                                        <label className="block text-xs font-bold text-gray-600 dark:text-gray-300 mb-1">학원 주소</label>
                                        <input
                                            name="academyAddress"
                                            type="text"
                                            value={academyPin.address}
                                            onChange={(e) => setAcademyPin(p => ({ ...p, address: e.target.value }))}
                                            placeholder="경기 남양주시 다산중앙로20번길 10-32"
                                            className="w-full border border-gray-300 rounded-lg p-2.5 text-sm bg-gray-50 focus:bg-white dark:focus:bg-gray-700 dark:bg-gray-800 focus:ring-2 focus:ring-brand-orange-500 dark:focus:ring-brand-neon-lime transition"
                                        />
                                    </div>
                                    <div>
                                        <label className="block text-xs font-bold text-gray-600 dark:text-gray-300 mb-1">위도</label>
                                        <input
                                            name="academyLatitude"
                                            type="text"
                                            inputMode="decimal"
                                            value={academyPin.latitude}
                                            onChange={(e) => setAcademyPin(p => ({ ...p, latitude: e.target.value }))}
                                            placeholder="37.6145054"
                                            className="w-full border border-gray-300 rounded-lg p-2.5 text-sm bg-gray-50 focus:bg-white dark:focus:bg-gray-700 dark:bg-gray-800 focus:ring-2 focus:ring-brand-orange-500 dark:focus:ring-brand-neon-lime transition"
                                        />
                                    </div>
                                    <div>
                                        <label className="block text-xs font-bold text-gray-600 dark:text-gray-300 mb-1">경도</label>
                                        <input
                                            name="academyLongitude"
                                            type="text"
                                            inputMode="decimal"
                                            value={academyPin.longitude}
                                            onChange={(e) => setAcademyPin(p => ({ ...p, longitude: e.target.value }))}
                                            placeholder="127.1563116"
                                            className="w-full border border-gray-300 rounded-lg p-2.5 text-sm bg-gray-50 focus:bg-white dark:focus:bg-gray-700 dark:bg-gray-800 focus:ring-2 focus:ring-brand-orange-500 dark:focus:ring-brand-neon-lime transition"
                                        />
                                    </div>
                                </div>
                            </div>
                        </div>
                    </section>

                    {/* ── 유튜브 영상 ───────────────────────────────────────── */}
                    <section className="pt-6 border-t border-gray-100 dark:border-gray-800">
                        <SectionHeader title="메인페이지 유튜브 영상" />
                        <AppliesTo pages={["메인 페이지 (홍보 영상)"]} />
                        <input
                            name="youtubeUrl"
                            type="text"
                            defaultValue={settings?.youtubeUrl || ""}
                            placeholder="https://www.youtube.com/watch?v=XXXXXXXXXXX  또는 <iframe ...> 코드"
                            className="w-full border border-gray-300 rounded-lg p-2.5 text-sm bg-gray-50 focus:bg-white dark:focus:bg-gray-700 dark:bg-gray-800 focus:ring-2 focus:ring-brand-orange-500 dark:focus:ring-brand-neon-lime transition font-mono"
                        />
                        <p className="text-xs text-gray-400 mt-1.5">YouTube 영상 URL 또는 YouTube &quot;공유 → 퍼가기&quot; iframe 코드를 그대로 붙여넣으면 메인페이지에 자동 임베드됩니다. 비우면 영상 섹션이 숨겨집니다.</p>
                    </section>

                    {/* ── 푸터 및 소셜 링크 ─────────────────────────────────── */}
                    <section className="pt-6 border-t border-gray-100 dark:border-gray-800">
                        <SectionHeader title="푸터 및 소셜 링크" />
                        <AppliesTo pages={["모든 공개 페이지 푸터"]} />

                        <div className="space-y-4">
                            <div>
                                <label className="block text-sm font-bold text-gray-700 dark:text-gray-200 mb-1">푸터 소개 문구</label>
                                <textarea
                                    name="footerDescription"
                                    defaultValue={settings?.footerDescription || ""}
                                    rows={3}
                                    placeholder={"아이들이 농구를 통해 협동심과\n건강한 체력을 기를 수 있도록 지도합니다."}
                                    className="w-full border border-gray-300 rounded-lg p-2.5 text-sm bg-gray-50 focus:bg-white dark:focus:bg-gray-700 dark:bg-gray-800 focus:ring-2 focus:ring-brand-orange-500 dark:focus:ring-brand-neon-lime transition resize-y"
                                />
                                <p className="text-xs text-gray-400 mt-1.5">비워두면 기본 소개 문구가 표시됩니다.</p>
                            </div>

                            <div>
                                <label className="block text-sm font-bold text-gray-700 dark:text-gray-200 mb-1">저작권 문구</label>
                                <input
                                    name="footerCopyright"
                                    type="text"
                                    defaultValue={settings?.footerCopyright || ""}
                                    placeholder="© 2026 STIZ Basketball Academy. All rights reserved."
                                    className="w-full border border-gray-300 rounded-lg p-2.5 text-sm bg-gray-50 focus:bg-white dark:focus:bg-gray-700 dark:bg-gray-800 focus:ring-2 focus:ring-brand-orange-500 dark:focus:ring-brand-neon-lime transition"
                                />
                                <p className="text-xs text-gray-400 mt-1.5">비워두면 기본 저작권 문구가 표시됩니다.</p>
                            </div>

                            <div className="grid md:grid-cols-2 gap-4">
                                <div>
                                    <label className="block text-sm font-bold text-gray-700 dark:text-gray-200 mb-1">인스타그램 URL</label>
                                    <input
                                        name="instagramUrl"
                                        type="text"
                                        defaultValue={settings?.instagramUrl || ""}
                                        placeholder="https://www.instagram.com/stiz... 또는 @stiz..."
                                        className="w-full border border-gray-300 rounded-lg p-2.5 text-sm bg-gray-50 focus:bg-white dark:focus:bg-gray-700 dark:bg-gray-800 focus:ring-2 focus:ring-brand-orange-500 dark:focus:ring-brand-neon-lime transition"
                                    />
                                </div>
                                <div>
                                    <label className="block text-sm font-bold text-gray-700 dark:text-gray-200 mb-1">Instagram Business Account ID</label>
                                    <input
                                        name="instagramBusinessAccountId"
                                        type="text"
                                        defaultValue={settings?.instagramBusinessAccountId || ""}
                                        placeholder="예: 1784..."
                                        className="w-full border border-gray-300 rounded-lg p-2.5 text-sm bg-gray-50 focus:bg-white dark:focus:bg-gray-700 dark:bg-gray-800 focus:ring-2 focus:ring-brand-orange-500 dark:focus:ring-brand-neon-lime transition font-mono"
                                    />
                                    <p className="text-xs text-gray-400 mt-1.5">인스타그램 게시물 가져오기와 자동 업로드에 사용됩니다.</p>
                                </div>
                                <div>
                                    <label className="block text-sm font-bold text-gray-700 dark:text-gray-200 mb-1">네이버 플레이스 URL</label>
                                    <input
                                        name="naverPlaceUrl"
                                        type="url"
                                        defaultValue={settings?.naverPlaceUrl || ""}
                                        placeholder="https://naver.me/..."
                                        className="w-full border border-gray-300 rounded-lg p-2.5 text-sm bg-gray-50 focus:bg-white dark:focus:bg-gray-700 dark:bg-gray-800 focus:ring-2 focus:ring-brand-orange-500 dark:focus:ring-brand-neon-lime transition"
                                    />
                                </div>
                                <div>
                                    <label className="block text-sm font-bold text-gray-700 dark:text-gray-200 mb-1">카카오 채널 URL</label>
                                    <input
                                        name="kakaoChannelUrl"
                                        type="url"
                                        defaultValue={settings?.kakaoChannelUrl || ""}
                                        placeholder="https://pf.kakao.com/..."
                                        className="w-full border border-gray-300 rounded-lg p-2.5 text-sm bg-gray-50 focus:bg-white dark:focus:bg-gray-700 dark:bg-gray-800 focus:ring-2 focus:ring-brand-orange-500 dark:focus:ring-brand-neon-lime transition"
                                    />
                                </div>
                            </div>
                            <label className="flex items-start gap-3 rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 p-3 text-sm">
                                <input
                                    type="checkbox"
                                    name="instagramAutoPublishEnabled"
                                    value="true"
                                    defaultChecked={settings?.instagramAutoPublishEnabled === true}
                                    className="mt-1 rounded border-gray-300"
                                />
                                <span>
                                    <span className="block font-bold text-gray-700 dark:text-gray-200">갤러리 새 게시물 인스타그램 자동 업로드</span>
                                    <span className="block text-xs text-gray-400 mt-1">켜면 관리자 갤러리에 새 공개 게시물을 만들 때 첫 번째 이미지를 인스타그램에도 발행합니다.</span>
                                </span>
                            </label>
                        </div>
                    </section>

                    {/* 저장 */}
                    <div className="pt-4 border-t border-gray-100 dark:border-gray-800 flex justify-end">
                        <ConfirmSubmitButton
                            confirmMessage="변경 사항을 저장하시겠습니까?"
                            className="bg-brand-orange-500 dark:bg-brand-neon-lime dark:text-brand-navy-900 text-white px-6 py-2.5 rounded-lg font-bold hover:bg-orange-600 transition shadow"
                        >
                            {saving ? "저장 중..." : "저장하기"}
                        </ConfirmSubmitButton>
                    </div>
                    </fieldset>
                </form>

            </div>

            {/* 학원 위치 지도 선택. 폼 밖에 두어 지도 안의 조작이 설정 저장을 건드리지 않게 한다.
                여기서는 입력칸만 채우고, 실제 저장은 아래 "저장하기"를 눌러야 일어난다. */}
            {academyPickerOpen && (
                <LocationPickerModal
                    title="학원 위치 선택"
                    initialValue={(() => {
                        const latitude = Number(academyPin.latitude);
                        const longitude = Number(academyPin.longitude);
                        if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || !academyPin.latitude || !academyPin.longitude) return undefined;
                        return { address: academyPin.address || academyPin.name || "학원", latitude, longitude, source: "MAP_PIN" as const };
                    })()}
                    onClose={() => setAcademyPickerOpen(false)}
                    onConfirm={(value: MapLocationData) => {
                        setAcademyPin(previous => ({
                            // 이름은 원장이 부르는 이름(예: 다산2호점)이 정본이라 지도 결과로 덮지 않는다.
                            name: previous.name,
                            address: value.roadAddress || value.address,
                            latitude: String(value.latitude),
                            longitude: String(value.longitude),
                        }));
                        setAcademyPickerOpen(false);
                    }}
                />
            )}
        </div>
    );
}
