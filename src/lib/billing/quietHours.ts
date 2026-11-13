/**
 * 청구·미납 안내 «야간 발송 금지» 규칙 — 한 곳(2026-11-13 원장 점검표 f11).
 *
 * ■ 왜
 *   밤늦게 «수강료 미납» 문자가 울리면 학부모에게 실례이고 민원이 된다.
 *   그래서 청구서 안내·미납 안내는 한국시간 밤 9시(21:00)부터 다음 날 아침 8시(08:00) 전까지 실제로 나가지 않는다.
 *   그 사이에 예약된 건은 지우지 않고 대기열(NotificationDelivery PENDING)에 그대로 두었다가,
 *   08:00 이후 첫 cron(manual-message-dispatch, 매분)이 보낸다.
 *
 * ■ 범위
 *   청구 안내 연결표(BillingNoticeDelivery)에 묶인 문자만. 인증번호·결석·학부모 공지 등 다른 문자는 영향 없다.
 *
 * ⚠️ 서버는 UTC 다 — 시각은 반드시 kst.ts 의 kstHm 으로 구한다(getHours() 금지).
 * ⚠️ 이 파일은 prisma·next 를 import 하지 않는다(관리자 화면·테스트에서도 그대로 쓴다).
 */
import { kstHm } from "@/lib/datetime/kst";

/** 야간 금지 시작 — 이 시각(KST, 시)부터 막는다 */
export const BILLING_QUIET_START_HOUR = 21;
/** 야간 금지 끝 — 이 시각(KST, 시)부터 다시 보낸다 */
export const BILLING_QUIET_END_HOUR = 8;

/** 관리자 화면 한 줄 안내(문구는 여기 한 곳에서만) */
export const BILLING_QUIET_HINT = "밤 9시~아침 8시에는 보내지 않고, 아침 8시에 차례로 보내집니다.";

/**
 * 지금(KST) 청구·미납 안내를 «보내면 안 되는» 시간인가.
 * 21:00 ≤ 시각 또는 시각 < 08:00 이면 true. (20:59 → false · 21:00 → true · 07:59 → true · 08:00 → false)
 */
export function isBillingQuietHour(nowMs: number = Date.now()): boolean {
    const hm = kstHm(nowMs);
    // 시각을 못 읽으면(이론상 없음) 안전 쪽 = 보내지 않음
    if (!/^\d{2}:\d{2}$/.test(hm)) return true;
    const hour = Number(hm.slice(0, 2));
    return hour >= BILLING_QUIET_START_HOUR || hour < BILLING_QUIET_END_HOUR;
}
