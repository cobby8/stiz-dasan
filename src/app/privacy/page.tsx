import { getAcademySettings } from "@/lib/queries";
import { DEFAULT_PRIVACY_POLICY } from "@/lib/defaultPolicies";
import PublicPageLayout from "@/components/PublicPageLayout";
import SectionLayout from "@/components/ui/SectionLayout";
import AnimateOnScroll from "@/components/ui/AnimateOnScroll";
import { buildPublicMetadata } from "@/lib/publicMetadata";

// 개인정보 처리방침은 자주 바뀌지 않으므로 5분 ISR (terms 페이지와 동일)
export const revalidate = 300;
export const metadata = buildPublicMetadata({
  title: "개인정보 처리방침 | STIZ 농구교실 다산2호점",
  description: "STIZ 농구교실 다산2호점 개인정보 처리방침을 확인하세요.",
  path: "/privacy",
});

function parsePrivacyPolicy(policyText: string) {
  const blocks = policyText
    .trim()
    .split(/\n(?=제\d+조\s*\()/)
    .map((block) => block.trim())
    .filter(Boolean);

  return blocks.map((block, idx) => {
    const [titleLine, ...contentLines] = block.split("\n");
    const title = titleLine?.trim() || `개인정보 처리방침 ${idx + 1}`;
    const content = contentLines.join("\n").trim();
    return { title, content };
  });
}

export default async function PrivacyPage() {
  const settings = (await getAcademySettings()) as { privacyPolicy?: string | null };
  const policyText = settings.privacyPolicy?.trim() || DEFAULT_PRIVACY_POLICY;
  const privacySections = parsePrivacyPolicy(policyText);

  return (
    <PublicPageLayout>
      {/* 페이지 히어로 — terms 페이지와 동일한 스타일 */}
      <section className="public-page-intro">
        <div className="public-container">
          <h1>개인정보 처리방침</h1>
          <p>개인정보의 수집·이용·보호 기준을 안내합니다.</p>
        </div>
      </section>

      {/* 본문 — 관리자 설정값을 조항별 카드 형태로 표시 */}
      <SectionLayout bgColor="section">
        <div className="public-card max-w-4xl mx-auto overflow-hidden">
          {privacySections.map((section, idx) => (
            <AnimateOnScroll key={`${section.title}-${idx}`}>
              <div className="border-b border-[var(--color-public-border)] px-5 py-5 md:px-6">
                <h2 className="text-lg font-bold text-brand-navy-900 dark:text-white mb-2">
                  {section.title}
                </h2>
                <div className="text-sm text-gray-700 dark:text-gray-200 leading-relaxed whitespace-pre-line">
                  {section.content}
                </div>
              </div>
            </AnimateOnScroll>
          ))}

          <AnimateOnScroll>
            <p className="px-5 py-4 text-sm text-gray-500">
              개인정보 처리방침 변경 사항은 홈페이지를 통해 안내됩니다.
            </p>
          </AnimateOnScroll>
        </div>
      </SectionLayout>
    </PublicPageLayout>
  );
}
