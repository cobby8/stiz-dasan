"use client";
import { adminMessageText } from "@/components/admin/adminDisplayText";

import { useCallback, useEffect, useRef, useState } from "react";
import type { DriverRequestRow } from "@/app/api/admin/driver-requests/route";
import { REQUEST_TONE, statusBadgeClass } from "@/lib/ui/statusTones";

const TYPE_LABEL: Record<string, string> = {
  REMOVE: "학생 제외", LOCATION: "주소 변경", ORDER: "순서 고정", OTHER: "기타",
};
const TYPE_COLOR: Record<string, string> = {
  REMOVE: "bg-[var(--color-academy-danger-soft)] text-[var(--color-academy-danger)]",
  LOCATION: "bg-[var(--color-academy-soft)] text-[var(--color-academy-muted)]",
  ORDER: "bg-[var(--color-academy-warning-soft)] text-[var(--color-academy-warning)]",
  OTHER: "bg-[var(--color-academy-soft)] text-[var(--color-academy-muted)]",
};
const STATUS_LABEL: Record<string, string> = { PENDING: "대기", APPROVED: "승인", REJECTED: "거절" };
// 상태색은 공용 지도(statusTones) — 대기 주의 · 승인 정상 · 거절 위험
const STATUS_COLOR: Record<string, string> = {
  PENDING: statusBadgeClass(REQUEST_TONE.PENDING),
  APPROVED: statusBadgeClass(REQUEST_TONE.APPROVED),
  REJECTED: statusBadgeClass(REQUEST_TONE.REJECTED),
};

function fmtDate(iso: string) {
  return new Date(iso).toLocaleString("ko-KR", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export default function DriverRequestPanel({ onClose }: { onClose: () => void }) {
  const [requests, setRequests] = useState<DriverRequestRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [err, setErr] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/driver-requests");
      if (!res.ok) return;
      const data = await res.json() as { requests: DriverRequestRow[] };
      setRequests(data.requests);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function resolve(id: string, action: "approve" | "reject") {
    setBusy((b) => ({ ...b, [id]: true }));
    setErr("");
    try {
      const res = await fetch("/api/admin/driver-requests", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, action }),
      });
      const data = await res.json() as { error?: string };
      if (!res.ok) { setErr(adminMessageText(data.error, "처리 실패")); return; }
      await load();
    } catch {
      setErr("네트워크 오류");
    } finally {
      setBusy((b) => ({ ...b, [id]: false }));
    }
  }

  const pending = requests.filter((r) => r.status === "PENDING");
  const done = requests.filter((r) => r.status !== "PENDING");

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-lg rounded-2xl bg-white shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}>

        <div className="flex items-center justify-between border-b border-[var(--color-academy-line)] px-5 py-4">
          <div>
            <h2 className="text-[17px] font-bold text-[var(--color-academy-ink)]">
              📥 기사 요청 수신함
              {pending.length > 0 && (
                <span className="ml-2 rounded-full bg-[var(--color-academy-danger)] px-2 py-0.5 text-[12px] font-bold text-white">
                  {pending.length}
                </span>
              )}
            </h2>
            <p className="text-[12px] text-[var(--color-academy-faint)] mt-0.5">최근 7일 · 승인 시 자동 처리됩니다</p>
          </div>
          <button type="button" onClick={onClose} className="text-[22px] text-[var(--color-academy-faint)] hover:text-[var(--color-academy-muted)]">✕</button>
        </div>

        <div className="max-h-[65vh] overflow-y-auto p-4 space-y-3">
          {loading && <p className="py-8 text-center text-sm text-[var(--color-academy-faint)]">불러오는 중…</p>}
          {!loading && requests.length === 0 && (
            <p className="py-8 text-center text-[15px] font-bold text-[var(--color-academy-faint)]">접수된 요청이 없습니다</p>
          )}

          {err && <p className="rounded-xl bg-[var(--color-academy-danger-soft)] px-4 py-3 text-sm font-bold text-[var(--color-academy-danger)]">{err}</p>}

          {/* 대기 중 요청 */}
          {pending.map((req) => (
            <div key={req.id} className="rounded-xl border-2 border-[var(--color-academy-warning)] bg-[var(--color-academy-warning-soft)] p-4">
              <div className="flex items-start gap-2 mb-2">
                <span className={`shrink-0 rounded-md px-2 py-0.5 text-[12px] font-bold ${TYPE_COLOR[req.type] ?? "bg-[var(--color-academy-soft)] text-[var(--color-academy-muted)]"}`}>
                  {TYPE_LABEL[req.type] ?? req.type}
                </span>
                {req.targetName && (
                  <span className="text-[14px] font-bold text-[var(--color-academy-ink)]">{req.targetName}</span>
                )}
                <span className="ml-auto shrink-0 text-[11px] text-[var(--color-academy-faint)]">{fmtDate(req.createdAt)}</span>
              </div>
              <p className="text-[12px] text-[var(--color-academy-muted)] mb-1">운행일: {req.serviceDate}</p>
              {req.note && (
                <p className="rounded-lg bg-white px-3 py-2 text-[13px] font-semibold text-[var(--color-academy-ink)] mb-3">
                  &quot;{req.note}&quot;
                </p>
              )}
              {req.type === "ORDER" && (
                <p className="text-[12px] text-[var(--color-academy-faint)] mb-3">변경할 운행 순서가 첨부되었습니다.</p>
              )}
              <div className="flex gap-2">
                <button type="button" disabled={busy[req.id]}
                  onClick={() => resolve(req.id, "approve")}
                  className="flex-1 h-11 rounded-xl bg-[var(--color-academy-primary)] text-[15px] font-bold text-[var(--color-academy-on-primary)] disabled:opacity-60 active:bg-[var(--color-academy-primary-hover)]">
                  {busy[req.id] ? "처리 중…" : "✅ 승인"}
                </button>
                <button type="button" disabled={busy[req.id]}
                  onClick={() => resolve(req.id, "reject")}
                  className="h-11 min-w-[80px] rounded-xl border-2 border-[var(--color-academy-line-input)] text-[15px] font-bold text-[var(--color-academy-muted)] disabled:opacity-60">
                  ❌ 거절
                </button>
              </div>
            </div>
          ))}

          {/* 처리 완료 요청 */}
          {done.length > 0 && (
            <details className="mt-2">
              <summary className="cursor-pointer text-[13px] font-bold text-[var(--color-academy-faint)] hover:text-[var(--color-academy-muted)]">
                처리 완료 {done.length}건 보기
              </summary>
              <div className="mt-2 space-y-2">
                {done.map((req) => (
                  <div key={req.id} className="rounded-xl border border-[var(--color-academy-line)] p-3 opacity-70">
                    <div className="flex items-center gap-2">
                      <span className={`rounded-md px-2 py-0.5 text-[11px] font-bold ${TYPE_COLOR[req.type] ?? "bg-[var(--color-academy-soft)] text-[var(--color-academy-muted)]"}`}>
                        {TYPE_LABEL[req.type] ?? req.type}
                      </span>
                      <span className="text-[13px] font-semibold text-[var(--color-academy-muted)]">
                        {req.targetName ?? "-"}
                      </span>
                      <span className={`ml-auto rounded px-2 py-0.5 text-[11px] font-bold ${STATUS_COLOR[req.status] ?? ""}`}>
                        {STATUS_LABEL[req.status] ?? req.status}
                      </span>
                    </div>
                    {req.note && <p className="mt-1 text-[12px] text-[var(--color-academy-faint)]">&quot;{req.note}&quot;</p>}
                  </div>
                ))}
              </div>
            </details>
          )}
        </div>
      </div>
    </div>
  );
}
