"use client";
import { adminErrorText } from "@/components/admin/adminDisplayText";

import { useCallback, useEffect, useRef, useState } from "react";
import { updateAcademySettings } from "@/app/actions/admin";

function TermsLoadingFallback() {
    return (
        <div className="space-y-6">
            <div>
                <div className="h-8 w-48 animate-pulse rounded bg-gray-200 dark:bg-gray-700" />
                <div className="mt-2 h-4 w-96 max-w-full animate-pulse rounded bg-gray-100 dark:bg-gray-800" />
            </div>
            <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-700 dark:bg-gray-800">
                <div className="h-5 w-28 animate-pulse rounded bg-gray-200 dark:bg-gray-700" />
                <div className="mt-4 h-[520px] animate-pulse rounded-lg bg-gray-100 dark:bg-gray-700" />
                <div className="mt-4 flex justify-end gap-2">
                    <div className="h-10 w-24 animate-pulse rounded-lg bg-gray-100 dark:bg-gray-700" />
                    <div className="h-10 w-24 animate-pulse rounded-lg bg-gray-200 dark:bg-gray-700" />
                </div>
            </div>
        </div>
    );
}

// 이용약관 관리 독립 클라이언트 컴포넌트
// 기존 ProgramsAdminClient에서 분리하여 단독 페이지로 운영
export default function TermsAdminClient({
    termsOfService: initialTerms,
    fetchError = false,
}: {
    termsOfService?: string | null;
    fetchError?: boolean;
}) {
    const hasInitialData = initialTerms !== undefined || fetchError;
    const [terms, setTerms] = useState(initialTerms ?? "");
    const [loading, setLoading] = useState(!hasInitialData);
    const [saved, setSaved] = useState(false);
    const [pending, setPending] = useState(false);
    const savingRef = useRef(false);
    const [loadError, setLoadError] = useState<string | null>(fetchError ? "현재 내용을 불러오지 못했습니다. 다시 불러온 뒤 저장해 주세요." : null);
    const [saveError, setSaveError] = useState<string | null>(null);
    const [loaded, setLoaded] = useState(hasInitialData && !fetchError);

    const loadTerms = useCallback(async () => {
        setLoading(true);
        setLoadError(null);
        setSaved(false);
        try {
            const response = await fetch("/api/admin/settings");
            if (!response.ok) throw new Error("Failed to load academy settings.");
            const data = (await response.json()) as { settings?: { termsOfService?: string | null } | null; fetchError?: boolean };
            if (data.fetchError || !("settings" in data)) throw new Error("Failed to load academy settings.");
            setTerms(data.settings?.termsOfService ?? "");
            setLoaded(true);
        } catch (error) {
            console.error("Failed to load terms:", error);
            setLoadError("현재 내용을 불러오지 못했습니다. 다시 불러온 뒤 저장해 주세요.");
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        if (hasInitialData) return;
        void loadTerms();
    }, [hasInitialData, loadTerms]);

    if (loading && !loaded && !loadError) {
        return <TermsLoadingFallback />;
    }

    // 이용약관 저장 핸들러
    async function saveTerms() {
        if (savingRef.current || loading || loadError || !loaded) return;
        savingRef.current = true;
        setPending(true);
        setSaved(false);
        setSaveError(null);
        try {
            await updateAcademySettings({ termsOfService: terms });
            setSaved(true);
        } catch (error) {
            setSaveError(adminErrorText(error, "저장에 실패했습니다. 입력 내용은 유지됩니다."));
        } finally {
            savingRef.current = false;
            setPending(false);
        }
    }

    return (
        <div className="space-y-8">
            {loadError && <div role="alert" className="rounded-lg border p-4">
                <p>{loadError}</p>
                <button type="button" onClick={() => void loadTerms()} disabled={loading}>{loading ? "불러오는 중..." : "다시 불러오기"}</button>
            </div>}
            {saveError && <p role="alert">{saveError}</p>}

            {/* 페이지 헤더 */}
            <div>
                <h1 className="text-2xl font-bold text-gray-900 dark:text-white mb-2">이용약관 관리</h1>
                <p className="text-gray-500 dark:text-gray-400">프로그램 안내 페이지 하단 및 이용약관 독립 페이지(/terms)에 표시됩니다.</p>
            </div>

            {/* 이용약관 에디터 */}
            <div className="bg-white dark:bg-gray-800 p-6 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700">
                <div className="flex items-center justify-between mb-4">
                    <h2 className="text-lg font-bold text-gray-900 dark:text-white">이용약관 내용</h2>
                    <div className="flex items-center gap-3">
                        {saved && <span className="text-xs text-green-600 font-medium">저장됨</span>}
                        <button
                            onClick={saveTerms}
                            disabled={pending || loading || !!loadError || !loaded}
                            className="bg-brand-navy-900 text-white text-sm font-bold px-4 py-2 rounded-lg hover:bg-gray-800 transition disabled:opacity-40"
                        >
                            {pending ? "저장 중..." : "저장"}
                        </button>
                    </div>
                </div>
                <textarea
                    disabled={pending || loading || !!loadError || !loaded}
                    value={terms}
                    onChange={(e) => { setTerms(e.target.value); setSaved(false); }}
                    rows={16}
                    placeholder={`예시:\n제1조 (목적)\n본 약관은 STIZ 농구교실 다산2호점(이하 '학원')이 제공하는 교육 서비스 이용에 관한 기본적인 사항을 규정합니다.\n\n제2조 (수강료 및 환불)\n• 수강료는 매월 초에 납부합니다.\n• 개인 사정으로 인한 환불은 규정에 따릅니다.`}
                    className="w-full border border-gray-300 rounded-xl px-4 py-3 text-sm focus:ring-2 focus:ring-brand-orange-500 dark:focus:ring-brand-neon-lime focus:border-brand-orange-500 dark:border-brand-neon-lime bg-gray-50 focus:bg-white dark:focus:bg-gray-700 dark:bg-gray-800 resize-y font-mono leading-relaxed"
                />
                <p className="text-xs text-gray-400 mt-2">엔터키로 줄바꿈이 공개 페이지에 그대로 적용됩니다.</p>
            </div>
        </div>
    );
}
