import Link from "next/link";
import PublicSiteTheme from "@/components/PublicSiteTheme";

/**
 * 학부모 앱(/mypage) 안에서 «공개 신청 부품»(체육관 대관·방학특강 신청)을 그대로 그리는 틀 — 2026-11-14 원장 결정표 c9.
 *
 * 왜 필요한가: 설치된 학부모 앱은 /mypage 밖(/rental·/seasonal)으로 나가면 주소창이 뜨고 돌아올 길이 없다.
 * 그래서 신청 화면을 /mypage 아래 «얇은 길»로 한 번 더 열고, 신청 부품·검증·저장 동작은 공개 화면 것을 그대로 쓴다(두 벌로 만들지 않는다).
 *
 * 하는 일 두 가지:
 *  1) 공개 부품은 공개 테마의 색·버튼 규칙(.stiz-public-sport)이 있어야 제 모양이 난다 → 이 틀 안에만 공개 테마를 건다.
 *  2) 공개 부품의 «하단 고정 바»(신청하기 버튼)는 화면 맨 아래에 붙는데, 학부모 앱은 그 자리에 아래 탭(48px)이 있다
 *     → 휴대폰 폭에서만 고정 바를 탭 바로 위로 올린다(PC 는 아래 탭이 없어 그대로).
 */
export default function ParentEmbeddedPublic({
  backHref,
  backLabel,
  title,
  children,
}: {
  /** 맨 위 «← 뒤로»가 가는 앱 안 주소 */
  backHref: string;
  backLabel: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid gap-3">
      <div className="flex items-center gap-2">
        {/* 뒤로가기 = 누르는 영역 44×44(academy-back-link) */}
        <Link href={backHref} aria-label={backLabel} className="academy-back-link">
          <span aria-hidden="true">←</span>
        </Link>
        <h1 className="academy-heading min-w-0 flex-1">{title}</h1>
      </div>
      <style>{`@media (max-width: 767.98px){.parent-embedded-public [data-public-bottom-bar]{bottom:calc(3rem + env(safe-area-inset-bottom)) !important}}`}</style>
      <PublicSiteTheme publicScope className="parent-embedded-public overflow-hidden rounded-2xl">
        {children}
      </PublicSiteTheme>
    </div>
  );
}
