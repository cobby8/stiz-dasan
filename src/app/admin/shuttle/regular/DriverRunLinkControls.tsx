"use client";

import { useState } from "react";
import { useAdminConfirm } from "@/components/admin/AdminConfirmDialog";
import { adminErrorText } from "@/components/admin/adminDisplayText";

/**
 * 기사님 운행 링크(문자 주소) 관리 — 셔틀 명단 화면 위에 한 줄로 작게.
 *
 * - 스위치 «운행 링크(문자 주소) 사용»: 끄면 토큰 주소로는 운행표가 안 열린다(서버가 막음).
 *   기사님이 앱 계정으로 기사님 역할을 받은 뒤에 끈다. 계정 로그인 운행표는 계속 열린다.
 * - «링크 새로 만들기»: 이전 주소를 즉시 무효로(퇴사한 기사님 등). 새 주소는 «기사님 운행 링크 복사»로 다시 받는다.
 * 두 작업 모두 확인 창을 거친다(관리자 공용 확인 창).
 */
export default function DriverRunLinkControls({ initialEnabled }: { initialEnabled: boolean }) {
  const [enabled, setEnabled] = useState(initialEnabled);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const { confirm, confirmDialog } = useAdminConfirm();

  // 서버 응답의 error 문구를 그대로 보여 준다(없으면 기본 문구).
  async function send(method: "PATCH" | "POST", body: unknown, fallback: string) {
    const response = await fetch("/api/admin/shuttle/driver-link", {
      method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const result = await response.json().catch(() => null) as { error?: string; enabled?: boolean; rotated?: number } | null;
    if (!response.ok) throw new Error(result?.error || fallback);
    return result ?? {};
  }

  async function toggle() {
    const next = !enabled;
    const ok = await confirm(next
      ? { title: "운행 링크(문자 주소)를 다시 켤까요?", description: "켜면 문자로 보낸 주소만으로 누구나 운행표(원생 명단·연락처)를 볼 수 있습니다.", confirmLabel: "켜기", tone: "primary" }
      : {
        title: "운행 링크(문자 주소)를 끌까요?",
        description: "끄면 문자로 보낸 주소로는 운행표가 열리지 않습니다.\n기사님은 앱에서 로그인해야 운행표를 볼 수 있습니다.\n먼저 기사님 계정에 기사님 역할을 승인했는지 확인해 주세요.",
        confirmLabel: "끄기",
        acknowledgeLabel: "기사님 계정 승인을 확인했습니다",
      });
    if (!ok) return;
    setBusy(true); setErr(null); setMsg(null);
    try {
      const result = await send("PATCH", { enabled: next }, "스위치를 바꾸지 못했습니다.");
      setEnabled(result.enabled === true);
      setMsg(result.enabled ? "운행 링크를 켰습니다." : "운행 링크를 껐습니다. 이제 로그인한 기사님만 운행표를 봅니다.");
    } catch (e) {
      setErr(adminErrorText(e, "스위치를 바꾸지 못했습니다."));
    } finally { setBusy(false); }
  }

  async function rotate() {
    const ok = await confirm({
      title: "운행 링크를 새로 만들까요?",
      description: "지금까지 보낸 운행 주소는 모두 바로 못 쓰게 됩니다(특강 날짜별 주소 포함).\n운행 중인 기사님 앱의 위치 전송도 끊깁니다.\n열어 둔 기사님 화면은 새로고침이 필요합니다.\n새 주소는 «기사님 운행 링크 복사»로 받아 기사님께 다시 보내 주세요.",
      confirmLabel: "새로 만들기",
      acknowledgeLabel: "이전 주소가 바로 막히는 것을 확인했습니다",
    });
    if (!ok) return;
    setBusy(true); setErr(null); setMsg(null);
    try {
      await send("POST", { action: "rotate" }, "링크를 새로 만들지 못했습니다.");
      setMsg("운행 링크를 새로 만들었습니다. 이전 주소는 더 이상 열리지 않습니다.");
    } catch (e) {
      setErr(adminErrorText(e, "링크를 새로 만들지 못했습니다."));
    } finally { setBusy(false); }
  }

  return (
    <section aria-label="기사님 운행 링크 관리" className="mb-3 rounded-xl border border-[var(--color-academy-line)] bg-white px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="material-symbols-outlined text-lg text-[var(--color-academy-muted)]" aria-hidden="true">link</span>
        <span className="text-sm font-black text-[var(--color-academy-ink)]">운행 링크(문자 주소) 사용</span>
        {/* 스위치 — role=switch 로 화면읽기에서도 켜짐/꺼짐을 읽는다. 터치 44px */}
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          disabled={busy}
          onClick={() => void toggle()}
          className={`inline-flex min-h-11 items-center gap-1 rounded-lg px-3 text-sm font-black ${enabled ? "bg-[var(--color-academy-success-soft)] text-[var(--color-academy-success)]" : "bg-[var(--color-academy-soft)] text-[var(--color-academy-muted)]"}`}
        >
          <span className="material-symbols-outlined text-lg" aria-hidden="true">{enabled ? "toggle_on" : "toggle_off"}</span>
          {enabled ? "켜짐" : "꺼짐"}
        </button>
        <button type="button" disabled={busy} onClick={() => void rotate()} className="academy-button-danger inline-flex min-h-11 items-center gap-1 rounded-lg px-3 text-sm font-black">
          <span className="material-symbols-outlined text-lg" aria-hidden="true">autorenew</span>링크 새로 만들기
        </button>
        <span className="text-xs text-[var(--color-academy-muted)]">
          {enabled ? "기사님 계정 승인 후 끄면, 로그인한 기사님만 운행표를 봅니다." : "꺼짐 — 문자 주소로는 운행표가 열리지 않습니다."}
        </span>
      </div>
      {err && <p role="alert" className="mt-2 rounded-lg bg-[var(--color-academy-danger-soft)] px-3 py-2 text-xs font-bold text-[var(--color-academy-danger)]">{err}</p>}
      {msg && <p className="mt-2 rounded-lg bg-[var(--color-academy-success-soft)] px-3 py-2 text-xs font-bold text-[var(--color-academy-success)]">{msg}</p>}
      {confirmDialog}
    </section>
  );
}
