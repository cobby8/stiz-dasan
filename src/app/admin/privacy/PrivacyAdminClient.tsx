"use client";
import { adminErrorText } from "@/components/admin/adminDisplayText";

import { useCallback, useEffect, useRef, useState } from "react";
import { updateAcademySettings } from "@/app/actions/admin";
import { DEFAULT_PRIVACY_POLICY } from "@/lib/defaultPolicies";

function PolicyEditorLoadingFallback() {
  return (
    <div className="space-y-6">
      <div>
        <div className="h-8 w-56 animate-pulse rounded bg-gray-200 dark:bg-gray-700" />
        <div className="mt-2 h-4 w-96 max-w-full animate-pulse rounded bg-gray-100 dark:bg-gray-800" />
      </div>
      <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-700 dark:bg-gray-800">
        <div className="h-5 w-32 animate-pulse rounded bg-gray-200 dark:bg-gray-700" />
        <div className="mt-4 h-[520px] animate-pulse rounded-lg bg-gray-100 dark:bg-gray-700" />
        <div className="mt-4 flex justify-end gap-2">
          <div className="h-10 w-24 animate-pulse rounded-lg bg-gray-100 dark:bg-gray-700" />
          <div className="h-10 w-24 animate-pulse rounded-lg bg-gray-200 dark:bg-gray-700" />
        </div>
      </div>
    </div>
  );
}

export default function PrivacyAdminClient({
  privacyPolicy: initialPrivacyPolicy,
  fetchError = false,
}: {
  privacyPolicy?: string;
  fetchError?: boolean;
}) {
  const hasInitialData = initialPrivacyPolicy !== undefined || fetchError;
  const [privacyPolicy, setPrivacyPolicy] = useState(initialPrivacyPolicy ?? DEFAULT_PRIVACY_POLICY);
  const [loading, setLoading] = useState(!hasInitialData);
  const [saved, setSaved] = useState(false);
  const [pending, setPending] = useState(false);
  const savingRef = useRef(false);
  const [loadError, setLoadError] = useState<string | null>(fetchError ? "현재 내용을 불러오지 못했습니다. 다시 불러온 뒤 저장해 주세요." : null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(hasInitialData && !fetchError);

  const loadPrivacyPolicy = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    setSaved(false);
    try {
      const response = await fetch("/api/admin/settings");
      if (!response.ok) throw new Error("Failed to load academy settings.");
      const data = (await response.json()) as { settings?: { privacyPolicy?: string | null } | null; fetchError?: boolean };
      if (data.fetchError || !("settings" in data)) throw new Error("Failed to load academy settings.");
      setPrivacyPolicy(data.settings?.privacyPolicy?.trim() || DEFAULT_PRIVACY_POLICY);
      setLoaded(true);
    } catch (error) {
      console.error("Failed to load privacy policy:", error);
      setLoadError("현재 내용을 불러오지 못했습니다. 다시 불러온 뒤 저장해 주세요.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (hasInitialData) return;
    void loadPrivacyPolicy();
  }, [hasInitialData, loadPrivacyPolicy]);

  if (loading && !loaded && !loadError) {
    return <PolicyEditorLoadingFallback />;
  }

  async function savePrivacyPolicy() {
    if (savingRef.current || loading || loadError || !loaded) return;
    savingRef.current = true;
    setPending(true);
    setSaved(false);
    setSaveError(null);
    try {
      await updateAcademySettings({ privacyPolicy });
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
        <button type="button" onClick={() => void loadPrivacyPolicy()} disabled={loading}>{loading ? "불러오는 중..." : "다시 불러오기"}</button>
      </div>}
      {saveError && <p role="alert">{saveError}</p>}

      <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white mb-2">
          개인정보처리방침 관리
        </h1>
        <p className="text-gray-500 dark:text-gray-400">
          공개 페이지(/privacy)에 표시되는 개인정보 처리방침을 관리합니다.
        </p>
      </div>

      <div className="bg-white dark:bg-gray-800 p-6 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-bold text-gray-900 dark:text-white">
            개인정보 처리방침 내용
          </h2>
          <div className="flex items-center gap-3">
            {saved && <span className="text-xs text-green-600 font-medium">저장됨</span>}
            <button
              onClick={savePrivacyPolicy}
              disabled={pending || loading || !!loadError || !loaded}
              className="bg-brand-navy-900 text-white text-sm font-bold px-4 py-2 rounded-lg hover:bg-gray-800 transition disabled:opacity-40"
            >
              {pending ? "저장 중..." : "저장"}
            </button>
          </div>
        </div>
        <textarea
          disabled={pending || loading || !!loadError || !loaded}
          value={privacyPolicy}
          onChange={(e) => {
            setPrivacyPolicy(e.target.value);
            setSaved(false);
          }}
          rows={22}
          placeholder={"제1조 (개인정보의 처리 목적)\n..."}
          className="w-full border border-gray-300 rounded-xl px-4 py-3 text-sm focus:ring-2 focus:ring-brand-orange-500 dark:focus:ring-brand-neon-lime focus:border-brand-orange-500 dark:border-brand-neon-lime bg-gray-50 focus:bg-white dark:focus:bg-gray-700 dark:bg-gray-800 resize-y font-mono leading-relaxed"
        />
        <p className="text-xs text-gray-400 mt-2">
          &quot;제1조 (...)&quot;처럼 조항 제목을 줄 시작에 쓰면 공개 페이지에서 카드 단위로 나뉘어 표시됩니다.
        </p>
      </div>
    </div>
  );
}
