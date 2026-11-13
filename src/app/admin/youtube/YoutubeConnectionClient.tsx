"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useAdminConfirm } from "@/components/admin/AdminConfirmDialog";

type ConnectionView = {
  channelId: string;
  channelTitle: string | null;
  connectedAt: string;
  lastError: string | null;
  lastErrorAt: string | null;
  quotaText: string;
};

/** 대기 현황 표에 보일 상태 이름 */
const STATUS_LABELS: Array<[string, string]> = [
  ["PENDING", "유튜브 대기"],
  ["UPLOADING", "올리는 중"],
  ["UPLOADED", "일부공개 완료"],
  ["PRIVATE_LOCKED", "비공개로 잠김(심사 전)"],
  ["FAILED", "실패"],
];

/**
 * 유튜브 연결 화면의 버튼·상태 칸.
 * 연결은 구글 동의 화면을 거쳐야 해서 «링크 이동»(/api/admin/youtube/connect)으로, 해제·다시 시도는 POST 로 한다.
 */
export default function YoutubeConnectionClient({
  configReady,
  missingEnv,
  redirectUri,
  connection,
  summary,
  resultMessage,
  resultIsError,
}: {
  configReady: boolean;
  missingEnv: string[];
  redirectUri: string;
  connection: ConnectionView | null;
  summary: Record<string, number>;
  resultMessage: string | null;
  resultIsError: boolean;
}) {
  const router = useRouter();
  const { confirm, confirmDialog } = useAdminConfirm();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const lockedCount = (summary.PRIVATE_LOCKED ?? 0) + (summary.FAILED ?? 0);

  async function post(path: string, done: string) {
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch(path, { method: "POST" });
      const body = await response.json().catch(() => ({})) as { error?: string; count?: number };
      // 서버가 보낸 안내 문장(한국어)만 보인다 — 오류 원문은 띄우지 않는다
      if (!response.ok) {
        setMessage(body.error || "요청을 처리하지 못했습니다. 잠시 뒤 다시 시도해 주세요.");
        return;
      }
      setMessage(typeof body.count === "number" ? `${done} (${body.count}건)` : done);
      router.refresh();
    } catch {
      setMessage("요청을 처리하지 못했습니다. 네트워크를 확인한 뒤 다시 시도해 주세요.");
    } finally {
      setBusy(false);
    }
  }

  async function handleDisconnect() {
    const ok = await confirm({
      title: "유튜브 연결 해제",
      description: "새 수업 영상이 유튜브로 옮겨지지 않습니다(학부모는 사이트 사본으로 계속 봅니다). 이미 올라간 영상은 지우지 않습니다.",
      confirmLabel: "연결 해제",
      tone: "danger",
    });
    if (ok) await post("/api/admin/youtube/disconnect", "유튜브 연결을 해제했습니다.");
  }

  async function handleRetry() {
    const ok = await confirm({
      title: "유튜브로 다시 시도",
      description: "구글 심사를 통과한 뒤에 눌러 주세요. 비공개로 잠긴 영상은 일부공개로 바꾸고, 실패한 영상은 다시 올립니다(15분 안에 시작).",
      confirmLabel: "다시 시도",
      tone: "primary",
    });
    if (ok) await post("/api/admin/youtube/retry", "다시 시도하도록 대기열에 넣었습니다.");
  }

  return (
    <div className="space-y-3">
      {resultMessage && (
        <p
          role="status"
          className={`rounded-xl p-3 text-sm ${resultIsError
            ? "bg-[var(--color-academy-danger-soft)] text-[var(--color-academy-danger)]"
            : "bg-[var(--color-academy-success-soft)] text-[var(--color-academy-success)]"}`}
        >
          {resultMessage}
        </p>
      )}

      <section className="rounded-2xl border border-[var(--color-academy-line)] bg-white p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-[var(--color-academy-ink)]">
              {!configReady ? "설정 대기" : connection ? `연결됨 · ${connection.channelTitle || connection.channelId}` : "연결 안 됨"}
            </p>
            {connection && (
              <p className="mt-0.5 text-xs text-[var(--color-academy-muted)]">
                연결 {connection.connectedAt} · 오늘 업로드 {connection.quotaText}
              </p>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            {configReady && (
              // 구글 동의 화면으로 이동 — 다시 연결(채널 바꾸기)도 같은 버튼
              <a href="/api/admin/youtube/connect" className="academy-button-primary" aria-disabled={busy}>
                {connection ? "다시 연결" : "유튜브 연결"}
              </a>
            )}
            {connection && (
              <button type="button" disabled={busy} onClick={() => void handleDisconnect()} className="academy-button-danger">
                연결 해제
              </button>
            )}
          </div>
        </div>

        {!configReady && (
          <div className="mt-3 rounded-xl bg-[var(--color-academy-warning-soft)] p-3 text-sm text-[var(--color-academy-warning)]">
            <p className="font-medium">서버 설정이 아직 없어 연결할 수 없습니다. 아래 값을 서버 환경 설정에 넣어 주세요.</p>
            <p className="mt-1 break-all font-mono text-xs">{missingEnv.join(" · ")}</p>
          </div>
        )}

        {connection?.lastError && (
          <p className="mt-3 rounded-xl bg-[var(--color-academy-danger-soft)] p-3 text-sm text-[var(--color-academy-danger)]">
            마지막 오류{connection.lastErrorAt ? `(${connection.lastErrorAt})` : ""}: {connection.lastError}
          </p>
        )}

        <p className="mt-3 text-xs text-[var(--color-academy-muted)]">
          구글 콘솔 «승인된 리디렉션 URI»: <span className="break-all font-mono">{redirectUri}</span>
        </p>
      </section>

      <section className="rounded-2xl border border-[var(--color-academy-line)] bg-white p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="academy-section-title">수업 영상 현황</h2>
          {connection && lockedCount > 0 && (
            <button type="button" disabled={busy} onClick={() => void handleRetry()} className="academy-button-secondary">
              심사 통과 후 다시 시도 ({lockedCount})
            </button>
          )}
        </div>
        <dl className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-5">
          {STATUS_LABELS.map(([key, label]) => (
            <div key={key} className="rounded-xl bg-[var(--color-academy-soft)] px-3 py-2">
              <dt className="text-xs text-[var(--color-academy-muted)]">{label}</dt>
              <dd className="text-base font-semibold text-[var(--color-academy-ink)]">{summary[key] ?? 0}</dd>
            </div>
          ))}
        </dl>
      </section>

      {message && <p aria-live="polite" className="text-sm text-[var(--color-academy-muted)]">{message}</p>}
      {confirmDialog}
    </div>
  );
}
