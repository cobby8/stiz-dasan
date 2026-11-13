"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { updateAcademySettings } from "@/app/actions/admin";
import TrialFeeGuideSettings from "./TrialFeeGuideSettings";

type ApplySettings = {
    trialTitle: string;
    trialContent: string | null;
    trialFormUrl: string | null;
    enrollTitle: string;
    enrollContent: string | null;
    enrollFormUrl: string | null;
    uniformFormUrl: string | null;
};

interface ApplySettingsTabProps {
    initialSettings?: ApplySettings;
}

const DEFAULT_SETTINGS: ApplySettings = {
    trialTitle: "체험수업 안내",
    trialContent: null,
    trialFormUrl: null,
    enrollTitle: "수강신청 안내",
    enrollContent: null,
    enrollFormUrl: null,
    uniformFormUrl: null,
};

// 입력칸 = 테마 공용 입력칸(academy-input: 44px·입력선 테두리) — 2026-11-13 UI 통일
const INPUT = "academy-input";
const TEXTAREA = INPUT + " resize-none";

export default function ApplySettingsTab({ initialSettings }: ApplySettingsTabProps) {
    const settings = initialSettings ?? DEFAULT_SETTINGS;
    const [trialTitle, setTrialTitle] = useState(settings.trialTitle);
    const [trialContent, setTrialContent] = useState(settings.trialContent || "");
    const [trialFormUrl, setTrialFormUrl] = useState(settings.trialFormUrl || "");
    const [enrollTitle, setEnrollTitle] = useState(settings.enrollTitle);
    const [enrollContent, setEnrollContent] = useState(settings.enrollContent || "");
    const [enrollFormUrl, setEnrollFormUrl] = useState(settings.enrollFormUrl || "");
    const [uniformFormUrl, setUniformFormUrl] = useState(settings.uniformFormUrl || "");
    const [loading, setLoading] = useState(!initialSettings);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const applySettings = useCallback((nextSettings: ApplySettings) => {
        setTrialTitle(nextSettings.trialTitle);
        setTrialContent(nextSettings.trialContent || "");
        setTrialFormUrl(nextSettings.trialFormUrl || "");
        setEnrollTitle(nextSettings.enrollTitle);
        setEnrollContent(nextSettings.enrollContent || "");
        setEnrollFormUrl(nextSettings.enrollFormUrl || "");
        setUniformFormUrl(nextSettings.uniformFormUrl || "");
    }, []);

    const loadSettings = useCallback(async () => {
        setLoading(true);
        setLoadError(null);

        try {
            const response = await fetch("/api/admin/apply/settings", { cache: "no-store" });
            if (!response.ok) {
                throw new Error("request failed");
            }
            const data = (await response.json()) as { settings: ApplySettings };
            applySettings(data.settings);
        } catch {
            setLoadError("신청 안내 설정을 불러오지 못했습니다.");
        } finally {
            setLoading(false);
        }
    }, [applySettings]);

    useEffect(() => {
        if (initialSettings) return;
        void loadSettings();
    }, [initialSettings, loadSettings]);

    async function handleSave() {
        setSaving(true);
        setSaved(false);
        setError(null);
        try {
            await updateAcademySettings({
                trialTitle: trialTitle.trim() || "체험수업 안내",
                trialContent: trialContent.trim() || undefined,
                trialFormUrl: trialFormUrl.trim() || undefined,
                enrollTitle: enrollTitle.trim() || "수강신청 안내",
                enrollContent: enrollContent.trim() || undefined,
                enrollFormUrl: enrollFormUrl.trim() || undefined,
                uniformFormUrl: uniformFormUrl.trim() || undefined,
            });
            setSaved(true);
            setTimeout(() => setSaved(false), 3000);
        } catch (saveError: any) {
            setError(saveError.message ?? "저장 실패");
        } finally {
            setSaving(false);
        }
    }

    if (loading) {
        return (
            <div className="rounded-xl border border-[var(--color-academy-line)] bg-white p-6 text-center text-sm text-[var(--color-academy-muted)]">
                신청 안내 설정을 불러오는 중...
            </div>
        );
    }

    if (loadError) {
        return (
            <div className="rounded-xl border border-[var(--color-academy-line)] bg-white p-6 text-center">
                <p className="text-sm font-semibold text-[var(--color-academy-danger)]">{loadError}</p>
                <button
                    type="button"
                    onClick={loadSettings}
                    className="academy-button-primary mt-3"
                >
                    다시 시도
                </button>
            </div>
        );
    }

    return (
        <div className="space-y-8">
            {error && (
                <div className="bg-[var(--color-academy-danger-soft)] border border-[var(--color-academy-line)] text-[var(--color-academy-danger)] text-sm rounded-lg p-4">
                    {error}
                </div>
            )}

            <SettingsCard badge="체험수업" badgeColor="bg-[var(--color-academy-neutral-soft)] text-[var(--color-academy-neutral)] border border-[var(--color-academy-line)]" title="체험수업 안내 설정">
                <div>
                    <label className="block text-xs font-medium text-[var(--color-academy-muted)] mb-1">섹션 제목</label>
                    <input
                        type="text"
                        value={trialTitle}
                        onChange={(event) => setTrialTitle(event.target.value)}
                        className={INPUT}
                        placeholder="체험수업 안내"
                    />
                </div>
                <div>
                    <label className="block text-xs font-medium text-[var(--color-academy-muted)] mb-1">
                        안내 내용
                    </label>
                    <textarea
                        value={trialContent}
                        onChange={(event) => setTrialContent(event.target.value)}
                        rows={6}
                        className={TEXTAREA}
                        placeholder={"예:\n- 체험수업 1회 1만원(신청 후 바로 결제)\n- 준비물: 실내용 운동화, 운동복장, 물\n- 위치: 남양주시 다산중앙로20번길 10-32, 1층\n- 체험비가 확인되면 체험수업이 확정됩니다"}
                    />
                </div>
                <div>
                    <label className="block text-xs font-medium text-[var(--color-academy-muted)] mb-1">
                        외부 신청 링크
                    </label>
                    <input
                        type="url"
                        value={trialFormUrl}
                        onChange={(event) => setTrialFormUrl(event.target.value)}
                        className={INPUT}
                        placeholder="https://..."
                    />
                </div>
            </SettingsCard>

            {/* 체험비 온라인 결제 설정 + 체험·등록 안내 미리보기(2026-11-10). 자동 발송은 원장 문구 승인 전이라 «꺼짐» 표시만 */}
            <TrialFeeGuideSettings />

            <SettingsCard badge="수강신청" badgeColor="bg-[var(--color-academy-soft)] text-[var(--color-academy-muted)] border border-[var(--color-academy-line)]" title="수강신청 안내 설정">
                <div>
                    <label className="block text-xs font-medium text-[var(--color-academy-muted)] mb-1">섹션 제목</label>
                    <input
                        type="text"
                        value={enrollTitle}
                        onChange={(event) => setEnrollTitle(event.target.value)}
                        className={INPUT}
                        placeholder="수강신청 안내"
                    />
                </div>
                <div>
                    <label className="block text-xs font-medium text-[var(--color-academy-muted)] mb-1">
                        안내 내용
                    </label>
                    <textarea
                        value={enrollContent}
                        onChange={(event) => setEnrollContent(event.target.value)}
                        rows={6}
                        className={TEXTAREA}
                        placeholder={"예:\n- 신청서 작성 후 원장님 확인\n- 수강료는 매월 1일 납부"}
                    />
                </div>
                <div>
                    <label className="block text-xs font-medium text-[var(--color-academy-muted)] mb-1">
                        외부 신청 링크
                    </label>
                    <input
                        type="url"
                        value={enrollFormUrl}
                        onChange={(event) => setEnrollFormUrl(event.target.value)}
                        className={INPUT}
                        placeholder="https://..."
                    />
                </div>
            </SettingsCard>

            <SettingsCard badge="유니폼" badgeColor="bg-[var(--color-academy-neutral-soft)] text-[var(--color-academy-neutral)] border border-[var(--color-academy-line)]" title="유니폼 신청 설정">
                <div>
                    <label className="block text-xs font-medium text-[var(--color-academy-muted)] mb-1">
                        유니폼 신청 링크
                    </label>
                    <input
                        type="url"
                        value={uniformFormUrl}
                        onChange={(event) => setUniformFormUrl(event.target.value)}
                        className={INPUT}
                        placeholder="https://..."
                    />
                </div>
            </SettingsCard>

            <div className="flex justify-end gap-3">
                {saved && <span className="text-sm text-[var(--color-academy-success)] font-medium self-center">저장 완료</span>}
                <button
                    onClick={handleSave}
                    disabled={saving}
                    className="academy-button-primary"
                >
                    {saving ? "저장 중..." : "저장하기"}
                </button>
            </div>
        </div>
    );
}

function SettingsCard({
    badge,
    badgeColor,
    title,
    children,
}: {
    badge: string;
    badgeColor: string;
    title: string;
    children: ReactNode;
}) {
    return (
        <div className="bg-white rounded-xl shadow-sm border border-[var(--color-academy-line)] overflow-hidden">
            <div className="px-6 py-4 border-b border-[var(--color-academy-line)] flex items-center gap-3">
                <span className={`text-xs font-medium px-2.5 py-1 rounded-full ${badgeColor}`}>{badge}</span>
                <h2 className="academy-section-title">{title}</h2>
            </div>
            <div className="p-6 space-y-4">{children}</div>
        </div>
    );
}
