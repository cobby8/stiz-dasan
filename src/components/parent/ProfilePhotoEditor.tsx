"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import ProfileAvatar from "@/components/common/ProfileAvatar";
import { SESSION_IMAGE_ALLOWED_TYPES, compressImageForUpload } from "@/lib/clientImageCompression";
import { PROFILE_PHOTO_NOTICE, profilePhotoUploadProblem, profilePhotoUrl, type ProfilePhotoOwner } from "@/lib/profilePhoto/rules";

// 프로필 사진 올리기·바꾸기·지우기 칸(2026-11-15) — 아이 기록 «아이 정보»와 설정 «내 정보»가 같이 쓴다.
//  · 올리기 전에 브라우저에서 먼저 줄인다(휴대폰 원본은 5~10MB — 그대로 보내면 느리고 상한에 걸린다).
//  · 진행·실패는 글자로 알린다(아이콘 없음). 지우기는 그 자리에서 한 번 더 묻는다.
//  · 누구 사진인지는 서버가 다시 확인한다 — 여기서 보내는 studentId 는 «요청»일 뿐이다.

type Status = { text: string; tone: "info" | "ok" | "error" };

const TONE_CLASS: Record<Status["tone"], string> = {
  info: "text-[var(--color-academy-muted)]",
  ok: "text-[var(--color-academy-success)]",
  error: "text-[var(--color-academy-danger)]",
};

export default function ProfilePhotoEditor({
  target,
  studentId,
  ownerId,
  name,
  initialVersion,
}: {
  /** student = 아이 사진, me = 내 사진 */
  target: "student" | "me";
  /** 아이 사진일 때 학생 id */
  studentId?: string;
  /** 사진 주소를 만들 주인 id(아이 = 학생 id, 내 사진 = 내 사용자 id) */
  ownerId: string;
  name: string;
  /** 지금 사진의 캐시 버전(없으면 null = 사진 없음) */
  initialVersion: string | null;
}) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  // 올리거나 지운 뒤의 버전 — 서버 새 그림(router.refresh)이 오기 전에도 바로 바뀐 사진을 보인다
  const [changed, setChanged] = useState<{ version: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);

  const version = changed ? changed.version : initialVersion;
  const owner: ProfilePhotoOwner = { kind: target === "student" ? "student" : "user", id: ownerId };
  const hasPhoto = Boolean(version);

  async function upload(file: File) {
    setBusy(true);
    setConfirming(false);
    setStatus({ text: "사진을 줄이는 중이에요…", tone: "info" });
    try {
      // 긴 변 1024px·약 0.8MB 로 먼저 줄인다(서버가 512px 정사각형으로 다시 만든다)
      const compressed = await compressImageForUpload(file, {
        maxEdge: 1024,
        targetBytes: 800 * 1024,
        allowedTypes: SESSION_IMAGE_ALLOWED_TYPES,
      }).catch((error: unknown) => {
        // 휴대폰 전용 형식(HEIC 등)·읽지 못한 파일 — 쉬운 말로 다시 안내
        throw new Error(error instanceof Error && /25MB|너무 큽니다/.test(error.message) ? error.message : "사진은 JPG, PNG, WebP 만 올릴 수 있어요.");
      });
      const problem = profilePhotoUploadProblem({ type: compressed.type, size: compressed.size });
      if (problem) throw new Error(problem);

      setStatus({ text: "사진을 올리는 중이에요…", tone: "info" });
      const form = new FormData();
      form.set("target", target);
      if (target === "student" && studentId) form.set("studentId", studentId);
      form.set("file", compressed);
      const response = await fetch("/api/mypage/profile-photo", { method: "POST", body: form }).catch(() => null);
      if (!response) throw new Error("보내지 못했어요. 인터넷 연결을 확인하고 다시 시도해 주세요.");
      const result = (await response.json().catch(() => null)) as { ok?: boolean; version?: string | null; error?: string } | null;
      if (!response.ok || !result?.ok) throw new Error(result?.error || "사진을 올리지 못했어요. 잠시 뒤 다시 시도해 주세요.");

      setChanged({ version: result.version ?? null });
      setStatus({ text: "사진을 올렸어요.", tone: "ok" });
      router.refresh(); // 제목·칩의 사진도 새로 그린다
    } catch (error) {
      setStatus({ text: error instanceof Error ? error.message : "사진을 올리지 못했어요.", tone: "error" });
    } finally {
      setBusy(false);
      // 같은 파일을 다시 골라도 반응하게 입력칸을 비운다
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  async function remove() {
    setBusy(true);
    setStatus({ text: "사진을 지우는 중이에요…", tone: "info" });
    try {
      const query = new URLSearchParams({ target });
      if (target === "student" && studentId) query.set("studentId", studentId);
      const response = await fetch(`/api/mypage/profile-photo?${query.toString()}`, { method: "DELETE" }).catch(() => null);
      if (!response) throw new Error("보내지 못했어요. 인터넷 연결을 확인하고 다시 시도해 주세요.");
      const result = (await response.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      if (!response.ok || !result?.ok) throw new Error(result?.error || "사진을 지우지 못했어요. 잠시 뒤 다시 시도해 주세요.");

      setChanged({ version: null });
      setStatus({ text: "사진을 지웠어요.", tone: "ok" });
      router.refresh();
    } catch (error) {
      setStatus({ text: error instanceof Error ? error.message : "사진을 지우지 못했어요.", tone: "error" });
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  return (
    <div className="px-3 py-2">
      <div className="flex items-center gap-3">
        {/* 64px 는 128px 사진으로 충분하다(2배 화면 기준) */}
        <ProfileAvatar name={name} src={profilePhotoUrl(owner, version, true)} size={64} />
        <div className="min-w-0 flex-1">
          {/* 파일 고르기 — 화면에는 글자 버튼만 보이고, 실제 입력칸은 숨긴다 */}
          <input
            ref={inputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            className="sr-only"
            tabIndex={-1}
            aria-hidden="true"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void upload(file);
            }}
          />
          {confirming ? (
            // 지우기 확인 — 그 자리에서 한 번 더 묻는다
            <div role="group" aria-label="사진 지우기 확인" className="flex flex-wrap items-center gap-2">
              <span className="text-sm text-[var(--color-academy-ink)]">사진을 지울까요?</span>
              <button type="button" onClick={() => void remove()} disabled={busy} className="academy-button-danger min-h-11!">
                {busy ? "지우는 중" : "지우기"}
              </button>
              <button type="button" onClick={() => setConfirming(false)} disabled={busy} className="academy-button-secondary min-h-11!">
                취소
              </button>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" onClick={() => inputRef.current?.click()} disabled={busy} className="academy-button-secondary min-h-11!">
                {busy ? "올리는 중" : hasPhoto ? "사진 바꾸기" : "사진 올리기"}
              </button>
              {hasPhoto && (
                <button type="button" onClick={() => { setConfirming(true); setStatus(null); }} disabled={busy} className="academy-button-text min-h-11!">
                  사진 지우기
                </button>
              )}
            </div>
          )}
        </div>
      </div>
      {status && (
        <p role={status.tone === "error" ? "alert" : "status"} className={`mt-1 text-xs font-medium ${TONE_CLASS[status.tone]}`}>
          {status.text}
        </p>
      )}
      <p className="mt-1 break-keep text-xs text-[var(--color-academy-muted)]">{PROFILE_PHOTO_NOTICE}</p>
    </div>
  );
}
