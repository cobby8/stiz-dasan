/**
 * 체육관 대관 신청 — /rental (공개, 로그인 없이 신청)
 *
 * 화면 순서: 이용 안내(장소·요금·규칙) → 날짜 → 가능 시간 → 인원·냉난방 → 요금 → 신청자 정보 → 동의 → 신청.
 * 가능 시간은 손님이 날짜를 고를 때마다 서버에서 새로 받는다(페이지 자체는 정적).
 * 입금 계좌는 이 페이지 본문에 두지 않는다 — 신청 완료 화면에서만 보인다(원장 결정 2026-11-07).
 */
import PublicPageLayout from "@/components/PublicPageLayout";
import { buildPublicMetadata } from "@/lib/publicMetadata";
import { RENTAL_FEE, formatWon } from "@/lib/rental/gym-rental-rules";
import RentalClient from "./RentalClient";
import RentalGuide from "./RentalGuide";

export const revalidate = 3600;

export const metadata = buildPublicMetadata({
  title: "체육관 대관 | STIZ 농구교실 다산2호점",
  description: "스티즈농구교실 다산2호점 실내 농구 체육관 대관 안내. 수업이 없는 시간에 10분 단위로 시작해 30분 단위로 신청할 수 있습니다(최소 1시간).",
  path: "/rental",
});

export default function RentalPage() {
  return (
    <PublicPageLayout>
      {/* 컴팩트 히어로 — 제목 1줄 + 핵심 정보 1줄 */}
      {/* 색·크기는 공용 배너 규칙(public-sport.css 의 public-page-hero--compact)을 그대로 따른다 */}
      <section className="public-page-hero public-page-hero--compact px-4">
        <div className="mx-auto max-w-5xl">
          <h1>체육관 대관</h1>
          <p className="break-keep">
            스티즈농구교실 다산2호점 · 다산동 6158-4, 1층 · 수업 없는 시간(최소 1시간) · 1시간 {formatWon(RENTAL_FEE.firstHour)}
          </p>
        </div>
      </section>

      <section className="public-content-section px-4 py-6">
        <div className="mx-auto grid max-w-5xl gap-5 md:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]">
          {/* 이용 안내(요금·규칙·진행 순서) — 학부모 앱 안 대관 화면(/mypage/rental)과 같은 부품 */}
          <RentalGuide />

          <RentalClient />
        </div>
      </section>
    </PublicPageLayout>
  );
}
