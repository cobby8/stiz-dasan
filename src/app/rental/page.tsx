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

export const revalidate = 3600;

export const metadata = buildPublicMetadata({
  title: "체육관 대관 | STIZ 농구교실 다산2호점",
  description: "스티즈농구교실 다산2호점 실내 농구 체육관 대관 안내. 수업이 없는 시간에 10분 단위로 시작해 30분 단위로 신청할 수 있습니다(최소 1시간).",
  path: "/rental",
});

// 요금표 — 숫자는 규칙 모듈(RENTAL_FEE) 한 곳에서 읽는다(계산과 표가 어긋나지 않게). 30분 단위(2026-11-08 원장 확정)
const FEE_ROWS: Array<[string, string]> = [
  ["기본 1시간", formatWon(RENTAL_FEE.firstHour)],
  ["이후 30분마다", `+${formatWon(RENTAL_FEE.extraHalfHour)}`],
  ["냉난방 사용", `30분당 +${formatWon(RENTAL_FEE.airconPerHalfHour)}`],
  [`인원 ${RENTAL_FEE.baseHeadcount}명 초과`, `1인·30분당 +${formatWon(RENTAL_FEE.extraPersonPerHalfHour)}`],
  ["보증금(사용 후 환불)", formatWon(RENTAL_FEE.deposit)],
];

export default function RentalPage() {
  return (
    <PublicPageLayout>
      {/* 컴팩트 히어로 — 제목 1줄 + 핵심 정보 1줄 */}
      {/* 색·크기는 공용 배너 규칙(public-sport.css 의 public-page-hero--compact)을 그대로 따른다 */}
      <section className="public-page-hero public-page-hero--compact px-4">
        <div className="mx-auto max-w-5xl">
          <h1>체육관 대관</h1>
          <p className="break-keep">
            스티즈농구교실 다산2호점 · 다산동 6158-4, 1층 · 수업 없는 시간 30분 단위(최소 1시간) · {formatWon(RENTAL_FEE.firstHour)}부터
          </p>
        </div>
      </section>

      <section className="public-content-section px-4 py-6">
        <div className="mx-auto grid max-w-5xl gap-5 md:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]">
          {/* 이용 안내 — 요금표·규칙(근접성: 돈 이야기는 한 상자, 지켜야 할 것은 한 상자) */}
          <aside className="space-y-4">
            <div className="public-card p-4">
              <h2 className="text-base font-black text-[var(--color-public-ink)]">요금</h2>
              <dl className="mt-2 divide-y divide-[var(--color-public-line)] text-sm">
                {FEE_ROWS.map(([label, value]) => (
                  <div key={label} className="flex items-baseline justify-between gap-3 py-1.5">
                    <dt className="text-[var(--color-public-muted)]">{label}</dt>
                    <dd className="text-right font-bold tabular-nums text-[var(--color-public-ink)]">{value}</dd>
                  </div>
                ))}
              </dl>
              <p className="mt-2 text-xs break-keep text-[var(--color-public-muted)]">
                보증금은 사용 후 돌려드립니다. 정리정돈·냉난방·인원 규칙을 지키지 않으면 차감될 수 있어요.
              </p>
            </div>
            <div className="public-card p-4">
              <h2 className="text-base font-black text-[var(--color-public-ink)]">이용 규칙</h2>
              <ul className="mt-2 space-y-1.5 text-sm break-keep text-[var(--color-public-ink)]">
                <li>· 실내운동화 필수 지참·착용</li>
                <li>· 건물 주차가 어려워요. 인근 주민센터 주차장을 이용해 주세요.</li>
                <li>· 최대 {RENTAL_FEE.baseHeadcount}명 기준, 넘으면 인원 추가 요금</li>
                <li>· 사용 후 정리정돈, 냉난방은 끄고 퇴실</li>
                <li>· 평일 09:00~22:00 · 주말 10:00~22:00 (수업 시간 제외)</li>
              </ul>
            </div>
            <div className="public-card p-4 text-sm break-keep text-[var(--color-public-muted)]">
              <h2 className="text-base font-black text-[var(--color-public-ink)]">진행 순서</h2>
              <p className="mt-2">신청 → 원장님 승인 → 입금 → 확정 → 사용 → 보증금 환불</p>
            </div>
          </aside>

          <RentalClient />
        </div>
      </section>
    </PublicPageLayout>
  );
}
