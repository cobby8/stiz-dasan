"use client";

import { useCallback, useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import { userErrorMessage } from "@/components/staff/userErrorMessage";
import { UPLOAD_STALLED_MESSAGE, createStallWatch, fetchWithTimeout } from "@/components/staff/fetchWithTimeout";
import { SessionVideoPlayer } from "@/components/parent/SessionVideoPlayer";
import { isStoreApp, needsAppUpdateForVideoCapture } from "@/lib/storeApp";
import { checkSessionVideoFile, SESSION_VIDEO_DEFAULT_MAX_BYTES, uploadHintMessage, type SessionVideoPlayback } from "@/lib/sessionVideo/rules";

type VideoListResponse = {
  videos?: SessionVideoPlayback[];
  canManage?: boolean;
  windowMessage?: string | null;
  maxBytes?: number;
  error?: string;
};

/** 영상 길이(초) — 못 읽으면 null(5초 안에 답이 없으면 포기). 업로드를 막지 않는 참고값이다. */
function readDurationSec(file: File): Promise<number | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    const done = (value: number | null) => {
      window.clearTimeout(timer);
      URL.revokeObjectURL(url);
      resolve(value);
    };
    const timer = window.setTimeout(() => done(null), 5000);
    video.preload = "metadata";
    video.onloadedmetadata = () => done(Number.isFinite(video.duration) ? video.duration : null);
    video.onerror = () => done(null);
    video.src = url;
  });
}

/**
 * 저장소 서명 주소로 «직접» 올린다(XHR — 진행률을 보이려고 fetch 대신 쓴다).
 * 서버(Vercel)를 거치지 않으므로 4.5MB 본문 한계와 무관하다.
 */
function putWithProgress(url: string, file: File, mimeType: string, onProgress: (percent: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    // 무진행 감시(2026-11-15 검수) — 올리기가 60초 동안 한 바이트도 안 움직이면 끊는다.
    // 멈춘 채 두면 «올리는 중»이 풀리지 않아 버튼이 회색이고 수업 종료도 잠긴다.
    let stalled = false;
    const watch = createStallWatch(() => { stalled = true; xhr.abort(); });
    xhr.open("PUT", url);
    xhr.setRequestHeader("Content-Type", mimeType);
    xhr.setRequestHeader("x-upsert", "false");
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (anonKey) xhr.setRequestHeader("apikey", anonKey);
    xhr.upload.onprogress = (event) => {
      watch.touch();
      if (event.lengthComputable) onProgress(Math.min(99, Math.round((event.loaded / event.total) * 100)));
    };
    xhr.onload = () => { watch.stop(); return (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(xhr.status === 413
      ? "영상이 너무 큽니다. 30초 이내로 짧게 찍어 주세요."
      : "영상 업로드에 실패했습니다. 네트워크를 확인한 뒤 다시 시도해 주세요."))); };
    xhr.onerror = () => { watch.stop(); reject(new Error("영상 업로드에 실패했습니다. 네트워크를 확인한 뒤 다시 시도해 주세요.")); };
    xhr.onabort = () => { watch.stop(); reject(new Error(stalled ? UPLOAD_STALLED_MESSAGE : "영상 업로드가 취소되었습니다.")); };
    watch.touch();
    xhr.send(file);
  });
}

/**
 * 수업 영상 촬영·업로드(선생님) — 수업 진행 화면의 사진 칸 아래에 둔다.
 *
 * 순서: ① 서버에 «업로드 주소» 요청(권한·시간·형식·크기 확인) ② 브라우저 → 저장소 직접 업로드(진행률)
 *       ③ 서버에 «등록»(서버가 저장소 파일 크기·형식을 다시 확인) ④ 목록 새로 불러오기.
 * 업로드·삭제는 수업일 포함 7일 동안(원장·부원장은 제한 없음 — 서버가 판정, 화면은 그 결과만 보인다).
 */
/** 바깥 버튼(수업 화면 아래 [동영상]·[갤러리])이 이 부품의 올리기를 부를 때 쓰는 손잡이(2026-11-15) */
export type SessionVideoUploaderHandle = { upload: (file: File) => void; reload: () => void };
export type SessionVideoUploaderState = {
  busy: boolean; canUpload: boolean; count: number; message: string; progress: number | null; windowMessage: string | null;
  /** 옛 안드로이드 앱(1.0.3 미만) — «영상 촬영»이 파일 선택으로 떨어진다. 바깥 [동영상] 버튼 옆에 업데이트 안내를 보이는 데 쓴다 */
  needsAppUpdate: boolean;
  /** 목록을 한 번이라도 다 읽었는가 · 읽지 못했을 때의 문구 — 바깥 [동영상] 버튼이 «왜 안 눌리는지» 보이는 데 쓴다 */
  loaded: boolean; loadError: string;
};

export function SessionVideoUploader({ sessionId, hideButtons = false, onStateChange, ref }: {
  sessionId: string;
  /** true 면 [영상 촬영]·[영상 선택] 버튼을 그리지 않는다 — 수업 화면 아래 고정 막대가 대신 올린다. 목록·삭제·진행률은 그대로 */
  hideButtons?: boolean;
  onStateChange?: (state: SessionVideoUploaderState) => void;
  ref?: Ref<SessionVideoUploaderHandle>;
}) {
  const cameraRef = useRef<HTMLInputElement>(null);
  const galleryRef = useRef<HTMLInputElement>(null);
  const [videos, setVideos] = useState<SessionVideoPlayback[]>([]);
  const [canManage, setCanManage] = useState(false);
  const [windowMessage, setWindowMessage] = useState<string | null>(null);
  const [maxBytes, setMaxBytes] = useState(SESSION_VIDEO_DEFAULT_MAX_BYTES);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [message, setMessage] = useState("");
  const [retryFile, setRetryFile] = useState<File | null>(null);
  const [needsAppUpdate, setNeedsAppUpdate] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState("");
  const base = `/api/staff/sessions/${encodeURIComponent(sessionId)}/videos`;

  // 화면이 사라지면 진행 중인 목록 조회를 끊는다
  const unmountRef = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    unmountRef.current = controller;
    return () => controller.abort();
  }, []);
  // 실패 문구로 칸 안에 띄운 글 — «다시 시도»가 성공하면 지운다
  const failedTextRef = useRef("");

  const load = useCallback(async () => {
    // 10초 안에 답이 없으면 실패로 떨어뜨린다(멈춘 조회 때문에 «준비 중…»에 머물지 않게)
    const response = await fetchWithTimeout(base, { cache: "no-store" }, { signal: unmountRef.current?.signal });
    const body = await response.json().catch(() => ({})) as VideoListResponse;
    if (!response.ok) throw new Error(body.error || "영상 목록을 불러오지 못했습니다.");
    setVideos(body.videos || []);
    setCanManage(Boolean(body.canManage));
    setWindowMessage(body.windowMessage ?? null);
    if (typeof body.maxBytes === "number" && body.maxBytes > 0) setMaxBytes(body.maxBytes);
  }, [base]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      // 옛 안드로이드 앱(1.0.3 미만)은 «영상 촬영»이 파일 선택으로 떨어진다 → 버튼 아래에 안내 한 줄
      try {
        setNeedsAppUpdate(needsAppUpdateForVideoCapture({ userAgent: window.navigator.userAgent, storeApp: isStoreApp() }));
      } catch {
        // 판정 실패 = 안내 없음(촬영 버튼은 그대로 쓸 수 있다)
      }
      reloadRef.current();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  // 목록 읽기(처음 + «다시 시도») — 실패하면 바깥 [동영상] 버튼 옆에도 보이게 따로 적어 둔다
  // (예전엔 접힌 «사진·영상» 칸 안에만 떠서 버튼이 왜 회색인지 알 수 없었다)
  function reload() {
    setLoadError("");
    void load().then(() => {
      setLoaded(true);
      // 앞서 실패해 띄운 문구가 그대로 남아 있으면 지운다(그사이 다른 안내로 바뀌었으면 둔다)
      const failedText = failedTextRef.current;
      failedTextRef.current = "";
      if (failedText) setMessage((current) => (current === failedText ? "" : current));
    }).catch((error) => {
      if (unmountRef.current?.signal.aborted) return; // 화면이 사라져 끊은 것
      const text = userErrorMessage(error, "영상 목록을 불러오지 못했습니다.");
      failedTextRef.current = text;
      setMessage(text);
      setLoadError(text);
    });
  }
  const reloadRef = useRef(reload);
  useEffect(() => { reloadRef.current = reload; });

  async function upload(file: File | null | undefined) {
    if (!file || busy) return;
    // 서버에 묻기 전에 화면에서 먼저 크기·형식을 본다(큰 영상을 몇 분씩 올리다 실패하지 않게)
    const check = checkSessionVideoFile({ mimeType: file.type, fileName: file.name, sizeBytes: file.size, maxBytes });
    if (!check.ok) {
      setMessage(check.message);
      setRetryFile(null);
      resetInputs();
      return;
    }
    setBusy(true);
    setRetryFile(null);
    setProgress(0);
    setMessage("영상을 올리는 중입니다. 화면을 닫지 마세요.");
    try {
      const durationSec = await readDurationSec(file);
      const prepare = await fetch(`${base}/upload-url`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mimeType: check.mimeType, sizeBytes: file.size, fileName: file.name }),
      });
      const prepared = await prepare.json().catch(() => ({})) as { videoId?: string; uploadUrl?: string; mimeType?: string; error?: string };
      if (!prepare.ok || !prepared.videoId || !prepared.uploadUrl) throw new Error(prepared.error || "영상 업로드를 준비하지 못했습니다.");

      await putWithProgress(prepared.uploadUrl, file, prepared.mimeType || check.mimeType, setProgress);

      const register = await fetch(base, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ videoId: prepared.videoId, durationSec }),
      });
      const registered = await register.json().catch(() => ({})) as { error?: string };
      if (!register.ok) throw new Error(registered.error || "영상을 등록하지 못했습니다.");
      setProgress(100);
      setMessage("영상을 올렸습니다. 수업이 끝나면 이 수업 학생의 보호자만 볼 수 있습니다.");
      await load().catch(() => undefined);
    } catch (error) {
      setMessage(userErrorMessage(error, "영상을 올리지 못했습니다. 네트워크를 확인한 뒤 다시 시도해 주세요."));
      setRetryFile(file);
    } finally {
      setBusy(false);
      setProgress(null);
      resetInputs();
    }
  }

  function resetInputs() {
    if (cameraRef.current) cameraRef.current.value = "";
    if (galleryRef.current) galleryRef.current.value = "";
  }

  async function remove(video: SessionVideoPlayback) {
    if (busy || !window.confirm("이 영상을 지울까요? 학부모 화면에서도 바로 사라집니다.")) return;
    setBusy(true);
    try {
      const response = await fetch(`${base}/${encodeURIComponent(video.id)}`, { method: "DELETE" });
      const body = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(body.error || "영상을 지우지 못했습니다.");
      setVideos((current) => current.filter((item) => item.id !== video.id));
      setMessage("영상을 지웠습니다.");
    } catch (error) {
      setMessage(userErrorMessage(error, "영상을 지우지 못했습니다. 다시 시도해 주세요."));
    } finally {
      setBusy(false);
    }
  }

  // 바깥 버튼용: 같은 upload 함수를 그대로 부른다(크기·형식 확인·진행률·다시 시도 모두 기존 로직)
  const uploadRef = useRef(upload);
  useEffect(() => { uploadRef.current = upload; });
  useImperativeHandle(ref, () => ({ upload: (file: File) => void uploadRef.current(file), reload: () => reloadRef.current() }), []);
  useEffect(() => {
    onStateChange?.({ busy, canUpload: canManage, count: videos.length, message, progress, windowMessage, needsAppUpdate, loaded, loadError });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, canManage, videos.length, message, progress, windowMessage, needsAppUpdate, loaded, loadError]);

  return (
    <div className="space-y-3">
      {videos.length > 0 && (
        <ul className="grid gap-3 sm:grid-cols-2" aria-label="올린 수업 영상">
          {videos.map((video) => (
            <li key={video.id} className="space-y-2">
              <SessionVideoPlayer video={video} />
              {canManage && (
                // 삭제는 오른쪽 끝에 떼어 둔 위험 버튼 하나(확인 창을 거친다)
                <div className="flex justify-end">
                  <button type="button" disabled={busy} onClick={() => void remove(video)} className="academy-button-danger academy-button-sm">
                    영상 삭제
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {canManage ? (
        <>
          {/* hideButtons(수업 중 화면): 촬영·선택 버튼과 업데이트 안내는 아래 고정 막대(SessionMediaBar)가 그린다 — 여기는 크기 안내만 */}
          {!hideButtons && <>
          {/* 촬영: 휴대폰 카메라(후면)로 바로 / 선택: 갤러리에 있는 영상
              ⚠️ 촬영 칸의 accept 는 «video/*» 하나만 둔다. 안드로이드(크롬·앱 1.0.3+)는 받는 형식이 «전부 영상»일 때만
              동영상 카메라를 열고, 구체 형식 목록(mp4,quicktime…)을 섞거나 multiple 을 붙이면 파일 선택으로 떨어진다.
              아이폰은 capture 가 있으면 형식과 무관하게 카메라를 연다. PC 브라우저는 capture 를 무시한다(파일 선택이 정상). */}
          <input ref={cameraRef} hidden type="file" accept="video/*" capture="environment" onChange={(event) => void upload(event.target.files?.[0])} />
          <input ref={galleryRef} hidden type="file" accept="video/mp4,video/quicktime,video/webm" onChange={(event) => void upload(event.target.files?.[0])} />
          <div className="grid grid-cols-2 gap-2">
            <button type="button" disabled={busy} onClick={() => cameraRef.current?.click()} className="academy-button-primary min-h-12!">
              영상 촬영
            </button>
            <button type="button" disabled={busy} onClick={() => galleryRef.current?.click()} className="academy-button-secondary min-h-12!">
              영상 선택
            </button>
          </div>
          {needsAppUpdate && (
            <p role="status" className="text-xs text-[var(--color-academy-warning)]">
              앱을 업데이트하면 바로 촬영돼요. 지금은 휴대폰 카메라로 찍은 뒤 «영상 선택»으로 올려 주세요.
            </p>
          )}
          </>}
          <p className="text-xs text-[var(--color-academy-muted)]">{uploadHintMessage(maxBytes)}</p>
        </>
      ) : (
        windowMessage && <p className="text-sm text-[var(--color-academy-muted)]">{windowMessage}</p>
      )}

      {progress !== null && (
        <div className="h-2 w-full overflow-hidden rounded-full bg-[var(--color-academy-soft)]" role="progressbar" aria-label="영상 업로드 진행률" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}>
          <div className="h-full bg-[var(--color-academy-primary)] transition-[width]" style={{ width: `${progress}%` }} />
        </div>
      )}
      {message && (
        <div className="flex items-center justify-between gap-3 rounded-xl bg-[var(--color-academy-soft)] p-3">
          <p aria-live="polite" className="min-w-0 text-sm text-[var(--color-academy-muted)]">
            {message}{progress !== null && progress > 0 ? ` ${progress}%` : ""}
          </p>
          {retryFile && !busy && (
            <button type="button" onClick={() => void upload(retryFile)} className="academy-button-secondary shrink-0">
              다시 시도
            </button>
          )}
        </div>
      )}
    </div>
  );
}
