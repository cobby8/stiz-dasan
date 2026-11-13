/**
 * 비회원 결제 링크(/pay/<토큰>) 순수 규칙 — DB·crypto 를 쓰지 않는다(테스트에서 그대로 실행).
 *
 * ■ 왜 필요한가
 *   학부모 결제 화면(/payments/<청구서>)은 로그인이 필요하다. 학부모 124명 중 가입자가 17명이라
 *   청구 안내의 링크를 눌러도 대부분 로그인 화면에서 막혔다. 그래서 «청구서 한 장만» 열리는 비밀 링크를 만든다.
 *
 * ■ 규칙 요약
 *   - 토큰 = 32바이트 난수(base64url 43자). DB 에는 SHA-256 해시만 둔다(guestPayToken.ts).
 *   - 만료 = 납부기한(한국 날짜)과 발급일 중 늦은 날 + 14일, 그날 하루 끝까지(다음 날 0시 KST 에 만료).
 *     (이미 기한이 지난 미납 안내에도 링크가 바로 만료되지 않게 «발급일»도 함께 본다)
 *   - 결제 완료 = 링크로는 «납부 완료» 표시만(결제 불가). 청구 취소·환불·만료·폐기 = «링크가 만료됐거나 올바르지 않아요».
 *   - 잘못된 토큰과 만료된 토큰은 같은 문구 — 존재 여부를 구분해 알려주지 않는다.
 */
import { addDaysKst, isKstYmd, kstAt } from "@/lib/datetime/kst";

/** 링크 유효 기간(일) — 납부기한(또는 발급일) 뒤 이만큼 더 열린다 */
export const GUEST_PAY_LINK_GRACE_DAYS = 14;

/** 잘못된·만료·취소 링크 공통 문구(어떤 이유인지 구분하지 않는다) */
export const GUEST_PAY_INVALID_MESSAGE = "링크가 만료됐거나 올바르지 않아요 · 학원으로 문의해 주세요.";

/** 발급 경로 — DB CHECK 제약과 같은 집합(migration 20261114000000) */
export const GUEST_PAY_LINK_SOURCES = ["ADMIN_COPY", "INVOICE_NOTICE", "UNPAID_NOTICE"] as const;
export type GuestPayLinkSource = (typeof GUEST_PAY_LINK_SOURCES)[number];

/** 주소에서 받은 토큰의 모양 — 32바이트 base64url = 정확히 43자. 아니면 DB 를 부르지 않는다 */
export function isGuestPayTokenShape(token: unknown): token is string {
    return typeof token === "string" && /^[A-Za-z0-9_-]{43}$/.test(token);
}

/** 알림톡 버튼 변수·문자 링크에 들어가는 상대 경로(앞 «/» 없음 — BILLING_LINK_BASE 뒤에 붙는다) */
export function guestPayPath(token: string): string {
    return `pay/${token}`;
}

/**
 * 만료일(한국 날짜, 이날 하루 끝까지 유효) = max(납부기한, 발급일) + 14일.
 * 납부기한이 비었거나 형식이 틀리면 발급일 기준.
 */
export function guestPayLinkLastYmd(dueYmd: string | null | undefined, issueYmd: string): string {
    const base = isKstYmd(dueYmd) && String(dueYmd) > issueYmd ? String(dueYmd) : issueYmd;
    return addDaysKst(base, GUEST_PAY_LINK_GRACE_DAYS);
}

/** 만료 시각(절대 시각 ms) = 마지막 날 «다음 날» 0시(KST). 이 시각부터 링크가 닫힌다 */
export function guestPayLinkExpiresAtMs(dueYmd: string | null | undefined, issueYmd: string): number {
    return kstAt(addDaysKst(guestPayLinkLastYmd(dueYmd, issueYmd), 1));
}

/**
 * 학생 이름 가운데 가리기 — «권민호» → «권○호», «김호» → «김○», «남궁민수» → «남○○수».
 * 한 글자는 «○», 빈 값은 빈 값. 링크를 손에 넣은 다른 사람에게 아이 이름 전체를 보이지 않는다.
 */
export function maskStudentName(name: string | null | undefined): string {
    const chars = Array.from(String(name ?? "").trim());
    if (chars.length === 0) return "";
    if (chars.length === 1) return "○";
    if (chars.length === 2) return `${chars[0]}○`;
    return `${chars[0]}${"○".repeat(chars.length - 2)}${chars[chars.length - 1]}`;
}

/**
 * 글(청구 제목·설명) 안의 학생 이름을 가린 이름으로 바꾼다 — 관리자가 설명에 아이 이름을 적어 둔 경우 대비.
 * 두 글자 이상 이름만 바꾼다(한 글자는 다른 낱말까지 바뀔 수 있어 그대로 둔다).
 */
export function maskNameInText(text: string | null | undefined, name: string | null | undefined): string {
    const source = String(text ?? "");
    const full = String(name ?? "").trim();
    if (!source || Array.from(full).length < 2) return source;
    return source.split(full).join(maskStudentName(full));
}

/**
 * 비회원 화면·API 로 보내는 입금 계좌 — 필요한 칸만 골라 새로 만든다(예금주 이름 등 개인정보 칸 제외).
 * 토스 계좌의 customerName 은 결제자(학부모) 이름이라 링크를 받은 다른 사람에게 보이면 안 된다.
 */
export function toGuestVirtualAccountView<T extends {
    bankName: string; accountNumber: string; amount: number; dueDate: string; dueLabel: string; expired: boolean;
}>(view: T | null | undefined) {
    if (!view) return null;
    return {
        bankName: view.bankName,
        accountNumber: view.accountNumber,
        customerName: null,
        amount: view.amount,
        dueDate: view.dueDate,
        dueLabel: view.dueLabel,
        expired: view.expired,
    };
}

/** 링크 상태 판정에 필요한 칸(서버가 DB 에서 읽어 넘긴다 — expired 는 SQL 의 NOW() 비교 결과) */
export type GuestPayLinkStateInput = {
    revoked: boolean;
    expired: boolean;
    invoiceStatus: string | null | undefined;
    paymentStatus: string | null | undefined;
};

/** INVALID = 문구 하나로 막는다 · PAID = «납부 완료»만 · PAYABLE = 결제 화면 */
export type GuestPayLinkState = "INVALID" | "PAID" | "PAYABLE";

/**
 * 링크 상태 — 폐기·만료가 먼저(납부됐어도 만료 뒤에는 아무것도 보이지 않는다),
 * 그다음 취소·환불(INVALID), 납부 완료(PAID), 나머지 미납(PAYABLE).
 */
export function judgeGuestPayLink(input: GuestPayLinkStateInput): GuestPayLinkState {
    if (input.revoked || input.expired) return "INVALID";
    const invoiceStatus = String(input.invoiceStatus ?? "");
    const paymentStatus = String(input.paymentStatus ?? "");
    if (invoiceStatus === "CANCELED" || paymentStatus === "REFUNDED" || paymentStatus === "CANCELED") return "INVALID";
    if (invoiceStatus === "PAID" || paymentStatus === "PAID") return "PAID";
    if (!invoiceStatus || !paymentStatus) return "INVALID";
    return "PAYABLE";
}

/**
 * 청구 안내에 비회원 링크를 쓸까 — 학부모 계정이 «실제 로그인 계정과 연결되지 않은»(authUserId 없음) 경우.
 * 가입 안내 발송(customer-notice.ts resolveSignupGuide 의 hasAccount)과 같은 기준이다.
 * 판정이 틀려 가입자에게 비회원 링크가 가도 그 청구서는 그대로 결제된다(안전한 쪽으로 틀린다).
 */
export function shouldUseGuestPayLink(row: { parentId: string | null | undefined; parentHasAccount: boolean | null | undefined }): boolean {
    return Boolean(row.parentId) && row.parentHasAccount !== true;
}
