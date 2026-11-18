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
import { userErrorMessage } from "@/components/staff/userErrorMessage";
import { QUICK_UPLOAD_CONSENT_NOTICE } from "@/lib/socialPostMessages";
import { askConfirm } from "@/components/ui/feedback";

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

// 게시 권한은 서버(page.tsx)가 계산해 내려 준다. 화면이 역할로 추측하지 않는다.
// 서버 액션의 권한 검사(갤러리 = 관리자)는 그대로이고, 이 값은 «화면이 무엇을 말할지»만 정한다.
// 2026-11-18 결정표 insta-auto-publish «안 쓴다»: 게시 = 홈페이지 갤러리만(인스타 게시 권한 값은 뺐다).
export type QuickPostPermissions = {
  /** 홈페이지 갤러리에 게시할 수 있다(원장·부원장). */
  canPublishGallery: boolean;
};

export default function QuickPostClient({
  currentUser,
  permissions,
  consentGateEnabled = false,
}: {
  currentUser: { name: string; role: string };
  permissions: QuickPostPermissions;
  /** 공개 게시 동의 검사가 켜져 있는가(서버가 내려 준다). 켜져 있을 때만 «학생 미지정 사진은 게시 불가» 안내를 보인다. */
  consentGateEnabled?: boolean;
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
  const canApprove = permissions.canPublishGallery;
  // 문구가 AI 초안인지, AI 연결이 안 돼 넣은 기본 문구인지(서버가 알려 준다)
  const [captionSource, setCaptionSource] = useState<"AI" | "FALLBACK" | null>(null);
  const roleLabel = ROLE_LABELS[currentUser.role];
  const isPublished = draft?.status === "PUBLISHED";
  // 게시를 눌렀지만 끝나지 않은 초안(실패·중간에 멈춤) — 잠그지 않고 «다시 게시»로 마무리한다.
  const needsRepublish = draft?.status === "FAILED" || draft?.status === "PUBLISHING";
  // 문구 저장 잠금 — 게시가 끝났거나, «게시 처리 중»(서버가 저장을 받지 않는 상태)이면 저장할 수 없다.
  const saveLocked = busy || isPublished || draft?.status === "PUBLISHING";

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;

    setError(null);
    setMessage("사진을 올리고 문구 초안을 만드는 중입니다.");
    setProgressText("사진을 압축하고 업로드하는 중입니다.");
    setDraft(null);
    setCaptionSource(null);
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
        setProgressText("문구 초안을 만드는 중입니다.");

        const result = await createSocialPostDraft({
          mediaJSON: JSON.stringify(uploaded),
          lessonType,
          memo,
          isPublic: true,
        });

        setDraft(result.draft);
        setCaptionSource(result.captionSource);
        setCaption(result.draft.caption || "");
        setHashtags(result.draft.hashtags || "");

        const notes = [
          skippedCount > 0 ? `최대 ${MAX_UPLOAD_COUNT}장만 처리했습니다.` : null,
          failedNames.length > 0 ? `${failedNames.length}장은 업로드하지 못했습니다.` : null,
        ].filter(Boolean);
        // 2026-11-14 사진·인스타 점검: 기본 문구를 «AI 초안»이라 하지 않고, 게시 권한이 없는 계정에 «바로 게시»를 말하지 않는다.
        const captionNote =
          result.captionSource === "AI" ? "AI 초안이 만들어졌습니다." : "기본 문구입니다(AI 연결 안 됨).";
        const nextStep = canApprove
          ? "문구를 확인해 주세요."
          : "검토 대기로 저장됐습니다. 원장님 확인을 거쳐야 게시됩니다.";
        setMessage(
          `${uploaded.length}장 업로드 완료. ${captionNote} ${nextStep}${
            notes.length > 0 ? ` ${notes.join(" ")}` : ""
          }`,
        );
      } catch (caught) {
        setError(userErrorMessage(caught, "초안을 만들지 못했습니다."));
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
        setError(userErrorMessage(caught, "저장하지 못했습니다."));
      } finally {
        setIsWorking(false);
        setProgressText(null);
      }
    });
  }

  function handlePublish() {
    if (!draft) return;

    const publishingText = "홈페이지 갤러리에 게시하는 중입니다.";
    setError(null);
    setMessage(publishingText);
    setProgressText("수정 내용을 저장하는 중입니다.");
    setIsWorking(true);
    startTransition(async () => {
      try {
        // «게시 처리 중»에 멈춘 초안은 서버가 문구 저장을 받지 않는다 — 저장을 건너뛰고 바로 다시 게시한다.
        const saved = draft.status === "PUBLISHING"
          ? { draft }
          : await saveSocialPostDraft(draft.id, {
              title: draft.title,
              caption,
              hashtags,
              lessonType,
              memo,
              isPublic: draft.isPublic,
            });
        setProgressText(publishingText);
        const result = await publishSocialPostDraft(saved.draft.id);
        setDraft(result.draft);
        if ("blocked" in result && result.blocked === true) {
          // 학생이 지정되지 않은 사진 — 게시되지 않았다. 서버가 준 «다음에 할 일» 안내를 그대로 보여 준다.
          setMessage(null);
          setError(result.error);
        } else {
          // 초안이 «게시 완료»로 닫혔을 때만 게시했다고 말한다(그 사이 반려 등으로 상태가 바뀌면 사실대로 알린다)
          setMessage(
            result.draft?.status === "PUBLISHED"
              ? "홈페이지 갤러리에 게시했습니다."
              : "갤러리 게시를 마치지 못했습니다. 초안 상태가 바뀌었을 수 있으니 목록에서 확인해 주세요.",
          );
        }
        setProgressText(null);
        setIsWorking(false);
      } catch (caught) {
        setMessage(null);
        setError(userErrorMessage(caught, "게시하지 못했습니다."));
        setIsWorking(false);
        setProgressText(null);
      }
    });
  }

  function resetFlow() {
    setDraft(null);
    setCaptionSource(null);
    setMediaItems([]);
    setCaption("");
    setHashtags("");
    setMessage(null);
    setError(null);
    setProgressText(null);
    setUploadProgress(null);
  }

  // 게슈탈트 T-05: 되돌리기 어려운 «바로 게시»(외부 공개)와 «새로 작성»(작성 내용 버림)은 한 번 더 묻는다.
  // 선생님 앱의 다른 확인(학부모 공지 발송 등)과 같은 화면 안 확인창(askConfirm) — 앱 웹뷰에서도 막히지 않고 뜬다.
  async function confirmPublish() {
    const question = needsRepublish
      ? "홈페이지 갤러리에 다시 게시할까요?"
      : "홈페이지 갤러리에 게시할까요? 게시하면 바로 공개됩니다.";
    if (!(await askConfirm(question))) {
      // 앱 웹뷰는 다른 창이 떠 있으면 확인 창이 조용히 «취소»로 끝난다 — 반응 없음으로 보이지 않게 알린다
      setMessage("게시를 취소했습니다. 게시하려면 게시 버튼을 다시 눌러 주세요.");
      return;
    }
    handlePublish();
  }

  async function confirmReset() {
    // 이미 게시가 끝났으면 버릴 내용이 없으니 묻지 않는다.
    if (!isPublished && !(await askConfirm("작성 중인 내용을 지우고 새로 작성할까요?"))) return;
    resetFlow();
  }

  function goBack() {
    if (window.history.length > 1) {
      window.history.back();
      return;
    }

    // 돌아갈 기록이 없으면 선생님 홈으로 — 공개 홈(/)으로 나가지 않는다(같은 줄 «홈» 버튼과 같은 곳, 2026-11-17)
    window.location.href = "/staff";
  }

  return (
    <main className="min-h-screen bg-surface-warm px-4 py-5">
      <div className="mx-auto max-w-md space-y-4">
        <header className="flex flex-wrap items-center justify-between gap-2">
          <div>
            {roleLabel && <p className="text-xs text-[var(--color-academy-muted)]">{roleLabel}</p>}
            <h1 className="academy-heading">사진 올리기</h1>
            <p className="text-sm text-[var(--color-academy-muted)]">{currentUser.name} 선생님</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={goBack}
              className="academy-button-secondary academy-button-sm"
            >
              이전
            </button>
            {/* 선생님 앱의 "홈"은 /staff 다. 공개 홈페이지로 보내면 설치된 앱이 제 범위를
                벗어나 주소표시줄이 뜨고 돌아올 길이 없다(프로필 메뉴에서 공개 링크를
                모두 뺀 것과 같은 이유). */}
            <Link href="/staff" className="academy-button-secondary academy-button-sm">
              홈
            </Link>
          </div>
        </header>

        {/* 2026-11-14 사진·인스타 점검: 올린 뒤에야 막히지 않게, 이 화면 사진은 게시할 수 없다는 사실을 먼저 알린다. */}
        {consentGateEnabled && (
        <p
          role="note"
          className="rounded-lg border border-[var(--color-academy-info)] bg-[var(--color-academy-info-soft)] px-3 py-2 text-xs leading-5 text-[var(--color-academy-info)]"
        >
          {QUICK_UPLOAD_CONSENT_NOTICE}
        </p>
        )}

        <section className="rounded-lg border border-[var(--color-academy-line)] bg-white p-4 shadow-sm">
          <div className="grid grid-cols-2 gap-2">
            {LESSON_TYPES.map((type) => (
              <button
                key={type}
                type="button"
                onClick={() => setLessonType(type)}
                // 2026-11-13 UI 통일: 고른 수업 종류 = 보조 색 칩(✓ + 하늘색)
                className={`academy-choice ${lessonType === type ? "is-selected" : ""}`}
              >
                {type}
              </button>
            ))}
          </div>

          <textarea
            value={memo}
            onChange={(event) => setMemo(event.target.value)}
            rows={3}
            className="academy-input mt-3 resize-none leading-6"
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
            className="academy-button-primary mt-3 min-h-14! w-full"
          >
            사진 선택하고 문구 초안 만들기
          </button>
        </section>

        {message && (
          <div className="flex items-center gap-2 rounded-lg border border-[var(--color-academy-success)] bg-[var(--color-academy-success-soft)] px-3 py-2 text-sm font-medium text-[var(--color-academy-success)]">
            {message}
          </div>
        )}

        {error && (
          <div className="rounded-lg border border-[var(--color-academy-danger)] bg-[var(--color-academy-danger-soft)] px-3 py-2 text-sm font-medium text-[var(--color-academy-danger)]">
            {error}
          </div>
        )}

        {draft && (
          <section className="space-y-3">
            <div className="rounded-lg border border-[var(--color-academy-success)] bg-[var(--color-academy-success-soft)] p-4 text-[var(--color-academy-success)]">
              <div className="text-sm font-semibold">
                {isPublished
                  ? "게시 완료"
                  : needsRepublish
                    ? "게시 마무리 필요"
                    : captionSource === "FALLBACK"
                      ? "기본 문구입니다(AI 연결 안 됨)"
                      : "AI 초안 준비 완료"}
              </div>
              <p className="mt-2 text-xs leading-5 text-[var(--color-academy-success)]">
                {isPublished
                  ? "홈페이지 갤러리 게시가 완료됐습니다."
                  : needsRepublish
                    ? "홈페이지 갤러리 게시가 끝나지 않았습니다. 다시 게시해 주세요."
                    : canApprove
                      ? "문구를 확인하고 필요한 부분을 수정해 주세요."
                      : "문구를 확인하고 필요한 부분을 고쳐 저장해 주세요. 원장님 확인을 거쳐야 게시됩니다."}
              </p>
              {canApprove && (
                <Link
                  href="/admin/gallery"
                  className="academy-button-secondary mt-3 w-full"
                >
                  관리자 갤러리 보기
                </Link>
              )}
              {isPublished && (
                <div className="mt-3 grid grid-cols-1 gap-2">
                  {/* 공개 홈페이지 갤러리. 설치된 앱에서 나가면 돌아올 길이 없어 감춘다. */}
                  <HideInInstalledApp>
                  <Link
                    href="/gallery"
                    className="academy-button-secondary w-full"
                  >
                    홈페이지 갤러리 보기
                  </Link>
                  </HideInInstalledApp>
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

            {/* 게슈탈트 T-05: 꽉 찬 버튼은 «게시» 하나(주인공), «수정 저장»은 보조.
                «새로 작성»은 작성 내용을 버리는 동작이라 아래로 떼어 작은 글자 버튼으로 둔다.
                2026-11-14: 게시 권한이 없는 계정(선생님)에는 게시 버튼을 보이지 않고 저장(검토 대기)만 둔다. */}
            <div className="grid grid-cols-1 gap-2">
              <button
                type="button"
                onClick={handleSave}
                disabled={saveLocked}
                className="academy-button-secondary min-h-12!"
              >
                {canApprove ? "수정 저장" : "저장(검토 대기)"}
              </button>
              {canApprove && !isPublished && (
                <button
                  type="button"
                  onClick={confirmPublish}
                  disabled={busy}
                  className="academy-button-primary min-h-12!"
                >
                  {needsRepublish ? "다시 게시" : "홈페이지 갤러리에 게시"}
                </button>
              )}
              {!canApprove && (
                <p className="text-xs leading-5 text-[var(--color-academy-muted)]">
                  게시는 원장님이 확인한 뒤 합니다. 이 화면에서는 문구를 고쳐 저장할 수 있습니다.
                </p>
              )}
            </div>
            <div className="mt-4 flex justify-center border-t border-[var(--color-academy-line)] pt-2">
              <button
                type="button"
                onClick={confirmReset}
                disabled={busy}
                className="academy-button-text"
              >
                새로 작성
              </button>
            </div>
          </section>
        )}

        {busy && (
          <div className="rounded-lg border border-[var(--color-academy-line)] bg-white p-4 text-sm font-medium text-[var(--color-academy-muted)]">
            <div className="min-w-0 flex-1">
              <p>{progressText || "처리 중입니다."}</p>
              {uploadProgress && uploadProgress.total > 0 && (
                <div className="mt-2">
                  <div className="flex justify-between text-xs font-normal tabular-nums text-[var(--color-academy-muted)]">
                    <span>사진 업로드</span>
                    <span>
                      {uploadProgress.done}/{uploadProgress.total}
                    </span>
                  </div>
                  <div className="mt-1 h-2 overflow-hidden rounded-full bg-[var(--color-academy-soft)]">
                    <div
                      className="h-full rounded-full bg-[var(--color-academy-secondary-strong)] transition-all"
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
