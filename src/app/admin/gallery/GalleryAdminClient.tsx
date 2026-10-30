"use client";
import { adminErrorText, adminMessageText } from "@/components/admin/adminDisplayText";

import { useCallback, useEffect, useState, useTransition } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { deleteGalleryPost, syncInstagramGalleryPosts } from "@/app/actions/admin";
import {
  publishSocialPostDraft,
  rejectSocialPostDraft,
  saveSocialPostDraft,
} from "@/app/actions/social-posts";
import InstagramFeedPreview from "@/components/instagram/InstagramFeedPreview";
import FontFreeIcon from "@/components/ui/FontFreeIcon";
import { toKstYmd } from "@/lib/datetime/kst";
import type { SocialPostDraft } from "@/lib/socialDrafts";

const GalleryPostFormModal = dynamic(() => import("./GalleryPostFormModal"), {
  loading: () => null,
});

const GALLERY_PAGE_SIZE = 24;

type MediaItem = { url: string; type: "image" | "video" };
type GalleryPost = {
  id: string;
  classId: string | null;
  title: string | null;
  caption: string | null;
  mediaJSON: string;
  isPublic: boolean;
  createdAt: Date | string;
  className: string | null;
};
type ClassInfo = { id: string; name: string; program?: { name: string } | null };
type InstagramStatus = {
  profileUrl: string;
  businessAccountId: string;
  autoPublishEnabled: boolean;
  hasAccessToken: boolean;
  hasBusinessAccountId: boolean;
};
type GalleryPayload = {
  posts: GalleryPost[];
  classes: ClassInfo[];
  instagramStatus: InstagramStatus;
  socialDrafts: SocialPostDraft[];
  pagination: GalleryPagination;
};
type GalleryPostsPagePayload = {
  posts: GalleryPost[];
  pagination: GalleryPagination;
};
type GalleryPagination = {
  limit: number;
  offset: number;
  returned: number;
  total: number;
  hasMore: boolean;
  nextOffset: number | null;
  partial: boolean;
};

function normalizeInstagramProfileUrl(url: string) {
  const trimmed = url.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("@")) return `https://www.instagram.com/${trimmed.slice(1)}`;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

function parseMedia(mediaJSON: string): MediaItem[] {
  try {
    const parsed = JSON.parse(mediaJSON);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function GalleryLoadingFallback() {
  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <div className="h-8 w-44 animate-pulse rounded bg-gray-200 dark:bg-gray-700" />
          <div className="mt-2 h-4 w-80 max-w-full animate-pulse rounded bg-gray-100 dark:bg-gray-800" />
        </div>
        <div className="flex flex-wrap gap-2">
          <div className="h-10 w-32 animate-pulse rounded-lg bg-gray-100 dark:bg-gray-800" />
          <div className="h-10 w-28 animate-pulse rounded-lg bg-gray-200 dark:bg-gray-700" />
        </div>
      </div>
      <section className="rounded-lg border border-gray-100 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div className="space-y-2">
            <div className="h-5 w-36 animate-pulse rounded bg-gray-200 dark:bg-gray-700" />
            <div className="h-4 w-96 max-w-full animate-pulse rounded bg-gray-100 dark:bg-gray-700" />
          </div>
          <div className="h-9 w-32 animate-pulse rounded-lg bg-gray-100 dark:bg-gray-700" />
        </div>
      </section>
      <section className="rounded-lg border border-orange-100 bg-orange-50/40 p-4 dark:border-gray-700 dark:bg-gray-800">
        <div className="flex items-center justify-between gap-3">
          <div className="space-y-2">
            <div className="h-5 w-32 animate-pulse rounded bg-orange-100 dark:bg-gray-700" />
            <div className="h-4 w-72 max-w-full animate-pulse rounded bg-orange-100/80 dark:bg-gray-700" />
          </div>
          <div className="h-8 w-20 animate-pulse rounded-full bg-orange-100 dark:bg-gray-700" />
        </div>
      </section>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }).map((_, index) => (
          <div
            key={index}
            className="overflow-hidden rounded-lg border border-gray-100 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-800"
          >
            <div className="aspect-video animate-pulse bg-gray-100 dark:bg-gray-700" />
            <div className="space-y-3 p-4">
              <div className="h-5 w-3/4 animate-pulse rounded bg-gray-200 dark:bg-gray-700" />
              <div className="h-4 w-full animate-pulse rounded bg-gray-100 dark:bg-gray-700" />
              <div className="h-4 w-2/3 animate-pulse rounded bg-gray-100 dark:bg-gray-700" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function GalleryErrorState({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="rounded-lg border border-red-200 bg-red-50 p-6 text-center dark:border-red-800 dark:bg-red-950/30">
      <p className="text-sm font-bold text-red-700 dark:text-red-200">갤러리 데이터를 불러오지 못했습니다.</p>
      <button
        type="button"
        onClick={onRetry}
        className="academy-button-secondary mt-4"
      >
        다시 불러오기
      </button>
    </div>
  );
}

export default function GalleryAdminClient({
  posts: initialPosts,
  classes: initialClasses,
  instagramStatus: initialInstagramStatus,
  socialDrafts: initialSocialDrafts,
  pagination: initialPagination,
}: {
  posts?: GalleryPost[];
  classes?: ClassInfo[];
  instagramStatus?: InstagramStatus;
  socialDrafts?: SocialPostDraft[];
  pagination?: GalleryPagination;
}) {
  const [isPending, startTransition] = useTransition();
  const hasInitialData = initialPosts !== undefined && initialClasses !== undefined;
  const [posts, setPosts] = useState<GalleryPost[]>(initialPosts ?? []);
  const [classes, setClasses] = useState<ClassInfo[]>(initialClasses ?? []);
  const [instagramStatus, setInstagramStatus] = useState<InstagramStatus | undefined>(initialInstagramStatus);
  const [drafts, setDrafts] = useState<SocialPostDraft[]>(initialSocialDrafts ?? []);
  const [pagination, setPagination] = useState<GalleryPagination | undefined>(initialPagination);
  const [loading, setLoading] = useState(!hasInitialData);
  const [loadError, setLoadError] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [editingPost, setEditingPost] = useState<GalleryPost | null>(null);
  const [syncResult, setSyncResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [draftMessage, setDraftMessage] = useState<string | null>(null);
  const [draftBusy, setDraftBusy] = useState<{ id: string; action: "save" | "publish" | "reject" } | null>(null);
  const [pageMessage, setPageMessage] = useState<{ ok: boolean; message: string } | null>(null);

  const loadGallery = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const response = await fetch(`/api/admin/gallery?limit=${GALLERY_PAGE_SIZE}`, { cache: "no-store" });
      if (!response.ok) throw new Error("Failed to load gallery data.");
      const data = (await response.json()) as GalleryPayload;
      setPosts(data.posts);
      setClasses(data.classes);
      setInstagramStatus(data.instagramStatus);
      setDrafts(data.socialDrafts);
      setPagination(data.pagination);
    } catch (error) {
      console.error("Failed to load gallery data:", error);
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!hasInitialData) void loadGallery();
  }, [hasInitialData, loadGallery]);

  const instagramReady = Boolean(instagramStatus?.hasAccessToken && instagramStatus.hasBusinessAccountId);
  const instagramProfileUrl = normalizeInstagramProfileUrl(instagramStatus?.profileUrl || "");
  const hasMorePosts = Boolean(pagination?.hasMore);

  async function loadMorePosts() {
    if (loadingMore || !pagination?.hasMore || pagination.nextOffset === null) return;
    setLoadingMore(true);
    try {
      const params = new URLSearchParams({
        postsOnly: "1",
        limit: String(pagination.limit || GALLERY_PAGE_SIZE),
        offset: String(pagination.nextOffset),
      });
      const response = await fetch(`/api/admin/gallery?${params.toString()}`, { cache: "no-store" });
      if (!response.ok) throw new Error("Failed to load more gallery posts.");
      const data = (await response.json()) as GalleryPostsPagePayload;
      setPosts((current) => {
        const seen = new Set(current.map((post) => post.id));
        return [...current, ...data.posts.filter((post) => !seen.has(post.id))];
      });
      setPagination(data.pagination);
    } catch (error) {
      console.error("Failed to load more gallery posts:", error);
      setPageMessage({ ok: false, message: "갤러리 게시물을 더 불러오지 못했습니다." });
    } finally {
      setLoadingMore(false);
    }
  }

  function closeForm() {
    setShowForm(false);
    setEditingPost(null);
  }

  function startEdit(post: GalleryPost) {
    setEditingPost(post);
    setShowForm(true);
  }

  function handleDelete(id: string) {
    if (!confirm("이 갤러리 게시물을 삭제할까요?")) return;
    startTransition(async () => {
      try {
        await deleteGalleryPost(id);
        await loadGallery();
        setPageMessage({ ok: true, message: "갤러리 게시물이 삭제됐습니다." });
      } catch (error) {
        alert(adminErrorText(error, "갤러리 게시물 삭제 중 오류가 발생했습니다."));
      }
    });
  }

  function handleInstagramSync() {
    setSyncResult(null);
    startTransition(async () => {
      try {
        const result = await syncInstagramGalleryPosts();
        setSyncResult({ ok: result.ok, message: result.message });
        await loadGallery();
      } catch (error) {
        console.error("Instagram sync failed:", error);
        setSyncResult({ ok: false, message: "인스타그램 가져오기 중 오류가 발생했습니다." });
      }
    });
  }

  function patchDraft(id: string, patch: Partial<SocialPostDraft>) {
    setDrafts((prev) => prev.map((draft) => (draft.id === id ? { ...draft, ...patch } : draft)));
  }

  function runDraftAction(id: string, action: "save" | "publish" | "reject", task: () => Promise<void>) {
    setDraftBusy({ id, action });
    startTransition(async () => {
      try {
        await task();
      } finally {
        setDraftBusy((current) => (current?.id === id && current.action === action ? null : current));
      }
    });
  }

  function handleDraftSave(draft: SocialPostDraft) {
    setDraftMessage(null);
    runDraftAction(draft.id, "save", async () => {
      try {
        const result = await saveSocialPostDraft(draft.id, {
          title: draft.title,
          caption: draft.caption,
          hashtags: draft.hashtags,
          lessonType: draft.lessonType,
          memo: draft.memo,
          isPublic: draft.isPublic,
        });
        patchDraft(draft.id, result.draft);
        setDraftMessage("초안 수정 내용을 저장했습니다.");
      } catch (error) {
        setDraftMessage(adminErrorText(error, "초안 저장에 실패했습니다."));
      }
    });
  }

  function handleDraftPublish(draft: SocialPostDraft) {
    if (!confirm("이 초안을 홈페이지 갤러리와 인스타그램에 바로 게시할까요?")) return;
    setDraftMessage(null);
    runDraftAction(draft.id, "publish", async () => {
      try {
        const result = await publishSocialPostDraft(draft.id);
        patchDraft(draft.id, result.draft);
        setDraftMessage(
          result.ok
            ? "홈페이지 갤러리와 인스타그램 게시가 완료됐습니다."
            : "홈페이지 갤러리는 게시됐고, 인스타그램은 재시도 대기 중입니다.",
        );
        await loadGallery();
      } catch (error) {
        setDraftMessage(adminErrorText(error, "게시 중 오류가 발생했습니다."));
      }
    });
  }

  function handleDraftReject(draft: SocialPostDraft) {
    if (!confirm("이 초안을 반려할까요?")) return;
    setDraftMessage(null);
    runDraftAction(draft.id, "reject", async () => {
      try {
        const result = await rejectSocialPostDraft(draft.id);
        setDrafts((prev) => prev.filter((item) => item.id !== draft.id));
        await loadGallery();
        setDraftMessage(
          result.removedGalleryPostId
            ? "초안을 반려하고 연결된 갤러리 게시물을 삭제했습니다."
            : "초안을 반려했습니다.",
        );
      } catch (error) {
        setDraftMessage(adminErrorText(error, "반려 처리에 실패했습니다."));
      }
    });
  }

  if (loading && posts.length === 0) {
    return <GalleryLoadingFallback />;
  }

  if (loadError && posts.length === 0) {
    return <GalleryErrorState onRetry={loadGallery} />;
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">사진/영상 갤러리</h1>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link
            href="/staff/quick-post"
            prefetch={false}
            className="flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-4 py-2.5 text-sm font-bold text-gray-700 transition hover:border-brand-orange-500 hover:text-brand-orange-500 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200"
          >
            <FontFreeIcon name="upload" size={18} />
            선생님 업로드
          </Link>
          <button
            onClick={() => {
              setEditingPost(null);
              setShowForm(true);
            }}
            className="flex items-center gap-2 rounded-lg bg-brand-orange-500 px-4 py-2.5 text-sm font-bold text-white transition hover:bg-orange-600 dark:bg-brand-neon-lime dark:text-brand-navy-900"
          >
            <FontFreeIcon name="add" size={18} /> 새 게시물
          </button>
        </div>
      </div>

      {pageMessage && (
        <div
          className={`flex items-start justify-between gap-3 rounded-lg border px-4 py-3 text-sm font-bold ${
            pageMessage.ok
              ? "border-green-200 bg-green-50 text-green-700"
              : "border-red-200 bg-red-50 text-red-700"
          }`}
        >
          <div className="flex items-center gap-2">
            <FontFreeIcon name="check_circle" size={18} />
            <span>{pageMessage.message}</span>
          </div>
          <button
            type="button"
            onClick={() => setPageMessage(null)}
            className="rounded p-0.5 opacity-70 transition hover:opacity-100"
            aria-label="메시지 닫기"
          >
            <FontFreeIcon name="close" size={16} />
          </button>
        </div>
      )}

      {instagramStatus && (
        <section className="rounded-lg border border-gray-100 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-sm font-bold text-gray-900 dark:text-white">인스타그램 연결</h2>
                <span
                  className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${
                    instagramReady ? "bg-green-50 text-green-700" : "bg-amber-50 text-amber-700"
                  }`}
                >
                  {instagramReady ? "준비 완료" : "설정 필요"}
                </span>
                {instagramStatus.autoPublishEnabled && (
                  <span className="rounded-full bg-blue-50 px-2 py-0.5 text-[11px] font-bold text-blue-700">
                    즉시 업로드 켜짐
                  </span>
                )}
              </div>
              {syncResult && (
                <p className={`mt-1 text-xs font-medium ${syncResult.ok ? "text-green-600" : "text-red-600"}`}>
                  {syncResult.ok ? syncResult.message : adminMessageText(syncResult.message, "인스타그램 게시물을 가져오지 못했습니다. 연결 설정을 확인해 주세요.")}
                </p>
              )}
            </div>
            <div className="flex gap-2">
              {instagramProfileUrl && (
                <a
                  href={instagramProfileUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="rounded-lg border border-gray-200 px-3 py-2 text-xs font-bold text-gray-600 transition hover:border-brand-orange-500 hover:text-brand-orange-500 dark:border-gray-700 dark:text-gray-300"
                >
                  프로필 열기
                </a>
              )}
              <button
                onClick={handleInstagramSync}
                disabled={!instagramReady || isPending}
                className="flex items-center gap-2 rounded-lg bg-gray-900 px-3 py-2 text-xs font-bold text-white transition hover:bg-gray-700 disabled:opacity-40"
              >
                {isPending ? (
                  <FontFreeIcon name="sync" size={14} className="animate-spin" />
                ) : (
                  <FontFreeIcon name="sync" size={14} />
                )}
                인스타 가져오기
              </button>
            </div>
          </div>
        </section>
      )}

      <section className="rounded-lg border border-gray-100 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
        <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
          <div>
            <h2 className="text-lg font-black text-gray-900 dark:text-white">선생님 업로드 대기</h2>
            <p className="text-sm text-gray-500 dark:text-gray-400">
              문구를 직접 수정한 뒤 게시하면 홈페이지 갤러리와 인스타그램에 함께 반영됩니다.
            </p>
          </div>
          <span className="w-fit rounded-full bg-gray-100 px-3 py-1 text-xs font-bold text-gray-600">
            {drafts.length}개 대기
          </span>
        </div>

        {draftMessage && (
          <div className="mt-3 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm font-bold text-gray-700">
            {draftMessage}
          </div>
        )}

        {drafts.length === 0 ? (
          <div className="mt-4 rounded-lg border border-dashed border-gray-300 p-8 text-center text-sm text-gray-400">
            승인 대기 중인 초안이 없습니다.
          </div>
        ) : (
          <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
            {drafts.map((draft) => {
              const media = parseMedia(draft.mediaJSON).filter((item) => item.type === "image");
              const hasPublishingStatus = draft.status === "PUBLISHING";
              const isDraftBusy = draftBusy?.id === draft.id;
              const isPublishingDraft = isDraftBusy && draftBusy?.action === "publish";
              const isRejectingDraft = isDraftBusy && draftBusy?.action === "reject";
              const isEditLocked = isDraftBusy || hasPublishingStatus;
              return (
                <div key={draft.id} className="grid gap-4 rounded-lg border border-gray-200 p-3 md:grid-cols-[minmax(220px,320px)_1fr]">
                  <InstagramFeedPreview
                    mediaItems={media}
                    caption={draft.caption || ""}
                    hashtags={draft.hashtags || ""}
                    editable
                    compact
                    onCaptionChange={(value) => patchDraft(draft.id, { caption: value })}
                    onHashtagsChange={(value) => patchDraft(draft.id, { hashtags: value })}
                  />
                  <div className="flex min-w-0 flex-col justify-between gap-3">
                    <div className="space-y-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="rounded-full bg-orange-50 px-2 py-0.5 text-xs font-bold text-orange-700">
                          {draft.lessonType || "수업"}
                        </span>
                        <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-bold text-gray-600">
                          {draft.authorName || "선생님"}
                        </span>
                        {draft.status === "FAILED" && (
                          <span className="rounded-full bg-red-50 px-2 py-0.5 text-xs font-bold text-red-700">
                            재시도 필요
                          </span>
                        )}
                        {hasPublishingStatus && (
                          <span className="rounded-full bg-blue-50 px-2 py-0.5 text-xs font-bold text-blue-700">
                            게시 처리 중
                          </span>
                        )}
                      </div>
                      <input
                        value={draft.title || ""}
                        onChange={(event) => patchDraft(draft.id, { title: event.target.value })}
                        className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm font-bold outline-none focus:border-brand-orange-500"
                        placeholder="게시물 제목"
                      />
                      {draft.memo && <p className="text-xs leading-5 text-gray-500">메모: {draft.memo}</p>}
                      {draft.instagramPublishError && (
                        <p className="rounded-lg bg-red-50 p-2 text-xs font-medium leading-5 text-red-700">
                          {draft.instagramPublishError}
                        </p>
                      )}
                    </div>
                    <div className="grid grid-cols-3 gap-2">
                      <button
                        type="button"
                        onClick={() => handleDraftSave(draft)}
                        disabled={isEditLocked}
                        className="flex min-h-10 items-center justify-center gap-1 rounded-lg border border-gray-200 px-2 text-xs font-black text-gray-700 disabled:opacity-50"
                      >
                        <FontFreeIcon name="save" size={15} />
                        저장
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDraftPublish(draft)}
                        disabled={isEditLocked}
                        className="flex min-h-10 items-center justify-center gap-1 rounded-lg bg-brand-orange-500 px-2 text-xs font-black text-white disabled:opacity-50"
                      >
                        {isPublishingDraft || hasPublishingStatus ? (
                          <FontFreeIcon name="sync" size={15} className="animate-spin" />
                        ) : (
                          <FontFreeIcon name="send" size={15} />
                        )}
                        {hasPublishingStatus ? "처리 중" : draft.status === "FAILED" ? "다시 게시" : "게시"}
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDraftReject(draft)}
                        disabled={isRejectingDraft}
                        className="flex min-h-10 items-center justify-center gap-1 rounded-lg bg-gray-100 px-2 text-xs font-black text-gray-600 disabled:opacity-50"
                      >
                        {isRejectingDraft ? (
                          <FontFreeIcon name="sync" size={15} className="animate-spin" />
                        ) : (
                          <FontFreeIcon name="block" size={15} />
                        )}
                        {isRejectingDraft ? "반려 중" : "반려"}
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {showForm && (
        <GalleryPostFormModal
          post={editingPost}
          classes={classes}
          onClose={closeForm}
          onSaved={(message) => {
            setPageMessage({ ok: true, message });
            closeForm();
            void loadGallery();
          }}
        />
      )}

      {posts.length === 0 ? (
        <div className="rounded-lg border border-gray-100 bg-white p-12 text-center text-gray-400 dark:border-gray-700 dark:bg-gray-800">
          <FontFreeIcon name="image" className="mx-auto mb-3 text-gray-300" size={48} />
          <p className="font-medium">아직 갤러리 게시물이 없습니다.</p>
        </div>
      ) : (
        <>
          {/* 사진 카드 그리드는 유지(사진은 카드형이 맞다) — 넓은 화면은 4열로 한 화면에 더 많이 */}
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {posts.map((post) => {
              const media = parseMedia(post.mediaJSON);
              const firstImage = media.find((item) => item.type === "image");
              return (
                <div
                  key={post.id}
                  className="overflow-hidden rounded-lg border border-gray-100 bg-white shadow-sm transition hover:shadow-md dark:border-gray-700 dark:bg-gray-800"
                >
                  <div className="relative aspect-video bg-gray-100 dark:bg-gray-900">
                    {firstImage ? (
                      <img
                        src={firstImage.url}
                        alt={post.title || ""}
                        loading="lazy"
                        decoding="async"
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <div className="flex h-full items-center justify-center text-gray-300">
                        <FontFreeIcon name="image" size={48} />
                      </div>
                    )}
                    <div className="absolute right-2 top-2 flex gap-1">
                      {post.isPublic ? (
                        <span className="flex items-center gap-1 rounded-full bg-green-500 px-2 py-0.5 text-xs text-white">
                          <FontFreeIcon name="visibility" size={10} /> 공개
                        </span>
                      ) : (
                        <span className="flex items-center gap-1 rounded-full bg-gray-500 px-2 py-0.5 text-xs text-white">
                          <FontFreeIcon name="visibility_off" size={10} /> 비공개
                        </span>
                      )}
                      {media.length > 1 && (
                        <span className="rounded-full bg-black/60 px-2 py-0.5 text-xs text-white">+{media.length - 1}</span>
                      )}
                    </div>
                  </div>
                  <div className="p-3">
                    <div className="mb-2 flex items-start justify-between gap-2">
                      {/* 제목은 말줄임 없이 전부(길면 줄바꿈) */}
                      <h3 className="min-w-0 break-keep break-words text-sm font-bold text-gray-900 dark:text-white">
                        {post.title || "제목 없음"}
                      </h3>
                      {/* 작성일 — KST 달력 날짜, 자릿수 폭 고정 */}
                      <span className="shrink-0 text-xs tabular-nums text-gray-400">
                        {toKstYmd(post.createdAt)}
                      </span>
                    </div>
                    {post.className && (
                      <span className="mb-2 inline-block rounded-full bg-blue-50 px-2 py-0.5 text-xs text-blue-600">
                        {post.className}
                      </span>
                    )}
                    {post.caption && <p className="line-clamp-2 text-xs text-gray-500 dark:text-gray-400">{post.caption}</p>}
                    <div className="mt-2 flex gap-1 border-t border-gray-50 pt-1">
                      {/* 수정·삭제 — 함수·확인창 그대로, 터치 44px */}
                      <button
                        type="button"
                        onClick={() => startEdit(post)}
                        className="flex min-h-11 items-center gap-1 rounded-lg px-2 text-xs text-gray-500 transition hover:text-brand-orange-500"
                      >
                        <FontFreeIcon name="edit" size={14} /> 수정
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDelete(post.id)}
                        className="flex min-h-11 items-center gap-1 rounded-lg px-2 text-xs text-gray-500 transition hover:text-red-500"
                      >
                        <FontFreeIcon name="delete" size={14} /> 삭제
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          {hasMorePosts && (
            <div className="mt-5 flex justify-center">
              <button
                type="button"
                onClick={loadMorePosts}
                disabled={loadingMore}
                className="rounded-lg border border-gray-200 bg-white px-4 py-2.5 text-sm font-bold text-gray-700 transition hover:border-brand-orange-500 hover:text-brand-orange-500 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200"
              >
                {loadingMore ? "불러오는 중..." : `더 보기 ${posts.length}/${pagination?.total ?? posts.length}`}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
