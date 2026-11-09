// 학부모 설정 화면의 «순수 규칙» 한 곳 (2026-11-10 원장 결정 k7·m5).
// DB·브라우저를 모르는 함수만 둔다 — 발송 쪽(pushNotification)·설정 화면·머리줄이 같은 규칙을 함께 쓰고,
// 테스트가 그대로 불러 실행할 수 있게.

// ── 앱 알림(웹푸시) 종류별 받기 ─────────────────────────────────────────────
// 학부모가 끌 수 있는 종류는 넷. 그 밖의 알림(문의 답변·수강 변경 결과·대기 안내 등)은
// «내 신청의 결과»라 끄면 놓치므로 늘 보낸다(종 목록에는 끈 종류도 그대로 쌓인다 — 끄는 건 휴대폰 울림만).
export const PUSH_CATEGORIES = [
    { key: "attendance", label: "출결", column: "pushAttendance" },
    { key: "billing", label: "청구", column: "pushBilling" },
    { key: "notice", label: "공지", column: "pushNotice" },
    { key: "shuttle", label: "셔틀", column: "pushShuttle" },
] as const;

export type PushCategory = (typeof PUSH_CATEGORIES)[number]["key"];
export type PushPrefs = Record<PushCategory, boolean>;

/** 아무것도 저장하지 않은 학부모 = 전부 받기 */
export const DEFAULT_PUSH_PREFS: PushPrefs = { attendance: true, billing: true, notice: true, shuttle: true };

/**
 * 알림 종류 값(Notification.type = 푸시 tag)을 «끌 수 있는 종류»로 바꾼다. 끌 수 없는 알림은 null.
 * 발송하는 쪽은 모두 tag 에 알림 종류를 넣는다(createNotificationRecord·notifyAllParents·운영 알림 대기열).
 */
export function pushCategoryOf(tag: string | null | undefined): PushCategory | null {
    const t = String(tag ?? "").trim().toUpperCase();
    if (!t) return null;
    // 출결: 출석·지각·결석 처리 알림(ATTENDANCE…)
    if (t.startsWith("ATTENDANCE")) return "attendance";
    // 청구: 청구서·납부 안내(PAYMENT, PAYMENT_REQUEST …)
    if (t.startsWith("PAYMENT")) return "billing";
    // 공지: 학원 공지(NOTICE…)
    if (t.startsWith("NOTICE")) return "notice";
    // 셔틀: 배정·시간 확정·명단 변경(SHUTTLE_…)
    if (t.startsWith("SHUTTLE")) return "shuttle";
    return null;
}

/** 화면이 보낸 값을 네 칸짜리 설정으로 정리한다(모르는 칸은 버리고, 빠진 칸은 «받기»). */
export function normalizePushPrefs(input: unknown): PushPrefs {
    const src = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
    const out = { ...DEFAULT_PUSH_PREFS };
    for (const c of PUSH_CATEGORIES) {
        if (typeof src[c.key] === "boolean") out[c.key] = src[c.key] as boolean;
    }
    return out;
}

// ── 글자 크기 ────────────────────────────────────────────────────────────────
// html 루트 글자 크기를 바꾸면 rem 으로 잡힌 글자·여백이 함께 커진다(화면 전체가 고르게 커짐).
// 쿠키에 저장해 서버가 처음 그릴 때부터 그 크기로 그린다 — 브라우저 저장소만 쓰면 «작게 떴다가 커지는» 깜빡임이 생긴다.
export const FONT_SCALE_COOKIE = "stiz_parent_font";
export const FONT_SCALES = [
    { key: "md", label: "보통", percent: 100 },
    { key: "lg", label: "크게", percent: 112.5 },
    { key: "xl", label: "아주 크게", percent: 125 },
] as const;
export type FontScaleKey = (typeof FONT_SCALES)[number]["key"];

/** 쿠키 값 → 글자 크기 이름. 모르는 값은 «보통» */
export function parseFontScale(value: string | null | undefined): FontScaleKey {
    const found = FONT_SCALES.find((s) => s.key === value);
    return found ? found.key : "md";
}

/** 글자 크기 이름 → html 글자 배율(%) */
export function fontScalePercent(key: FontScaleKey): number {
    return FONT_SCALES.find((s) => s.key === key)?.percent ?? 100;
}

// ── 테마(어둡게) ─────────────────────────────────────────────────────────────
// 원장 결정 m5: 다크모드 작업 때 함께 연다. 지금은 설정 화면에서 항목을 숨긴다(자리만).
export const SHOW_THEME_SETTING = false;

// ── 알림 배지 숫자 ───────────────────────────────────────────────────────────
/** 안 읽은 알림 수 배지 글자 — 0 이면 배지 없음, 10 이상은 «9+» */
export function unreadBadgeText(count: number): string | null {
    const n = Math.max(0, Math.floor(Number(count) || 0));
    if (n === 0) return null;
    return n > 9 ? "9+" : String(n);
}

// ── 내 정보 ─────────────────────────────────────────────────────────────────
/** 이름 검사 — 앞뒤 빈칸 정리, 1~30자. 맞으면 정리된 이름, 아니면 null */
export function cleanDisplayName(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const name = value.replace(/\s+/g, " ").trim();
    if (name.length < 1 || name.length > 30) return null;
    // 꺾쇠·제어 문자는 받지 않는다(알림 문구·문자에 그대로 들어간다)
    if (/[<>\u0000-\u001f]/.test(name)) return null;
    return name;
}

/** 새 비밀번호 검사 — 가입 화면과 같은 8자 이상, 최대 72자(Supabase 한도). 문제면 안내문, 괜찮으면 null */
export function newPasswordProblem(current: string, next: string, confirm: string): string | null {
    if (!current) return "지금 비밀번호를 입력해 주세요.";
    if (next.length < 8) return "새 비밀번호는 8자 이상 입력해 주세요.";
    if (next.length > 72) return "새 비밀번호는 72자 이하로 입력해 주세요.";
    if (next !== confirm) return "새 비밀번호가 서로 다릅니다.";
    if (next === current) return "지금 비밀번호와 다른 비밀번호를 입력해 주세요.";
    return null;
}
