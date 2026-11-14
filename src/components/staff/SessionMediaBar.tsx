"use client";

import { useRef, useState, type RefObject } from "react";
import type { SessionPhotoUploaderHandle, SessionUploaderState } from "@/components/staff/SessionPhotoUploader";
import type { SessionVideoUploaderHandle, SessionVideoUploaderState } from "@/components/staff/SessionVideoUploader";
import { galleryLeftoverNotice, planGalleryUpload, splitGalleryFiles } from "@/components/staff/sessionWorkspaceRules";

/**
 * 수업 중 화면 아래 고정 막대 — [사진] [동영상] [갤러리] (2026-11-15 원장 지시: 예전 «수업 종료 확인» 자리).
 *
 * - [사진] = 카메라로 바로 촬영, [동영상] = 영상 바로 촬영, [갤러리] = 찍어 둔 사진(여러 장)·영상(1개) 고르기.
 * - 숨은 파일 입력칸은 «누른 직후» 열려야 해서(브라우저 규칙) 버튼과 같은 이 부품 안에 둔다.
 * - 실제 올리기(압축·장수·용량·시간 제한·실패분 다시 올리기)는 기존 SessionPhotoUploader / SessionVideoUploader 가 한다.
 *   이 막대는 고른 파일을 그 부품의 upload 로 넘기기만 한다.
 * - 세 버튼은 같은 등급(옅은 바탕)이다 — 꽉 찬 주 버튼은 출석부의 «전체 출석» 하나만.
 */
export function SessionMediaBar({
  photoRef,
  videoRef,
  photoState,
  videoState,
  aboveBottomNav = false,
  onPicked,
}: {
  photoRef: RefObject<SessionPhotoUploaderHandle | null>;
  videoRef: RefObject<SessionVideoUploaderHandle | null>;
  photoState: SessionUploaderState | null;
  videoState: SessionVideoUploaderState | null;
  /** 오늘 수업 홈에 끼웠을 때 — 아래 탭 위로 띄운다(겹치지 않게) */
  aboveBottomNav?: boolean;
  /** 파일을 골라 올리기를 시작했을 때(사진·영상 칸을 펼쳐 진행·실패를 보이게) */
  onPicked?: () => void;
}) {
  const photoCameraRef = useRef<HTMLInputElement>(null);
  const videoCameraRef = useRef<HTMLInputElement>(null);
  const galleryRef = useRef<HTMLInputElement>(null);
  const [notice, setNotice] = useState("");

  // 목록을 읽기 전(상태 없음)에는 잠근다 — 시간 밖에서 눌렀다 실패하지 않게(기존 부품과 같은 원칙)
  const photoLocked = !photoState?.canUpload || photoState.busy;
  const videoLocked = !videoState?.canUpload || videoState.busy;
  const galleryLocked = Boolean(photoState?.busy || videoState?.busy) || (!photoState?.canUpload && !videoState?.canUpload);

  function sendPhotos(files: File[]) {
    if (files.length === 0) return;
    photoRef.current?.upload(files);
    onPicked?.();
  }

  function sendVideo(file: File | null | undefined) {
    if (!file) return;
    videoRef.current?.upload(file);
    onPicked?.();
  }

  function pickedFromGallery(list: FileList | null) {
    const split = splitGalleryFiles(list ? Array.from(list) : []);
    // 막힌 쪽(올릴 수 있는 시간이 아니거나 이미 올리는 중)의 파일은 보내지 않고 이유를 알린다
    const plan = planGalleryUpload({
      images: split.images,
      video: split.video,
      photoAvailable: !photoLocked,
      videoAvailable: !videoLocked,
      photoReason: photoState?.busy ? "사진을 올리는 중이라 새 사진은 잠시 뒤에 골라 주세요." : photoState?.windowMessage,
      videoReason: videoState?.busy ? "영상을 올리는 중이라 새 영상은 잠시 뒤에 골라 주세요." : videoState?.windowMessage,
    });
    setNotice([plan.blocked, galleryLeftoverNotice(split)].filter(Boolean).join(" "));
    // 고른 파일 종류대로 기존 사진·영상 올리기에 나눠 보낸다
    sendPhotos(plan.images);
    sendVideo(plan.video);
    if (galleryRef.current) galleryRef.current.value = "";
  }

  // 막대에 보일 한 줄: 올리는 중이면 진행, 아니면 올릴 수 없는 이유(시간 밖), 갤러리에서 빠진 파일 안내
  const status = photoState?.busy
    ? photoState.message
    : videoState?.busy
      ? `영상 올리는 중${videoState.progress ? ` ${videoState.progress}%` : ""}`
      : notice || (photoState && !photoState.canUpload ? photoState.windowMessage ?? "" : "");

  return (
    <div
      id="session-media-bar"
      className="fixed inset-x-0 z-30 mx-auto max-w-lg px-4"
      // 수업 주소에서는 아래 탭이 숨으므로 화면 바닥(홈 인디케이터만 비움), 홈에서는 아래 탭(56px + 여백) 위
      style={{ bottom: aboveBottomNav ? "calc(3.75rem + max(0.625rem, env(safe-area-inset-bottom)))" : "max(0.5rem, env(safe-area-inset-bottom))" }}
    >
      <div className="rounded-2xl border border-[var(--color-academy-line)] bg-white/95 p-2 shadow-lg backdrop-blur">
        <input ref={photoCameraRef} hidden type="file" accept="image/jpeg,image/png,image/webp" capture="environment" onChange={(event) => { sendPhotos(Array.from(event.target.files ?? [])); event.target.value = ""; }} />
        {/* ⚠️ 영상 촬영 칸의 accept 는 «video/*» 하나만 둔다 — 안드로이드는 받는 형식이 «전부 영상»일 때만 동영상 카메라를 열고,
            구체 형식 목록을 섞거나 multiple 을 붙이면 파일 선택으로 떨어진다(그래서 갤러리 칸과 따로 둔다). */}
        <input ref={videoCameraRef} hidden type="file" accept="video/*" capture="environment" onChange={(event) => { sendVideo(event.target.files?.[0]); event.target.value = ""; }} />
        <input ref={galleryRef} hidden type="file" accept="image/jpeg,image/png,image/webp,video/mp4,video/quicktime,video/webm" multiple onChange={(event) => pickedFromGallery(event.target.files)} />
        <div className="grid grid-cols-3 gap-2" role="group" aria-label="수업 사진·영상 올리기">
          <button type="button" disabled={photoLocked} onClick={() => { setNotice(""); photoCameraRef.current?.click(); }} className="academy-button-tonal min-h-12!">사진</button>
          <button type="button" disabled={videoLocked} onClick={() => { setNotice(""); videoCameraRef.current?.click(); }} className="academy-button-tonal min-h-12!">동영상</button>
          <button type="button" disabled={galleryLocked} onClick={() => { setNotice(""); galleryRef.current?.click(); }} className="academy-button-tonal min-h-12!">갤러리</button>
        </div>
        {/* 옛 안드로이드 앱(1.0.3 미만)은 [동영상]이 촬영 화면 대신 파일 선택으로 떨어진다 → 버튼 바로 아래에 안내(판정은 영상 부품의 needsAppUpdateForVideoCapture) */}
        {videoState?.needsAppUpdate && videoState.canUpload && (
          <p role="status" className="mt-1 text-center text-xs text-[var(--color-academy-warning)]">
            앱을 업데이트하면 [동영상]이 바로 촬영돼요. 지금은 휴대폰 카메라로 찍은 뒤 «갤러리»로 올려 주세요.
          </p>
        )}
        {status && <p aria-live="polite" className="mt-1 text-center text-xs text-[var(--color-academy-muted)]">{status}</p>}
      </div>
    </div>
  );
}
