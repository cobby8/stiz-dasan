"use client";

import { useEffect, useRef, useState } from "react";
import { loadKakaoMaps, type KakaoSdk, type KakaoMapObj, type KakaoOverlay } from "@/lib/kakao/loadKakaoMaps";

// 배차 노선을 지도로 보여준다(인라인 패널). 지도는 한 번만 만들고, 정차/순서가 바뀌면 마커·선만 다시 그린다
// → 순서를 바꾸면 실시간으로 반영된다. path(T맵 실도로 경로)가 있으면 그 선을, 없으면 정차를 직선으로 잇는다.

export type RouteMapStop = { lat: number; lng: number; label: string; badge: string; kind: "stop" | "hub" };
type Endpoint = { lat: number; lng: number; label: string } | null;

export function RouteMapCanvas({
  start, end, stops, path, heightClass = "h-[420px]",
}: {
  start: Endpoint;
  end: Endpoint;
  stops: RouteMapStop[];
  path?: { lat: number; lng: number }[];
  heightClass?: string;
}) {
  const mapElRef = useRef<HTMLDivElement>(null);
  const sdkRef = useRef<KakaoSdk | null>(null);
  const mapRef = useRef<KakaoMapObj | null>(null);
  const overlaysRef = useRef<KakaoOverlay[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "fallback">("loading");
  const apiKey = process.env.NEXT_PUBLIC_KAKAO_MAP_JS_KEY?.trim();

  // 최신 데이터를 ref로 들고 있어 draw()가 항상 현재 값으로 그린다(로딩 중 변경돼도 안전).
  const dataRef = useRef({ start, end, stops, path });
  dataRef.current = { start, end, stops, path };

  function draw() {
    const sdk = sdkRef.current, map = mapRef.current;
    if (!sdk || !map) return;
    const maps = sdk.maps;
    const { start: s, end: e, stops: st, path: p } = dataRef.current;
    overlaysRef.current.forEach((o) => { try { o.setMap(null); } catch { /* noop */ } });
    overlaysRef.current = [];
    // 지도 선 색 = 정보 토큰의 실제 값(카카오 Polyline 은 SVG 속성이라 var() 를 못 읽는다). 상태 토큰은 :root 에 있다.
    const lineColor = getComputedStyle(document.documentElement).getPropertyValue("--color-academy-info").trim() || "rgb(29, 78, 216)";
    const nodes = [
      ...(s ? [{ ...s, badge: "출발", kind: "start" as const }] : []),
      ...st.map((x) => ({ ...x })),
      ...(e ? [{ ...e, badge: "도착", kind: "end" as const }] : []),
    ];
    if (nodes.length === 0) return;
    const lineCoords = (p && p.length ? p : nodes.map((n) => ({ lat: n.lat, lng: n.lng }))).map((c) => new maps.LatLng(c.lat, c.lng));
    overlaysRef.current.push(new maps.Polyline({
      path: lineCoords, strokeWeight: 5, strokeColor: lineColor, strokeOpacity: 0.85,
      strokeStyle: p && p.length ? "solid" : "shortdash", map,
    }));
    const bounds = new maps.LatLngBounds();
    for (const n of nodes) {
      const pos = new maps.LatLng(n.lat, n.lng);
      bounds.extend(pos);
      const color = n.kind === "hub" ? "var(--color-academy-success)" : n.kind === "start" || n.kind === "end" ? "var(--color-academy-neutral)" : "var(--color-academy-primary)";
      const el = document.createElement("div");
      el.style.cssText = "transform:translateY(-50%);display:flex;align-items:center;gap:4px;";
      el.innerHTML =
        `<span style="display:grid;place-items:center;min-width:22px;height:22px;padding:0 5px;border-radius:11px;background:${color};color:var(--color-academy-on-primary);font-size:11px;font-weight:800;border:2px solid var(--color-academy-surface);box-shadow:0 1px 3px rgba(0,0,0,.3)">${escapeHtml(n.badge)}</span>` +
        `<span style="max-width:140px;background:var(--color-academy-surface);border:1px solid var(--color-academy-line);border-radius:6px;padding:1px 5px;font-size:11px;font-weight:700;color:var(--color-academy-ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;box-shadow:0 1px 2px rgba(0,0,0,.15)">${escapeHtml(n.label)}</span>`;
      const overlay = new maps.CustomOverlay({ position: pos, content: el, yAnchor: 0.5, xAnchor: 0, zIndex: 5 });
      overlay.setMap(map);
      overlaysRef.current.push(overlay);
    }
    map.setBounds(bounds, 30, 30, 30, 30);
  }

  // 지도 1회 생성
  useEffect(() => {
    if (!apiKey || !mapElRef.current) { setStatus("fallback"); return; }
    let cancelled = false;
    loadKakaoMaps(apiKey).then((sdk) => {
      if (cancelled || !mapElRef.current) return;
      sdkRef.current = sdk;
      mapRef.current = new sdk.maps.Map(mapElRef.current, { center: new sdk.maps.LatLng(37.62, 127.15), level: 5 });
      setStatus("ready");
      window.setTimeout(() => { mapRef.current?.relayout(); draw(); }, 0);
    }).catch(() => { if (!cancelled) setStatus("fallback"); });
    return () => {
      cancelled = true;
      overlaysRef.current.forEach((o) => { try { o.setMap(null); } catch { /* noop */ } });
      overlaysRef.current = [];
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKey]);

  // 정차/순서/경로가 바뀌면 다시 그린다(순서 변경 실시간 반영).
  useEffect(() => {
    draw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stops, path, start, end]);

  return (
    <div>
      <div className={`relative ${heightClass} w-full bg-[var(--color-academy-soft)]`}>
        <div ref={mapElRef} className="absolute inset-0" aria-label="노선 지도" />
        {status === "loading" && <div className="absolute inset-0 grid place-items-center text-sm font-bold text-[var(--color-academy-muted)]">지도를 불러오는 중…</div>}
        {status === "fallback" && (
          <div className="absolute inset-0 grid place-items-center p-4 text-center text-xs font-bold text-[var(--color-academy-muted)]">
            지도를 표시할 수 없습니다. 카카오 지도 키를 확인해주세요.
          </div>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-[var(--color-academy-line)] px-3 py-2 text-[11px] font-bold text-[var(--color-academy-muted)]">
        <span><span className="mr-1 inline-block h-2.5 w-2.5 rounded-full align-middle" style={{ background: "var(--color-academy-neutral)" }} />출발·도착</span>
        <span><span className="mr-1 inline-block h-2.5 w-2.5 rounded-full align-middle" style={{ background: "var(--color-academy-primary)" }} />정차 순서</span>
        <span><span className="mr-1 inline-block h-2.5 w-2.5 rounded-full align-middle" style={{ background: "var(--color-academy-success)" }} />무료 거점</span>
        <span className="ml-auto">{path && path.length ? "파란 선 = T맵 실도로" : "점선 = 현재 순서"}</span>
      </div>
    </div>
  );
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}
