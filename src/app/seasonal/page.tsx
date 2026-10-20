import PublicPageLayout from "@/components/PublicPageLayout";
import SeasonalListClient from "@/components/seasonal/SeasonalListClient";
import { buildPublicMetadata } from "@/lib/publicMetadata";

export const metadata = buildPublicMetadata({
  title: "방학특강 | STIZ 농구교실 다산2호점",
  description: "스티즈 농구교실 다산2호점 방학특강 일정과 잔여석을 확인하고 모바일로 신청하세요.",
  path: "/seasonal",
});

export default function SeasonalPage() {
  return (
    <PublicPageLayout>
      <section className="public-page-intro"><div className="public-container"><h1>방학특강</h1><p>운영 일정과 수업, 잔여석을 확인하세요.</p></div></section>
      <section className="public-section"><div className="public-container"><SeasonalListClient /></div></section>
    </PublicPageLayout>
  );
}
