// 3년 이상 재원생 유니폼 무료 신청 — 학생별 전용 링크 페이지
//
// 위쪽 /apply/uniform(page.tsx)은 본사 쇼핑몰로 영구 이동 중이지만, 그 리다이렉트는 그 주소 «하나»
// 에만 걸린다. 이 하위 경로(/apply/uniform/free/<토큰>)는 별도 페이지라 영향을 받지 않는다.
import type { Metadata } from "next";
import PublicPageLayout from "@/components/PublicPageLayout";
import { prisma } from "@/lib/prisma";
import { getAcademySettings } from "@/lib/queries";
import { getFreeGrantView, type FreeGrantView } from "@/lib/uniform-free-grant";
import { grantUnusableMessage } from "@/lib/uniform-free-grant-rules";
import FreeUniformForm from "./FreeUniformForm";

// 링크마다 상태가 다르고 한 번 쓰면 바뀌므로 캐시하지 않는다. 검색 노출·주소 유출(referrer)도 막는다
export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "유니폼 무료 신청 | STIZ 농구교실",
  robots: { index: false, follow: false, nocache: true },
  referrer: "no-referrer",
};

export default async function FreeUniformApplyPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;

  let view: FreeGrantView;
  try {
    view = await getFreeGrantView(prisma, token, Date.now());
  } catch (error) {
    // 표가 아직 없거나 DB 오류 — 학부모에게는 «링크 확인 불가» 로만 안내
    console.error("[uniform-free] 링크 조회 실패", error);
    view = { state: "NOT_FOUND", message: grantUnusableMessage("NOT_FOUND") };
  }
  const settings = await getAcademySettings().catch(() => null);
  const contactPhone = settings?.contactPhone || "";

  return (
    <PublicPageLayout>
      <section className="public-content-section bg-[var(--color-public-tint)] py-6 dark:bg-[var(--color-public-paper)] md:py-10">
        <div className="mx-auto max-w-xl px-4">
          {view.state === "USABLE" ? (
            <FreeUniformForm
              token={token}
              studentName={view.studentName}
              initialParentName={view.parentName}
              parentPhoneMask={view.parentPhoneMask}
              contactPhone={contactPhone}
            />
          ) : (
            // 쓸 수 없는 링크: 이유 한 줄 + 학원 연락처
            <div className="public-card rounded-2xl bg-white p-6 text-center shadow-lg dark:bg-[var(--color-public-tint)]">
              <h1 className="break-keep text-lg font-black text-[var(--color-public-ink)] dark:text-white">{view.message}</h1>
              <p className="mt-2 break-keep text-sm text-[var(--color-public-muted)] dark:text-[var(--color-public-muted)]">
                궁금한 점은 학원으로 연락해 주세요.
              </p>
              {contactPhone && (
                <a
                  href={`tel:${contactPhone.replace(/[^0-9+]/g, "")}`}
                  className="mt-4 inline-flex min-h-11 items-center justify-center gap-1.5 rounded-xl border border-[var(--color-public-line)] bg-white px-5 text-base font-bold text-[var(--color-public-ink)] hover:bg-[var(--color-public-tint)] dark:border-[var(--color-public-line)] dark:bg-[var(--color-public-paper)] dark:text-[var(--color-public-ink)]"
                >
                  {contactPhone}
                </a>
              )}
            </div>
          )}
        </div>
      </section>
    </PublicPageLayout>
  );
}
