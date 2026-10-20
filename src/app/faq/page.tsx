/**
 * FAQ 독립 페이지 — /faq
 *
 * 기존 /apply#faq 앵커에서 독립 페이지로 분리.
 * DB에서 공개 FAQ를 조회하여 FaqClient 아코디언으로 렌더링한다.
 * ISR 60초 캐시로 성능과 실시간성의 균형을 맞춘다.
 */

import { getPublicFaqs } from "@/lib/queries";
import PublicPageLayout from "@/components/PublicPageLayout";
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
      <section className="public-page-intro">
        <div className="public-container">
          <h1>자주 묻는 질문</h1>
          <p>체험·수강료·보강에 관한 질문을 확인하세요.</p>
        </div>
      </section>

      {/* FAQ 아코디언 — 클라이언트 컴포넌트 */}
      <FaqClient faqData={faqData} />

      <div className="public-container !max-w-3xl pb-6 text-sm text-[var(--color-public-muted)]">
        수업과 비용은 <Link href="/programs" className="public-link">프로그램 안내</Link>, 가능한 시간은 <Link href="/schedule" className="public-link">시간표</Link>에서 확인하세요.
      </div>
    </PublicPageLayout>
  );
}
