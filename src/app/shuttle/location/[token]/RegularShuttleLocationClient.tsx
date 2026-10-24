"use client";

import { useEffect, useState } from "react";
import LocationPickerModal, { type MapLocationData } from "@/components/maps/LocationPickerModal";
import { SHUTTLE_LOCATION_CONSENT_VERSION } from "@/lib/seasonal/contracts";

type LocationKind = "PICKUP" | "DROPOFF";
type LinkData = {
  status?: "ACTIVE";
  studentName?: string;
  expiresAt?: string | null;
  locations?: { PICKUP?: ServerLocation | null; DROPOFF?: ServerLocation | null };
};

type ServerLocation = Omit<MapLocationData, "placeName"> & { name?: string | null; accuracyMeters?: number | null };

function fromServer(value: ServerLocation | null | undefined): MapLocationData | null {
  if (!value) return null;
  return { ...value, placeName: value.name ?? undefined, accuracyMeters: value.accuracyMeters ?? undefined };
}

function toServer(value: MapLocationData) {
  return { ...value, name: value.placeName ?? null, placeName: undefined, accuracyMeters: value.accuracyMeters ?? null };
}

function locationTitle(location: MapLocationData | null) {
  return location?.placeName || location?.roadAddress || location?.address || "아직 선택하지 않았습니다.";
}

function locationAddress(location: MapLocationData | null) {
  if (!location) return null;
  const title = locationTitle(location);
  const address = location.roadAddress || location.address;
  return title === address ? null : address;
}

export default function RegularShuttleLocationClient({ token }: { token: string }) {
  const [data, setData] = useState<LinkData | null>(null);
  const [pickup, setPickup] = useState<MapLocationData | null>(null);
  const [dropoff, setDropoff] = useState<MapLocationData | null>(null);
  const [sameAsPickup, setSameAsPickup] = useState(false);
  const [consent, setConsent] = useState(false);
  const [picker, setPicker] = useState<LocationKind | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [complete, setComplete] = useState<{ studentName?: string; pickupLabel?: string; dropoffLabel?: string; savedAt?: string | null } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetch(`/api/shuttle/regular-location/${encodeURIComponent(token)}`, { cache: "no-store" })
      .then(async (response) => {
        const result = await response.json().catch(() => null);
        if (!response.ok) {
          if (result?.status === "EXPIRED") throw new Error("링크가 만료되었습니다. 학원에 새 링크를 요청해 주세요.");
          if (result?.status === "REVOKED") throw new Error("이미 취소된 링크입니다. 변경이 필요하면 학원에 문의해 주세요.");
          throw new Error(result?.error || "유효하지 않은 링크입니다. 주소를 다시 확인해 주세요.");
        }
        if (cancelled) return;
        setData(result);
        const nextPickup = fromServer(result.locations?.PICKUP);
        const nextDropoff = fromServer(result.locations?.DROPOFF);
        setPickup(nextPickup);
        setDropoff(nextDropoff);
        setSameAsPickup(Boolean(nextPickup && nextDropoff && nextPickup.latitude === nextDropoff.latitude && nextPickup.longitude === nextDropoff.longitude));
      })
      .catch((cause) => { if (!cancelled) setError(cause instanceof Error ? cause.message : "링크를 확인하지 못했습니다."); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [token]);

  function chooseLocation(kind: LocationKind, value: MapLocationData) {
    if (kind === "PICKUP") {
      setPickup(value);
      if (sameAsPickup) setDropoff(value);
    } else {
      setDropoff(value);
      setSameAsPickup(false);
    }
    setPicker(null);
  }

  async function save() {
    const finalDropoff = sameAsPickup ? pickup : dropoff;
    if (!pickup || !finalDropoff) { setError("등원 탑승 위치와 하원 하차 위치를 모두 선택해 주세요."); return; }
    if (!consent) { setError("셔틀 운행을 위한 위치정보 이용에 동의해 주세요."); return; }
    setSaving(true); setError(null);
    try {
      const response = await fetch(`/api/shuttle/regular-location/${encodeURIComponent(token)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ purpose: "REGULAR_SHUTTLE_LOCATION", consentVersion: SHUTTLE_LOCATION_CONSENT_VERSION, pickup: toServer(pickup), dropoff: toServer(finalDropoff) }),
      });
      const result = await response.json().catch(() => null);
      if (!response.ok) throw new Error(result?.error || "위치를 저장하지 못했습니다.");
      // 서버가 최종 정규화한 장소명·주소를 그대로 보여줘 저장 결과를 다시 확인할 수 있게 한다.
      setComplete({
        studentName: result.studentName ?? data?.studentName,
        pickupLabel: locationTitle(fromServer(result.locations?.PICKUP) ?? pickup),
        dropoffLabel: locationTitle(fromServer(result.locations?.DROPOFF) ?? finalDropoff),
        savedAt: result.submittedAt ?? new Date().toISOString(),
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "위치를 저장하지 못했습니다.");
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <main className="grid min-h-dvh place-items-center bg-gray-50 px-5 dark:bg-gray-950"><p className="font-bold text-gray-500">셔틀 위치 정보를 확인하고 있습니다…</p></main>;
  if (error && !data) return <StatePage title="링크를 사용할 수 없습니다" body={error} />;
  if (complete) {
    return <StatePage title="셔틀 위치 저장 완료" body={`${complete.studentName ?? data?.studentName ?? "학생"}의 위치가 안전하게 저장되었습니다.`}>
      <ResultRow label="등원 탑승" value={complete.pickupLabel ?? "저장됨"} />
      <ResultRow label="하원 하차" value={complete.dropoffLabel ?? "저장됨"} />
      {complete.savedAt && <p className="mt-3 text-xs text-gray-500">저장 시각 {new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", dateStyle: "medium", timeStyle: "short" }).format(new Date(complete.savedAt))}</p>}
    </StatePage>;
  }

  return (
    <main className="min-h-dvh bg-gray-50 px-4 py-6 pb-[max(2rem,env(safe-area-inset-bottom))] dark:bg-gray-950">
      <div className="mx-auto max-w-xl">
        <p className="text-xs font-black text-brand-orange-500 dark:text-brand-neon-lime">STIZ SHUTTLE</p>
        <h1 className="mt-1 text-2xl font-black text-gray-950 dark:text-white">{data?.studentName ?? "학생"} 셔틀 위치 확인</h1>
        <p className="mt-2 text-sm leading-6 text-gray-600 dark:text-gray-300">기사님이 정확한 곳에서 만나도록 등원 탑승 위치와 하원 하차 위치를 지도에서 확인해 주세요.</p>
        {data?.expiresAt && <p className="mt-2 text-xs font-bold text-gray-500">입력 기한 {new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", dateStyle: "medium", timeStyle: "short" }).format(new Date(data.expiresAt))}</p>}

        <div className="mt-5 space-y-3">
          <LocationCard kind="PICKUP" location={pickup} onPick={() => setPicker("PICKUP")} />
          <label className="flex min-h-12 items-center gap-3 rounded-xl border border-gray-200 bg-white px-4 text-sm font-bold dark:border-gray-700 dark:bg-gray-900 dark:text-white">
            <input type="checkbox" checked={sameAsPickup} disabled={!pickup} onChange={(event) => { setSameAsPickup(event.target.checked); if (event.target.checked && pickup) setDropoff(pickup); }} className="size-5 accent-orange-500" />
            하원 하차 위치도 등원 탑승 위치와 같아요
          </label>
          <LocationCard kind="DROPOFF" location={sameAsPickup ? pickup : dropoff} disabled={sameAsPickup} onPick={() => setPicker("DROPOFF")} />
        </div>

        <label className="mt-5 flex items-start gap-3 rounded-2xl bg-blue-50 p-4 text-sm leading-6 text-blue-950 dark:bg-blue-950/30 dark:text-blue-100">
          <input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} className="mt-0.5 size-5 shrink-0 accent-blue-600" />
          <span><b>위치정보 이용에 동의합니다.</b><br />입력한 위치는 셔틀 배차와 운행 안내를 위해 사용됩니다.</span>
        </label>
        {error && <p role="alert" className="mt-3 rounded-xl bg-red-50 p-3 text-sm font-bold text-red-700 dark:bg-red-950/30 dark:text-red-200">{error}</p>}
        <button type="button" disabled={saving || !pickup || !(sameAsPickup ? pickup : dropoff) || !consent} onClick={() => void save()} className="mt-4 min-h-14 w-full rounded-2xl bg-[var(--brand-accent)] text-base font-black text-[var(--brand-accent-contrast)] disabled:opacity-40">{saving ? "저장 중…" : "두 위치 확인 · 저장"}</button>
      </div>

      {picker && <LocationPickerModal title={picker === "PICKUP" ? "등원 탑승 위치" : "하원 하차 위치"} initialValue={(picker === "PICKUP" ? pickup : dropoff) ?? undefined} onClose={() => setPicker(null)} onConfirm={(value) => chooseLocation(picker, value)} />}
    </main>
  );
}

function LocationCard({ kind, location, disabled = false, onPick }: { kind: LocationKind; location: MapLocationData | null; disabled?: boolean; onPick: () => void }) {
  const pickup = kind === "PICKUP";
  return <section className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-900">
    <div className="flex items-start justify-between gap-3"><div><p className="text-xs font-black text-gray-500">{pickup ? "PICKUP · 등원" : "DROPOFF · 하원"}</p><h2 className="mt-1 text-lg font-black text-gray-950 dark:text-white">{pickup ? "탑승 위치" : "하차 위치"}</h2></div><button type="button" disabled={disabled} onClick={onPick} className="min-h-11 rounded-xl border border-gray-300 px-4 text-sm font-black disabled:opacity-40 dark:border-gray-600 dark:text-white">{location ? "위치 수정" : "지도에서 선택"}</button></div>
    <p className="mt-3 font-bold text-gray-900 dark:text-white">{locationTitle(location)}</p>
    {locationAddress(location) && <p className="mt-1 text-sm text-gray-500">{locationAddress(location)}</p>}
  </section>;
}

function ResultRow({ label, value }: { label: string; value: string }) {
  return <div className="mt-3 rounded-xl bg-gray-50 p-3 text-left dark:bg-gray-900"><p className="text-xs font-black text-gray-500">{label}</p><p className="mt-1 font-bold text-gray-900 dark:text-white">{value}</p></div>;
}

function StatePage({ title, body, children }: { title: string; body: string; children?: React.ReactNode }) {
  return <main className="grid min-h-dvh place-items-center bg-gray-50 px-5 dark:bg-gray-950"><section className="w-full max-w-md rounded-3xl bg-white p-6 text-center shadow-sm dark:bg-gray-900"><p className="text-xs font-black text-brand-orange-500 dark:text-brand-neon-lime">STIZ SHUTTLE</p><h1 className="mt-2 text-2xl font-black text-gray-950 dark:text-white">{title}</h1><p className="mt-3 text-sm leading-6 text-gray-600 dark:text-gray-300">{body}</p>{children}</section></main>;
}
