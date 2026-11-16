/**
 * «이 청구는 몇 월 청구인가» — SQL 조건 한 곳(2026-11-16 원장 지시: 12월 청구가 수납 관리 11월에 보였다).
 *
 * 규칙: 청구 월(Payment.year·month)이 있으면 **그것만** 본다. 청구 월이 빈 옛 청구만 납부 기한(dueDate)의 달로 대신한다.
 * 왜: 12월 수강료는 «11월 30일까지 미리 내기»라 기한이 11월이다. 기한으로 달을 정하면 12월 청구가 11월에 섞이고,
 * 11월 화면의 «청구서 안내» 버튼이 학부모에게 «11월 수강료»라고 보낸다.
 * 학부모 화면(monthBills·childRecordRules)·통계·하루 요약은 이미 이 규칙이다 — 관리자 수납 화면만 기한으로 보고 있었다.
 *
 * dueDate 는 무tz 칸에 KST 달력 날짜를 글자 그대로 넣는다(billing-due-date.ts) — 그래서 대신 비교도 날짜 글자 범위 그대로다.
 * prisma 를 import 하지 않는다(테스트가 그대로 읽는다).
 */
export function billingMonthMatchSql(alias: string, p: { year: string; month: string; dueStart: string; dueEnd: string }): string {
    const a = alias ? `${alias}.` : "";
    return `((${a}year = ${p.year} AND ${a}month = ${p.month})
         OR ((${a}year IS NULL OR ${a}month IS NULL) AND ${a}"dueDate" >= ${p.dueStart}::timestamp AND ${a}"dueDate" < ${p.dueEnd}::timestamp))`;
}
