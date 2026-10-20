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
      <section className="bg-brand-navy-900 px-5 py-12 text-white">
        <div className="mx-auto max-w-5xl"><p className="text-sm font-bold text-brand-orange-500">SEASONAL PROGRAM</p><h1 className="mt-2 text-3xl font-black md:text-4xl">방학특강</h1><p className="mt-3 max-w-xl text-blue-100 break-keep">방학 동안 집중해서 배우고, 즐겁게 성장하는 프로그램을 만나보세요.</p></div>
      </section>
      <section className="bg-gray-50 px-4 py-8 dark:bg-gray-900 md:py-12"><div className="mx-auto max-w-5xl"><SeasonalListClient /></div></section>
    </PublicPageLayout>
  );
}
