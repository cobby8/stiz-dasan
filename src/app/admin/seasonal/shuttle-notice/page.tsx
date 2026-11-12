import { requireAdmin } from "@/lib/auth-guard";
import SeasonalHeader from "../SeasonalHeader";
import ShuttleSectionTabs from "../../shuttle/ShuttleSectionTabs";
import ShuttleNoticeClient from "./ShuttleNoticeClient";

export const dynamic = "force-dynamic";

// 셔틀 등원시간 안내 문자 — 저장된 요일별 노선에서 학생별 문안을 만들어 보여 주고,
// 원장이 확인한 뒤 직접 발송한다. 자동 발송(크론)은 두지 않는다.
export default async function ShuttleNoticePage() {
  // 레이아웃 검사만 믿지 않고 화면마다 관리자 확인(d3 — 레이아웃이 바뀌거나 우회돼도 데이터가 새지 않게)
  await requireAdmin();
  return (
    <>
      <SeasonalHeader
        eyebrow="SHUTTLE"
        title="등원시간 안내 문자"
        subtitle="저장된 요일별 등원 노선에서 학생별 문안을 만들어 보냅니다. 학생마다 따로 발송됩니다."
      />
      <ShuttleSectionTabs />
      <ShuttleNoticeClient />
    </>
  );
}
