"use client";
import { adminErrorText } from "@/components/admin/adminDisplayText";

import { useState, useTransition } from "react";
import { createGalleryPost, updateGalleryPost } from "@/app/actions/admin";
import { uploadImagesWithProgress } from "@/lib/clientImageUpload";
import FontFreeIcon from "@/components/ui/FontFreeIcon";
import AdminModal from "@/components/admin/AdminModal";

type MediaItem = { url: string; type: "image" | "video" };
type UploadProgress = { done: number; total: number };
type GalleryPost = {
  id: string;
  classId: string | null;
  title: string | null;
  caption: string | null;
  mediaJSON: string;
  isPublic: boolean;
};
type ClassInfo = { id: string; name: string; program?: { name: string } | null };

function parseMedia(mediaJSON: string): MediaItem[] {
  try {
    const parsed = JSON.parse(mediaJSON);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export default function GalleryPostFormModal({
  post,
  classes,
  onClose,
  onSaved,
}: {
  post: GalleryPost | null;
  classes: ClassInfo[];
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const [isPending, startTransition] = useTransition();
  const [classId, setClassId] = useState(post?.classId || "");
  const [title, setTitle] = useState(post?.title || "");
  const [caption, setCaption] = useState(post?.caption || "");
  const [isPublic, setIsPublic] = useState(post?.isPublic ?? true);
  const [mediaItems, setMediaItems] = useState<MediaItem[]>(() => (post ? parseMedia(post.mediaJSON) : []));
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<UploadProgress | null>(null);
  const [formMessage, setFormMessage] = useState<{ ok: boolean; message: string } | null>(null);

  async function handleUpload(files: FileList | null) {
    if (!files || files.length === 0) return;
    setUploading(true);
    setUploadProgress({ done: 0, total: files.length });
    setFormMessage({ ok: true, message: "사진을 압축하고 업로드하는 중입니다." });

    try {
      const { items, failedNames } = await uploadImagesWithProgress(files, {
        folder: "gallery",
        onProgress: (done, total) => setUploadProgress({ done, total }),
      });

      setMediaItems((prev) => [...prev, ...items]);

      if (items.length === 0) {
        setFormMessage({ ok: false, message: "업로드된 사진이 없습니다. 사진을 다시 선택해주세요." });
        return;
      }

      setFormMessage({
        ok: failedNames.length === 0,
        message:
          failedNames.length === 0
            ? `${items.length}장 업로드 완료. 등록 버튼을 누르면 게시됩니다.`
            : `${items.length}장 업로드 완료, ${failedNames.length}장은 업로드하지 못했습니다.`,
      });
    } finally {
      setUploading(false);
      setUploadProgress(null);
    }
  }

  function removeMedia(index: number) {
    setMediaItems((prev) => prev.filter((_, itemIndex) => itemIndex !== index));
  }

  function handleSubmit() {
    if (mediaItems.length === 0) {
      setFormMessage({ ok: false, message: "사진을 최소 1장 업로드해주세요." });
      return;
    }
    setFormMessage({ ok: true, message: post ? "게시물을 수정하는 중입니다." : "게시물을 등록하는 중입니다." });

    const payload = {
      classId: classId || null,
      title: title || null,
      caption: caption || null,
      mediaJSON: JSON.stringify(mediaItems),
      isPublic,
    };

    startTransition(async () => {
      try {
        if (post) await updateGalleryPost(post.id, payload);
        else await createGalleryPost(payload);
        onSaved(
          post
            ? "갤러리 게시물이 수정됐습니다."
            : "갤러리 게시물이 등록됐습니다. 공개 상태라면 홈페이지에 바로 반영됩니다."
        );
      } catch (error) {
        setFormMessage({
          ok: false,
          message: adminErrorText(error, "갤러리 게시물 저장 중 오류가 발생했습니다."),
        });
      }
    });
  }

  return (
    <AdminModal onClose={onClose} titleId="gallery-post-form-modal-title" panelClassName="max-w-2xl rounded-lg">
        <div className="flex items-center justify-between border-b border-[var(--color-academy-line)] p-6">
          <h2 id="gallery-post-form-modal-title" className="text-lg font-bold text-[var(--color-academy-ink)]">{post ? "게시물 수정" : "새 게시물"}</h2>
          <button type="button" onClick={onClose} aria-label="닫기" className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-lg text-[var(--color-academy-muted)] hover:bg-[var(--color-academy-soft)]">
            <FontFreeIcon name="close" size={20} />
          </button>
        </div>
        <div className="space-y-4 p-6">
          {formMessage && (
            <div
              className={`rounded-lg border px-3 py-2 text-sm font-medium ${
                formMessage.ok
                  ? "border-[var(--color-academy-success)] bg-[var(--color-academy-success-soft)] text-[var(--color-academy-success)]"
                  : "border-[var(--color-academy-danger)] bg-[var(--color-academy-danger-soft)] text-[var(--color-academy-danger)]"
              }`}
            >
              {formMessage.message}
            </div>
          )}
          <div>
            <label className="mb-1 block text-sm font-medium text-[var(--color-academy-muted)]">반 선택</label>
            <select
              value={classId}
              onChange={(event) => setClassId(event.target.value)}
              className="academy-input"
            >
              <option value="">전체 공개</option>
              {classes.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                  {item.program ? ` (${item.program.name})` : ""}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium text-[var(--color-academy-muted)]">제목</label>
            <input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="예: 3월 토요일 수업 스케치"
              className="academy-input"
            />
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium text-[var(--color-academy-muted)]">설명</label>
            <textarea
              value={caption}
              onChange={(event) => setCaption(event.target.value)}
              rows={3}
              placeholder="게시물 설명을 입력하세요."
              className="academy-input"
            />
          </div>

          <div>
            <label className="mb-2 block text-sm font-medium text-[var(--color-academy-muted)]">사진 업로드</label>
            <label className="flex h-32 w-full cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed border-[var(--color-academy-line-input)] transition hover:bg-[var(--color-academy-soft)]">
              <span className="text-sm text-[var(--color-academy-muted)]">
                {uploading && uploadProgress
                  ? `${uploadProgress.done}/${uploadProgress.total}장 업로드 중...`
                  : "클릭해서 사진 선택"}
              </span>
              <span className="mt-1 text-xs text-[var(--color-academy-faint)]">여러 장 선택 가능</span>
              <input
                type="file"
                className="hidden"
                multiple
                accept="image/*"
                onChange={(event) => handleUpload(event.target.files)}
                disabled={uploading}
              />
            </label>
            {uploading && uploadProgress && uploadProgress.total > 0 && (
              <div className="mt-3">
                <div className="flex justify-between text-xs font-medium text-[var(--color-academy-muted)]">
                  <span>사진 업로드</span>
                  <span className="tabular-nums">
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
            {mediaItems.length > 0 && (
              <div className="mt-3 grid grid-cols-4 gap-2">
                {mediaItems.map((item, index) => (
                  <div key={`${item.url}-${index}`} className="group relative aspect-square overflow-hidden rounded-lg bg-[var(--color-academy-soft)]">
                    <img src={item.url} alt="" className="h-full w-full object-cover" />
                    <button
                      type="button"
                      aria-label="사진 빼기"
                      onClick={() => removeMedia(index)}
                      className="absolute right-1 top-1 rounded-full bg-[var(--color-academy-danger)] p-1 text-white opacity-0 transition group-hover:opacity-100"
                    >
                      <FontFreeIcon name="close" size={12} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={isPublic}
              onChange={(event) => setIsPublic(event.target.checked)}
              className="rounded"
            />
            <span className="text-sm text-[var(--color-academy-muted)]">홈페이지 갤러리에 공개</span>
          </label>
        </div>
        <div className="flex justify-end gap-3 border-t border-[var(--color-academy-line)] p-6">
          <button
            onClick={onClose}
            className="academy-button-secondary"
          >
            취소
          </button>
          <button
            onClick={handleSubmit}
            disabled={isPending || uploading}
            className="academy-button-primary"
          >
            {isPending ? "저장 중..." : post ? "수정" : "등록"}
          </button>
        </div>
    </AdminModal>
  );
}
