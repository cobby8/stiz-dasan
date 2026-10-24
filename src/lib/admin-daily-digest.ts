// 원장 아침 요약 알림 — 문구를 만드는 "순수 함수"만 둔다.
// DB·알림 발송은 admin-daily-digest-service.ts 가 맡는다.
// 이렇게 나누면 DB 없이도 문구(금액 콤마·0건 생략·월 라벨)를 실제로 실행해 테스트할 수 있다.

/** 청구 월별 미납 집계 한 줄 (SQL 이 KST 기준으로 묶어서 넘긴다) */
export type UnpaidMonthRow = {
  year: number;
  month: number; // 1~12
  count: number; // 미납 건수
  amount: number; // 미납 금액 합계(원)
  overdueCount: number; // 그중 납부기한(KST 날짜)이 지난 건수
};

export type AdminDigestInput = {
  todayYmd: string; // KST 오늘 "YYYY-MM-DD" (todayKst() 결과)
  unpaid: UnpaidMonthRow[];
  needsCheckCount: number; // 수강 변경: 사이트엔 반영됐지만 시트·랠리즈 확인이 남은 건
  pendingChangeCount: number; // 수강 변경: 승인 대기
  kakaoPendingCount?: number; // 카카오 접수: 원장 확인 대기(접수·보류·실패)
};

export type AdminDigest = { title: string; message: string; linkUrl: string };

/** 1234000 → "1,234,000원" (서버 로캘과 무관하게 같은 결과가 나오도록 직접 콤마를 찍는다) */
export function formatWon(amount: number): string {
  const n = Math.round(Number(amount) || 0);
  const sign = n < 0 ? "-" : "";
  return `${sign}${String(Math.abs(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}원`;
}

/** 연·월 숫자를 "2026년 10월" 로. Date 를 쓰지 않으므로 시간대가 끼어들 틈이 없다. */
export function monthLabel(year: number, month: number): string {
  return `${year}년 ${month}월`;
}

/** 연·월을 비교 가능한 하나의 숫자로 (2026년 10월 → 2026*12+9) */
function monthIndex(year: number, month: number): number {
  return year * 12 + (month - 1);
}

/**
 * 요약 알림 1건을 만든다. 확인할 일이 하나도 없으면 null(= 보내지 않음).
 * - 미납: 최근 3개월(이번 달·지난달·지지난달, 미리 청구된 다음 달 이후도 포함)은 월별로,
 *         그보다 오래된 건은 "그 이전" 한 줄로 합친다.
 * - 0건인 항목은 문구에서 뺀다("이상 없음" 같은 줄은 만들지 않는다).
 */
export function buildAdminDailyDigest(input: AdminDigestInput): AdminDigest | null {
  // 오늘(KST) 기준 이번 달 — "YYYY-MM-DD" 문자열에서 바로 꺼낸다
  const [ty, tm] = input.todayYmd.split("-").map(Number);
  const recentFrom = monthIndex(ty, tm) - 2; // 지지난달부터는 월별로 보여 준다

  const rows = input.unpaid.filter((r) => r.count > 0);
  const totalCount = rows.reduce((s, r) => s + r.count, 0);
  const totalAmount = rows.reduce((s, r) => s + Number(r.amount || 0), 0);
  const overdueCount = rows.reduce((s, r) => s + r.overdueCount, 0);

  const lines: string[] = [];
  const titleParts: string[] = [];

  if (totalCount > 0) {
    titleParts.push(`미납 ${totalCount}건`);
    const overdueText = overdueCount > 0 ? ` (기한 지남 ${overdueCount}건)` : "";
    lines.push(`[사이트 장부 미납] ${totalCount}건 · ${formatWon(totalAmount)}${overdueText}`);

    // 최근 월은 최신 달이 위로 오도록 내림차순
    const recent = rows
      .filter((r) => monthIndex(r.year, r.month) >= recentFrom)
      .sort((a, b) => monthIndex(b.year, b.month) - monthIndex(a.year, a.month));
    for (const r of recent) {
      lines.push(`- ${monthLabel(r.year, r.month)}: ${r.count}건 · ${formatWon(r.amount)}`);
    }
    // 오래된 달은 한 줄로 합친다
    const older = rows.filter((r) => monthIndex(r.year, r.month) < recentFrom);
    if (older.length > 0) {
      const c = older.reduce((s, r) => s + r.count, 0);
      const a = older.reduce((s, r) => s + Number(r.amount || 0), 0);
      lines.push(`- 그 이전: ${c}건 · ${formatWon(a)}`);
    }
  }

  if (input.needsCheckCount > 0) {
    titleParts.push(`수강 변경 확인 ${input.needsCheckCount}건`);
    lines.push(`[수강 변경 확인 필요] ${input.needsCheckCount}건 — 시트·랠리즈 반영 확인`);
  }
  if (input.pendingChangeCount > 0) {
    titleParts.push(`변경 승인 대기 ${input.pendingChangeCount}건`);
    lines.push(`[수강 변경 승인 대기] ${input.pendingChangeCount}건`);
  }
  // 카카오 접수 대기 — 0건이면 줄을 만들지 않는다
  const kakaoPendingCount = Number(input.kakaoPendingCount ?? 0);
  if (kakaoPendingCount > 0) {
    titleParts.push(`카카오 접수 대기 ${kakaoPendingCount}건`);
    lines.push(`[카카오 접수 대기] ${kakaoPendingCount}건`);
  }

  // 확인할 일이 없으면 알림 자체를 만들지 않는다
  if (titleParts.length === 0) return null;

  // 링크는 하나만 달 수 있으므로 가장 급한 화면으로: 미납 → 확인 필요 → 승인 대기 → 카카오 접수
  const linkUrl = totalCount > 0
    ? "/admin/finance"
    : input.needsCheckCount > 0
      ? "/admin/enrollment-changes?status=NEEDS_CHECK"
      : input.pendingChangeCount > 0
        ? "/admin/enrollment-changes"
        : "/admin/kakao-requests";

  return {
    title: `오늘 확인할 일: ${titleParts.join(" · ")}`,
    message: lines.join("\n"),
    linkUrl,
  };
}
