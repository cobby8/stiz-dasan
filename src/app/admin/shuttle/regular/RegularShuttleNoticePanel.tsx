"use client";
import { useState } from "react";
import { adminErrorText } from "@/components/admin/adminDisplayText";

type Preview = { status: string; payloadHash: string; studentName: string; recipientLast4: string; messageBody: string };
const BUTTON = "min-h-11 rounded-lg border border-[var(--color-academy-line)] px-3 py-2 text-sm font-bold disabled:opacity-50";
export default function RegularShuttleNoticePanel({ studentId, serviceMonth, compareMonth }: { studentId: string; serviceMonth: string; compareMonth: string }) {
  const [preview,setPreview] = useState<Preview | null>(null);
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState("");
  async function act(action: "PREPARE" | "APPROVE" | "SEND") {
    if (busy) return;
    if (action === "SEND" && (!preview || !window.confirm(`${preview.studentName} 학생 보호자(끝자리 ${preview.recipientLast4})에게 아래 문구를 발송할까요?\n\n${preview.messageBody}`))) return;
    setBusy(true);setError("");
    try {
      const response = await fetch("/api/admin/shuttle/regular-notice", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, serviceMonth, compareMonth, change: { key: `student:${studentId}` }, payloadHash: preview?.payloadHash }) });
      const value = await response.json().catch(() => null);
      if (!response.ok || !value?.ok) throw new Error(value?.error || "안내를 처리하지 못했습니다. 다시 확인해 주세요.");
      setPreview(value);
    } catch (e) { setError(adminErrorText(e, "안내를 처리하지 못했습니다. 다시 확인해 주세요.")); setPreview(null); }
    finally { setBusy(false); }
  }
  return <section className="mt-4 space-y-3 border-t border-[var(--color-academy-line)] pt-3 text-sm text-[var(--color-academy-ink)]" aria-label="확정 차량 일정 안내">
    <button type="button" className={BUTTON} disabled={busy} onClick={() => void act("PREPARE")}>{busy ? "확인 중…" : "확정 차량 일정 안내 준비"}</button>
    {error && <p role="alert" className="break-words">{error}</p>}
    {preview && <div className="space-y-3 rounded-lg bg-[var(--color-academy-soft)] p-3">
      <p className="font-bold">{preview.studentName} · 보호자 끝자리 {preview.recipientLast4}</p>
      <p className="whitespace-pre-wrap break-words">{preview.messageBody}</p>
      <p className="text-xs text-[var(--color-academy-muted)]">{preview.status === "SENT" ? "발송 접수됐습니다. 최종 전달 결과는 신청 상세에서 확인해 주세요." : preview.status === "UNCERTAIN" ? "발송 결과를 확정하지 못했습니다. 다시 보내지 말고 문자 이력을 확인해 주세요." : preview.status === "APPROVED" ? "문구가 승인됐습니다. 발송 버튼을 누르기 전에는 문자가 나가지 않습니다." : "아직 발송하지 않았습니다. 수신자와 문구를 확인해 주세요."}</p>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={BUTTON} disabled={busy} onClick={() => setPreview(null)}>닫기</button>
        {preview.status === "HELD" && <button type="button" className={BUTTON} disabled={busy} onClick={() => void act("APPROVE")}>수신자·문구 확인 후 승인</button>}
        {preview.status === "APPROVED" && <button type="button" className={BUTTON} disabled={busy} onClick={() => void act("SEND")}>보호자에게 문자 발송</button>}
      </div>
    </div>}
  </section>;
}
