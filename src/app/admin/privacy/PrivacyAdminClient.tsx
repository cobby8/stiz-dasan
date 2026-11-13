"use client";
import { adminErrorText } from "@/components/admin/adminDisplayText";
import AdminPageHeader from "@/components/admin/AdminPageHeader";

import { useCallback, useEffect, useRef, useState } from "react";
import { updateAcademySettings } from "@/app/actions/admin";
import { DEFAULT_PRIVACY_POLICY } from "@/lib/defaultPolicies";

function PolicyEditorLoadingFallback() {
  return (
    <div className="space-y-6">
      <div>
        <div className="h-8 w-56 animate-pulse rounded bg-[var(--color-academy-line)]" />
        <div className="mt-2 h-4 w-96 max-w-full animate-pulse rounded bg-[var(--color-academy-soft)]" />
      </div>
      <div className="rounded-xl border border-[var(--color-academy-line)] bg-white p-5 shadow-sm">
        <div className="h-5 w-32 animate-pulse rounded bg-[var(--color-academy-line)]" />
        <div className="mt-4 h-[520px] animate-pulse rounded-lg bg-[var(--color-academy-soft)]" />
        <div className="mt-4 flex justify-end gap-2">
          <div className="h-10 w-24 animate-pulse rounded-lg bg-[var(--color-academy-soft)]" />
          <div className="h-10 w-24 animate-pulse rounded-lg bg-[var(--color-academy-line)]" />
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
        <button type="button" onClick={() => void loadPrivacyPolicy()} disabled={loading} className="academy-button-secondary mt-2">{loading ? "불러오는 중..." : "다시 불러오기"}</button>
      </div>}
      {saveError && <p role="alert">{saveError}</p>}

      <AdminPageHeader title="개인정보처리방침 관리" description="공개 페이지(/privacy)에 표시되는 개인정보 처리방침을 관리합니다." />

      <div className="bg-white p-6 rounded-xl shadow-sm border border-[var(--color-academy-line)]">
        <div className="flex items-center justify-between mb-4">
          <h2 className="academy-section-title">
            개인정보 처리방침 내용
          </h2>
          <div className="flex items-center gap-3">
            {saved && <span className="text-xs text-[var(--color-academy-success)]">저장됨</span>}
            <button
              onClick={savePrivacyPolicy}
              disabled={pending || loading || !!loadError || !loaded}
              className="academy-button-primary"
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
          className="w-full border border-[var(--color-academy-line-input)] rounded-xl px-4 py-3 text-sm focus:ring-2 focus:ring-[var(--color-academy-primary)] focus:border-[var(--color-academy-primary)] bg-[var(--color-academy-soft)] focus:bg-white resize-y font-mono leading-relaxed"
        />
        <p className="text-xs text-[var(--color-academy-faint)] mt-2">
          &quot;제1조 (...)&quot;처럼 조항 제목을 줄 시작에 쓰면 공개 페이지에서 카드 단위로 나뉘어 표시됩니다.
        </p>
      </div>
    </div>
  );
}
