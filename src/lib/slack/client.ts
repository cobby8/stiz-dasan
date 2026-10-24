/**
 * 슬랙 Web API 최소 클라이언트 — 메시지 보내기(chat.postMessage)·고치기(chat.update) 두 개뿐.
 *
 * ⚠️ 슬랙은 실패해도 HTTP 200 을 주고 본문에 `{ ok: false, error }` 를 담는다.
 *    HTTP 상태만 보면 실패를 성공으로 착각한다 → `ok` 값을 반드시 확인한다.
 * ⚠️ 토큰(SLACK_BOT_TOKEN)은 절대 로그·에러 문구에 넣지 않는다.
 *
 * 필요한 봇 권한(scope): chat:write (DM 을 보낼 때 im:write 도 함께 둔다)
 */

export type SlackBlock = Record<string, unknown>;

export type SlackMessageResult = { channel: string; ts: string };

/** 슬랙 API 호출 실패. 비밀값은 담지 않는다. */
export class SlackApiError extends Error {
    slackError: string;
    constructor(message: string, slackError: string) {
        super(message);
        this.name = "SlackApiError";
        this.slackError = slackError;
    }
}

function readToken(): string {
    const token = (process.env.SLACK_BOT_TOKEN ?? "").trim();
    if (!token) {
        // 이 예외는 호출한 쪽이 잡아 알림을 FAILED 로 남긴다(스윕이 나중에 다시 시도).
        throw new SlackApiError("슬랙 봇 토큰(SLACK_BOT_TOKEN)이 설정되지 않아 메시지를 보내지 못했습니다.", "no_token");
    }
    return token;
}

async function callSlack(method: "chat.postMessage" | "chat.update", body: Record<string, unknown>) {
    const token = readToken();
    let response: Response;
    try {
        response = await fetch(`https://slack.com/api/${method}`, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json; charset=utf-8",
            },
            body: JSON.stringify(body),
            cache: "no-store",
            // 슬랙이 느려도 요청 전체가 끌려가지 않도록 끊는다.
            signal: AbortSignal.timeout(8000),
        });
    } catch (error) {
        throw new SlackApiError(`슬랙 서버에 연결하지 못했습니다(${method}): ${(error as Error).message}`, "network");
    }
    type SlackResponse = { ok?: boolean; error?: string; channel?: string; ts?: string };
    let json: SlackResponse | null = null;
    try {
        json = (await response.json()) as SlackResponse;
    } catch {
        json = null;
    }
    // HTTP 200 이어도 ok:false 면 실패다.
    if (!response.ok || !json || json.ok !== true) {
        const code = json?.error ?? `http_${response.status}`;
        throw new SlackApiError(`슬랙 API 오류(${method}): ${code}`, code);
    }
    return { channel: String(json.channel ?? body.channel ?? ""), ts: String(json.ts ?? body.ts ?? "") };
}

/** 메시지 보내기. channel 에 사용자 ID(U…)를 넣으면 봇과의 DM 으로 간다. */
export async function postMessage(input: { channel: string; text: string; blocks?: SlackBlock[] }): Promise<SlackMessageResult> {
    return callSlack("chat.postMessage", {
        channel: input.channel,
        text: input.text, // 알림 미리보기·블록을 못 보는 환경용 대체 문구
        blocks: input.blocks,
        unfurl_links: false,
    });
}

/** 이미 보낸 메시지 고치기(버튼 제거 + 처리 결과 한 줄 덧붙이기). */
export async function updateMessage(input: {
    channel: string;
    ts: string;
    text: string;
    blocks?: SlackBlock[];
}): Promise<SlackMessageResult> {
    return callSlack("chat.update", {
        channel: input.channel,
        ts: input.ts,
        text: input.text,
        blocks: input.blocks,
    });
}

/**
 * 버튼을 누른 사람에게만 보이는 답(ephemeral). response_url 로 보낸다(토큰 불필요).
 * 실패해도 조용히 넘어간다 — 이 답이 안 가도 데이터는 바뀌지 않았다.
 */
export async function respondEphemeral(responseUrl: string, text: string): Promise<void> {
    // 슬랙이 준 주소가 아니면 보내지 않는다(임의 주소로 요청을 흘리는 것 방지).
    if (!/^https:\/\/hooks\.slack\.com\//.test(responseUrl)) return;
    try {
        await fetch(responseUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json; charset=utf-8" },
            body: JSON.stringify({ response_type: "ephemeral", replace_original: false, text }),
            signal: AbortSignal.timeout(5000),
        });
    } catch {
        /* 무시 */
    }
}
