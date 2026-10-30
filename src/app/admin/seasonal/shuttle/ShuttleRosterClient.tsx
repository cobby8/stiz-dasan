"use client";

import { useMemo, useState } from "react";
import LocationPickerModal, { type MapLocationData } from "@/components/maps/LocationPickerModal";
import StudentDetailModal from "@/components/seasonal/StudentDetailModal";
import type { ShuttleRosterRow } from "@/lib/seasonal/shuttle-roster";
import { rosterPatchTarget } from "@/lib/seasonal/shuttleRosterEdit";

// 방학특강 셔틀 통합 명단 — 학생 단위 편집 표.
// 컬럼: 학생(클릭 시 상세) · 수업(반·요일) · 승차 위치(핀) · 하차 위치(핀) · 연락(전화/문자 선택).
// 시간 관련 값(학부모 희망시간 등)은 여기서 다루지 않고 노선표에서 확인한다.

function digits(p: string | null): string | null { if (!p) return null; const d = p.replace(/[^0-9]/g, ""); return d.length >= 9 ? d : null; }

const ROSTER_API = "/api/admin/seasonal/shuttle-roster";

// 1호점 무료탑승 학생 판정 — 승차 위치 라벨에 "무료탑승"이 들어가면 1호점 거점에서 타는 학생으로 본다.
// (원장이 라벨을 바꾸면 그룹에서 빠진다. 좌표가 아니라 라벨로 묶는 이유: 원장이 눈으로 바로 관리하기 위해서다.)
function isFreeHubRow(r: ShuttleRosterRow): boolean {
  return (r.pickupLocation ?? "").replace(/\s/g, "").includes("무료탑승");
}

// 좌표 없음 = 배차 불가 판정(표시 전용).
// 자동 배차는 핀 좌표 기준이라 좌표가 없으면 그 학생은 조용히 배차에서 빠진다.
// 여기서는 로직을 바꾸지 않고, 원장이 한눈에 알아보도록 경고만 붙이기 위한 판정이다.
//   · 탑승(ride) 행만 대상 — 미탑승은 애초에 배차 대상이 아니다.
//   · 승차 좌표가 없거나, 하차가 등원과 다른데 하차 좌표가 없으면 배차 불가로 본다.
function missingCoord(r: ShuttleRosterRow): boolean {
  if (!r.ride) return false;
  const noPickup = r.pickupLat == null || r.pickupLng == null;
  const noDropoff = !r.dropoffSameAsPickup && (r.dropoffLat == null || r.dropoffLng == null);
  return noPickup || noDropoff;
}

// ── 기존 주소 → 건물명 일괄 변환용 카카오 JS SDK(브라우저 전용) ──
// REST 키가 없어 서버에서 못 하므로, 관리자 브라우저에서 JS SDK로 좌표→건물명을 되찾는다.
type KakaoGeocoderResult = { road_address?: { address_name?: string; building_name?: string }; address?: { address_name?: string } };
type KakaoSdkLite = {
  maps: {
    load(cb: () => void): void;
    services: {
      Status: { OK: string };
      Geocoder: new () => { coord2Address(lng: number, lat: number, cb: (res: KakaoGeocoderResult[], status: string) => void): void };
    };
  };
};
let kakaoSdkPromise: Promise<KakaoSdkLite> | null = null;
function kakaoGlobal(): KakaoSdkLite | undefined { return (window as unknown as { kakao?: KakaoSdkLite }).kakao; }
function loadKakaoSdk(key: string): Promise<KakaoSdkLite> {
  if (kakaoGlobal()?.maps?.services) return Promise.resolve(kakaoGlobal() as KakaoSdkLite);
  if (kakaoSdkPromise) return kakaoSdkPromise;
  kakaoSdkPromise = new Promise((resolve, reject) => {
    const fail = () => { kakaoSdkPromise = null; reject(new Error("지도를 불러오지 못했습니다.")); };
    const start = () => { const k = kakaoGlobal(); if (!k) return fail(); k.maps.load(() => resolve(k)); };
    const existing = document.querySelector<HTMLScriptElement>('script[data-stiz-kakao-map="true"]');
    if (existing) {
      if (kakaoGlobal()?.maps) return start();
      existing.addEventListener("load", start, { once: true });
      existing.addEventListener("error", fail, { once: true });
      return;
    }
    const script = document.createElement("script");
    script.async = true;
    script.dataset.stizKakaoMap = "true";
    script.src = `https://dapi.kakao.com/v2/maps/sdk.js?appkey=${encodeURIComponent(key)}&autoload=false&libraries=services`;
    script.addEventListener("load", start, { once: true });
    script.addEventListener("error", () => { script.remove(); fail(); }, { once: true });
    document.head.appendChild(script);
  });
  return kakaoSdkPromise;
}
// 좌표의 도로명 건물명(아파트·건물명)을 돌려준다. 없거나 응답 지연이면 null(→ 주소 유지).
function buildingNameAt(sdk: KakaoSdkLite, lng: number, lat: number): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v: string | null) => { if (!settled) { settled = true; resolve(v); } };
    try {
      new sdk.maps.services.Geocoder().coord2Address(lng, lat, (res, status) => {
        if (status !== sdk.maps.services.Status.OK) return done(null);
        const bn = res?.[0]?.road_address?.building_name;
        done(bn && bn.trim() ? bn.trim() : null);
      });
    } catch { done(null); }
    setTimeout(() => done(null), 5000);
  });
}
// 현재 라벨이 '주소'처럼 보이는지 — 이미 건물명으로 잘 적힌 라벨은 건드리지 않는다.
function looksLikeAddress(s: string | null): boolean {
  if (!s) return false;
  return /(경기|서울|인천|남양주|[가-힣]+(로|길)\s*\d|동\s*\d|\d+-\d+|번지)/.test(s);
}

async function callApi(method: string, body?: unknown) {
  const r = await fetch(ROSTER_API, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  });
  const data = await r.json().catch(() => ({} as Record<string, unknown>));
  if (!r.ok) {
    // 상태 코드를 실어 보낸다. 409(그 사이 확정됨)는 문구만 띄우는 게 아니라 목록을 다시 읽어야 한다.
    const err = new Error((data as { error?: string })?.error || "저장 실패") as Error & { status?: number };
    err.status = r.status;
    throw err;
  }
  return data as Record<string, unknown>;
}

// 저장 경로는 행 하나로 갈린다(rosterPatchTarget).
//   rosterId 있음(확정 후) → 확정본만 수정한다. 원본 신청서는 건드리지 않는다.
//   rosterId 없음(확정 전) → 기존과 똑같이 원본 신청서를 수정한다.
// ⚠️ 이건 1차 판단일 뿐이다. 오래 열어 둔 탭은 확정 사실을 모르므로, 최종 판단은 서버가 한다(409).
async function patchRow(row: ShuttleRosterRow, patch: Record<string, unknown>) {
  await callApi("PATCH", { ...rosterPatchTarget(row), patch });
}

// 확정일시 표기(YYYY-MM-DD HH:MM). 보는 사람이 어디에 있든 학원 시간(서울)으로 고정해서 보여준다.
function fmtConfirmedAt(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const parts = new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(d);
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${g("year")}-${g("month")}-${g("day")} ${g("hour")}:${g("minute")}`;
}

// 연락 셀 — 학생/학부모 버튼을 누르면 전화/문자 두 옵션을 띄워 선택 실행.
function ContactCell({ row }: { row: ShuttleRosterRow }) {
  const [open, setOpen] = useState<"parent" | "child" | null>(null);
  const parent = digits(row.parentPhone);
  const child = digits(row.childPhone);
  const btn = "rounded-lg border px-2.5 py-1.5 text-xs font-black whitespace-nowrap";
  const act = "rounded-lg px-2.5 py-1.5 text-xs font-black text-white";
  const cur = open === "parent" ? parent : open === "child" ? child : null;
  return (
    <div className="relative">
      <div className="flex gap-1.5">
        <button type="button" disabled={!parent} onClick={() => setOpen(open === "parent" ? null : "parent")}
          className={`${btn} ${parent ? "border-blue-200 text-blue-700 dark:border-blue-500/40 dark:text-blue-300" : "border-gray-200 text-gray-300"}`}>📞 학부모</button>
        {child && <button type="button" onClick={() => setOpen(open === "child" ? null : "child")}
          className={`${btn} border-green-200 text-green-700 dark:border-green-500/40 dark:text-green-300`}>📞 학생</button>}
      </div>
      {open && cur && (
        <div className="absolute right-0 z-20 mt-1 flex gap-1.5 rounded-xl border border-gray-200 bg-white p-1.5 shadow-lg dark:border-gray-600 dark:bg-gray-900">
          <a href={`tel:${cur}`} onClick={() => setOpen(null)} className={`${act} bg-green-600`}>전화</a>
          <a href={`sms:${cur}`} onClick={() => setOpen(null)} className={`${act} bg-blue-600`}>문자</a>
          <button onClick={() => setOpen(null)} className="rounded-lg px-2 text-xs font-bold text-gray-400">닫기</button>
        </div>
      )}
    </div>
  );
}

export default function ShuttleRosterClient({
  initialRoster, initialConfirmedAt = null, initialConfirmedCount = 0, initialConfirmed = false,
}: {
  initialRoster: ShuttleRosterRow[];
  initialConfirmedAt?: string | null;
  initialConfirmedCount?: number;
  initialConfirmed?: boolean;
}) {
  const [rows, setRows] = useState<ShuttleRosterRow[]>(initialRoster);
  const [q, setQ] = useState("");
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pinEdit, setPinEdit] = useState<{ requestId: string; kind: "pickup" | "dropoff" } | null>(null);
  const [pinSaving, setPinSaving] = useState(false);
  const [detailAppId, setDetailAppId] = useState<string | null>(null);
  // 미탑승은 기본으로 숨긴다. "역시 태워주세요" 연락이 오면 되돌려야 하므로 지우지 않고 토글로 펼친다.
  const [showNonRiders, setShowNonRiders] = useState(false);
  // 1호점 무료탑승 학생들은 한 폴더로 접어서 관리한다. 기본은 펼침.
  const [hubOpen, setHubOpen] = useState(true);
  const [confirmedAt, setConfirmedAt] = useState<string | null>(initialConfirmedAt);
  const [confirmedCount, setConfirmedCount] = useState<number>(initialConfirmedCount);
  const [confirming, setConfirming] = useState(false);
  // 방금 뺀 행. 제외된 행은 목록에서 사라지므로, 이 자리에서만 되돌릴 수 있다.
  const [lastRemoved, setLastRemoved] = useState<{ rosterId: string; name: string } | null>(null);
  // 서버가 알려 준 확정 여부. 전원을 명단에서 빼면 목록이 비어 행으로는 판정할 수 없다.
  const [confirmedFlag, setConfirmedFlag] = useState<boolean>(initialConfirmed);
  // 주소 → 건물명 일괄 변환 상태
  const [converting, setConverting] = useState(false);
  const [convertMsg, setConvertMsg] = useState<string | null>(null);

  // 확정 여부는 서버 판정과 행의 출처를 함께 본다. 둘 중 하나라도 확정이면 확정으로 취급한다
  // (한쪽만 믿으면 "전원 제외" 상태나 오래된 목록에서 확정 전 화면으로 되돌아가 보인다).
  const confirmed = confirmedFlag || rows.some((r) => r.origin === "CONFIRMED");
  const confirmedAtLabel = fmtConfirmedAt(confirmedAt);

  const searched = useMemo(() => {
    const k = q.trim().toLowerCase();
    if (!k) return rows;
    return rows.filter((r) => [r.childName, r.parentName, r.pickupLocation, r.dropoffLocation, r.offeringTitle].some((v) => (v ?? "").toLowerCase().includes(k)));
  }, [rows, q]);

  const rideCount = rows.filter((r) => r.ride).length;
  const nonRiderCount = rows.length - rideCount;
  // 좌표가 없어 자동 배차에서 빠지는 탑승자 수(표시 전용 경고). 검색 결과가 아니라 전체 기준으로 센다.
  const missingCoordCount = rows.filter(missingCoord).length;
  const visible = useMemo(() => (showNonRiders ? searched : searched.filter((r) => r.ride)), [searched, showNonRiders]);
  // 1호점 무료탑승 학생은 별도 폴더로 묶는다. 나머지는 평소대로.
  const hubRows = useMemo(() => visible.filter(isFreeHubRow), [visible]);
  const mainRows = useMemo(() => visible.filter((r) => !isFreeHubRow(r)), [visible]);
  // 기사님께 드리는 파일이다. 미탑승자가 섞이면 실제로 태우면 안 되는 학생을 태우게 된다.
  const exportRows = useMemo(() => searched.filter((r) => r.ride), [searched]);

  function apply(requestId: string, partial: Partial<ShuttleRosterRow>) {
    setRows((cur) => cur.map((r) => (r.requestId === requestId ? { ...r, ...partial } : r)));
  }

  async function save(row: ShuttleRosterRow, patch: Record<string, unknown>, optimistic: Partial<ShuttleRosterRow>) {
    // 실패했을 때 되돌릴 "고치기 전 값"을 먼저 챙겨 둔다.
    // 이게 없으면 저장이 거절돼도(권한·좌표오류·확정충돌) 화면에는 새 값과 초록 핀이 남아
    // 원장은 저장된 줄 알게 된다 — 이 화면에서 가장 위험한 종류의 거짓말이다.
    const before: Partial<ShuttleRosterRow> = {};
    for (const key of Object.keys(optimistic) as (keyof ShuttleRosterRow)[]) {
      (before as Record<string, unknown>)[key] = row[key];
    }
    apply(row.requestId, optimistic);
    try { await patchRow(row, patch); setSavedAt(Date.now()); setError(null); }
    catch (e: any) {
      apply(row.requestId, before); // 낙관 반영 롤백
      setError(e?.message || "저장 실패");
      // 409 = 내가 보고 있던 사이에 명단이 확정됐다. 목록을 다시 읽어야 확정본으로 다시 저장할 수 있다.
      if (e?.status === 409) await refresh().catch(() => {});
    }
  }

  // 목록 새로고침. 확정 직후처럼 서버 값이 통째로 바뀌었을 때 화면을 다시 맞춘다.
  async function refresh() {
    const data = await callApi("GET");
    setRows((data.roster as ShuttleRosterRow[]) ?? []);
    setConfirmedAt((data.confirmedAt as string | null) ?? null);
    setConfirmedCount(Number(data.confirmedCount ?? 0));
    setConfirmedFlag(data.confirmed === true);
  }

  // 확정하기 — 원장이 눈으로 확인한 명단을 값으로 복제해 고정한다.
  async function confirmRoster() {
    if (confirming) return;
    const ok = window.confirm(
      `지금 탑승 ${rideCount}명을 확정 명단으로 저장합니다.\n\n` +
      `확정하면\n· 새 신청이 들어와도 이 명단에 자동으로 추가되지 않습니다.\n` +
      `· 여기서 고친 값이 그대로 기사님 명단이 됩니다.\n\n진행할까요?`,
    );
    if (!ok) return;
    setConfirming(true);
    try {
      await callApi("POST");
      await refresh();
      setSavedAt(Date.now()); setError(null);
    } catch (e: any) { setError(e?.message || "명단을 확정하지 못했습니다."); }
    finally { setConfirming(false); }
  }

  // 확정본에서 빼기. 지우는 게 아니라 제외 표시(soft remove)라 되돌릴 수 있다.
  async function removeRow(row: ShuttleRosterRow) {
    if (!row.rosterId) return;
    if (!window.confirm(`${row.childName} 학생을 확정 명단에서 뺄까요?\n(되돌리기로 다시 넣을 수 있습니다.)`)) return;
    const rosterId = row.rosterId;
    try {
      await callApi("PATCH", { rosterId, action: "remove" });
      setRows((cur) => cur.filter((r) => r.rosterId !== rosterId));
      setConfirmedCount((c) => Math.max(0, c - 1));
      setLastRemoved({ rosterId, name: row.childName });
      setSavedAt(Date.now()); setError(null);
    } catch (e: any) { setError(e?.message || "제외하지 못했습니다."); }
  }

  async function restoreRow() {
    if (!lastRemoved) return;
    try {
      await callApi("PATCH", { rosterId: lastRemoved.rosterId, action: "restore" });
      await refresh();
      setLastRemoved(null); setSavedAt(Date.now()); setError(null);
    } catch (e: any) { setError(e?.message || "되돌리지 못했습니다."); }
  }

  async function savePin(requestId: string, kind: "pickup" | "dropoff", loc: MapLocationData) {
    setPinSaving(true);
    const addr = loc.placeName ?? loc.roadAddress ?? loc.address;
    const patch = { [`${kind}Pin`]: { latitude: loc.latitude, longitude: loc.longitude, address: loc.address, roadAddress: loc.roadAddress, source: loc.source, placeId: loc.placeId, accuracyMeters: loc.accuracyMeters } };
    const isPinned = loc.source === "MAP_PIN" || loc.source === "CURRENT_LOCATION";
    const optimistic: Partial<ShuttleRosterRow> = kind === "pickup"
      ? { pickupLat: loc.latitude, pickupLng: loc.longitude, pickupPinned: isPinned, pickupApprox: loc.source === "SEARCH" }
      : { dropoffLat: loc.latitude, dropoffLng: loc.longitude, dropoffPinned: isPinned, dropoffApprox: loc.source === "SEARCH" };
    // 표시 라벨(건물명)은 서버에서 유지(비어있을 때만 주소로 채움) — 비어있던 경우 대비해 낙관 반영
    const target = rows.find((r) => r.requestId === requestId);
    if (kind === "pickup" && !target?.pickupLocation) optimistic.pickupLocation = addr;
    if (kind === "dropoff" && !target?.dropoffLocation) optimistic.dropoffLocation = addr;
    try { if (target) await save(target, patch, optimistic); setPinEdit(null); }
    finally { setPinSaving(false); }
  }

  // 기존 주소 라벨을 카카오 건물명으로 일괄 변환한다(관리자 브라우저 JS SDK).
  // 탑승자만·무료탑승 제외·주소처럼 보이는 라벨만·건물명이 있을 때만 바꾼다. 저장은 기존 save() 경로.
  async function convertAddressesToBuildingNames() {
    if (converting) return;
    const apiKey = process.env.NEXT_PUBLIC_KAKAO_MAP_JS_KEY?.trim();
    if (!apiKey) { setError("카카오 지도 키가 설정되지 않아 변환할 수 없습니다."); return; }
    const targets = rows.filter((r) => r.ride && !isFreeHubRow(r));
    if (targets.length === 0) { setConvertMsg("변환할 대상이 없습니다."); return; }
    setConverting(true); setError(null); setConvertMsg("지도를 불러오는 중...");
    try {
      const sdk = await loadKakaoSdk(apiKey);
      let changed = 0;
      for (let i = 0; i < targets.length; i++) {
        const r = targets[i];
        setConvertMsg(`변환 중 ${i + 1}/${targets.length}…`);
        if (r.pickupLat != null && r.pickupLng != null && looksLikeAddress(r.pickupLocation)) {
          const name = await buildingNameAt(sdk, r.pickupLng, r.pickupLat);
          if (name && name !== r.pickupLocation) { await save(r, { pickupLocation: name }, { pickupLocation: name }); changed++; }
        }
        if (!r.dropoffSameAsPickup && r.dropoffLat != null && r.dropoffLng != null && looksLikeAddress(r.dropoffLocation)) {
          const name = await buildingNameAt(sdk, r.dropoffLng, r.dropoffLat);
          if (name && name !== r.dropoffLocation) { await save(r, { dropoffLocation: name }, { dropoffLocation: name }); }
        }
      }
      setConvertMsg(`완료 · ${changed}건을 건물명으로 바꿨습니다${changed < targets.length ? " (건물명이 없는 곳은 주소 유지)" : ""}.`);
    } catch (e: any) {
      setError(e?.message || "건물명 변환에 실패했습니다.");
      setConvertMsg(null);
    } finally {
      setConverting(false);
    }
  }

  const pinRow = pinEdit ? rows.find((r) => r.requestId === pinEdit.requestId) : null;

  function exportCsv() {
    const head = ["학생", "학년", "수업", "요일", "승차위치", "하차위치", "학부모전화", "학생전화"];
    const lines = [head.join(",")];
    for (const r of exportRows) {
      const cells = [
        r.childName, r.childGrade ?? "", r.offeringTitle ?? "", r.weekdayLabel ?? "",
        r.pickupLocation ?? "", r.dropoffSameAsPickup ? "등원과 동일" : (r.dropoffLocation ?? ""),
        r.parentPhone ?? "", r.childPhone ?? "",
      ].map((c) => `"${String(c).replace(/"/g, '""')}"`);
      lines.push(cells.join(","));
    }
    const blob = new Blob(["﻿" + lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = `방학특강_셔틀_탑승자명단_${new Date().toISOString().slice(0, 10)}.csv`; a.click();
    URL.revokeObjectURL(url);
  }

  const cell = "w-full rounded-lg border border-transparent bg-transparent px-2 py-1.5 text-[12.5px] font-semibold hover:border-gray-200 focus:border-[var(--brand-accent)] focus:bg-white focus:outline-none dark:text-white dark:hover:border-gray-600 dark:focus:bg-gray-900";
  const dot = (pinned: boolean, approx: boolean) => `h-2.5 w-2.5 shrink-0 rounded-full ${pinned ? "bg-green-500" : approx ? "bg-amber-400" : "bg-gray-300"}`;
  const pinBtn = (pinned: boolean) => `grid h-7 w-7 shrink-0 place-items-center rounded-lg border text-sm ${pinned ? "border-green-300 text-green-600" : "border-gray-200 text-gray-500 dark:border-gray-600"}`;
  const colCount = confirmed ? 6 : 5;

  // 한 학생 행. 일반 명단과 1호점 폴더 안에서 똑같이 쓴다(두 벌로 갈리면 유지보수 사고).
  const renderRow = (r: ShuttleRosterRow) => (
    <tr key={r.requestId} className="border-t border-gray-100 align-middle hover:bg-gray-50/50 dark:border-gray-700 dark:hover:bg-gray-900/40">
      <td className="p-2">
        <button type="button" onClick={() => setDetailAppId(r.applicationId)} className="group text-left">
          <div className="font-bold text-gray-900 underline-offset-2 group-hover:text-brand-orange-600 group-hover:underline dark:text-white">
            {r.childName}{!r.ride && <span className="ml-1 rounded bg-gray-100 px-1 text-xs font-black text-gray-500 dark:bg-gray-700">미탑승</span>}
            {/* 좌표 없음 = 자동 배차에서 빠지는 학생. 원장이 바로 알아채도록 위험(빨강) 뱃지로 표시한다. */}
            {missingCoord(r) && <span className="ml-1 rounded bg-red-100 px-1 text-xs font-black text-red-700 dark:bg-red-900/40 dark:text-red-300">좌표 없음 · 배차 불가</span>}
          </div>
          <div className="text-xs text-gray-400">{[r.childGrade, r.childGender].filter(Boolean).join(" · ")}</div>
        </button>
      </td>
      <td className="p-2 text-[12.5px] font-semibold text-gray-700 dark:text-gray-200">
        {r.offeringTitle ?? "-"}
        {r.weekdayLabel && <div className="text-gray-400">{r.weekdayLabel}</div>}
      </td>
      <td className="p-2">
        <div className="flex items-center gap-1.5" style={{ minWidth: 190 }}>
          <input defaultValue={r.pickupLocation ?? ""} key={`p-${r.requestId}-${r.pickupLocation ?? ""}`}
            onBlur={(e) => { if (e.target.value !== (r.pickupLocation ?? "")) save(r, { pickupLocation: e.target.value }, { pickupLocation: e.target.value }); }}
            placeholder={r.ride ? "예: 다산이편한세상자이 정문" : "미탑승"} className={cell} />
          <button type="button" onClick={() => setPinEdit({ requestId: r.requestId, kind: "pickup" })}
            title="지도에서 핀 찍기"
            className={pinBtn(r.pickupPinned)}>📍</button>
          <span title={r.pickupPinned ? "정밀 핀" : r.pickupApprox ? "자동추정(재확인)" : "미지정"} className={dot(r.pickupPinned, r.pickupApprox)} />
        </div>
      </td>
      <td className="p-2 text-center">
        <label className="inline-flex cursor-pointer items-center gap-1.5 text-[12px] font-bold text-gray-600 dark:text-gray-300">
          <input type="checkbox" checked={r.dropoffSameAsPickup}
            onChange={(e) => save(r, { dropoffSameAsPickup: e.target.checked }, { dropoffSameAsPickup: e.target.checked, dropoffLocation: e.target.checked ? r.pickupLocation : r.dropoffLocation })}
            className="h-4 w-4 accent-[var(--brand-accent)]" />
          등원과 동일
        </label>
        {!r.dropoffSameAsPickup && (
          <div className="mt-1.5 flex items-center justify-center gap-1.5">
            <input defaultValue={r.dropoffLocation ?? ""} key={`d-${r.requestId}-${r.dropoffLocation ?? ""}`}
              onBlur={(e) => { if (e.target.value !== (r.dropoffLocation ?? "")) save(r, { dropoffLocation: e.target.value }, { dropoffLocation: e.target.value }); }}
              placeholder="예: 힐스테이트다산 정문" className={cell} />
            <button type="button" onClick={() => setPinEdit({ requestId: r.requestId, kind: "dropoff" })}
              title="지도에서 핀 찍기"
              className={pinBtn(r.dropoffPinned)}>📍</button>
            <span title={r.dropoffPinned ? "정밀 핀" : r.dropoffApprox ? "자동추정(재확인)" : "미지정"} className={dot(r.dropoffPinned, r.dropoffApprox)} />
          </div>
        )}
      </td>
      <td className="p-2"><ContactCell row={r} /></td>
      {/* 확정 후에만 제외 버튼을 준다. 확정 전에는 뺄 확정본 자체가 없다. */}
      {confirmed && (
        <td className="p-2">
          <button type="button" disabled={!r.rosterId} onClick={() => removeRow(r)}
            className="rounded-lg border border-red-200 px-2.5 py-1.5 text-xs font-black text-red-600 disabled:opacity-40 dark:border-red-500/40 dark:text-red-300">
            명단에서 빼기
          </button>
        </td>
      )}
    </tr>
  );

  return (
    <div className="mx-auto max-w-6xl px-4 py-4">
      <div className="rounded-2xl border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
        <div>
          {/* 조작 설명은 뺐다. 탑승 인원수는 대조용 숫자라 그대로 남긴다. */}
          <h3 className="text-base font-black text-gray-900 dark:text-white">셔틀 통합 명단</h3>
          <p className="mt-0.5 text-[12.5px] text-gray-500 dark:text-gray-400">탑승 {rideCount}명</p>
        </div>

        {/* 확정 배너 — 이 명단이 "아직 따라 움직이는 중"인지 "고정된 명단"인지 한 줄로 알려준다. */}
        {confirmed ? (
          <div className="mt-3 rounded-xl border border-green-200 bg-green-50 p-3 dark:border-green-500/40 dark:bg-green-900/20">
            <p className="text-[13px] font-black text-green-800 dark:text-green-200">
              ✓ 확정됨 · 탑승 {rideCount}명{confirmedAtLabel ? ` · ${confirmedAtLabel} 확정` : ""}
            </p>
            <p className="mt-0.5 text-[11.5px] font-semibold text-green-700 dark:text-green-300">
              확정본 {confirmedCount}건(미탑승 포함) · 새 신청이 들어와도 이 명단에는 자동으로 추가되지 않습니다. 여기서 고친 값이 그대로 기사님 명단이 됩니다.
            </p>
          </div>
        ) : (
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 dark:border-amber-500/40 dark:bg-amber-900/20">
            <p className="text-[12.5px] font-bold text-amber-800 dark:text-amber-200">
              이 명단은 아직 확정 전입니다. 신청이 바뀌면 명단도 함께 바뀝니다.
            </p>
            {/* 확정은 되돌리기 어려운 행동이라 확인창을 한 번 거친다. */}
            <button type="button" onClick={confirmRoster} disabled={confirming || rideCount === 0}
              className="rounded-xl bg-amber-600 px-3.5 py-2 text-[13px] font-black text-white disabled:opacity-50">
              {confirming ? "확정하는 중..." : `${rideCount}명 확정하기`}
            </button>
          </div>
        )}

        {/* 좌표 없는 탑승자 요약 — 자동 배차는 좌표 기준이라, 좌표가 없으면 그 학생은 조용히 배차에서 빠진다.
            원장이 명단 단계에서 미리 알아채고 위치를 지정하도록 눈에 띄는 경고로 노출한다(표시 전용). */}
        {missingCoordCount > 0 && (
          <div className="mt-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2 dark:border-red-500/40 dark:bg-red-900/20">
            <p className="text-[12.5px] font-black text-red-700 dark:text-red-300">
              ⚠ 좌표 없는 탑승자 {missingCoordCount}명 — 자동 배차에서 제외됩니다.
            </p>
            <p className="mt-0.5 text-[11.5px] font-semibold text-red-600/90 dark:text-red-300/80">
              해당 학생의 승·하차 위치를 지도 핀(📍)으로 지정하면 자동 배차에 포함됩니다.
            </p>
          </div>
        )}

        {/* 방금 뺀 행 되돌리기 — 제외된 행은 목록에서 사라지므로 여기서만 되돌릴 수 있다. */}
        {lastRemoved && (
          <div className="mt-2 flex flex-wrap items-center gap-2 rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 dark:border-gray-600 dark:bg-gray-900">
            <span className="text-[12.5px] font-bold text-gray-600 dark:text-gray-300">{lastRemoved.name} 학생을 확정 명단에서 뺐습니다.</span>
            <button type="button" onClick={restoreRow} className="rounded-lg border border-gray-300 px-2.5 py-1.5 text-[11.5px] font-black text-gray-700 dark:border-gray-500 dark:text-gray-200">되돌리기</button>
            <button type="button" onClick={() => setLastRemoved(null)} className="px-1 text-[11.5px] font-bold text-gray-400">닫기</button>
          </div>
        )}

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <div className="flex min-w-[180px] flex-1 items-center gap-2 rounded-xl border border-gray-200 bg-white px-3 py-2 dark:border-gray-600 dark:bg-gray-900">
            <span aria-hidden>🔍</span>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="학생·학부모·아파트 검색" className="w-full bg-transparent text-sm font-semibold outline-none dark:text-white" />
          </div>
          {savedAt && !error && !converting && <span className="rounded-full bg-green-50 px-2.5 py-1 text-[11.5px] font-black text-green-700 dark:bg-green-900/30 dark:text-green-300">✓ 저장됨</span>}
          {error && <span className="rounded-full bg-red-50 px-2.5 py-1 text-[11.5px] font-black text-red-600">⚠ {error}</span>}
          {convertMsg && <span className="rounded-full bg-blue-50 px-2.5 py-1 text-[11.5px] font-black text-blue-700 dark:bg-blue-900/30 dark:text-blue-300">{convertMsg}</span>}
          {nonRiderCount > 0 && (
            <button type="button" onClick={() => setShowNonRiders((v) => !v)}
              className={`rounded-xl border px-3 py-2 text-[13px] font-bold ${showNonRiders ? "border-[var(--brand-accent)] text-[var(--brand-accent)]" : "border-gray-200 text-gray-500 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300"}`}>
              {showNonRiders ? <>미탑승 {nonRiderCount}명 숨기기</> : <>미탑승 {nonRiderCount}명 보기</>}
            </button>
          )}
          <button onClick={convertAddressesToBuildingNames} disabled={converting}
            title="저장된 좌표로 아파트·건물명을 되찾아 승·하차 위치 이름을 일괄로 바꿉니다(건물명이 없는 곳은 주소 유지)."
            className="rounded-xl border border-gray-200 px-3 py-2 text-[13px] font-bold text-gray-600 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:text-gray-200">
            {converting ? "변환 중…" : "🏢 주소→건물명 변환"}
          </button>
          <button onClick={exportCsv} className="rounded-xl border border-gray-200 px-3 py-2 text-[13px] font-bold text-gray-600 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200">⬇ 기사님용 내보내기 ({exportRows.length}명)</button>
        </div>

        <div className="mt-3 overflow-x-auto rounded-xl border border-gray-200 dark:border-gray-700">
          <table className="w-full min-w-[820px] border-collapse text-[13px]">
            <thead>
              <tr className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500 dark:bg-gray-900 dark:text-gray-400">
                <th className="p-2.5">학생</th><th className="p-2.5">수업</th>
                <th className="p-2.5">승차 위치</th><th className="p-2.5">하차 위치</th><th className="p-2.5">연락</th>
                {confirmed && <th className="p-2.5">관리</th>}
              </tr>
            </thead>
            <tbody>
              {mainRows.map(renderRow)}

              {/* 1호점(무료탑승) 폴더 — 무료 거점에서 타는 학생들을 접었다 펼 수 있는 하위 그룹으로 묶는다. */}
              {hubRows.length > 0 && (
                <>
                  <tr className="border-t border-gray-100 dark:border-gray-700">
                    <td colSpan={colCount} className="bg-green-50/70 p-0 dark:bg-green-900/15">
                      <button type="button" onClick={() => setHubOpen((v) => !v)}
                        className="flex w-full items-center gap-2 px-3 py-2 text-left">
                        <span className="text-[12px] text-green-700 dark:text-green-300">{hubOpen ? "▼" : "▶"}</span>
                        <span className="grid h-5 w-5 place-items-center rounded bg-green-600 text-xs text-white">🆓</span>
                        <span className="text-[13px] font-black text-green-800 dark:text-green-200">1호점(무료탑승)</span>
                        <span className="rounded-full bg-green-600 px-2 py-0.5 text-xs font-black text-white">{hubRows.length}명</span>
                        <span className="text-xs font-semibold text-green-700/80 dark:text-green-300/80">1호점 거점에서 무료로 탑승하는 학생</span>
                      </button>
                    </td>
                  </tr>
                  {hubOpen && hubRows.map(renderRow)}
                </>
              )}

              {visible.length === 0 && (
                <tr><td colSpan={colCount} className="p-8 text-center text-sm text-gray-400">표시할 셔틀 명단이 없습니다.</td></tr>
              )}
            </tbody>
          </table>
        </div>
        {/* 색 범례는 색만 보고는 뜻을 알 수 없으므로 반드시 남긴다. 뒤의 조작 설명(중복)만 제거. */}
        <p className="mt-2 text-xs text-gray-400">● 초록=정밀 핀 · ● 노랑=자동추정(재확인 권장)</p>
        {confirmed && (
          <p className="mt-1 text-xs text-gray-400">확정 후 이 표에서 고친 값(위치 이름·지도 핀·하차 설정)은 확정 명단에만 저장되고, 학부모가 낸 원본 신청서는 그대로 유지됩니다.</p>
        )}
      </div>

      {pinEdit && pinRow && (
        <LocationPickerModal
          title={`${pinRow.childName} · ${pinEdit.kind === "pickup" ? "등원(승차)" : "하원(하차)"} 위치`}
          initialValue={(() => {
            const lat = pinEdit.kind === "pickup" ? pinRow.pickupLat : pinRow.dropoffLat;
            const lng = pinEdit.kind === "pickup" ? pinRow.pickupLng : pinRow.dropoffLng;
            const addr = pinEdit.kind === "pickup" ? pinRow.pickupLocation : pinRow.dropoffLocation;
            return lat != null && lng != null ? { address: addr ?? "", latitude: lat, longitude: lng, source: "MAP_PIN" as const } : undefined;
          })()}
          confirmPending={pinSaving}
          onConfirm={(loc) => savePin(pinEdit.requestId, pinEdit.kind, loc)}
          onClose={() => setPinEdit(null)}
        />
      )}

      {detailAppId && <StudentDetailModal applicationId={detailAppId} onClose={() => setDetailAppId(null)} />}
    </div>
  );
}
