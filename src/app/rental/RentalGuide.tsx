/**
 * 체육관 대관 이용 안내(요금·이용 규칙·진행 순서) — 공개 화면 /rental 과 학부모 앱 안 /mypage/rental 이 같이 쓴다.
 * 2026-11-14 c9: 앱 안 대관 화면을 만들면서 /rental 페이지 본문에 있던 안내를 그대로 옮겼다(글자·모양 변경 없음).
 * 훅이 없는 서버 부품이다.
 */
import { RENTAL_FEE, formatWon } from "@/lib/rental/gym-rental-rules";

// 요금표 — 숫자는 규칙 모듈(RENTAL_FEE) 한 곳에서 읽는다(계산과 표가 어긋나지 않게).
// 안내는 1시간 단위로 보여 준다(2026-11-08 원장 지시). 계산은 30분 단위 그대로(1시간 30분 = 55,000원).
const FEE_ROWS: Array<[string, string]> = [
  ["기본 1시간", formatWon(RENTAL_FEE.firstHour)],
  ["이후 1시간마다", `+${formatWon(RENTAL_FEE.extraHour)}`],
  ["냉난방 사용", `1시간 +${formatWon(RENTAL_FEE.airconPerHour)}`],
  [`인원 ${RENTAL_FEE.baseHeadcount}명 초과`, `1인 1시간 +${formatWon(RENTAL_FEE.extraPersonPerHour)}`],
  ["보증금(사용 후 환불)", formatWon(RENTAL_FEE.deposit)],
];

export default function RentalGuide() {
  return (
    // 이용 안내 — 요금표·규칙(근접성: 돈 이야기는 한 상자, 지켜야 할 것은 한 상자)
    <aside className="space-y-4">
      <div className="public-card p-4">
        <h2 className="text-base font-bold text-[var(--color-public-ink)]">요금</h2>
        <dl className="mt-2 divide-y divide-[var(--color-public-line)] text-sm">
          {FEE_ROWS.map(([label, value]) => (
            <div key={label} className="flex items-baseline justify-between gap-3 py-1.5">
              <dt className="text-[var(--color-public-muted)]">{label}</dt>
              <dd className="text-right font-semibold tabular-nums text-[var(--color-public-ink)]">{value}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-2 text-xs break-keep text-[var(--color-public-muted)]">
          보증금은 사용 후 돌려드립니다. 정리정돈·냉난방·인원 규칙을 지키지 않으면 차감될 수 있어요.
          30분 단위로 신청하면 그만큼 나눠 계산해요.
        </p>
        <p className="mt-1 text-xs font-semibold break-keep text-[var(--color-public-ink)]">
          재원생 가족은 2시간까지 무료(냉난방·인원 추가는 별도, 보증금 없음)
        </p>
      </div>
      <div className="public-card p-4">
        <h2 className="text-base font-bold text-[var(--color-public-ink)]">이용 규칙</h2>
        <ul className="mt-2 space-y-1.5 text-sm break-keep text-[var(--color-public-ink)]">
          <li>· 실내운동화 필수 지참·착용</li>
          <li>· 건물 주차가 어려워요. 인근 주민센터 주차장을 이용해 주세요.</li>
          <li>· 최대 {RENTAL_FEE.baseHeadcount}명 기준, 넘으면 인원 추가 요금</li>
          <li>· 사용 후 정리정돈, 냉난방은 끄고 퇴실</li>
          <li>· 평일 09:00~22:10 · 토 10:00~22:00 (수업 시간 제외) · 일 10:00~22:00</li>
        </ul>
      </div>
      <div className="public-card p-4 text-sm break-keep text-[var(--color-public-muted)]">
        <h2 className="text-base font-bold text-[var(--color-public-ink)]">진행 순서</h2>
        <p className="mt-2">신청 → 원장님 승인 → 입금 → 확정 → 사용 → 보증금 환불</p>
      </div>
    </aside>
  );
}
