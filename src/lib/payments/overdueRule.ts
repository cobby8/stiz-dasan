/**
 * 연체 판정 SQL — 한국 날짜 기준(2026-11-13).
 *
 * 왜: 예전 `"dueDate"::date < CURRENT_DATE` 는 DB 세션 시간대(UTC) 날짜라, 한국 00:00~09:00 에는
 *     «어제»와 비교해 연체 표시가 9시간 늦었다(납부기한 다음 날 아침 9시가 되어야 연체).
 *
 * "Payment"."dueDate" 는 시간대 없는 칸(timestamp)이라 AT TIME ZONE 을 «두 번» 건다:
 *   ("dueDate" AT TIME ZONE 'UTC') = 이 값을 UTC 로 읽어 timestamptz 로 → AT TIME ZONE 'Asia/Seoul' = 한국 벽시계.
 *   (관리자 일일 요약 admin-daily-digest-service 와 같은 방식. 납부기한은 «그날 00:00»으로 저장돼 하루가 밀리지 않는다)
 * 오늘은 NOW()(timestamptz)라 «한 번»만 건다.
 *
 * 이 파일은 다른 모듈을 import 하지 않는다(테스트에서 그대로 실행).
 */

/** 납부기한의 한국 날짜 */
export const PAYMENT_DUE_KST_DATE_SQL = `((("dueDate" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Seoul')::date)`;

/** 한국 오늘 */
export const KST_TODAY_SQL = `((NOW() AT TIME ZONE 'Asia/Seoul')::date)`;

/** 미납(PENDING) 중 납부기한이 한국 날짜로 지난 결제 — 기한 당일까지는 연체가 아니다 */
export const OVERDUE_PAYMENT_CANDIDATES_SQL =
    `SELECT id FROM "Payment" WHERE status = 'PENDING' AND ${PAYMENT_DUE_KST_DATE_SQL} < ${KST_TODAY_SQL}`;
