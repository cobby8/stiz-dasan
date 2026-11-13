"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { DriverLocationRow } from "@/app/api/admin/driver-locations/route";

// 관리자 — 실시간 차량 위치 패널. 30초마다 자동 갱신.

function elapsedLabel(sec: number): string {
  if (sec < 60) return `${sec}초 전`;
  if (sec < 3600) return `${Math.floor(sec / 60)}분 전`;
  return `${Math.floor(sec / 3600)}시간 전`;
}

function kakaoMapUrl(label: string | null, lat: number, lng: number): string {
  const name = encodeURIComponent(label ?? "차량 위치");
  return `https://map.kakao.com/link/map/${name},${lat},${lng}`;
}

function StatusDot({ sharing, secondsAgo }: { sharing: boolean; secondsAgo: number }) {
  if (!sharing) return <span className="h-3 w-3 rounded-full bg-[var(--color-academy-line-input)] shrink-0" title="공유 중단" />;
  if (secondsAgo < 30) return <span className="h-3 w-3 rounded-full bg-[var(--color-academy-success)] shrink-0" title="최근 위치 수신" />;
  if (secondsAgo < 120) return <span className="h-3 w-3 rounded-full bg-[var(--color-academy-warning)] shrink-0" title="지연" />;
  return <span className="h-3 w-3 rounded-full bg-[var(--color-academy-danger)] shrink-0" title="끊김" />;
}

export default function DriverLocationPanel({ onClose }: { onClose: () => void }) {
  const [locations, setLocations] = useState<DriverLocationRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const [error, setError] = useState(false);
  const [clock, setClock] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/driver-locations", { cache: "no-store" });
      if (!res.ok) throw new Error("조회 실패");
      const data = await res.json() as { locations: DriverLocationRow[] };
      if (!Array.isArray(data.locations)) throw new Error("응답 오류");
      setLocations(data.locations);
      setLastRefresh(new Date());
      setClock(Date.now());
      setError(false);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    timerRef.current = setInterval(() => void load(), 30_000);
    const clockTimer = setInterval(() => setClock(Date.now()), 1000);
    return () => { if (timerRef.current) clearInterval(timerRef.current); clearInterval(clockTimer); };
  }, [load]);

  // 조회 실패 중에도 시간은 흐른다. 마지막 성공 자료가 계속 '실시간'처럼 보이지 않게 한다.
  const elapsed = lastRefresh ? Math.max(0, Math.floor((clock - lastRefresh.getTime()) / 1000)) : 0;
  const visibleLocations = locations.map((loc) => ({ ...loc, secondsAgo: Math.max(0, loc.secondsAgo) + elapsed }));
  const activeCount = visibleLocations.filter((l) => l.sharing && l.secondsAgo < 120).length;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="w-full max-w-md rounded-2xl bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 헤더 */}
        <div className="flex items-center justify-between border-b border-[var(--color-academy-line)] px-5 py-4">
          <div>
            <h2 className="text-[17px] font-bold text-[var(--color-academy-ink)]">
              🚌 차량 마지막 위치
            </h2>
            {lastRefresh && (
              <p className="text-[12px] text-[var(--color-academy-faint)] mt-0.5">
                30초마다 자동 갱신 · 마지막: {lastRefresh.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
              </p>
            )}
          </div>
          <button type="button" onClick={onClose} className="text-[22px] text-[var(--color-academy-faint)] hover:text-[var(--color-academy-muted)]">✕</button>
        </div>

        {/* 본문 */}
        <div className="max-h-[60vh] overflow-y-auto p-4 space-y-3">
          {error && <div role="alert" className="rounded-lg border border-[var(--color-academy-warning)] bg-[var(--color-academy-warning-soft)] p-3 text-sm">
            위치 조회에 실패했습니다. {locations.length > 0 ? "마지막으로 확인한 위치입니다." : "현재 위치를 확인할 수 없습니다."}
            <button type="button" onClick={() => void load()} className="ml-2 min-h-11 underline">다시 확인</button>
          </div>}
          {loading && (
            <p className="py-8 text-center text-sm text-[var(--color-academy-faint)]">불러오는 중…</p>
          )}
          {!loading && !error && locations.length === 0 && (
            <div className="py-8 text-center">
              <p className="text-[15px] font-bold text-[var(--color-academy-muted)]">현재 위치를 공유 중인 기사님이 없습니다</p>
              <p className="mt-1 text-[13px] text-[var(--color-academy-faint)]">기사님 화면에서 위치 공유를 켜면 여기에 표시됩니다</p>
            </div>
          )}
          {visibleLocations.map((loc) => (
            <div
              key={loc.token}
              className={`rounded-xl border-2 p-4 ${
                !loc.sharing ? "border-[var(--color-academy-line)] bg-[var(--color-academy-soft)]" :
                loc.secondsAgo < 120 ? "border-[var(--color-academy-success)] bg-[var(--color-academy-success-soft)]" :
                "border-[var(--color-academy-warning)] bg-[var(--color-academy-warning-soft)]"
              }`}
            >
              <div className="flex items-start gap-3">
                <StatusDot sharing={loc.sharing} secondsAgo={loc.secondsAgo} />
                <div className="min-w-0 flex-1">
                  <p className="text-[15px] font-bold text-[var(--color-academy-ink)]">
                    {loc.label ?? "기사님"}
                  </p>
                  <p className="text-[13px] text-[var(--color-academy-muted)]">
                    {loc.sharing
                      ? `마지막 위치 수신 ${elapsedLabel(loc.secondsAgo)}${loc.accuracy != null ? ` · 정확도 ${Math.round(loc.accuracy)}m` : ""}${loc.secondsAgo >= 120 ? " · 위치 확인 필요" : ""}`
                      : "위치 공유 중단"}
                  </p>
                </div>
                {loc.sharing && (
                  <a
                    href={kakaoMapUrl(loc.label, loc.latitude, loc.longitude)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="shrink-0 rounded-lg bg-[var(--color-academy-primary-soft)] px-3 py-2 text-[13px] font-bold text-[var(--color-academy-ink)] hover:bg-[var(--color-academy-line)]"
                  >
                    지도↗
                  </a>
                )}
              </div>
            </div>
          ))}
        </div>

        {/* 하단 요약 */}
        {!loading && locations.length > 0 && (
          <div className="border-t border-[var(--color-academy-line)] px-5 py-3 text-[13px] text-[var(--color-academy-muted)]">
            최근 2분 내 접수 {activeCount}대 · 조회된 차량 {locations.length}대
          </div>
        )}
      </div>
    </div>
  );
}
