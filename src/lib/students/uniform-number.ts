// 학생 유니폼 번호(등번호) 규칙 — 화면 입력칸과 저장 서버 액션이 같은 함수를 쓴다(2026-11-16 원장 지시).
// 번호는 두 칸이다: 취미반 = Student."uniformNumber", 대표팀 = Student."teamUniformNumber" (둘 다 TEXT, 없으면 null).
// 숫자 글자 그대로 둔다("0"·"23"). ⚠️ "0" 은 «번호 없음»이 아니라 등번호 0 이다 — 참/거짓으로 판정하지 말 것.

/** 번호 최대 글자 수 — 입력칸 maxLength 와 서버 검증이 같은 값을 쓴다 */
export const UNIFORM_NUMBER_MAX_LENGTH = 3;

export type UniformNumberResult =
    | { ok: true; value: string | null }
    | { ok: false; error: string };

/**
 * 입력한 유니폼 번호를 저장할 값으로 바꾼다.
 * - 비우면(공백만 포함) null — «번호 없음»
 * - 숫자만, 최대 3자. 그 밖은 저장하지 않고 사유를 돌려준다
 * - "0"과 "00"은 서로 다른 등번호라 적힌 그대로 둔다(앞자리 0 을 지우지 않는다)
 */
export function normalizeUniformNumber(input: unknown, label = "유니폼 번호"): UniformNumberResult {
    if (input == null) return { ok: true, value: null };
    if (typeof input !== "string" && typeof input !== "number") {
        return { ok: false, error: `${label}는 숫자만 넣을 수 있습니다.` };
    }
    const text = String(input).trim();
    if (text === "") return { ok: true, value: null };
    if (!/^[0-9]+$/.test(text)) return { ok: false, error: `${label}는 숫자만 넣을 수 있습니다.` };
    if (text.length > UNIFORM_NUMBER_MAX_LENGTH) {
        return { ok: false, error: `${label}는 ${UNIFORM_NUMBER_MAX_LENGTH}자까지 넣을 수 있습니다.` };
    }
    return { ok: true, value: text };
}

/** 화면에 보일 글자 — 번호가 있으면 «23번»("0" 이면 «0번»), 없으면 «번호 없음» */
export function uniformNumberLabel(value: string | null | undefined): string {
    const text = (value ?? "").trim();
    // 길이로 본다 — "0" 도 번호다
    return text.length > 0 ? `${text}번` : "번호 없음";
}

/**
 * 유니폼 상태 옆에 덧붙이는 짧은 표기 — «취미 23 · 대표 0»처럼 값이 있는 것만.
 * 둘 다 없으면 빈 글자(덧붙이지 않는다).
 */
export function uniformNumbersInline(hobby: string | null | undefined, team: string | null | undefined): string {
    const h = (hobby ?? "").trim();
    const t = (team ?? "").trim();
    return [h.length > 0 ? `취미 ${h}` : null, t.length > 0 ? `대표 ${t}` : null].filter((v) => v !== null).join(" · ");
}
