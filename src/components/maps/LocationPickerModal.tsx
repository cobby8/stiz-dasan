"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useStoreAppLacks } from "@/components/storeApp/useStoreAppLacks";
import { hasShuttlePlaceName, SHUTTLE_PLACE_NAME_MAX, SHUTTLE_PLACE_NAME_REQUIRED_MESSAGE } from "@/lib/shuttle/placeNameRule";

export type MapLocationData = {
  address: string;
  roadAddress?: string;
  /** 장소명(예: "롯데캐슬 정문" 또는 검색으로 고른 아파트·건물명). 검색 자동채움 또는 사용자 입력으로 채워진다. */
  placeName?: string;
  latitude: number;
  longitude: number;
  placeId?: string;
  source: "MAP_PIN" | "SEARCH" | "CURRENT_LOCATION";
  accuracyMeters?: number;
};

type KakaoLatLng = { getLat(): number; getLng(): number };
type KakaoMap = {
  getCenter(): KakaoLatLng;
  setCenter(position: KakaoLatLng): void;
  relayout(): void;
};
type KakaoResult = {
  address_name?: string;
  road_address_name?: string;
  place_name?: string;
  id?: string;
  x?: string;
  y?: string;
  address?: { address_name?: string };
  road_address?: { address_name?: string };
};
type KakaoSdk = {
  maps: {
    load(callback: () => void): void;
    Map: new (container: HTMLElement, options: { center: KakaoLatLng; level: number }) => KakaoMap;
    LatLng: new (latitude: number, longitude: number) => KakaoLatLng;
    event: { addListener(target: KakaoMap, event: string, callback: () => void): void };
    services: {
      Status: { OK: string };
      Geocoder: new () => { coord2Address(longitude: number, latitude: number, callback: (results: KakaoResult[], status: string) => void): void };
      Places: new () => { keywordSearch(keyword: string, callback: (results: KakaoResult[], status: string) => void): void };
    };
  };
};

declare global {
  interface Window { kakao?: KakaoSdk }
}

let kakaoLoader: Promise<KakaoSdk> | null = null;
const DEFAULT_MAP_CENTER = { latitude: 37.624, longitude: 127.151 };

function loadKakaoSdk(key: string) {
  if (window.kakao?.maps) return Promise.resolve(window.kakao);
  if (kakaoLoader) return kakaoLoader;
  kakaoLoader = new Promise<KakaoSdk>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>('script[data-stiz-kakao-map="true"]');
    const script = existing ?? document.createElement("script");
    const fail = () => {
      kakaoLoader = null;
      script.remove();
      reject(new Error("지도를 불러오지 못했습니다."));
    };
    script.addEventListener("error", fail, { once: true });
    script.addEventListener("load", () => {
      if (!window.kakao?.maps) return fail();
      window.kakao.maps.load(() => resolve(window.kakao as KakaoSdk));
    }, { once: true });
    if (!existing) {
      script.async = true;
      script.dataset.stizKakaoMap = "true";
      script.src = `https://dapi.kakao.com/v2/maps/sdk.js?appkey=${encodeURIComponent(key)}&autoload=false&libraries=services`;
      document.head.appendChild(script);
    }
  });
  return kakaoLoader;
}

export default function LocationPickerModal({
  title,
  initialValue,
  confirmPending = false,
  requirePlaceName = false,
  onConfirm,
  onClose,
}: {
  title: string;
  initialValue?: MapLocationData;
  confirmPending?: boolean;
  /**
   * 장소명 필수(2026-11-09 원장 지시) — 아이가 타는 곳(관리자 원생 등록·학부모 셔틀 위치 링크)에서 켠다.
   * 켜면 이름이 빌 때 «위치 선택» 버튼이 꺼지고 안내가 보인다. 학원 위치·정류장 편집 등 다른 쓰임은 기본(꺼짐) 그대로.
   */
  requirePlaceName?: boolean;
  onConfirm: (location: MapLocationData) => void;
  onClose: () => void;
}) {
  const titleId = useId();
  const panelRef = useRef<HTMLElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const mapElementRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<KakaoMap | null>(null);
  const sdkRef = useRef<KakaoSdk | null>(null);
  const sourceRef = useRef<MapLocationData["source"]>(initialValue?.source ?? "MAP_PIN");
  const accuracyRef = useRef<number | undefined>(initialValue?.accuracyMeters);
  const selectionEnabledRef = useRef(Boolean(initialValue));
  const geocodeSequenceRef = useRef(0);
  const interactionSequenceRef = useRef(0);
  const pendingSearchRef = useRef<{ sequence: number; value: MapLocationData } | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "fallback">("loading");
  const [query, setQuery] = useState(initialValue?.roadAddress ?? initialValue?.address ?? "");
  // 장소명 입력값. 검색으로 고른 장소의 이름이 자동 프리필되고, 사용자가 직접 수정할 수 있다.
  const [placeName, setPlaceName] = useState(initialValue?.placeName ?? "");
  const [location, setLocation] = useState<MapLocationData | undefined>(initialValue);
  const [isLocating, setIsLocating] = useState(false);
  // 스토어 앱(현재 버전)은 현재 위치를 못 읽는다 → «현재 위치» 버튼을 숨긴다(검색·지도 이동은 그대로). 판정은 @/lib/storeApp 한 곳(d2)
  const appLacksGeolocation = useStoreAppLacks("geolocation");
  const [message, setMessage] = useState("지도를 움직여 핀을 실제 탑승 위치에 맞춰주세요.");
  const apiKey = process.env.NEXT_PUBLIC_KAKAO_MAP_JS_KEY?.trim();

  useEffect(() => {
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const panel = panelRef.current;
    const focusableSelector = 'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';
    (searchInputRef.current ?? panel?.querySelector<HTMLElement>(focusableSelector))?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab" || !panel) return;
      const focusable = Array.from(panel.querySelectorAll<HTMLElement>(focusableSelector))
        .filter((element) => !element.hidden && element.getAttribute("aria-hidden") !== "true");
      if (focusable.length === 0) {
        event.preventDefault();
        panel.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", handleKeyDown);
      previousFocusRef.current?.focus();
    };
  }, [onClose]);

  useEffect(() => {
    if (!apiKey || !mapElementRef.current) {
      setStatus("fallback");
      return;
    }
    let cancelled = false;
    loadKakaoSdk(apiKey).then((sdk) => {
      if (cancelled || !mapElementRef.current) return;
      sdkRef.current = sdk;
      const center = new sdk.maps.LatLng(initialValue?.latitude ?? DEFAULT_MAP_CENTER.latitude, initialValue?.longitude ?? DEFAULT_MAP_CENTER.longitude);
      const map = new sdk.maps.Map(mapElementRef.current, { center, level: initialValue ? 3 : 4 });
      mapRef.current = map;
      const updateCenter = () => {
        if (selectionEnabledRef.current) reverseGeocode(map.getCenter(), sourceRef.current, accuracyRef.current, interactionSequenceRef.current);
      };
      sdk.maps.event.addListener(map, "dragstart", () => {
        interactionSequenceRef.current += 1;
        geocodeSequenceRef.current += 1;
        pendingSearchRef.current = null;
        selectionEnabledRef.current = true;
        sourceRef.current = "MAP_PIN";
        accuracyRef.current = undefined;
        setLocation(undefined);
        setIsLocating(false);
        setMessage("새 위치의 주소를 확인하고 있습니다.");
      });
      sdk.maps.event.addListener(map, "idle", updateCenter);
      setStatus("ready");
      window.setTimeout(() => map.relayout(), 0);
    }).catch(() => {
      if (!cancelled) setStatus("fallback");
    });
    return () => { cancelled = true; };
    // 지도는 모달을 열 때 한 번만 생성합니다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKey]);

  function reverseGeocode(position: KakaoLatLng, source: MapLocationData["source"], accuracyMeters: number | undefined, interactionSequence: number) {
    const sdk = sdkRef.current;
    if (!sdk) return;
    const latitude = position.getLat();
    const longitude = position.getLng();
    const requestSequence = ++geocodeSequenceRef.current;
    new sdk.maps.services.Geocoder().coord2Address(longitude, latitude, (results, resultStatus) => {
      if (interactionSequence !== interactionSequenceRef.current || requestSequence !== geocodeSequenceRef.current) return;
      if (source === "CURRENT_LOCATION") setIsLocating(false);
      const pendingSearch = pendingSearchRef.current?.sequence === interactionSequence ? pendingSearchRef.current.value : undefined;
      if (resultStatus !== sdk.maps.services.Status.OK) {
        setLocation(pendingSearch ?? { address: "지도에서 선택한 위치", latitude, longitude, source, accuracyMeters });
        setMessage("주소를 찾지 못했습니다. 핀 위치는 저장할 수 있습니다.");
        return;
      }
      const first = results[0];
      const address = first?.address?.address_name ?? first?.road_address?.address_name ?? "지도에서 선택한 위치";
      setLocation({
        address: pendingSearch?.address ?? address,
        roadAddress: pendingSearch?.roadAddress ?? (first?.road_address?.address_name || undefined),
        placeName: pendingSearch?.placeName,
        latitude,
        longitude,
        placeId: pendingSearch?.placeId,
        source,
        accuracyMeters,
      });
      setMessage(first ? "선택한 위치를 확인해주세요." : "주소를 찾지 못했습니다. 핀 위치는 저장할 수 있습니다.");
    });
  }

  function search() {
    const sdk = sdkRef.current;
    if (!sdk || !mapRef.current || !query.trim()) return;
    const interactionSequence = ++interactionSequenceRef.current;
    geocodeSequenceRef.current += 1;
    pendingSearchRef.current = null;
    setLocation(undefined);
    setIsLocating(false);
    setMessage("장소를 검색하고 있습니다.");
    new sdk.maps.services.Places().keywordSearch(query.trim(), (results, resultStatus) => {
      if (interactionSequence !== interactionSequenceRef.current) return;
      const first = results[0];
      if (resultStatus !== sdk.maps.services.Status.OK || !first?.x || !first.y) {
        setMessage("검색 결과가 없습니다. 도로명이나 건물명을 다시 입력해주세요.");
        return;
      }
      sourceRef.current = "SEARCH";
      accuracyRef.current = undefined;
      selectionEnabledRef.current = true;
      const latitude = Number(first.y);
      const longitude = Number(first.x);
      // 카카오 검색 결과의 장소명(place_name)을 보존한다. 이전에는 주소 폴백으로만 쓰고 버렸다.
      const searchedName = first.place_name || undefined;
      // 사용자가 아직 장소명을 직접 입력하지 않았으면 검색한 장소명을 자동 프리필한다.
      if (searchedName) setPlaceName((prev) => prev.trim() ? prev : searchedName);
      pendingSearchRef.current = { sequence: interactionSequence, value: {
        address: first.address_name || first.place_name || query.trim(),
        roadAddress: first.road_address_name || undefined,
        placeName: first.place_name || undefined,
        latitude,
        longitude,
        placeId: first.id,
        source: "SEARCH",
      } };
      const mapPosition = new sdk.maps.LatLng(latitude, longitude);
      mapRef.current?.setCenter(mapPosition);
      reverseGeocode(mapPosition, "SEARCH", undefined, interactionSequence);
    });
  }

  function useCurrentLocation() {
    if (!navigator.geolocation || !sdkRef.current || !mapRef.current) {
      setMessage("이 기기에서는 현재 위치를 사용할 수 없습니다.");
      return;
    }
    const interactionSequence = ++interactionSequenceRef.current;
    geocodeSequenceRef.current += 1;
    pendingSearchRef.current = null;
    setLocation(undefined);
    setIsLocating(true);
    setMessage("현재 위치를 확인하고 있습니다.");
    navigator.geolocation.getCurrentPosition((position) => {
      if (interactionSequence !== interactionSequenceRef.current) return;
      const sdk = sdkRef.current;
      if (!sdk) {
        setIsLocating(false);
        return;
      }
      sourceRef.current = "CURRENT_LOCATION";
      accuracyRef.current = position.coords.accuracy;
      selectionEnabledRef.current = true;
      const mapPosition = new sdk.maps.LatLng(position.coords.latitude, position.coords.longitude);
      mapRef.current?.setCenter(mapPosition);
      reverseGeocode(mapPosition, "CURRENT_LOCATION", position.coords.accuracy, interactionSequence);
    }, () => {
      if (interactionSequence === interactionSequenceRef.current) {
        setIsLocating(false);
        setMessage("위치 권한이 거부됐습니다. 검색이나 지도 이동으로 선택해주세요.");
      }
    }, {
      enableHighAccuracy: true,
      timeout: 10000,
    });
  }

  function confirmSelection() {
    if (confirmPending) return;
    if (isLocating) {
      setMessage("현재 위치를 확인하고 있습니다. 잠시 후 다시 눌러주세요.");
      return;
    }
    if (!location) {
      setMessage("현재 위치 확인이 끝나거나 지도를 움직여 위치를 선택해주세요.");
      return;
    }
    // 사용자가 입력/수정한 장소명을 우선 반영한다. 비어 있으면 검색으로 잡힌 placeName을 유지한다.
    const trimmedName = placeName.trim();
    // 장소명 필수 모드: 칸이 비면 확정하지 않는다(검색 장소명으로 몰래 채우지 않는다 — 칸에 보이는 값이 저장값)
    if (requirePlaceName && !trimmedName) {
      setMessage(SHUTTLE_PLACE_NAME_REQUIRED_MESSAGE);
      return;
    }
    onConfirm({ ...location, placeName: trimmedName || (requirePlaceName ? undefined : location.placeName) || undefined });
  }

  // 장소명 필수인데 비어 있으면 «위치 선택» 버튼을 끈다
  const placeNameMissing = requirePlaceName && !hasShuttlePlaceName(placeName);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/55 sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <section ref={panelRef} tabIndex={-1} className="flex max-h-[96dvh] w-full max-w-2xl flex-col overflow-hidden rounded-t-3xl bg-white shadow-2xl outline-none dark:bg-gray-800 sm:max-h-[calc(100dvh-2rem)] sm:rounded-3xl">
        <header className="flex items-center justify-between border-b border-gray-200 px-4 py-3 dark:border-gray-700">
          <div>
            <p className="text-xs font-bold text-brand-orange-500 dark:text-brand-neon-lime">셔틀 위치 선택</p>
            <h2 id={titleId} className="text-lg font-black text-gray-900 dark:text-white">{title}</h2>
          </div>
          <button type="button" onClick={onClose} aria-label="지도 닫기" className="flex size-11 items-center justify-center rounded-full text-gray-600 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-700">
            <span className="material-symbols-outlined" aria-hidden="true">close</span>
          </button>
        </header>

        <div className="flex-1 space-y-3 overflow-y-auto p-4">
          {status !== "fallback" && (
            <div className="flex gap-2">
              <label className="sr-only" htmlFor={`${titleId}-search`}>주소 또는 장소 검색</label>
              <input ref={searchInputRef} id={`${titleId}-search`} value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); search(); } }} placeholder="도로명, 건물명으로 검색" className="min-h-11 min-w-0 flex-1 rounded-xl border border-gray-300 bg-white px-3 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-900 dark:text-white" />
              <button type="button" onClick={search} disabled={confirmPending} className="min-h-11 rounded-xl bg-brand-navy-900 px-4 text-sm font-black text-white disabled:opacity-50 dark:bg-brand-neon-lime dark:text-brand-navy-900">검색</button>
            </div>
          )}

          {status !== "fallback" && (
            <div>
              <label className="mb-1 block text-xs font-bold text-gray-600 dark:text-gray-300" htmlFor={`${titleId}-place-name`}>
                {requirePlaceName ? <>장소명 <span className="text-red-600 dark:text-red-300">*</span></> : "장소명 (선택)"}
              </label>
              {/* 검색으로 고른 장소의 이름이 자동 채워지고, 직접 수정할 수 있다. 확정 시 placeName으로 함께 저장된다. */}
              <input
                id={`${titleId}-place-name`}
                value={placeName}
                onChange={(event) => setPlaceName(event.target.value)}
                placeholder="예: 롯데캐슬 정문"
                maxLength={SHUTTLE_PLACE_NAME_MAX}
                required={requirePlaceName}
                aria-invalid={placeNameMissing || undefined}
                aria-describedby={placeNameMissing ? `${titleId}-place-name-hint` : undefined}
                className="min-h-11 w-full rounded-xl border border-gray-300 bg-white px-3 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-900 dark:text-white"
              />
              {/* 필수인데 비었을 때만 안내(기사님 명단에 이 이름이 나온다) */}
              {placeNameMissing && (
                <p id={`${titleId}-place-name-hint`} className="mt-1 text-xs font-bold text-red-600 dark:text-red-300">{SHUTTLE_PLACE_NAME_REQUIRED_MESSAGE}</p>
              )}
            </div>
          )}

          {status === "fallback" ? (
            <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100">
              <p className="font-black">현재 지도를 사용할 수 없습니다.</p>
              <p className="mt-1">신청 화면의 기존 위치 입력란에 주소와 정차 위치를 자세히 적어주세요. 지도 위치는 나중에 다시 확인할 수 있습니다.</p>
              <button type="button" onClick={onClose} className="mt-3 min-h-11 rounded-xl border border-amber-400 px-4 font-bold">텍스트로 입력하기</button>
            </div>
          ) : (
            <>
              <div className="relative h-[45dvh] min-h-72 overflow-hidden rounded-2xl bg-gray-100 dark:bg-gray-900">
                <div ref={mapElementRef} className="absolute inset-0" aria-label="승하차 위치 지도" />
                {status === "loading" && <div className="absolute inset-0 grid place-items-center text-sm font-bold text-gray-500">지도를 불러오는 중...</div>}
                <span className="material-symbols-outlined pointer-events-none absolute left-1/2 top-1/2 z-10 -translate-x-1/2 -translate-y-full text-5xl text-brand-orange-500 drop-shadow" aria-hidden="true">location_on</span>
                {!appLacksGeolocation && <button type="button" onClick={useCurrentLocation} disabled={confirmPending || isLocating} className="absolute bottom-3 right-3 z-10 flex min-h-11 items-center gap-1 rounded-xl bg-white px-3 text-sm font-black text-gray-800 shadow-lg disabled:opacity-60 dark:bg-gray-800 dark:text-white">
                  <span className="material-symbols-outlined text-lg" aria-hidden="true">my_location</span>{isLocating ? "확인 중" : "현재 위치"}
                </button>}
              </div>
              <div className="rounded-xl bg-gray-50 p-3 dark:bg-gray-900">
                <p className="text-xs text-gray-500 dark:text-gray-400">{message}</p>
                <p className="mt-1 font-bold text-gray-900 dark:text-white">{location?.placeName ?? location?.roadAddress ?? location?.address ?? "위치를 선택해주세요."}</p>
                {/* 장소명이 있으면 그 아래에 주소를, 없으면 기존처럼 지번을 보조로 보여준다. */}
                {location?.placeName
                  ? <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{location.roadAddress ?? location.address}</p>
                  : (location?.roadAddress && location.address !== location.roadAddress && <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">지번 {location.address}</p>)}
              </div>
            </>
          )}
        </div>

        {status !== "fallback" && (
          <footer className="flex gap-2 border-t border-gray-200 p-4 pb-[max(1rem,env(safe-area-inset-bottom))] dark:border-gray-700">
            <button type="button" onClick={onClose} disabled={confirmPending} className="min-h-12 rounded-xl border border-gray-300 px-5 font-bold text-gray-700 disabled:opacity-50 dark:border-gray-600 dark:text-gray-200">취소</button>
            <button type="button" disabled={confirmPending || placeNameMissing} aria-busy={confirmPending || isLocating} onClick={confirmSelection} className="min-h-12 flex-1 rounded-xl bg-brand-orange-500 px-5 font-black text-white disabled:opacity-50 dark:bg-brand-neon-lime dark:text-brand-navy-900">{confirmPending ? "저장 중..." : isLocating ? "현재 위치 확인 중..." : placeNameMissing ? "장소명을 적어 주세요" : location ? "이 위치로 선택" : "위치 선택 필요"}</button>
          </footer>
        )}
      </section>
    </div>
  );
}
