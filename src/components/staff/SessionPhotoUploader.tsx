"use client";

import { useCallback, useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import Image from "next/image";
import { SESSION_IMAGE_ALLOWED_TYPES } from "@/lib/clientImageCompression";
import { uploadImagesWithProgress } from "@/lib/clientImageUpload";
import { userErrorMessage } from "@/components/staff/userErrorMessage";

type ManagedPhoto = {
  id: string;
  url: string;
  canManage: boolean;
  requiresDeletionQueue: boolean;
};

/** 바깥 버튼(수업 화면 아래 [사진]·[갤러리])이 이 부품의 올리기를 부를 때 쓰는 손잡이(2026-11-15) */
export type SessionPhotoUploaderHandle = { upload: (files: File[]) => void };
/** 바깥 버튼이 잠금·진행 문구를 맞추는 데 쓰는 상태 */
export type SessionUploaderState = { busy: boolean; canUpload: boolean; count: number; message: string; windowMessage: string | null };

/** 한 번에 고를 수 있는 사진 수(예전과 같은 10장) */
const PHOTO_PICK_LIMIT = 10;

/**
 * 수업 사진 올리기(선생님) — 2026-11-14 수업 피드 개편(원장 결정).
 * - «사진에 나온 학생» 선택을 없앴다: 학부모는 «그 수업에 참여한 아이의 보호자»만 보므로 태그·동의가 필요 없다.
 * - 촬영·갤러리 여러 장은 그대로. 실패한 사진만 따로 «다시 올리기»(성공한 사진을 두 번 올리지 않게).
 * - 올리기·지우기 가능 시간은 영상과 같다(수업 중 또는 끝난 뒤 수업일 포함 7일, 원장·부원장은 제한 없음) — 서버가 canUpload 로 알려 준다.
 * - 사진을 올려도 학부모 알림은 다시 보내지 않는다(수업 종료 알림 한 번).
 */
export function SessionPhotoUploader({
  sessionId,
  onUploaded,
  hideButtons = false,
  onStateChange,
  ref,
}: {
  sessionId: string;
  onUploaded?: (urls: string[]) => void;
  /** true 면 [사진 촬영]·[갤러리 선택] 버튼을 그리지 않는다 — 수업 화면 아래 고정 막대가 대신 올린다. 목록·지우기·안내는 그대로 */
  hideButtons?: boolean;
  onStateChange?: (state: SessionUploaderState) => void;
  ref?: Ref<SessionPhotoUploaderHandle>;
}) {
  const cameraRef = useRef<HTMLInputElement>(null);
  const galleryRef = useRef<HTMLInputElement>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [photos, setPhotos] = useState<ManagedPhoto[]>([]);
  // 서버가 정한 올리기 가능 여부 — 목록을 읽기 전엔 막아 둔다(시간 밖에서 눌렀다 실패하지 않게)
  const [canUpload, setCanUpload] = useState(false);
  const [windowMessage, setWindowMessage] = useState<string | null>(null);
  // 마지막 올리기에서 실패한 파일 — «실패한 n장 다시 올리기» 버튼에 쓴다
  const [failedFiles, setFailedFiles] = useState<File[]>([]);
  const [retryDelete, setRetryDelete] = useState<ManagedPhoto | null>(null);

  const loadPhotos = useCallback(async () => {
    const response = await fetch(`/api/staff/sessions/${encodeURIComponent(sessionId)}/photos`, { cache: "no-store" });
    const body = await response.json().catch(() => ({})) as { photos?: ManagedPhoto[]; canUpload?: boolean; windowMessage?: string | null; error?: string };
    if (!response.ok) throw new Error(body.error || "사진 목록을 불러오지 못했습니다.");
    setPhotos(body.photos || []);
    setCanUpload(body.canUpload === true);
    setWindowMessage(body.windowMessage ?? null);
  }, [sessionId]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadPhotos().catch((error) => setMessage(userErrorMessage(error, "사진 목록을 불러오지 못했습니다.")));
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadPhotos]);

  async function upload(files: FileList | File[] | null) {
    const list = files ? Array.from(files) : [];
    if (list.length === 0 || busy) return;
    setBusy(true);
    setRetryDelete(null);
    setMessage("사진을 압축하고 있습니다.");
    try {
      const result = await uploadImagesWithProgress(list, {
        folder: "staff-sessions",
        endpoint: `/api/staff/sessions/${encodeURIComponent(sessionId)}/photos`,
        limit: PHOTO_PICK_LIMIT,
        compression: {
          maxEdge: 1600,
          targetBytes: 700 * 1024,
          allowedTypes: SESSION_IMAGE_ALLOWED_TYPES,
        },
        onProgress: (done, total) => setMessage(`사진 올리는 중 ${done}/${total}`),
      });
      setFailedFiles(result.failedFiles);
      const parts: string[] = [];
      if (result.items.length > 0) parts.push(`사진 ${result.items.length}장을 올렸습니다.`);
      if (result.failedFiles.length > 0) parts.push(`${result.failedFiles.length}장은 올리지 못했습니다.`);
      if (result.skippedCount > 0) parts.push(`한 번에 ${PHOTO_PICK_LIMIT}장까지라 ${result.skippedCount}장은 빠졌습니다.`);
      setMessage(parts.join(" ") || "사진을 올리지 못했습니다.");
      if (result.items.length > 0) onUploaded?.(result.items.map((item) => item.url));
      await loadPhotos().catch(() => undefined);
    } catch {
      setMessage("사진을 올리지 못했습니다. 네트워크 연결을 확인한 뒤 다시 선택해 주세요.");
    } finally {
      setBusy(false);
      if (cameraRef.current) cameraRef.current.value = "";
      if (galleryRef.current) galleryRef.current.value = "";
    }
  }

  async function deletePhoto(photo: ManagedPhoto, confirmed = false) {
    if (busy || (!confirmed && !window.confirm("이 사진을 지울까요? 학부모 소식에서도 사라집니다."))) return;
    setBusy(true);
    setRetryDelete(null);
    try {
      const response = await fetch(
        `/api/staff/sessions/${encodeURIComponent(sessionId)}/photos/${encodeURIComponent(photo.id)}`,
        { method: "DELETE" },
      );
      const body = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(body.error || "사진을 지우지 못했습니다.");
      setPhotos((current) => current.filter((item) => item.id !== photo.id));
      setMessage("사진을 지웠습니다.");
    } catch (error) {
      setMessage(userErrorMessage(error, "네트워크 연결을 확인한 뒤 다시 시도해 주세요."));
      setRetryDelete(photo);
    } finally {
      setBusy(false);
    }
  }

  const locked = busy || !canUpload;

  // 바깥 버튼용: 같은 upload 함수를 그대로 부른다(압축·장수 제한·실패분 다시 올리기 모두 기존 로직)
  const uploadRef = useRef(upload);
  useEffect(() => { uploadRef.current = upload; });
  useImperativeHandle(ref, () => ({ upload: (files: File[]) => void uploadRef.current(files) }), []);
  useEffect(() => {
    onStateChange?.({ busy, canUpload, count: photos.length, message, windowMessage });
    // onStateChange 는 부모의 setState 를 그대로 받는다(매 렌더 새 함수여도 값이 같으면 다시 그리지 않는다)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, canUpload, photos.length, message, windowMessage]);

  return (
    <div className="space-y-3">
      {photos.length > 0 && (
        // 올린 사진 — 3칸 작은 바둑판(공간 절약). 지우기는 사진 아래 글자 버튼
        <ul className="grid grid-cols-3 gap-2" aria-label="올린 수업 사진">
          {photos.map((photo, index) => (
            <li key={photo.id} className="overflow-hidden rounded-xl border border-[var(--color-academy-line)] bg-white">
              {/* 인증된 비공개 API 주소라서 공개 URL을 만들지 않고도 미리보기가 가능합니다. */}
              <div className="relative aspect-square w-full">
                <Image src={photo.url} alt={`올린 수업 사진 ${index + 1}`} fill unoptimized sizes="(max-width: 640px) 33vw, 160px" className="object-cover" />
              </div>
              {photo.requiresDeletionQueue ? (
                <p className="bg-[var(--color-academy-warning-soft)] px-1 py-1 text-center text-xs font-medium text-[var(--color-academy-warning)]">공개됨 · 관리자 회수</p>
              ) : photo.canManage && canUpload ? (
                <button type="button" disabled={busy} aria-label={`사진 ${index + 1} 지우기`} onClick={() => void deletePhoto(photo)} className="academy-button-danger academy-button-sm w-full rounded-none! border-0! border-t!">
                  지우기
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {!hideButtons && <>
      <input ref={cameraRef} hidden type="file" accept="image/jpeg,image/png,image/webp" capture="environment" onChange={(event) => void upload(event.target.files)} />
      <input ref={galleryRef} hidden type="file" accept="image/jpeg,image/png,image/webp" multiple onChange={(event) => void upload(event.target.files)} />
      <div className="grid grid-cols-2 gap-2">
        <button type="button" disabled={locked} onClick={() => cameraRef.current?.click()} className="academy-button-primary min-h-12!">
          사진 촬영
        </button>
        <button type="button" disabled={locked} onClick={() => galleryRef.current?.click()} className="academy-button-secondary min-h-12!">
          갤러리 선택
        </button>
      </div>
      </>}
      {!canUpload && windowMessage && <p className="text-xs text-[var(--color-academy-muted)]">{windowMessage}</p>}
      {message && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-[var(--color-academy-soft)] p-3">
          <p aria-live="polite" className="min-w-0 flex-1 text-sm text-[var(--color-academy-muted)]">{message}</p>
          {failedFiles.length > 0 && canUpload && (
            // 실패한 사진만 다시 — 성공한 사진은 다시 올리지 않는다
            <button type="button" disabled={busy} onClick={() => void upload(failedFiles)} className="academy-button-secondary shrink-0">
              실패한 {failedFiles.length}장 다시 올리기
            </button>
          )}
          {retryDelete && (
            <button type="button" disabled={busy} onClick={() => void deletePhoto(retryDelete, true)} className="academy-button-secondary shrink-0">
              다시 시도
            </button>
          )}
        </div>
      )}
    </div>
  );
}
