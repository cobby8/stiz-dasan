// 관리자 학생 상세 화면에서 쓰는 순수 표시 규칙(실행 테스트: tests/student-detail-format.test.mjs).
// 화면 파일이 커서 테스트로 직접 돌리기 어렵기 때문에, 판단이 들어간 두 가지만 여기로 뺐다.

/**
 * 시트에서 온 시각 글자를 «15:45» 같은 24시간 표기로 바꾼다.
 * 예) "오후 3:45:00" → "15:45", "오전 12:10" → "00:10", "9:05" → "09:05", "PM 3:45" → "15:45".
 * 시각 모양이 아니면(«하교 후» 등) 원문을 그대로 돌려준다 — 정보를 지우지 않는다.
 */
export function toHhmm(raw: string | null | undefined): string | null {
    if (!raw || !raw.trim()) return null;
    const text = raw.trim();
    const m = text.match(/^(오전|오후|AM|PM)?\s*(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)?$/i);
    if (!m) return text;
    const marker = (m[1] || m[4] || "").toUpperCase();
    let hour = Number(m[2]);
    const minute = Number(m[3]);
    if (hour > 23 || minute > 59) return text;
    // 오후 1~11시는 12를 더하고, 오전 12시는 0시로 본다(엑셀 한국어 표기 관례)
    if ((marker === "오후" || marker === "PM") && hour < 12) hour += 12;
    if ((marker === "오전" || marker === "AM") && hour === 12) hour = 0;
    return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

type MonthRow = { year: number | null; month: number | null };

/**
 * 월별 장부 중 «요약 칸»에 보여줄 달을 고른다.
 * - 오늘(KST «YYYY-MM-DD») 달의 기록이 있으면 그 달 → isThisMonth: true («이번 달 요약»)
 * - 없으면 가장 최근 기록(목록은 최신순) → isThisMonth: false («최근 장부 요약 · 9월»처럼 라벨을 바꾼다)
 * - 기록이 아예 없으면 null
 * 예전에는 «없으면 최근 달»로 넘어가면서도 제목은 «이번 달»이라 11월에 9월이 «이번 달»로 보였다.
 */
export function pickMonthSummary<T extends MonthRow>(rows: T[], todayYmd: string): { row: T; isThisMonth: boolean } | null {
    const year = Number(todayYmd.slice(0, 4));
    const month = Number(todayYmd.slice(5, 7));
    const current = rows.find((r) => r.year === year && r.month === month);
    if (current) return { row: current, isThisMonth: true };
    return rows[0] ? { row: rows[0], isThisMonth: false } : null;
}
