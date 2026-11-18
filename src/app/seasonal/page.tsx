import PublicPageLayout from "@/components/PublicPageLayout";
import SeasonalListClient from "@/components/seasonal/SeasonalListClient";
import { buildPublicMetadata } from "@/lib/publicMetadata";
import { listPublishedSeasons } from "@/lib/seasonal/service";

export const metadata = buildPublicMetadata({
  title: "방학특강 | STIZ 농구교실 다산2호점",
  description: "스티즈 농구교실 다산2호점 방학특강 일정과 모집 현황을 확인하고 모바일로 신청하세요.",
  path: "/seasonal",
});

// 목록을 서버에서 미리 읽어 그린다(2026-11-19 속도 2회차).
// 저장해 둔 화면(ISR)을 쓰지 않는다 — 관리자가 특강을 공개·내려도 이 화면을 새로 고치는 곳이 없어,
// 방문이 뜸하면 몇 시간 전 목록이 보일 수 있다. 예전에도 열 때마다 /api/seasonal 을 불렀으니 서버 일은 같다.
export const dynamic = "force-dynamic";

export default async function SeasonalPage() {
  // /api/seasonal 과 같은 함수·같은 모양. 읽기 실패면 넘기지 않아 예전처럼 브라우저가 다시 묻는다.
  // JSON 왕복 = API 응답과 똑같은 값(날짜는 글자)으로 맞추기 위해서
  const initialData = await listPublishedSeasons()
    .then((seasons) => JSON.parse(JSON.stringify({ seasons })) as { seasons: unknown[] })
    .catch(() => undefined);
  return (
    <PublicPageLayout>
      {/* 어두운 띠 바탕은 공개 테마 토큰(--color-public-dark). 설명 글자 색은 공개 테마의 배너 규칙이 정한다. */}
      <section className="public-page-hero public-page-hero--compact bg-[var(--color-public-dark)] px-5 py-12 text-white">
        <div className="mx-auto max-w-5xl"><h1 className="mt-2 text-3xl font-bold md:text-4xl">방학특강</h1><p className="mt-3 max-w-xl break-keep">방학 동안 집중해서 배우고, 즐겁게 성장하는 프로그램을 만나보세요.</p></div>
      </section>
      <section className="public-content-section bg-[var(--color-public-tint)] px-4 py-8 dark:bg-[var(--color-public-paper)] md:py-12"><div className="mx-auto max-w-5xl"><SeasonalListClient initialData={initialData} /></div></section>
    </PublicPageLayout>
  );
}
