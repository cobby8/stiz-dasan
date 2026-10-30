"use client";

import { useRef, useState, useTransition } from "react";
import Link from "next/link";
// 설치된 선생님 앱은 /staff 밖으로 나가면 돌아올 길이 없다.
import HideInInstalledApp from "@/components/pwa/HideInInstalledApp";
import {
  createSocialPostDraft,
  publishSocialPostDraft,
  saveSocialPostDraft,
} from "@/app/actions/social-posts";
import InstagramFeedPreview, {
  type InstagramPreviewMediaItem,
} from "@/components/instagram/InstagramFeedPreview";
import { uploadImagesWithProgress } from "@/lib/clientImageUpload";
import type { SocialPostDraft } from "@/lib/socialDrafts";

const LESSON_TYPES = ["정규 수업", "기초반", "심화반", "게임 수업", "특강", "대회 준비"];
// DB enum(INSTRUCTOR/ADMIN 등)이 화면에 영문 그대로 노출되지 않도록 한글 라벨로 바꿔 준다.
// 목록에 없는 역할은 라벨이 없으므로 아예 표시하지 않는다(정체불명 문자열 노출 방지).
const ROLE_LABELS: Record<string, string> = {
  INSTRUCTOR: "선생님",
  ADMIN: "관리자",
  VICE_ADMIN: "부원장",
  DRIVER: "기사님",
};
const MAX_UPLOAD_COUNT = 10;
type UploadProgress = { done: number; total: number };

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

export default function QuickPostClient({
  currentUser,
}: {
  currentUser: { name: string; role: string };
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [lessonType, setLessonType] = useState(LESSON_TYPES[0]);
  const [memo, setMemo] = useState("");
  const [mediaItems, setMediaItems] = useState<InstagramPreviewMediaItem[]>([]);
  const [draft, setDraft] = useState<SocialPostDraft | null>(null);
  const [caption, setCaption] = useState("");
  const [hashtags, setHashtags] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progressText, setProgressText] = useState<string | null>(null);
  const [uploadProgress, setUploadProgress] = useState<UploadProgress | null>(null);
  const [isWorking, setIsWorking] = useState(false);
  const [isPending, startTransition] = useTransition();
  const busy = isPending || isWorking;
  const canApprove = currentUser.role === "ADMIN" || currentUser.role === "VICE_ADMIN";
  const roleLabel = ROLE_LABELS[currentUser.role];
  const isPublished = draft?.status === "PUBLISHED";
  const hasInstagramIssue = draft?.status === "FAILED";
  const hasPublishingStatus = draft?.status === "PUBLISHING";
  const needsInstagramRetry = hasInstagramIssue || hasPublishingStatus;

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;

    setError(null);
    setMessage("사진을 올리고 AI 초안을 만드는 중입니다.");
    setProgressText("사진을 압축하고 업로드하는 중입니다.");
    setDraft(null);
    setCaption("");
    setHashtags("");
    setUploadProgress({ done: 0, total: Math.min(files.length, MAX_UPLOAD_COUNT) });
    setIsWorking(true);

    startTransition(async () => {
      try {
        const { items: uploaded, failedNames, skippedCount } = await uploadImagesWithProgress(files, {
          folder: "quick-post",
          limit: MAX_UPLOAD_COUNT,
          onProgress: (done, total) => setUploadProgress({ done, total }),
        });

        if (uploaded.length === 0) {
          throw new Error("업로드된 사진이 없습니다. 사진을 다시 선택해주세요.");
        }

        setMediaItems(uploaded as InstagramPreviewMediaItem[]);
        setProgressText("AI 문구를 만드는 중입니다.");

        const result = await createSocialPostDraft({
          mediaJSON: JSON.stringify(uploaded),
          lessonType,
          memo,
          isPublic: true,
        });

        setDraft(result.draft);
        setCaption(result.draft.caption || "");
        setHashtags(result.draft.hashtags || "");

        const notes = [
          skippedCount > 0 ? `최대 ${MAX_UPLOAD_COUNT}장만 처리했습니다.` : null,
          failedNames.length > 0 ? `${failedNames.length}장은 업로드하지 못했습니다.` : null,
        ].filter(Boolean);
        setMessage(
          `${uploaded.length}장 업로드 완료. AI 초안이 만들어졌습니다. 문구를 확인한 뒤 바로 게시할 수 있습니다.${
            notes.length > 0 ? ` ${notes.join(" ")}` : ""
          }`,
        );
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "초안을 만들지 못했습니다.");
        setMessage(null);
      } finally {
        setIsWorking(false);
        setProgressText(null);
        setUploadProgress(null);
        if (inputRef.current) inputRef.current.value = "";
      }
    });
  }

  function handleSave() {
    if (!draft) return;

    setError(null);
    setProgressText("수정 내용을 저장하는 중입니다.");
    setIsWorking(true);
    startTransition(async () => {
      try {
        const result = await saveSocialPostDraft(draft.id, {
          title: draft.title,
          caption,
          hashtags,
          lessonType,
          memo,
          isPublic: draft.isPublic,
        });
        setDraft(result.draft);
        setMessage("수정 내용이 저장됐습니다.");
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "저장하지 못했습니다.");
      } finally {
        setIsWorking(false);
        setProgressText(null);
      }
    });
  }

  function handlePublish() {
    if (!draft) return;

    setError(null);
    setMessage("홈페이지 갤러리와 인스타그램에 바로 게시하는 중입니다.");
    setProgressText("수정 내용을 저장하는 중입니다.");
    setIsWorking(true);
    startTransition(async () => {
      try {
        const saved = await saveSocialPostDraft(draft.id, {
          title: draft.title,
          caption,
          hashtags,
          lessonType,
          memo,
          isPublic: draft.isPublic,
        });
        setProgressText("홈페이지 갤러리와 인스타그램에 바로 게시하는 중입니다.");
        const result = await publishSocialPostDraft(saved.draft.id);
        setDraft(result.draft);
        setMessage(
          result.ok
            ? "홈페이지 갤러리와 인스타그램 게시가 완료됐습니다."
            : "홈페이지 갤러리는 게시됐고, 인스타그램은 재시도 대기 중입니다.",
        );
        setProgressText(null);
        setIsWorking(false);
      } catch (caught) {
        setMessage(null);
        setError(caught instanceof Error ? caught.message : "게시하지 못했습니다.");
        setIsWorking(false);
        setProgressText(null);
      }
    });
  }

  function resetFlow() {
    setDraft(null);
    setMediaItems([]);
    setCaption("");
    setHashtags("");
    setMessage(null);
    setError(null);
    setProgressText(null);
    setUploadProgress(null);
  }

  // 게슈탈트 T-05: 되돌리기 어려운 «바로 게시»(외부 공개)와 «새로 작성»(작성 내용 버림)은 한 번 더 묻는다.
  // 선생님 앱의 다른 확인(학부모 공지 발송 등)과 같은 window.confirm — iOS·안드로이드 앱 웹뷰에서 확인 창이 뜬다.
  function confirmPublish() {
    const question = needsInstagramRetry
      ? "인스타그램에 다시 게시할까요?"
      : "홈페이지 갤러리와 인스타그램에 바로 게시할까요? 게시하면 바로 공개됩니다.";
    if (!window.confirm(question)) return;
    handlePublish();
  }

  function confirmReset() {
    // 이미 게시가 끝났으면 버릴 내용이 없으니 묻지 않는다.
    if (!isPublished && !window.confirm("작성 중인 내용을 지우고 새로 작성할까요?")) return;
    resetFlow();
  }

  function goBack() {
    if (window.history.length > 1) {
      window.history.back();
      return;
    }

    window.location.href = "/";
  }

  return (
    <main className="min-h-screen bg-surface-warm px-4 py-5 dark:bg-gray-950 dark:text-gray-100">
      <div className="mx-auto max-w-md space-y-4">
        <header className="flex items-center justify-between">
          <div>
            {roleLabel && <p className="text-xs font-bold tracking-wide text-brand-orange-600 dark:text-brand-neon-lime">{roleLabel}</p>}
            <h1 className="text-2xl font-black text-brand-navy-900 dark:text-white">사진 올리기</h1>
            <p className="text-sm text-gray-600 dark:text-gray-400">{currentUser.name} 선생님</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={goBack}
              className="inline-flex min-h-9 items-center gap-1 rounded-lg border border-gray-200 bg-white px-2.5 text-xs font-bold text-gray-600 transition hover:border-brand-orange-500 hover:text-brand-orange-500 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100 dark:hover:border-brand-neon-lime dark:hover:text-brand-neon-lime"
            >
              <SymbolIcon name="arrow_back" size={15} />
              이전
            </button>
            {/* 선생님 앱의 "홈"은 /staff 다. 공개 홈페이지로 보내면 설치된 앱이 제 범위를
                벗어나 주소표시줄이 뜨고 돌아올 길이 없다(프로필 메뉴에서 공개 링크를
                모두 뺀 것과 같은 이유). */}
            <Link href="/staff" className="inline-flex min-h-9 items-center gap-1 rounded-lg border border-gray-200 bg-white px-2.5 text-xs font-bold text-gray-600 transition hover:border-brand-orange-500 hover:text-brand-orange-500 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100 dark:hover:border-brand-neon-lime dark:hover:text-brand-neon-lime">
              <SymbolIcon name="home" size={15} />
              홈
            </Link>
          </div>
        </header>

        <section className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-900">
          <div className="grid grid-cols-2 gap-2">
            {LESSON_TYPES.map((type) => (
              <button
                key={type}
                type="button"
                onClick={() => setLessonType(type)}
                className={`min-h-10 rounded-lg border px-3 text-sm font-bold transition ${
                  lessonType === type
                    ? "border-brand-orange-500 bg-orange-50 text-brand-orange-700 dark:border-brand-neon-lime dark:bg-brand-neon-lime dark:text-brand-navy-900"
                    : "border-gray-200 bg-white text-gray-600 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200"
                }`}
              >
                {type}
              </button>
            ))}
          </div>

          <textarea
            value={memo}
            onChange={(event) => setMemo(event.target.value)}
            rows={3}
            className="mt-3 w-full resize-none rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm leading-6 text-gray-900 outline-none placeholder:text-gray-400 focus:border-brand-orange-500 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100 dark:placeholder:text-gray-500"
            placeholder="오늘 수업 포인트를 짧게 적어주세요"
          />

          <input
            ref={inputRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            disabled={busy}
            onChange={(event) => handleFiles(event.target.files)}
          />
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            disabled={busy}
            className="mt-3 flex min-h-14 w-full items-center justify-center gap-2 rounded-lg bg-brand-orange-500 px-4 py-3 text-sm font-black text-white transition hover:bg-brand-orange-600 disabled:opacity-60 dark:bg-brand-neon-lime dark:text-brand-navy-900 dark:hover:bg-lime-400"
          >
            <SymbolIcon name={busy ? "progress_activity" : "photo_camera"} size={20} className={busy ? "animate-spin" : ""} />
            사진 선택하고 AI 초안 만들기
          </button>
        </section>

        {message && (
          <div className="flex items-center gap-2 rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-sm font-bold text-green-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300">
            <SymbolIcon name="check_circle" size={17} />
            {message}
          </div>
        )}

        {error && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm font-bold text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300">
            {error}
          </div>
        )}

        {draft && (
          <section className="space-y-3">
            <div className="rounded-lg border border-green-200 bg-green-50 p-4 text-green-800 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-200">
              <div className="flex items-center gap-2 text-sm font-black">
                <SymbolIcon name="check_circle" size={18} />
                {isPublished
                  ? "게시 완료"
                  : needsInstagramRetry
                    ? "홈페이지 게시 완료"
                    : "AI 초안 준비 완료"}
              </div>
              <p className="mt-2 text-xs leading-5 text-green-700 dark:text-emerald-300">
                {isPublished
                  ? "홈페이지 갤러리와 인스타그램 게시가 완료됐습니다."
                  : hasPublishingStatus
                    ? "홈페이지 갤러리는 완료됐습니다. 인스타그램은 지금 게시 중이거나 재시도 대기 중입니다."
                  : hasInstagramIssue
                    ? "사진은 홈페이지 갤러리에 올라갔고, 인스타그램 게시만 다시 시도하거나 관리자 설정을 확인하면 됩니다."
                    : "문구를 확인하고 필요한 부분을 수정한 뒤 바로 게시할 수 있습니다."}
              </p>
              {canApprove && (
                <Link
                  href="/admin/gallery"
                  className="mt-3 flex min-h-11 items-center justify-center gap-2 rounded-lg bg-green-700 px-3 text-sm font-black text-white"
                >
                  관리자 갤러리 보기
                  <SymbolIcon name="arrow_forward" size={17} />
                </Link>
              )}
              {isPublished && (
                <div className="mt-3 grid grid-cols-1 gap-2">
                  {/* 공개 홈페이지 갤러리. 설치된 앱에서 나가면 돌아올 길이 없어 감춘다. */}
                  <HideInInstalledApp>
                  <Link
                    href="/gallery"
                    className="flex min-h-11 items-center justify-center gap-2 rounded-lg border border-green-200 bg-white px-3 text-sm font-black text-green-700 dark:border-emerald-500/30 dark:bg-gray-900 dark:text-emerald-300"
                  >
                    홈페이지 갤러리 보기
                    <SymbolIcon name="arrow_forward" size={17} />
                  </Link>
                  </HideInInstalledApp>
                  {draft?.instagramPermalink && (
                    <a
                      href={draft.instagramPermalink}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex min-h-11 items-center justify-center gap-2 rounded-lg bg-green-700 px-3 text-sm font-black text-white"
                    >
                      인스타그램 게시물 보기
                      <SymbolIcon name="arrow_forward" size={17} />
                    </a>
                  )}
                </div>
              )}
            </div>

            <InstagramFeedPreview
              mediaItems={mediaItems}
              caption={caption}
              hashtags={hashtags}
              editable={!isPublished}
              onCaptionChange={setCaption}
              onHashtagsChange={setHashtags}
            />

            {/* 게슈탈트 T-05: 꽉 찬 버튼은 «바로 게시» 하나(주인공), «수정 저장»은 보조.
                «새로 작성»은 작성 내용을 버리는 동작이라 아래로 떼어 작은 글자 버튼으로 둔다. */}
            <div className="grid grid-cols-1 gap-2">
              <button
                type="button"
                onClick={handleSave}
                disabled={busy || isPublished}
                className="academy-button-secondary flex min-h-12 items-center justify-center gap-2 rounded-lg px-3 text-sm font-black disabled:opacity-60"
              >
                <SymbolIcon name="save" size={18} />
                수정 저장
              </button>
              {!isPublished && (
                <button
                  type="button"
                  onClick={confirmPublish}
                  disabled={busy || hasPublishingStatus}
                  className="academy-button-primary flex min-h-12 items-center justify-center gap-2 rounded-lg px-3 text-sm font-black disabled:opacity-60"
                >
                  <SymbolIcon
                    name={hasPublishingStatus ? "progress_activity" : "send"}
                    size={18}
                    className={hasPublishingStatus ? "animate-spin" : ""}
                  />
                  {hasPublishingStatus ? "인스타그램 게시 중" : needsInstagramRetry ? "인스타그램 다시 게시" : "바로 게시"}
                </button>
              )}
            </div>
            <div className="mt-4 flex justify-center border-t border-[var(--color-academy-line)] pt-2">
              <button
                type="button"
                onClick={confirmReset}
                disabled={busy}
                className="academy-button-text flex min-h-11 items-center justify-center gap-1 px-3 text-sm font-bold disabled:opacity-60"
              >
                <SymbolIcon name="refresh" size={18} />
                새로 작성
              </button>
            </div>
          </section>
        )}

        {hasPublishingStatus && !busy && (
          <div className="flex items-start gap-3 rounded-lg border border-blue-200 bg-blue-50 p-4 text-sm font-bold text-blue-700 dark:border-blue-500/30 dark:bg-blue-500/10 dark:text-blue-300">
            <SymbolIcon name="progress_activity" size={18} className="mt-0.5 shrink-0 animate-spin" />
            <p>인스타그램 게시를 처리 중입니다.</p>
          </div>
        )}

        {busy && (
          <div className="flex items-start gap-3 rounded-lg border border-gray-200 bg-white p-4 text-sm font-bold text-gray-600 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300">
            <SymbolIcon name="auto_awesome" size={18} className="mt-0.5 shrink-0 text-brand-orange-500 dark:text-brand-neon-lime" />
            <div className="min-w-0 flex-1">
              <p>{progressText || "처리 중입니다."}</p>
              {uploadProgress && uploadProgress.total > 0 && (
                <div className="mt-2">
                  <div className="flex justify-between text-xs text-[var(--color-academy-muted)]">
                    <span>사진 업로드</span>
                    <span>
                      {uploadProgress.done}/{uploadProgress.total}
                    </span>
                  </div>
                  <div className="mt-1 h-2 overflow-hidden rounded-full bg-gray-100 dark:bg-gray-800">
                    <div
                      className="h-full rounded-full bg-brand-orange-500 transition-all dark:bg-brand-neon-lime"
                      style={{ width: `${Math.round((uploadProgress.done / uploadProgress.total) * 100)}%` }}
                    />
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
