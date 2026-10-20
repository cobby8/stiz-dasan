/**
 * FAQ 독립 페이지 — /faq
 *
 * 기존 /apply#faq 앵커에서 독립 페이지로 분리.
 * DB에서 공개 FAQ를 조회하여 FaqClient 아코디언으로 렌더링한다.
 * ISR 60초 캐시로 성능과 실시간성의 균형을 맞춘다.
 */

import { getPublicFaqs } from "@/lib/queries";
import PublicPageLayout from "@/components/PublicPageLayout";
import AnimateOnScroll from "@/components/ui/AnimateOnScroll";
import FaqClient from "./FaqClient";
import { buildPublicMetadata } from "@/lib/publicMetadata";
import Link from "next/link";

// ISR 60초 — apply 페이지와 동일한 캐싱 정책
export const revalidate = 60;

export const metadata = buildPublicMetadata({
  title: "자주 묻는 질문 | STIZ 농구교실 다산2호점",
  description: "체험수업, 수강료, 보강, 준비물 등 스티즈 농구교실 다산2호점 FAQ를 확인하세요.",
  path: "/faq",
});

export default async function FaqPage() {
  // DB에서 공개 FAQ 조회
  const faqData = await getPublicFaqs();

  return (
    <PublicPageLayout>
      {/* 페이지 히어로 — 다른 공개 페이지와 동일한 그라데이션 패턴 */}
      <section className="relative overflow-hidden bg-gradient-to-br from-brand-navy-900 via-brand-navy-800 to-brand-navy-900 dark:from-black dark:via-gray-900 dark:to-black text-white py-16 md:py-20 transition-colors duration-300">
        {/* 배경 장식 도형들 */}
        <div className="absolute inset-0 pointer-events-none">
          <div className="absolute right-0 top-0 w-72 h-72 border-[20px] border-white/5 dark:border-brand-neon-cobalt/10 rounded-full translate-x-1/3 -translate-y-1/3 transition-colors duration-300" />
          <div className="absolute left-0 bottom-0 w-48 h-48 border-[15px] border-brand-orange-500/10 dark:border-brand-neon-lime/10 rounded-full -translate-x-1/4 translate-y-1/4 transition-colors duration-300" />
        </div>
        <div className="max-w-6xl mx-auto px-6 md:px-4 relative">
          <AnimateOnScroll>
            <p className="text-brand-orange-500 dark:text-brand-neon-lime text-sm font-bold uppercase tracking-widest mb-3">
              FAQ
            </p>
            <h1 className="text-4xl md:text-5xl font-black mb-4 break-keep">
              자주 묻는 질문
            </h1>
            <p className="text-blue-200 text-lg max-w-xl">
              체험수업, 수강료, 보강 등 궁금한 점을 빠르게 확인하세요.
            </p>
          </AnimateOnScroll>
        </div>
      </section>

      {/* FAQ 아코디언 — 클라이언트 컴포넌트 */}
      <FaqClient faqData={faqData} />

      <section className="bg-gray-50 px-6 py-12 text-gray-900 dark:bg-gray-900 dark:text-white">
        <div className="mx-auto max-w-3xl space-y-6">
          <h2 className="text-2xl font-bold">다산 지역 학부모님께 안내드립니다</h2>
          <div>
            <h3 className="font-semibold">스티즈농구교실 다산점은 지금 어디에 있나요?</h3>
            <p className="mt-2 leading-relaxed text-gray-700 dark:text-gray-300">
              2026년 3월부터 다산2호점 한 곳에서 수업을 운영하고 있습니다. 현재 위치는 경기도 남양주시 다산중앙로20번길 10-32, 1층입니다. 예전 1호점 위치로 방문하지 않도록 현재 주소를 확인해 주세요.
            </p>
          </div>
          <div>
            <h3 className="font-semibold">다산·도농에서 차량을 이용할 수 있나요?</h3>
            <p className="mt-2 leading-relaxed text-gray-700 dark:text-gray-300">
              다산과 도농 생활권의 차량 이용은 실제 운행 노선과 수업 시간에 따라 확인합니다. 같은 지역 안에서도 탑승 가능 여부가 다를 수 있으므로 아이의 수업 시간과 승하차 희망 위치를 상담할 때 알려주세요.
            </p>
          </div>
          <p className="text-sm text-gray-700 dark:text-gray-300">
            연령별 수업과 비용은 <Link href="/programs" className="font-semibold underline">프로그램 안내</Link>에서, 가능한 수업 시간은 <Link href="/schedule" className="font-semibold underline">시간표</Link>에서 확인할 수 있습니다. 체험을 원하시면 <Link href="/apply/trial" className="font-semibold underline">체험수업 신청</Link>으로 이어집니다.
          </p>
        </div>
      </section>
    </PublicPageLayout>
  );
}
