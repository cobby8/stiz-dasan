"use client";

import { useEffect, useRef, useState } from "react";
import { userErrorMessage } from "@/components/staff/userErrorMessage";

export function VoiceToTextButton({
  onText,
  onBusyChange,
}: {
  onText: (text: string) => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const recorder = useRef<MediaRecorder | null>(null);
  const startedAt = useRef(0);
  const chunks = useRef<Blob[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
      const activeRecorder = recorder.current;
      if (activeRecorder) activeRecorder.onstop = null;
      if (activeRecorder?.state === "recording") activeRecorder.stop();
      activeRecorder?.stream.getTracks().forEach((track) => track.stop());
    };
  }, []);

  async function start() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const preferred = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm"].find((type) => MediaRecorder.isTypeSupported(type));
      const next = new MediaRecorder(stream, preferred ? { mimeType: preferred } : undefined);
      chunks.current = [];
      next.ondataavailable = (event) => { if (event.data.size) chunks.current.push(event.data); };
      next.onstop = () => { stream.getTracks().forEach((track) => track.stop()); void transcribe(next.mimeType); };
      recorder.current = next;
      // 녹음 버튼 이벤트 안에서만 시작 시각을 기록합니다.
      startedAt.current = Date.now();
      next.start();
      setRecording(true);
      onBusyChange?.(true);
      setMessage("녹음 중… 최대 60초");
      timer.current = setTimeout(stop, 60_000);
    } catch {
      onBusyChange?.(false);
      setMessage("마이크 권한을 허용해 주세요.");
    }
  }

  function stop() {
    if (timer.current) clearTimeout(timer.current);
    if (recorder.current?.state === "recording") recorder.current.stop();
    setRecording(false);
  }

  async function transcribe(mimeType: string) {
    setTranscribing(true);
    setMessage("음성을 글로 바꾸는 중입니다.");
    const blob = new Blob(chunks.current, { type: mimeType.split(";")[0] });
    chunks.current = [];
    if (blob.size > 10 * 1024 * 1024) {
      setMessage("녹음 용량이 너무 큽니다.");
      setTranscribing(false);
      onBusyChange?.(false);
      return;
    }
    const form = new FormData();
    form.append("audio", blob, "voice-recording");
    form.append("durationMs", String(Math.min(Date.now() - startedAt.current, 60_000)));
    try {
      const response = await fetch("/api/staff/transcribe", { method: "POST", body: form });
      const data = await response.json();
      if (!response.ok) { setMessage(userErrorMessage(data.error, "음성 인식에 실패했습니다. 다시 말씀해 주세요.")); return; }
      onText(data.text);
      setMessage("음성을 메모로 변환했습니다.");
    } catch {
      setMessage("네트워크 연결을 확인하고 다시 시도해 주세요.");
    } finally {
      setTranscribing(false);
      onBusyChange?.(false);
    }
  }

  return <div className="flex flex-col items-end gap-1">
    <button
      type="button"
      disabled={transcribing}
      aria-pressed={recording}
      aria-label={recording ? "음성 녹음 종료" : "특이사항 음성 녹음 시작"}
      onClick={recording ? stop : () => void start()}
      className="min-h-12 rounded-xl bg-[var(--brand-accent)] px-4 text-sm font-black text-[var(--brand-accent-contrast)] disabled:opacity-50"
    >
      <span className="material-symbols-outlined mr-1 align-middle" aria-hidden="true">
        {recording ? "stop_circle" : transcribing ? "progress_activity" : "mic"}
      </span>
      {recording ? "녹음 종료" : transcribing ? "메모 변환 중" : "음성으로 기록"}
    </button>
    {message && <span aria-live="polite" className="max-w-48 text-right text-xs font-bold text-gray-500">{message}</span>}
  </div>;
}
