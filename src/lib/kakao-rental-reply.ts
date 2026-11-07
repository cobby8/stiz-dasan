import { buildKakaoSkillResponse } from "@/lib/kakao-chatbot-contract";
// 요금은 대관 규칙 모듈 한 곳에만 있다(공개 /rental 화면·서버 재계산과 같은 값). 이 모듈에는 계좌가 없다.
import { formatWon, RENTAL_FEE } from "@/lib/rental/gym-rental-rules";

// ── 카카오 체육관 대관 안내 카드 ───────────────────────────────────────────
// 연결·미연결 모두 같은 카드를 받는다. 계좌는 넣지 않는다(신청 후 원장님 승인 문자로 안내).
// 요금 숫자를 여기 직접 적지 않는다 — 원장님이 요금을 바꾸면 RENTAL_FEE 한 곳만 고치면 된다.
export const KAKAO_RENTAL_TEXT = [
  `· 요금: 1시간 ${formatWon(RENTAL_FEE.firstHour)}, 이후 1시간마다 ${formatWon(RENTAL_FEE.extraHour)}`,
  `· 냉난방: 시간당 ${formatWon(RENTAL_FEE.airconPerHour)}`,
  `· ${RENTAL_FEE.baseHeadcount}명 초과 시 1인당 시간당 ${formatWon(RENTAL_FEE.extraPersonPerHour)}`,
  `· 보증금 ${formatWon(RENTAL_FEE.deposit)}(사용 후 환불)`,
  "· 실내 운동화 필수",
  "· 건물 주차가 어려워요. 인근 주민센터 주차장을 이용해 주세요.",
  "",
  "아래 ‘대관 신청하기’에서 날짜·시간을 신청해 주세요.",
].join("\n");

/** 대관 안내 카드(요금·주의사항 + 신청 버튼). quickReplies 는 연결 여부에 따라 다르게 준다. */
export function kakaoRentalReply(origin: string, quickReplies: string[] = ["체험 문의", "상담 안내"]) {
  const base = origin.replace(/\/+$/, "");
  return buildKakaoSkillResponse({
    title: "체육관 대관 안내",
    text: KAKAO_RENTAL_TEXT,
    buttons: [{ action: "webLink", label: "대관 신청하기", webLinkUrl: `${base}/rental` }],
    quickReplies,
  });
}
