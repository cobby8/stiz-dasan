"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type KakaoPlace = { x: string; y: string; place_name: string; road_address_name?: string; address_name?: string };
type KakaoLatLng = { getLat: () => number; getLng: () => number };
type KakaoMap = { setCenter: (position: KakaoLatLng) => void };
type KakaoMarker = { getPosition: () => KakaoLatLng; setPosition: (position: KakaoLatLng) => void; setMap: (map: KakaoMap | null) => void };
type KakaoSdk = { maps: {
  load: (cb: () => void) => void;
  LatLng: new (lat: number, lng: number) => KakaoLatLng;
  Map: new (element: HTMLElement, options: { center: KakaoLatLng; level: number }) => KakaoMap;
  Marker: new (options: { map: KakaoMap; position: KakaoLatLng; draggable: boolean }) => KakaoMarker;
  event: { addListener: (target: KakaoMap | KakaoMarker, event: string, cb: (mouseEvent?: { latLng: KakaoLatLng }) => void) => void };
  services: { Places: new () => { keywordSearch: (keyword: string, cb: (data: KakaoPlace[], status: string) => void) => void } };
} };
type Candidate = { placeName: string; address: string; lat: number; lng: number };

function winKakao(): KakaoSdk | undefined { return (window as unknown as { kakao?: KakaoSdk }).kakao; }
let kakaoLoader: Promise<KakaoSdk> | null = null;
function loadKakaoSdk(key: string): Promise<KakaoSdk> {
  const loaded = winKakao();
  if (loaded?.maps?.services) return Promise.resolve(loaded);
  if (kakaoLoader) return kakaoLoader;
  kakaoLoader = new Promise<KakaoSdk>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>('script[data-stiz-kakao-map="true"]');
    const ready = () => {
      const sdk = winKakao();
      if (!sdk?.maps) { kakaoLoader = null; reject(new Error("카카오 지도를 불러오지 못했습니다.")); return; }
      sdk.maps.load(() => resolve(sdk));
    };
    if (existing) { existing.addEventListener("load", ready); if (winKakao()?.maps) ready(); return; }
    const script = document.createElement("script");
    script.dataset.stizKakaoMap = "true";
    script.src = `https://dapi.kakao.com/v2/maps/sdk.js?appkey=${encodeURIComponent(key)}&autoload=false&libraries=services`;
    script.onload = ready;
    script.onerror = () => { kakaoLoader = null; reject(new Error("카카오 지도 연결에 실패했습니다.")); };
    document.head.appendChild(script);
  });
  return kakaoLoader;
}

function searchPlaces(sdk: KakaoSdk, keyword: string): Promise<Candidate[]> {
  return new Promise((resolve) => {
    new sdk.maps.services.Places().keywordSearch(keyword, (data, status) => {
      if (status !== "OK") { resolve([]); return; }
      resolve(data.slice(0, 5).flatMap((place) => {
        const lat = Number(place.y), lng = Number(place.x);
        return Number.isFinite(lat) && Number.isFinite(lng) ? [{ placeName: place.place_name, address: place.road_address_name || place.address_name || "주소 없음", lat, lng }] : [];
      }));
    });
  });
}

export default function RegularStopGeocodePanel({ stopNames, totalStopCount, initialCompletedCount }: { stopNames: string[]; totalStopCount: number; initialCompletedCount: number }) {
  const [remaining, setRemaining] = useState(stopNames);
  const [selectedName, setSelectedName] = useState(stopNames[0] ?? "");
  const [query, setQuery] = useState(stopNames[0] ? `${stopNames[0]} 남양주 다산` : "");
  const [sdk, setSdk] = useState<KakaoSdk | null>(null);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [chosen, setChosen] = useState<Candidate | null>(null);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mapElement = useRef<HTMLDivElement>(null);
  const mapInstance = useRef<KakaoMap | null>(null);
  const markerInstance = useRef<KakaoMarker | null>(null);
  const completed = initialCompletedCount + (stopNames.length - remaining.length);
  const percent = totalStopCount > 0 ? Math.round((completed / totalStopCount) * 100) : 100;
  const currentIndex = useMemo(() => Math.max(0, remaining.indexOf(selectedName)), [remaining, selectedName]);

  useEffect(() => {
    const key = process.env.NEXT_PUBLIC_KAKAO_MAP_JS_KEY?.trim();
    if (!key) { setError("카카오 지도 설정이 없습니다."); return; }
    void loadKakaoSdk(key).then(setSdk).catch((caught: unknown) => setError(caught instanceof Error ? caught.message : "카카오 지도를 불러오지 못했습니다."));
  }, []);

  useEffect(() => {
    if (!sdk || !mapElement.current || mapInstance.current) return;
    const center = new sdk.maps.LatLng(37.6145054, 127.1563116);
    const map = new sdk.maps.Map(mapElement.current, { center, level: 5 });
    mapInstance.current = map;
    sdk.maps.event.addListener(map, "click", (mouseEvent) => {
      if (!mouseEvent?.latLng) return;
      const position = mouseEvent.latLng;
      if (markerInstance.current) markerInstance.current.setPosition(position);
      else {
        const marker = new sdk.maps.Marker({ map, position, draggable: true });
        markerInstance.current = marker;
        sdk.maps.event.addListener(marker, "dragend", () => {
          const dragged = marker.getPosition();
          setChosen({ placeName: "지도에서 직접 지정", address: "직접 지정한 승하차 위치", lat: dragged.getLat(), lng: dragged.getLng() });
        });
      }
      setChosen({ placeName: "지도에서 직접 지정", address: "직접 지정한 승하차 위치", lat: position.getLat(), lng: position.getLng() });
    });
  }, [sdk]);

  useEffect(() => {
    if (!chosen || !sdk || !mapInstance.current) return;
    const center = new sdk.maps.LatLng(chosen.lat, chosen.lng);
    mapInstance.current.setCenter(center);
    if (markerInstance.current) markerInstance.current.setPosition(center);
    else {
      const marker = new sdk.maps.Marker({ map: mapInstance.current, position: center, draggable: true });
      markerInstance.current = marker;
      sdk.maps.event.addListener(marker, "dragend", () => {
        const position = marker.getPosition();
        setChosen((previous) => previous ? { ...previous, lat: position.getLat(), lng: position.getLng() } : previous);
      });
    }
  }, [chosen, sdk]);

  function chooseStop(name: string) {
    markerInstance.current?.setMap(null); markerInstance.current = null;
    setSelectedName(name); setQuery(`${name} 남양주 다산`); setCandidates([]); setChosen(null); setMessage(null); setError(null);
  }
  async function runSearch() {
    if (!query.trim()) return;
    setBusy(true); setError(null); setMessage(null); setChosen(null);
    try {
      const key = process.env.NEXT_PUBLIC_KAKAO_MAP_JS_KEY?.trim();
      if (!key) throw new Error("카카오 지도 설정이 없습니다.");
      const loaded = sdk ?? await loadKakaoSdk(key); setSdk(loaded);
      const result = await searchPlaces(loaded, query.trim()); setCandidates(result);
      if (result.length === 0) setError("검색 결과가 없습니다. 아파트명·도로명처럼 더 구체적으로 입력해 주세요.");
    } catch (caught) { setError(caught instanceof Error ? caught.message : "정류장을 검색하지 못했습니다."); }
    finally { setBusy(false); }
  }
  async function saveSelected() {
    if (!chosen || !selectedName || saving) return;
    setSaving(true); setError(null); setMessage(null);
    try {
      const response = await fetch("/api/admin/shuttle/regular-geocode", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ entries: [{ stopName: selectedName, latitude: chosen.lat, longitude: chosen.lng }] }) });
      const result = await response.json().catch(() => null);
      if (!response.ok) throw new Error(result?.error || "좌표를 저장하지 못했습니다.");
      const savedName = selectedName;
      const next = remaining.filter((name) => name !== savedName);
      markerInstance.current?.setMap(null); markerInstance.current = null;
      setRemaining(next); setMessage(`${savedName} 좌표를 저장했습니다. 같은 정류장의 모든 탑승자에게 적용됩니다.`); setCandidates([]); setChosen(null);
      if (next.length) { const nextName = next[Math.min(currentIndex, next.length - 1)]; setSelectedName(nextName); setQuery(`${nextName} 남양주 다산`); }
    } catch (caught) { setError(caught instanceof Error ? caught.message : "좌표를 저장하지 못했습니다."); }
    finally { setSaving(false); }
  }

  if (remaining.length === 0) return <div id="regular-stop-coordinate-setup" className="mx-auto mb-4 max-w-6xl px-4"><div className="rounded-2xl border border-green-200 bg-green-50 p-4 text-sm font-black text-green-700 dark:border-green-800 dark:bg-green-950/30 dark:text-green-200">✓ 정류장 {totalStopCount}곳의 좌표 설정이 완료됐습니다.</div></div>;

  return <section id="regular-stop-coordinate-setup" className="mx-auto mb-4 max-w-6xl px-4"><div className="rounded-2xl border border-blue-200 bg-white p-4 dark:border-blue-800 dark:bg-gray-800">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="text-base font-black">정류장 좌표 설정</h3><p className="mt-1 text-xs text-gray-500">한 곳씩 검색하고 지도 핀을 확인한 뒤 저장하세요. 자동 저장되지 않습니다.</p></div><div className="rounded-xl bg-blue-50 px-3 py-2 text-right dark:bg-blue-950/30"><b className="text-sm text-blue-800 dark:text-blue-200">{completed}/{totalStopCount}곳 완료</b><p className="text-[11px] text-blue-600 dark:text-blue-300">남은 정류장 {remaining.length}곳</p></div></div>
    <div className="mt-3 h-2 overflow-hidden rounded-full bg-gray-100 dark:bg-gray-700"><div className="h-full bg-blue-600 transition-all" style={{ width: `${percent}%` }} /></div>
    <div className="mt-4 grid gap-4 lg:grid-cols-[260px_1fr]">
      <div className="max-h-[430px] overflow-y-auto rounded-xl border border-gray-200 p-2 dark:border-gray-700">{remaining.map((name) => <button key={name} type="button" onClick={() => chooseStop(name)} className={`mb-1 block w-full rounded-lg px-3 py-2 text-left text-xs font-bold ${selectedName === name ? "bg-blue-700 text-white" : "hover:bg-gray-100 dark:hover:bg-gray-700"}`}>{name}</button>)}</div>
      <div><p className="text-sm font-black">{selectedName}</p><p className="mt-1 rounded-lg bg-lime-50 px-3 py-2 text-xs font-black text-lime-800 dark:bg-lime-950/30 dark:text-lime-200">① 지도에서 실제 승하차 위치를 누르세요. 핀을 끌어서 다시 조정할 수도 있습니다.</p><div ref={mapElement} className="mt-2 h-72 overflow-hidden rounded-xl border border-gray-200 dark:border-gray-700" /><p className="mt-3 text-xs font-black text-gray-500">장소를 찾기 어려울 때만 검색을 사용하세요.</p><div className="mt-2 flex gap-2"><input value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void runSearch(); }} placeholder="아파트명 또는 도로명 검색" className="min-w-0 flex-1 rounded-xl border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-900" /><button type="button" onClick={() => void runSearch()} disabled={busy} className="rounded-xl bg-brand-navy-900 px-4 py-2 text-sm font-black text-white disabled:opacity-50">{busy ? "검색 중…" : "검색"}</button></div>
        {error && <p role="alert" className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-xs font-bold text-red-700 dark:bg-red-950/30 dark:text-red-200">{error}</p>}{message && <p className="mt-2 rounded-lg bg-green-50 px-3 py-2 text-xs font-bold text-green-700 dark:bg-green-950/30 dark:text-green-200">{message}</p>}
        {candidates.length > 0 && <div className="mt-3 space-y-1"><p className="text-xs font-black text-gray-500">검색 후보를 선택하세요</p>{candidates.map((candidate, index) => <button key={`${candidate.lat}-${candidate.lng}`} type="button" onClick={() => setChosen(candidate)} className={`block w-full rounded-xl border p-3 text-left ${chosen === candidate ? "border-blue-600 bg-blue-50 dark:bg-blue-950/30" : "border-gray-200 dark:border-gray-700"}`}><b className="text-sm">{index + 1}. {candidate.placeName}</b><p className="mt-0.5 text-xs text-gray-500">{candidate.address}</p></button>)}</div>}
        {chosen && <div className="mt-3 rounded-xl border border-green-200 bg-green-50 p-3 dark:border-green-800 dark:bg-green-950/20"><p className="text-xs font-black text-green-800 dark:text-green-200">② 선택한 핀을 확인하고 저장하세요.</p><div className="mt-2 flex flex-wrap items-center justify-between gap-2"><span className="font-mono text-[11px] text-gray-500">{chosen.lat.toFixed(6)}, {chosen.lng.toFixed(6)}</span><button type="button" onClick={() => void saveSelected()} disabled={saving} className="rounded-xl bg-brand-orange-500 px-4 py-2.5 text-sm font-black text-white disabled:opacity-50">{saving ? "저장 중…" : "이 위치 확인 후 저장"}</button></div></div>}
      </div>
    </div>
  </div></section>;
}
