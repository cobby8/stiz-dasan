"use client";
import { adminErrorText } from "@/components/admin/adminDisplayText";

import { useEffect, useState } from "react";

// 셔틀 등원시간 안내 문자 — 미리보기 후 원장이 직접 발송한다.
// ★ 자동 발송은 없다. 반드시 사람이 내용을 보고 누른다(잘못 나가면 회수 불가).

type Preview = {
  requestId: string; studentName: string; phoneMasked: string; sendable: boolean;
  stopLabel: string; days: number[]; message: string; startsFrom: string | null; skipReason?: string;
};
type SendResult = { studentName: string; ok: boolean; reason?: string };

const DOW_KO = ["일", "월", "화", "수", "목", "금", "토"];

export default function ShuttleNoticeClient() {
  const [previews, setPreviews] = useState<Preview[]>([]);
  const [today, setToday] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [results, setResults] = useState<SendResult[] | null>(null);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => { void load(); }, []);

  async function load() {
    setLoading(true); setErr(null);
    try {
      const r = await fetch("/api/admin/seasonal/shuttle-notice", { cache: "no-store" });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || "불러오지 못했습니다.");
      setPreviews(j.previews ?? []); setToday(j.today ?? "");
      // 기본값: 보낼 수 있는 사람은 모두 선택.
      const init: Record<string, boolean> = {};
      for (const p of (j.previews ?? []) as Preview[]) init[p.requestId] = p.sendable;
      setChecked(init);
    } catch (e) { setErr(adminErrorText(e, "불러오지 못했습니다.")); }
    finally { setLoading(false); }
  }

  const targets = previews.filter((p) => p.sendable && checked[p.requestId]);

  async function send() {
    if (sending || targets.length === 0) return;
    setSending(true); setErr(null); setResults(null);
    try {
      const r = await fetch("/api/admin/seasonal/shuttle-notice", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestIds: targets.map((t) => t.requestId) }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || "발송에 실패했습니다.");
      setResults(j.results ?? []);
    } catch (e) { setErr(adminErrorText(e, "발송에 실패했습니다.")); }
    finally { setSending(false); setConfirming(false); }
  }

  if (loading) return <p className="p-4 text-sm text-gray-500">불러오는 중…</p>;

  return (
    <div className="space-y-4 p-1">
      <div className="rounded-xl border border-amber-300 bg-amber-50 p-3 dark:border-amber-500/40 dark:bg-amber-900/20">
        <p className="text-[13px] font-black text-amber-900 dark:text-amber-200">
          ⚠️ 실제 학부모에게 발송됩니다. 한 번 나간 문자는 취소할 수 없습니다.
        </p>
        <p className="mt-1 text-[12px] font-bold text-amber-800 dark:text-amber-300">
          학생마다 <b>따로</b> 발송되므로 다른 집 정보가 섞이지 않습니다 · 같은 날 두 번 눌러도 중복 발송되지 않습니다.
        </p>
      </div>

      {err && <p className="rounded-lg bg-red-50 p-3 text-[13px] font-bold text-red-700">{err}</p>}

      {results && (
        <div className="rounded-xl border border-gray-200 p-3">
          <p className="text-[13px] font-black">
            발송 결과 — 성공 {results.filter((r) => r.ok).length}건 / 실패 {results.filter((r) => !r.ok).length}건
          </p>
          <ul className="mt-2 space-y-1">
            {results.map((r, i) => (
              <li key={i} className={`text-[12.5px] font-bold ${r.ok ? "text-green-700" : "text-red-600"}`}>
                {r.ok ? "✅" : "❌"} {r.studentName}{r.reason ? ` — ${r.reason}` : ""}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <p className="text-[13px] font-black">
          기준일 {today} · 대상 {previews.length}명 · 선택 {targets.length}명
        </p>
        <button type="button" onClick={() => void load()} disabled={sending}
          className="rounded-lg border border-gray-300 px-2.5 py-1 text-[12px] font-black text-gray-600 disabled:opacity-50">
          🔄 새로고침
        </button>
        {!confirming ? (
          <button type="button" onClick={() => setConfirming(true)} disabled={sending || targets.length === 0}
            className="rounded-lg bg-brand-orange-500 px-3 py-1.5 text-[13px] font-black text-white disabled:opacity-40">
            📨 선택한 {targets.length}명에게 발송
          </button>
        ) : (
          <span className="flex items-center gap-2 rounded-lg bg-red-50 px-2.5 py-1.5">
            <span className="text-[12.5px] font-black text-red-700">{targets.length}명에게 지금 보냅니다. 확실합니까?</span>
            <button type="button" onClick={() => void send()} disabled={sending}
              className="rounded-lg bg-red-600 px-3 py-1 text-[12.5px] font-black text-white disabled:opacity-50">
              {sending ? "발송 중…" : "네, 발송합니다"}
            </button>
            <button type="button" onClick={() => setConfirming(false)} disabled={sending}
              className="rounded-lg border border-gray-300 px-2.5 py-1 text-[12.5px] font-black text-gray-600">취소</button>
          </span>
        )}
      </div>

      <ul className="space-y-2">
        {previews.map((p) => (
          <li key={p.requestId} className={`rounded-xl border p-3 ${p.sendable ? "border-gray-200" : "border-red-200 bg-red-50/50"}`}>
            <div className="flex items-start gap-2">
              <input type="checkbox" disabled={!p.sendable} checked={!!checked[p.requestId]}
                onChange={(e) => setChecked((c) => ({ ...c, [p.requestId]: e.target.checked }))}
                className="mt-1 h-4 w-4" />
              <div className="min-w-0 flex-1">
                <p className="text-[13.5px] font-black">
                  {p.studentName}
                  <span className="ml-2 font-bold text-gray-500">{p.phoneMasked}</span>
                  <span className="ml-2 font-bold text-gray-400">
                    {p.days.map((d) => DOW_KO[d]).join("·")} · {p.stopLabel}
                  </span>
                  {p.startsFrom && <span className="ml-2 rounded bg-blue-100 px-1.5 py-0.5 text-[11px] font-black text-blue-700">{p.startsFrom}부터</span>}
                </p>
                {p.skipReason
                  ? <p className="mt-1 text-[12px] font-black text-red-600">발송 제외 — {p.skipReason}</p>
                  : <pre className="mt-1.5 whitespace-pre-wrap rounded-lg bg-gray-50 p-2 text-[12px] leading-relaxed text-gray-700 dark:bg-gray-800 dark:text-gray-200">{p.message}</pre>}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
