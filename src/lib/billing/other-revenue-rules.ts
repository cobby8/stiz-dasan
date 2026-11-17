/**
 * 기타 매출(OtherRevenue) — 순수 규칙(값 목록·화면 글자·입력 확인).
 *
 * 왜 따로 두나: prisma·next 를 import 하지 않아야 `node --test`(npm run test:guards)로 바로 시험할 수 있고,
 *   화면(클라이언트)과 서버가 같은 목록·같은 확인 규칙을 쓴다. 값 목록은 마이그레이션 CHECK 와 같은 집합이어야 한다
 *   (다르면 DB 가 저장을 통째로 거부한다 — 테스트가 마이그레이션 파일과 비교한다).
 *
 * ⚠️ 이 파일은 kst.ts 말고는 import 하지 않는다.
 */
// @ts-expect-error -- Node 타입 제거 기반 단위 테스트는 런타임 확장자를 요구한다.
import { addMonthsYm, isKstYmd } from "../datetime/kst.ts";

/** 분류(DB CHECK 와 같은 집합) */
export const OTHER_REVENUE_CATEGORIES = ["SCHOOL_CLUB", "SPECIAL_NON_STUDENT", "RENTAL", "OTHER"] as const;
export type OtherRevenueCategory = (typeof OTHER_REVENUE_CATEGORIES)[number];

/** 결제수단(DB CHECK 와 같은 집합) */
export const OTHER_REVENUE_METHODS = ["BANK", "CARD_POS", "CASH", "VOUCHER", "OTHER"] as const;
export type OtherRevenueMethod = (typeof OTHER_REVENUE_METHODS)[number];

/** 화면에 보이는 분류 이름 — 저장값은 영어, 화면은 한국어 */
export const OTHER_REVENUE_CATEGORY_LABEL: Record<OtherRevenueCategory, string> = {
    SCHOOL_CLUB: "학교 스포츠클럽",
    SPECIAL_NON_STUDENT: "특강(사이트 학생 아님)",
    RENTAL: "대관",
    OTHER: "기타",
};

/** 화면에 보이는 결제수단 이름 */
export const OTHER_REVENUE_METHOD_LABEL: Record<OtherRevenueMethod, string> = {
    BANK: "계좌이체",
    CARD_POS: "카드(POS)",
    CASH: "현금",
    VOUCHER: "이용권",
    OTHER: "기타",
};

/** 글자 수 상한(DB CHECK 와 같은 값) */
export const OTHER_REVENUE_TITLE_MAX = 200;
export const OTHER_REVENUE_NOTE_MAX = 500;
/** 금액 상한 — DB 는 «0 보다 큼»만 본다. 0 을 하나 더 붙이는 오타를 막으려고 코드에서만 1억 원으로 묶는다 */
export const OTHER_REVENUE_MAX_AMOUNT = 100_000_000;

/** 화면에서 받은 값(확인 전) */
export type OtherRevenueInput = {
    revenueDate: unknown;
    category: unknown;
    title: unknown;
    amount: unknown;
    method: unknown;
    note?: unknown;
};

/** 확인을 통과한 저장 값 */
export type OtherRevenueDraft = {
    revenueDate: string;
    category: OtherRevenueCategory;
    title: string;
    amount: number;
    method: OtherRevenueMethod;
    note: string | null;
};

/** 원장이 읽을 수 있는 문장만 담는 오류 — 서버 동작은 이 오류의 글만 화면에 그대로 보인다 */
export class OtherRevenueError extends Error {}

const isCategory = (value: string): value is OtherRevenueCategory => (OTHER_REVENUE_CATEGORIES as readonly string[]).includes(value);
const isMethod = (value: string): value is OtherRevenueMethod => (OTHER_REVENUE_METHODS as readonly string[]).includes(value);

/** 화면 입력을 확인해 저장 값으로 바꾼다. 틀리면 OtherRevenueError(한국어 문장)를 던진다. */
export function validateOtherRevenueInput(input: OtherRevenueInput): OtherRevenueDraft {
    // 날짜: KST 달력 날짜 문자열이고 실제로 있는 날(2월 30일 같은 날은 거절)
    const revenueDate = typeof input.revenueDate === "string" ? input.revenueDate.trim() : "";
    if (!isKstYmd(revenueDate)) throw new OtherRevenueError("날짜를 골라 주세요.");

    const category = typeof input.category === "string" ? input.category.trim() : "";
    if (!isCategory(category)) throw new OtherRevenueError("분류를 골라 주세요.");

    const title = typeof input.title === "string" ? input.title.trim() : "";
    if (!title) throw new OtherRevenueError("내용을 적어 주세요.");
    if (title.length > OTHER_REVENUE_TITLE_MAX) throw new OtherRevenueError(`내용은 ${OTHER_REVENUE_TITLE_MAX}자까지 적을 수 있습니다.`);

    // 금액: «150,000원»처럼 쉼표·«원»이 섞여 와도 받는다. 1원 이상 원 단위 정수만(소수·0·음수 거절)
    const rawAmount = typeof input.amount === "number" ? input.amount : String(input.amount ?? "").replace(/[,\s원]/g, "");
    const amount = typeof rawAmount === "number" ? rawAmount : rawAmount === "" ? NaN : Number(rawAmount);
    if (!Number.isSafeInteger(amount) || amount <= 0 || amount > OTHER_REVENUE_MAX_AMOUNT) {
        throw new OtherRevenueError(`금액은 1원부터 ${OTHER_REVENUE_MAX_AMOUNT.toLocaleString("ko-KR")}원까지 원 단위 숫자로 적어 주세요.`);
    }

    const method = typeof input.method === "string" ? input.method.trim() : "";
    if (!isMethod(method)) throw new OtherRevenueError("결제수단을 골라 주세요.");

    const noteRaw = typeof input.note === "string" ? input.note.trim() : "";
    if (noteRaw.length > OTHER_REVENUE_NOTE_MAX) throw new OtherRevenueError(`메모는 ${OTHER_REVENUE_NOTE_MAX}자까지 적을 수 있습니다.`);

    return { revenueDate, category, title, amount, method, note: noteRaw || null };
}

/**
 * "YYYY-MM" 한 달의 날짜 범위 [시작일, 다음 달 1일) — SQL 에서 문자열 비교로 쓴다.
 * 잘못된 달이면 null. (날짜를 문자열로 저장하므로 시간대가 끼지 않는다)
 */
export function otherRevenueMonthRange(ym: unknown): { from: string; to: string } | null {
    const value = typeof ym === "string" ? ym.trim() : "";
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) return null;
    const next = addMonthsYm(value, 1) as string;
    return { from: `${value}-01`, to: `${next}-01` };
}
