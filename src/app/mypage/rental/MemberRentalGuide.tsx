/**
 * 재원생 가족 대관 안내 — 학부모 앱 안 /mypage/rental 전용(2026-11-16 원장 지시).
 * 공개 /rental 안내(RentalGuide)는 외부 손님 기준(1시간 4만 원·보증금·입금 순서)이라 재원생에게 맞지 않았다.
 * 재원생 규칙: 시간 요금 2시간분까지 무료 · 넘는 시간만 시간 요금 · 냉난방·10명 넘는 인원은 별도 · 보증금 없음 ·
 * 돈이 없으면 원장님 승인 = 바로 확정. 숫자는 규칙 모듈(RENTAL_FEE) 한 곳에서 읽는다(계산과 안내가 어긋나지 않게).
 * 훅이 없는 서버 부품이다.
 */
import { RENTAL_FEE, formatWon } from "@/lib/rental/gym-rental-rules";

const FEE_ROWS: Array<[string, string]> = [
  ["처음 2시간", "무료"],
  ["2시간 넘는 시간", `1시간 ${formatWon(RENTAL_FEE.extraHour)}`],
  ["냉난방 사용", `1시간 ${formatWon(RENTAL_FEE.airconPerHour)}`],
  [`인원 ${RENTAL_FEE.baseHeadcount}명 초과`, `1인 1시간 ${formatWon(RENTAL_FEE.extraPersonPerHour)}`],
  ["보증금", "없음"],
];

export default function MemberRentalGuide({ studentNames }: { studentNames: string[] }) {
  return (
    <aside className="space-y-4">
      {/* 주인공 상자 — 재원생 혜택 한 줄을 먼저 */}
      <div className="public-card border-[var(--color-public-secondary-strong)] bg-[var(--color-public-secondary-soft)] p-4">
        <h2 className="text-base font-bold text-[var(--color-public-secondary-ink)]">재원생 가족 무료 대관</h2>
        <p className="mt-1 text-sm break-keep text-[var(--color-public-ink)]">
          {studentNames.join(" · ")} 가족은 체육관을 <b className="font-semibold">2시간까지 무료</b>로 쓸 수 있어요. 가족·친구와 함께 와도 돼요.
        </p>
      </div>
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
          냉난방을 안 쓰고 {RENTAL_FEE.baseHeadcount}명 이하로 2시간 안에 쓰면 낼 돈이 없어요. 요금이 생기면 승인 뒤 계좌이체로 내면 돼요.
        </p>
      </div>
      <div className="public-card p-4">
        <h2 className="text-base font-bold text-[var(--color-public-ink)]">이용 규칙</h2>
        <ul className="mt-2 space-y-1.5 text-sm break-keep text-[var(--color-public-ink)]">
          <li>· 실내운동화 필수 지참·착용</li>
          <li>· 건물 주차가 어려워요. 인근 주민센터 주차장을 이용해 주세요.</li>
          <li>· 사용 후 정리정돈, 냉난방은 끄고 퇴실</li>
          <li>· 평일 09:00~22:10 · 토 10:00~22:00 (수업 시간 제외) · 일 10:00~22:00</li>
        </ul>
      </div>
      <div className="public-card p-4 text-sm break-keep text-[var(--color-public-muted)]">
        <h2 className="text-base font-bold text-[var(--color-public-ink)]">진행 순서</h2>
        <p className="mt-2">신청 → 원장님 승인 → 확정(낼 돈이 있으면 입금 뒤 확정) → 사용</p>
      </div>
    </aside>
  );
}
