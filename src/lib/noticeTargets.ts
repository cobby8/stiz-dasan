// 공지 «대상 반»(Notice.targetClassIds) 읽기 — 한 곳에서만 푼다.
//
// 왜 필요한가: 같은 칸에 두 가지 모양이 저장된다.
//   - 관리자 공지(actions/admin.ts) = 쉼표 문자열 "반A,반B"
//   - 선생님 반 공지(actions/staff-notices.ts) = JSON 배열 '["반A"]'
// 학부모 화면이 쉼표로만 나눠서, 선생님 반 공지가 '["반A"]' 한 덩어리로 읽혀 우리 반 공지인데도 안 보였다(2026-11-09 리뷰).
// 쓰는 쪽 모양은 그대로 두고(이미 저장된 공지·중복 방지 비교가 그 모양에 기대고 있다) 읽는 쪽만 둘 다 받는다.

/** "반A,반B" 또는 '["반A","반B"]' → ["반A","반B"]. 비었거나 깨진 값이면 [] */
export function parseNoticeTargetClassIds(value: unknown): string[] {
    if (Array.isArray(value)) return value.map((item) => String(item ?? "").trim()).filter(Boolean);
    if (typeof value !== "string") return [];
    const text = value.trim();
    if (!text) return [];
    if (text.startsWith("[")) {
        try {
            const parsed: unknown = JSON.parse(text);
            if (Array.isArray(parsed)) return parsed.map((item) => String(item ?? "").trim()).filter(Boolean);
        } catch {
            // JSON 처럼 보이지만 깨졌다 — 아래 쉼표 규칙으로 읽는다(괄호·따옴표는 걷어낸다)
        }
        return text.replace(/[[\]"]/g, "").split(",").map((item) => item.trim()).filter(Boolean);
    }
    return text.split(",").map((item) => item.trim()).filter(Boolean);
}
