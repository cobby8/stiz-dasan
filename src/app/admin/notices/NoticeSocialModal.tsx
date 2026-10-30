"use client";
import { adminErrorText } from "@/components/admin/adminDisplayText";

import { useEffect, useState, useTransition } from "react";
import { prepareNoticeSocialCampaign, publishNoticeSocialCampaign } from "@/app/actions/social-campaigns";
import type { NoticeData } from "./NoticesAdminClient";
import AdminModal from "@/components/admin/AdminModal";

type SocialPreview = Awaited<ReturnType<typeof prepareNoticeSocialCampaign>>;
type SocialPublishResult = Awaited<ReturnType<typeof publishNoticeSocialCampaign>>;

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

export default function NoticeSocialModal({
    notice,
    onClose,
}: {
    notice: NoticeData;
    onClose: () => void;
}) {
    const [, startTransition] = useTransition();
    const [socialPreview, setSocialPreview] = useState<SocialPreview | null>(null);
    const [socialLoading, setSocialLoading] = useState(true);
    const [socialResult, setSocialResult] = useState<SocialPublishResult | null>(null);
    const [publishFeed, setPublishFeed] = useState(true);
    const [publishStory, setPublishStory] = useState(true);

    useEffect(() => {
        let active = true;
        setSocialPreview(null);
        setSocialResult(null);
        setPublishFeed(true);
        setPublishStory(true);
        setSocialLoading(true);

        startTransition(async () => {
            try {
                const preview = await prepareNoticeSocialCampaign(notice.id);
                if (active) setSocialPreview(preview);
            } catch (error) {
                alert(adminErrorText(error, "소셜 발행 준비에 실패했습니다."));
                if (active) onClose();
            } finally {
                if (active) setSocialLoading(false);
            }
        });

        return () => {
            active = false;
        };
    }, [notice.id, onClose, startTransition]);

    function updateSocialPreview(patch: Partial<SocialPreview>) {
        setSocialPreview((prev) => (prev ? { ...prev, ...patch } : prev));
    }

    function copyAdDraft() {
        if (!socialPreview) return;
        const text = [
            "[페이스북 광고 소재]",
            `주요 문구: ${socialPreview.adPrimaryText}`,
            `제목: ${socialPreview.adHeadline}`,
            `설명: ${socialPreview.adDescription}`,
            `랜딩 링크: ${socialPreview.landingUrl}`,
        ].join("\n\n");
        navigator.clipboard?.writeText(text).catch(() => {});
        alert("페이스북 광고 문구를 복사했습니다.");
    }

    function handleSocialPublish() {
        if (!socialPreview) return;
        setSocialLoading(true);
        setSocialResult(null);
        startTransition(async () => {
            try {
                const result = await publishNoticeSocialCampaign(socialPreview.noticeId, {
                    feedCaption: socialPreview.feedCaption,
                    storyText: socialPreview.storyText,
                    adPrimaryText: socialPreview.adPrimaryText,
                    adHeadline: socialPreview.adHeadline,
                    adDescription: socialPreview.adDescription,
                    landingUrl: socialPreview.landingUrl,
                    publishInstagramFeed: socialPreview.mediaItems.length > 0 && publishFeed,
                    publishInstagramStory: socialPreview.mediaItems.length > 0 && publishStory,
                });
                setSocialResult(result);
            } catch (error) {
                alert(adminErrorText(error, "소셜 발행에 실패했습니다."));
            } finally {
                setSocialLoading(false);
            }
        });
    }

    return (
        <AdminModal onClose={onClose} titleId="notice-social-modal-title" panelClassName="max-w-3xl">
                <div className="p-6 border-b border-gray-100 dark:border-gray-800 flex items-center justify-between">
                    <div>
                        <h2 id="notice-social-modal-title" className="text-lg font-bold text-gray-900 dark:text-white">소셜 발행</h2>
                        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">{notice.title}</p>
                    </div>
                    <button onClick={onClose} className="p-1 hover:bg-gray-100 dark:bg-gray-800 rounded-lg">
                        <SymbolIcon name="close" size={20} />
                    </button>
                </div>

                {socialLoading && !socialPreview ? (
                    <div className="p-8 text-center text-sm font-bold text-gray-500">소셜 발행 내용을 준비 중입니다.</div>
                ) : socialPreview ? (
                    <div className="p-6 space-y-5">
                        {socialPreview.mediaItems.length > 0 ? (
                            <div className="flex gap-2 overflow-x-auto pb-1">
                                {socialPreview.mediaItems.map((item, index) => (
                                    // eslint-disable-next-line @next/next/no-img-element
                                    <img key={`${item.url}-${index}`} src={item.url} alt="" className="h-24 w-24 flex-shrink-0 rounded-xl object-cover border border-gray-200 dark:border-gray-700" />
                                ))}
                            </div>
                        ) : (
                            <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-bold text-amber-700">
                                인스타 피드/스토리에 올릴 이미지가 없습니다. 공지 본문이나 첨부파일에 이미지를 추가해주세요.
                            </div>
                        )}

                        <div className="grid gap-3 sm:grid-cols-2">
                            <label className="flex items-center gap-2 rounded-xl border border-gray-200 dark:border-gray-700 px-4 py-3 text-sm font-bold text-gray-700 dark:text-gray-200">
                                <input type="checkbox" checked={socialPreview.mediaItems.length > 0 && publishFeed} onChange={(e) => setPublishFeed(e.target.checked)} disabled={socialPreview.mediaItems.length === 0} />
                                인스타 피드
                            </label>
                            <label className="flex items-center gap-2 rounded-xl border border-gray-200 dark:border-gray-700 px-4 py-3 text-sm font-bold text-gray-700 dark:text-gray-200">
                                <input type="checkbox" checked={socialPreview.mediaItems.length > 0 && publishStory} onChange={(e) => setPublishStory(e.target.checked)} disabled={socialPreview.mediaItems.length === 0} />
                                인스타 스토리
                            </label>
                        </div>

                        <div>
                            <label className="block text-sm font-bold text-gray-700 dark:text-gray-200 mb-1">인스타 피드 문구</label>
                            <textarea
                                value={socialPreview.feedCaption}
                                onChange={(e) => updateSocialPreview({ feedCaption: e.target.value })}
                                rows={7}
                                className="w-full resize-none rounded-xl border border-gray-200 dark:border-gray-700 px-4 py-3 text-sm leading-6 dark:bg-gray-900 dark:text-white"
                            />
                        </div>

                        <div>
                            <label className="block text-sm font-bold text-gray-700 dark:text-gray-200 mb-1">스토리 문구</label>
                            <input
                                value={socialPreview.storyText}
                                onChange={(e) => updateSocialPreview({ storyText: e.target.value })}
                                className="w-full rounded-xl border border-gray-200 dark:border-gray-700 px-4 py-3 text-sm dark:bg-gray-900 dark:text-white"
                            />
                        </div>

                        <div className="rounded-2xl border border-gray-200 dark:border-gray-700 p-4 space-y-3">
                            <h3 className="font-bold text-gray-900 dark:text-white">페이스북 광고 소재</h3>
                            <textarea
                                value={socialPreview.adPrimaryText}
                                onChange={(e) => updateSocialPreview({ adPrimaryText: e.target.value })}
                                rows={5}
                                className="w-full resize-none rounded-xl border border-gray-200 dark:border-gray-700 px-4 py-3 text-sm leading-6 dark:bg-gray-900 dark:text-white"
                            />
                            <input
                                value={socialPreview.adHeadline}
                                onChange={(e) => updateSocialPreview({ adHeadline: e.target.value })}
                                className="w-full rounded-xl border border-gray-200 dark:border-gray-700 px-4 py-3 text-sm dark:bg-gray-900 dark:text-white"
                                placeholder="광고 제목"
                            />
                            <input
                                value={socialPreview.adDescription}
                                onChange={(e) => updateSocialPreview({ adDescription: e.target.value })}
                                className="w-full rounded-xl border border-gray-200 dark:border-gray-700 px-4 py-3 text-sm dark:bg-gray-900 dark:text-white"
                                placeholder="광고 설명"
                            />
                            <input
                                value={socialPreview.landingUrl}
                                onChange={(e) => updateSocialPreview({ landingUrl: e.target.value })}
                                className="w-full rounded-xl border border-gray-200 dark:border-gray-700 px-4 py-3 text-sm dark:bg-gray-900 dark:text-white"
                                placeholder="랜딩 링크"
                            />
                            <div className="grid gap-2 sm:grid-cols-2">
                                <button
                                    type="button"
                                    onClick={copyAdDraft}
                                    className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-gray-200 dark:border-gray-700 px-4 text-sm font-bold text-gray-700 dark:text-gray-200"
                                >
                                    <SymbolIcon name="content_copy" size={16} />
                                    광고 문구 복사
                                </button>
                                <a
                                    href="https://adsmanager.facebook.com/adsmanager/manage/campaigns"
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 text-sm font-bold text-white"
                                >
                                    <SymbolIcon name="open_in_new" size={16} />
                                    광고관리자 열기
                                </a>
                            </div>
                        </div>

                        {socialResult && (
                            <div className="rounded-xl border border-gray-200 dark:border-gray-700 p-4 text-sm">
                                <p className="font-bold text-gray-900 dark:text-white mb-2">발행 결과</p>
                                <div className="space-y-1">
                                    {socialResult.results.length === 0 ? (
                                        <p className="text-gray-500">인스타 발행 없이 광고 소재만 준비했습니다.</p>
                                    ) : socialResult.results.map((result) => (
                                        <p key={result.channel} className={result.ok ? "text-green-700" : "text-red-600"}>
                                            {result.channel}: {result.message}
                                        </p>
                                    ))}
                                </div>
                            </div>
                        )}

                        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                            <button onClick={onClose} className="px-4 py-2 text-sm text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:bg-gray-800 rounded-xl transition">닫기</button>
                            <button
                                onClick={handleSocialPublish}
                                disabled={socialLoading}
                                className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-brand-orange-500 dark:bg-brand-neon-lime dark:text-brand-navy-900 px-5 text-sm font-bold text-white disabled:opacity-50"
                            >
                                <SymbolIcon name="campaign" size={16} />
                                {socialLoading ? "발행 중..." : "선택 항목 발행"}
                            </button>
                        </div>
                    </div>
                ) : null}
        </AdminModal>
    );
}
