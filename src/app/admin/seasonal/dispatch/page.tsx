import { requireAdmin } from "@/lib/auth-guard";
import DispatchClient from "./DispatchClient";
import ShuttleSectionTabs from "../../shuttle/ShuttleSectionTabs";
import SeasonalHeader from "../SeasonalHeader";
import { getDispatchForView } from "@/lib/seasonal/shuttle-optimize";

export const dynamic = "force-dynamic";

// 방학특강 셔틀 자동 배차(노선 자동 제안). 기본값은 등원/첫 수업시간대/9인승으로 초안을 미리 계산해 보여준다.
export default async function SeasonalDispatchPage() {
  // 레이아웃 검사만 믿지 않고 화면마다 관리자 확인(d3 — 레이아웃이 바뀌거나 우회돼도 데이터가 새지 않게)
  await requireAdmin();
  // 저장본이 있으면 T맵 없이 그대로(제공량 절약). 없을 때만 T맵으로 초안 계산.
  const [pickup, dropoff] = await Promise.all([
    getDispatchForView(null, "PICKUP", true),
    getDispatchForView(null, "DROPOFF", true),
  ]);
  const initialPickup = JSON.parse(JSON.stringify(pickup));
  const initialDropoff = JSON.parse(JSON.stringify(dropoff));

  return (
    <>
      <SeasonalHeader eyebrow="SHUTTLE" title="셔틀 관리" subtitle="요일별 등원·하원 노선을 짜고 기사님 링크를 전달합니다." />
      <ShuttleSectionTabs />
      <DispatchClient initialPickup={initialPickup} initialDropoff={initialDropoff} />
    </>
  );
}
