import VehicleManagerClient from "./VehicleManagerClient";
import ShuttleSectionTabs from "./ShuttleSectionTabs";
import SeasonalHeader from "../seasonal/SeasonalHeader";
import ShuttleGeoEditor from "@/components/shuttle/ShuttleGeoEditor";
import { getShuttleDashboard } from "@/lib/shuttle/service";
import { getSettings } from "@/lib/seasonal/shuttle-optimize";

export const dynamic = "force-dynamic";

// 셔틀 '차량 관리' — 차량 등록·관리 + 셔틀 기준 위치(학원·차고지·거점) 설정을 담당한다.
export default async function ShuttleAdminPage() {
  const [dashboard, geo] = await Promise.all([getShuttleDashboard(), getSettings()]);
  const data = JSON.parse(JSON.stringify(dashboard)) as { vehicles?: { id: string; name: string; plateNumber?: string | null; capacity: number; notes?: string | null; isActive?: boolean }[] };
  const geoPlain = JSON.parse(JSON.stringify(geo)) as typeof geo;

  return (
    <>
      <SeasonalHeader eyebrow="SHUTTLE" title="셔틀 관리" subtitle="차량·기준 위치와 배차·정규 셔틀을 한곳에서 관리합니다." />
      <ShuttleSectionTabs />
      <div className="mx-auto max-w-6xl px-4 pt-4">
        <ShuttleGeoEditor initial={geoPlain} />
      </div>
      <VehicleManagerClient initialVehicles={data.vehicles ?? []} />
    </>
  );
}
