"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { DriverRequestRow } from "@/app/api/admin/driver-requests/route";

const TYPE_LABEL: Record<string, string> = {
  REMOVE: "학생 제외", LOCATION: "주소 변경", ORDER: "순서 고정", OTHER: "기타",
};
const TYPE_COLOR: Record<string, string> = {
  REMOVE: "bg-red-100 text-red-700",
  LOCATION: "bg-blue-100 text-blue-700",
  ORDER: "bg-amber-100 text-amber-800",
  OTHER: "bg-gray-100 text-gray-600",
};
const STATUS_LABEL: Record<string, string> = { PENDING: "대기", APPROVED: "승인", REJECTED: "거절" };
const STATUS_COLOR: Record<string, string> = {
  PENDING: "bg-yellow-100 text-yellow-800",
  APPROVED: "bg-green-100 text-green-700",
  REJECTED: "bg-gray-100 text-gray-500",
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
      if (!res.ok) { setErr(data.error ?? "처리 실패"); return; }
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
      <div className="w-full max-w-lg rounded-2xl bg-white shadow-2xl dark:bg-gray-900 overflow-hidden"
        onClick={(e) => e.stopPropagation()}>

        <div className="flex items-center justify-between border-b border-gray-200 px-5 py-4 dark:border-gray-700">
          <div>
            <h2 className="text-[17px] font-black text-gray-900 dark:text-white">
              📥 기사 요청 수신함
              {pending.length > 0 && (
                <span className="ml-2 rounded-full bg-red-500 px-2 py-0.5 text-[12px] font-black text-white">
                  {pending.length}
                </span>
              )}
            </h2>
            <p className="text-[12px] text-gray-400 mt-0.5">최근 7일 · 승인 시 자동 처리됩니다</p>
          </div>
          <button type="button" onClick={onClose} className="text-[22px] text-gray-400 hover:text-gray-700">✕</button>
        </div>

        <div className="max-h-[65vh] overflow-y-auto p-4 space-y-3">
          {loading && <p className="py-8 text-center text-sm text-gray-400">불러오는 중…</p>}
          {!loading && requests.length === 0 && (
            <p className="py-8 text-center text-[15px] font-bold text-gray-400">접수된 요청이 없습니다</p>
          )}

          {err && <p className="rounded-xl bg-red-50 px-4 py-3 text-sm font-bold text-red-700">{err}</p>}

          {/* 대기 중 요청 */}
          {pending.map((req) => (
            <div key={req.id} className="rounded-xl border-2 border-yellow-300 bg-yellow-50 p-4 dark:border-yellow-700 dark:bg-yellow-950/20">
              <div className="flex items-start gap-2 mb-2">
                <span className={`shrink-0 rounded-md px-2 py-0.5 text-[12px] font-black ${TYPE_COLOR[req.type] ?? "bg-gray-100 text-gray-600"}`}>
                  {TYPE_LABEL[req.type] ?? req.type}
                </span>
                {req.targetName && (
                  <span className="text-[14px] font-black text-gray-800 dark:text-white">{req.targetName}</span>
                )}
                <span className="ml-auto shrink-0 text-[11px] text-gray-400">{fmtDate(req.createdAt)}</span>
              </div>
              <p className="text-[12px] text-gray-500 dark:text-gray-400 mb-1">운행일: {req.serviceDate}</p>
              {req.note && (
                <p className="rounded-lg bg-white px-3 py-2 text-[13px] font-semibold text-gray-800 dark:bg-gray-800 dark:text-gray-200 mb-3">
                  &quot;{req.note}&quot;
                </p>
              )}
              {req.type === "ORDER" && (
                <p className="text-[12px] text-gray-400 mb-3">변경할 운행 순서가 첨부되었습니다.</p>
              )}
              <div className="flex gap-2">
                <button type="button" disabled={busy[req.id]}
                  onClick={() => resolve(req.id, "approve")}
                  className="flex-1 h-11 rounded-xl bg-green-600 text-[15px] font-black text-white disabled:opacity-60 active:bg-green-700">
                  {busy[req.id] ? "처리 중…" : "✅ 승인"}
                </button>
                <button type="button" disabled={busy[req.id]}
                  onClick={() => resolve(req.id, "reject")}
                  className="h-11 min-w-[80px] rounded-xl border-2 border-gray-300 text-[15px] font-black text-gray-600 disabled:opacity-60">
                  ❌ 거절
                </button>
              </div>
            </div>
          ))}

          {/* 처리 완료 요청 */}
          {done.length > 0 && (
            <details className="mt-2">
              <summary className="cursor-pointer text-[13px] font-bold text-gray-400 hover:text-gray-600">
                처리 완료 {done.length}건 보기
              </summary>
              <div className="mt-2 space-y-2">
                {done.map((req) => (
                  <div key={req.id} className="rounded-xl border border-gray-200 p-3 dark:border-gray-700 opacity-70">
                    <div className="flex items-center gap-2">
                      <span className={`rounded-md px-2 py-0.5 text-[11px] font-black ${TYPE_COLOR[req.type] ?? "bg-gray-100 text-gray-600"}`}>
                        {TYPE_LABEL[req.type] ?? req.type}
                      </span>
                      <span className="text-[13px] font-semibold text-gray-700 dark:text-gray-300">
                        {req.targetName ?? "-"}
                      </span>
                      <span className={`ml-auto rounded-md px-2 py-0.5 text-[11px] font-black ${STATUS_COLOR[req.status] ?? ""}`}>
                        {STATUS_LABEL[req.status] ?? req.status}
                      </span>
                    </div>
                    {req.note && <p className="mt-1 text-[12px] text-gray-400">&quot;{req.note}&quot;</p>}
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
