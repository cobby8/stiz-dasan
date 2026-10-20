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
  const settings = (await getAcademySettings()) as any;
  const policyText = settings.privacyPolicy?.trim() || DEFAULT_PRIVACY_POLICY;
  const privacySections = parsePrivacyPolicy(policyText);

  return (
    <PublicPageLayout>
      {/* 페이지 히어로 — terms 페이지와 동일한 스타일 */}
      <section className="relative overflow-hidden bg-gradient-to-br from-brand-navy-900 via-brand-navy-800 to-brand-navy-900 dark:from-black dark:via-gray-900 dark:to-black text-white py-12 md:py-14 transition-colors duration-300">
        <div className="absolute inset-0 pointer-events-none">
          <div className="absolute right-0 top-0 w-72 h-72 border-[20px] border-white/5 dark:border-brand-neon-cobalt/10 rounded-full translate-x-1/3 -translate-y-1/3 transition-colors duration-300" />
          <div className="absolute left-0 bottom-0 w-48 h-48 border-[15px] border-brand-orange-500/10 dark:border-brand-neon-lime/10 rounded-full -translate-x-1/4 translate-y-1/4 transition-colors duration-300" />
        </div>
        <div className="max-w-6xl mx-auto px-6 md:px-4 relative">
          <AnimateOnScroll>
            <p className="text-brand-orange-500 dark:text-brand-neon-lime text-sm font-bold uppercase tracking-widest mb-3">
              PRIVACY POLICY
            </p>
            <h1 className="text-4xl md:text-5xl font-black mb-4 break-keep">
              개인정보 처리방침
            </h1>
            <p className="text-blue-200 text-lg max-w-xl">
              개인정보보호법 제30조에 따른 개인정보 처리방침을 안내합니다.
            </p>
          </AnimateOnScroll>
        </div>
      </section>

      {/* 본문 — 관리자 설정값을 조항별 카드 형태로 표시 */}
      <SectionLayout bgColor="section">
        <div className="max-w-4xl mx-auto space-y-6">
          {privacySections.map((section, idx) => (
            <AnimateOnScroll key={`${section.title}-${idx}`}>
              <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-6 md:p-8 shadow-sm">
                <h2 className="text-lg font-bold text-brand-navy-900 dark:text-white mb-4">
                  {section.title}
                </h2>
                <div className="text-sm text-gray-700 dark:text-gray-200 leading-relaxed whitespace-pre-line">
                  {section.content}
                </div>
              </div>
            </AnimateOnScroll>
          ))}

          <AnimateOnScroll>
            <p className="text-center text-sm text-gray-400 mt-8">
              개인정보 처리방침 변경 사항은 홈페이지를 통해 안내됩니다.
            </p>
          </AnimateOnScroll>
        </div>
      </SectionLayout>
    </PublicPageLayout>
  );
}
