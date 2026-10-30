"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Image from "next/image";
import { SESSION_IMAGE_ALLOWED_TYPES } from "@/lib/clientImageCompression";
import { uploadImagesWithProgress } from "@/lib/clientImageUpload";

type PhotoSubject = { id: string; name: string };
type ManagedPhoto = {
  id: string;
  url: string;
  subjectStudentIds: string[];
  canManage: boolean;
  requiresDeletionQueue: boolean;
};

export function SessionPhotoUploader({
  sessionId,
  students,
  onUploaded,
}: {
  sessionId: string;
  students: PhotoSubject[];
  onUploaded?: (urls: string[]) => void;
}) {
  const cameraRef = useRef<HTMLInputElement>(null);
  const galleryRef = useRef<HTMLInputElement>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [subjectStudentIds, setSubjectStudentIds] = useState<string[]>([]);
  const [photos, setPhotos] = useState<ManagedPhoto[]>([]);
  const [editingPhotoId, setEditingPhotoId] = useState<string | null>(null);
  const [retryAction, setRetryAction] = useState<(() => Promise<void>) | null>(null);

  const loadPhotos = useCallback(async () => {
    const response = await fetch(`/api/staff/sessions/${encodeURIComponent(sessionId)}/photos`, { cache: "no-store" });
    const body = await response.json().catch(() => ({})) as { photos?: ManagedPhoto[]; error?: string };
    if (!response.ok) throw new Error(body.error || "사진 목록을 불러오지 못했습니다.");
    setPhotos(body.photos || []);
  }, [sessionId]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadPhotos().catch((error) => setMessage(error instanceof Error ? error.message : "사진 목록을 불러오지 못했습니다."));
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadPhotos]);

  function toggleSubject(studentId: string) {
    setSubjectStudentIds((current) =>
      current.includes(studentId)
        ? current.filter((id) => id !== studentId)
        : [...current, studentId],
    );
  }

  async function upload(files: FileList | null) {
    if (!files?.length || busy) return;
    if (subjectStudentIds.length === 0) {
      setMessage("사진에 나온 학생을 한 명 이상 선택해 주세요.");
      return;
    }

    setBusy(true);
    setMessage("사진을 압축하고 있습니다.");
    try {
      const result = await uploadImagesWithProgress(files, {
        folder: "staff-sessions",
        endpoint: `/api/staff/sessions/${encodeURIComponent(sessionId)}/photos`,
        fields: { subjectStudentIds: JSON.stringify(subjectStudentIds) },
        limit: 10,
        compression: {
          maxEdge: 1600,
          targetBytes: 700 * 1024,
          allowedTypes: SESSION_IMAGE_ALLOWED_TYPES,
        },
        onProgress: (done, total) => setMessage(`사진 등록 중 ${done}/${total}`),
      });
      setMessage(
        result.failedNames.length
          ? `${result.failedNames.length}장의 등록에 실패했습니다.`
          : "관리자 검토용 비공개 초안으로 등록했습니다.",
      );
      onUploaded?.(result.items.map((item) => item.url));
      await loadPhotos().catch(() => undefined);
    } catch {
      setMessage("사진을 등록하지 못했습니다. 네트워크 연결을 확인한 뒤 다시 선택해 주세요.");
    } finally {
      setBusy(false);
      if (cameraRef.current) cameraRef.current.value = "";
      if (galleryRef.current) galleryRef.current.value = "";
    }
  }

  async function updatePhotoSubjects(photo: ManagedPhoto) {
    if (photo.subjectStudentIds.length === 0 || busy) return;
    setBusy(true);
    setRetryAction(null);
    try {
      const response = await fetch(
        `/api/staff/sessions/${encodeURIComponent(sessionId)}/photos/${encodeURIComponent(photo.id)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ subjectStudentIds: photo.subjectStudentIds }),
        },
      );
      const body = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(body.error || "사진의 학생 정보를 수정하지 못했습니다.");
      setEditingPhotoId(null);
      setMessage("사진에 나온 학생 정보를 수정했습니다.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "네트워크 연결을 확인한 뒤 다시 시도해 주세요.");
      setRetryAction(() => () => updatePhotoSubjects(photo));
    } finally {
      setBusy(false);
    }
  }

  async function deletePhoto(photo: ManagedPhoto, confirmed = false) {
    if (busy || (!confirmed && !window.confirm("이 사진을 수업 기록과 관리자 검토 목록에서 삭제할까요?"))) return;
    setBusy(true);
    setRetryAction(null);
    try {
      const response = await fetch(
        `/api/staff/sessions/${encodeURIComponent(sessionId)}/photos/${encodeURIComponent(photo.id)}`,
        { method: "DELETE" },
      );
      const body = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(body.error || "사진을 삭제하지 못했습니다.");
      setPhotos((current) => current.filter((item) => item.id !== photo.id));
      setMessage("사진을 삭제했습니다.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "네트워크 연결을 확인한 뒤 다시 시도해 주세요.");
      setRetryAction(() => () => deletePhoto(photo, true));
    } finally {
      setBusy(false);
    }
  }

  function togglePhotoSubject(photoId: string, studentId: string) {
    setPhotos((current) => current.map((photo) => photo.id !== photoId ? photo : {
      ...photo,
      subjectStudentIds: photo.subjectStudentIds.includes(studentId)
        ? photo.subjectStudentIds.filter((id) => id !== studentId)
        : [...photo.subjectStudentIds, studentId],
    }));
  }

  return (
    <div className="space-y-3">
      {photos.length > 0 && (
        <div className="grid grid-cols-2 gap-3" aria-label="등록한 수업 사진">
          {photos.map((photo) => (
            <article key={photo.id} className="overflow-hidden rounded-xl border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800">
              {/* 인증된 비공개 API 주소라서 공개 URL을 만들지 않고도 미리보기가 가능합니다. */}
              <div className="relative aspect-square w-full">
                <Image src={photo.url} alt="등록한 수업 사진" fill unoptimized sizes="(max-width: 640px) 50vw, 240px" className="object-cover" />
              </div>
              <div className="space-y-2 p-2">
                <p className="line-clamp-2 text-xs text-gray-600 dark:text-gray-300">
                  {photo.subjectStudentIds.map((id) => students.find((student) => student.id === id)?.name).filter(Boolean).join(", ") || "대상 학생 미지정"}
                </p>
                {photo.requiresDeletionQueue ? (
                  <p className="rounded-lg bg-amber-50 p-2 text-xs font-bold text-amber-800">공개된 사진 · 관리자 회수 필요</p>
                ) : (
                  // 게슈탈트 T-10: «학생 수정»과 «삭제»가 나란히 붙어 있으면 잘못 누르기 쉽다.
                  // 삭제는 오른쪽 끝 휴지통 아이콘으로 떼어 두고(간격 12px), 확인 창(deletePhoto)은 그대로 둔다.
                  <div className="flex items-center justify-between gap-3">
                    <button type="button" disabled={busy} onClick={() => setEditingPhotoId(editingPhotoId === photo.id ? null : photo.id)} className="min-h-11 flex-1 rounded-lg border border-[var(--color-academy-line)] text-xs font-bold disabled:opacity-50">학생 수정</button>
                    <button type="button" disabled={busy} aria-label="사진 삭제" title="사진 삭제" onClick={() => void deletePhoto(photo)} className="grid size-11 shrink-0 place-items-center rounded-lg border border-[var(--color-academy-danger)] text-[var(--color-academy-danger)] disabled:opacity-50">
                      <span aria-hidden="true" className="material-symbols-outlined text-xl">delete</span>
                    </button>
                  </div>
                )}
                {editingPhotoId === photo.id && photo.canManage && (
                  <div className="space-y-2 border-t border-gray-100 pt-2 dark:border-gray-700">
                    <div className="flex max-h-48 flex-wrap gap-2 overflow-y-auto">
                      {students.map((student) => {
                        const selected = photo.subjectStudentIds.includes(student.id);
                        return <button key={student.id} type="button" aria-pressed={selected} onClick={() => togglePhotoSubject(photo.id, student.id)} className={`min-h-11 rounded-full border px-3 text-xs font-bold ${selected ? "border-[var(--brand-accent)] bg-[var(--brand-accent)] text-[var(--brand-accent-contrast)]" : "border-gray-200 dark:border-gray-600"}`}>{student.name}</button>;
                      })}
                    </div>
                    <button type="button" disabled={busy || photo.subjectStudentIds.length === 0} onClick={() => void updatePhotoSubjects(photo)} className="academy-button-secondary min-h-11 w-full rounded-lg text-xs font-black disabled:opacity-50">변경 저장</button>
                  </div>
                )}
              </div>
            </article>
          ))}
        </div>
      )}
      <fieldset disabled={busy}>
        <legend className="text-sm font-bold text-gray-700 dark:text-gray-200">
          사진에 나온 학생 <span className="text-red-600">(필수)</span>
        </legend>
        <p className="mt-1 text-xs leading-5 text-gray-500">
          선택한 학생의 보호자 동의가 확인된 사진만 관리자가 갤러리나 인스타그램에 게시할 수 있습니다.
        </p>
        <div className="mt-2 flex max-h-40 flex-wrap gap-2 overflow-y-auto rounded-xl border border-gray-200 p-3 dark:border-gray-700">
          {students.map((student) => {
            const selected = subjectStudentIds.includes(student.id);
            return (
              <button
                key={student.id}
                type="button"
                aria-pressed={selected}
                onClick={() => toggleSubject(student.id)}
                className={`min-h-11 rounded-full border px-3 text-sm font-bold ${
                  selected
                    ? "border-[var(--brand-accent)] bg-[var(--brand-accent)] text-[var(--brand-accent-contrast)]"
                    : "border-gray-200 bg-white text-gray-600 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200"
                }`}
              >
                {selected ? "✓ " : ""}{student.name}
              </button>
            );
          })}
        </div>
      </fieldset>

      <input ref={cameraRef} hidden type="file" accept="image/jpeg,image/png,image/webp" capture="environment" onChange={(event) => void upload(event.target.files)} />
      <input ref={galleryRef} hidden type="file" accept="image/jpeg,image/png,image/webp" multiple onChange={(event) => void upload(event.target.files)} />
      <div className="grid grid-cols-2 gap-2">
        <button type="button" disabled={busy} onClick={() => cameraRef.current?.click()} className="min-h-12 rounded-xl bg-[var(--brand-accent)] px-3 font-black text-[var(--brand-accent-contrast)] disabled:opacity-50">
          사진 촬영
        </button>
        <button type="button" disabled={busy} onClick={() => galleryRef.current?.click()} className="min-h-12 rounded-xl border border-gray-200 bg-white px-3 font-black disabled:opacity-50 dark:border-gray-700 dark:bg-gray-800">
          갤러리 선택
        </button>
      </div>
      {message && (
        <div className="flex items-center justify-between gap-3 rounded-xl bg-gray-100 p-3 dark:bg-gray-800">
          <p aria-live="polite" className="text-sm font-bold text-gray-600 dark:text-gray-300">{message}</p>
          {retryAction && (
            <button type="button" disabled={busy} onClick={() => void retryAction()} className="min-h-11 shrink-0 rounded-xl border border-gray-300 px-3 text-sm font-black dark:border-gray-600">
              다시 시도
            </button>
          )}
        </div>
      )}
    </div>
  );
}
