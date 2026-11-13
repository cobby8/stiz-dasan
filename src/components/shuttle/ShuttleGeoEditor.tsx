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
    <div className="rounded-2xl border border-[var(--color-academy-line)] bg-white p-4">
      <h3 className="academy-section-title">셔틀 기준 위치</h3>
      <p className="mt-0.5 text-xs text-[var(--color-academy-muted)]">배차·정규셔틀 지도의 출발·도착 지점과 무료 탑승 거점 기준입니다.</p>

      <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {(Object.keys(GEO_META) as GeoKind[]).map((kind) => {
          const g = geoOf(kind); const m = GEO_META[kind];
          return (
            <div key={kind} className="rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-soft)] p-2.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium text-[var(--color-academy-muted)]">{m.title}</span>
                <button type="button" onClick={() => setEditKind(kind)} className="academy-button-secondary academy-button-sm shrink-0">지도에서 변경</button>
              </div>
              <div className="mt-1 truncate text-xs font-medium text-[var(--color-academy-ink)]">{g ? g.label : "미설정"}</div>
            </div>
          );
        })}
      </div>

      {err && <p className="mt-3 rounded-lg bg-[var(--color-academy-danger-soft)] px-3 py-2 text-xs text-[var(--color-academy-danger)]">{err}</p>}

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
