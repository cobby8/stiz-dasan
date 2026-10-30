"use client";

import { useState } from "react";
import LocationPickerModal, { type MapLocationData } from "@/components/maps/LocationPickerModal";
import { userErrorMessage } from "@/components/staff/userErrorMessage";

// 셔틀 기준 위치 편집 — 학원 / 차고지 / 무료탑승 거점(1호점) 좌표를 지도로 지정한다.
// 배차·정규셔틀 지도의 출발/도착·거점 기준이 되는 공용 설정이라, '차량 관리'에 둔다.

type Geo = { lat: number; lng: number; name: string } | null;
type GeoKind = "academy" | "depot" | "hub" | "hubDropoff";
type GeoState = Record<GeoKind, Geo>;
const GEO_META: Record<GeoKind, { title: string; icon: string }> = {
  academy: { title: "학원", icon: "🏫" },
  depot: { title: "차고지", icon: "🚏" },
  hub: { title: "1호점 거점(탑승)", icon: "🆓" },
  hubDropoff: { title: "거점 하차(길 건너)", icon: "🚏" },
};

export default function ShuttleGeoEditor({ initial }: { initial: GeoState }) {
  const [geo, setGeo] = useState<GeoState>(initial);
  const [editKind, setEditKind] = useState<GeoKind | null>(null);
  const [savingGeo, setSavingGeo] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function geoOf(kind: GeoKind) {
    const g = geo[kind];
    return g ? { label: g.name.replace(/^(STIZ 다산점 · |차고지 · )/, ""), lat: g.lat, lng: g.lng } : null;
  }

  async function saveGeo(kind: GeoKind, loc: MapLocationData) {
    setSavingGeo(true); setErr(null);
    try {
      const r = await fetch("/api/admin/seasonal/shuttle-settings", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, latitude: loc.latitude, longitude: loc.longitude, address: loc.roadAddress ?? loc.address, name: loc.placeName ?? undefined }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || "저장 실패");
      setGeo((g) => ({ ...g, [kind]: { lat: loc.latitude, lng: loc.longitude, name: loc.placeName || loc.roadAddress || loc.address } }));
      setEditKind(null);
    } catch (e: any) { setErr(userErrorMessage(e, "저장하지 못했습니다. 다시 시도해 주세요.")); }
    finally { setSavingGeo(false); }
  }

  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
      <h3 className="text-base font-black text-gray-900 dark:text-white">🚐 셔틀 기준 위치</h3>
      <p className="mt-0.5 text-[12.5px] text-gray-500 dark:text-gray-400">배차·정규셔틀 지도의 출발·도착 지점과 무료 탑승 거점 기준입니다.</p>

      <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {(Object.keys(GEO_META) as GeoKind[]).map((kind) => {
          const g = geoOf(kind); const m = GEO_META[kind];
          return (
            <div key={kind} className="rounded-xl border border-gray-200 bg-gray-50 p-2.5 dark:border-gray-700 dark:bg-gray-900/40">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] font-black text-gray-500">{m.icon} {m.title}</span>
                <button onClick={() => setEditKind(kind)} className="rounded-lg border border-gray-200 px-2 py-1 text-[11px] font-bold text-brand-orange-600 hover:bg-white dark:border-gray-600 dark:text-brand-neon-lime">지도에서 변경</button>
              </div>
              <div className="mt-1 truncate text-[12px] font-bold text-gray-800 dark:text-gray-200">{g ? g.label : "미설정"}</div>
            </div>
          );
        })}
      </div>

      {err && <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs font-bold text-red-600">⚠ {err}</p>}

      {editKind && (
        <LocationPickerModal
          title={`${GEO_META[editKind].title} 위치 변경`}
          initialValue={(() => { const g = geoOf(editKind); return g ? { address: g.label, latitude: g.lat, longitude: g.lng, source: "MAP_PIN" } : undefined; })()}
          confirmPending={savingGeo}
          onConfirm={(loc) => saveGeo(editKind, loc)}
          onClose={() => setEditKind(null)}
        />
      )}
    </div>
  );
}
