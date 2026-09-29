/**
 * 토스플레이스 Open API — **조회 전용** 클라이언트 (한 벌만 존재한다)
 *
 * 왜 여기 있나: CLI(scripts/tossplace-reconcile.mjs)와 웹앱(reconcileService.ts)이
 * 각자 fetch 를 들고 있으면, 한쪽만 고쳐졌을 때 "어제까지 맞던 금액"이 조용히 갈린다.
 * 그래서 호출 코드는 이 파일 하나만 쓴다.
 *
 * ⚠️ 이 파일은 **타입만 지우면 그대로 실행되는 문법(erasable syntax)** 으로만 쓴다.
 *    CLI 는 node 가 직접 이 .ts 를 읽어 타입을 걷어내고 실행한다(node 22.18+ / 25.x).
 *    enum·namespace·파라미터 프로퍼티 같은 "실행 코드를 만들어내는 문법"을 쓰면 CLI 가 죽는다.
 *
 * 안전장치: GET 이 아니거나 허용된 주문목록 경로가 아니면 **보내기 전에** 예외를 던진다
 *          (assertReadOnlyTossRequest). 결제를 취소·변경하는 호출은 원천적으로 나갈 수 없다.
 */

import { TOSS_API_BASE, assertReadOnlyTossRequest } from "./tossplace-match.mjs";

/** 한 번에 받아오는 주문 수. 토스 권장 상한 안쪽으로 둔다. */
export const TOSS_PAGE_SIZE = 500;

/** 안전장치: 아무리 페이지가 많아도 여기서 멈춘다(무한 루프 방지). */
const MAX_PAGES = 200;

export type TossCredentials = {
    accessKey: string;
    secretKey: string;
    merchantId: string;
};

export type TossOrderFetchResult = {
    /** 토스가 내려준 주문 원본 배열 */
    orders: unknown[];
    /** 마지막 응답의 추적용 이벤트 ID(문의 시 토스에 알려주는 값) */
    eventId: string;
    /** 실제로 받아온 페이지 수 */
    pages: number;
};

export type TossApiError = Error & {
    httpStatus?: number;
    errorCode?: string;
    eventId?: string;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * GET 요청 한 번. 429(초당 10건 제한)는 reset 헤더까지 기다렸다가 최대 5회 재시도한다.
 * 실패 응답은 토스 봉투 규격({ resultType, error })을 사람이 읽는 한국어 문장으로 바꿔 던진다.
 */
export function createTossClient({ accessKey, secretKey }: { accessKey: string; secretKey: string }) {
    return async function request(
        method: string,
        pathname: string,
        query?: Record<string, string | number | undefined>,
    ): Promise<{ data: unknown[]; eventId: string }> {
        assertReadOnlyTossRequest(method, pathname); // GET·주문목록 외에는 여기서 막힌다
        const url = new URL(`${TOSS_API_BASE}${pathname}`);
        for (const [key, value] of Object.entries(query ?? {})) {
            if (value != null && value !== "") url.searchParams.set(key, String(value));
        }
        for (let attempt = 0; attempt < 5; attempt += 1) {
            const response = await fetch(url, {
                method: "GET",
                headers: {
                    "x-access-key": accessKey,
                    "x-secret-key": secretKey,
                    "Content-Type": "application/json",
                },
                cache: "no-store",
            });
            const eventId = response.headers.get("x-toss-event-id") ?? "(없음)";
            if (response.status === 429) {
                // 초당 10건 제한. reset 헤더(유닉스 ms)까지 기다렸다가 다시 시도한다.
                const reset = Number(response.headers.get("x-ratelimit-reset"));
                const waitMs = Number.isFinite(reset)
                    ? Math.max(200, reset - Date.now())
                    : 1000 * (attempt + 1);
                await sleep(Math.min(waitMs, 10_000));
                continue;
            }
            const text = await response.text();
            let body: any = null;
            try {
                body = text ? JSON.parse(text) : null;
            } catch {
                body = null;
            }
            if (!response.ok || body?.resultType === "FAIL") {
                const code = body?.error?.errorCode ?? "";
                const reason = body?.error?.reason ?? "";
                const error: TossApiError = new Error(
                    `토스플레이스 API 오류 (HTTP ${response.status}${code ? `, 오류코드 ${code}` : ""})` +
                        `${reason ? `: ${reason}` : ""} — 이벤트 ID ${eventId}`,
                );
                error.httpStatus = response.status;
                error.errorCode = code;
                error.eventId = eventId;
                throw error;
            }
            return { data: Array.isArray(body?.success) ? body.success : [], eventId };
        }
        throw new Error(
            "토스플레이스 API 호출 제한(429)이 계속돼 조회를 포기했습니다. 잠시 후 다시 실행해 주세요.",
        );
    };
}

/**
 * 기간 안의 주문을 전부 받아온다(페이지를 끝까지 넘긴다).
 * from/to 는 ISO 문자열(예: 2026-08-29T00:00:00+09:00). 끝은 열린 구간이다.
 */
export async function fetchTossOrders(params: {
    merchantId: string;
    from: string;
    to: string;
    accessKey: string;
    secretKey: string;
}): Promise<TossOrderFetchResult> {
    const { merchantId, from, to, accessKey, secretKey } = params;
    const request = createTossClient({ accessKey, secretKey });
    const pathname = `/merchants/${merchantId}/order/orders`;
    const orders: unknown[] = [];
    let lastEventId = "";
    let pages = 0;
    for (let page = 1; page <= MAX_PAGES; page += 1) {
        const { data, eventId } = await request("GET", pathname, {
            from,
            to,
            page,
            size: TOSS_PAGE_SIZE,
            sortOrder: "ASC",
        });
        pages = page;
        lastEventId = eventId;
        const list = Array.isArray(data) ? data : [];
        orders.push(...list);
        if (list.length < TOSS_PAGE_SIZE) break; // 마지막 페이지
    }
    return { orders, eventId: lastEventId, pages };
}
