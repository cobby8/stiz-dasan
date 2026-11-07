// POS 플러그인 «롱폴링»(오래 기다리는 조회) 순수 규칙 — DB·시계·잠자기를 인자로 받아 테스트에서 가짜로 꽂는다.
//
// 왜 필요한가(2026-11-08 원장 요청 «사이트에서 누르면 POS 결제창이 바로»):
//   예전엔 플러그인이 14초마다 물어봐서 최대 14초 늦었다. 이제 플러그인이 «최대 20초까지 기다려 줘» 하고 물으면,
//   서버가 그동안 약 1초마다 가벼운 SELECT 로 새 요청을 확인하다가 생기는 즉시 답한다(전화를 끊지 않고 기다리는 것과 같다).
//   토스 POS 요청 한도(60초 100번·30분 200번)는 «답을 받은 횟수» 기준이라 오래 기다릴수록 오히려 덜 쓴다.

/** 한 번에 기다리는 최대 초. Vercel 함수 시간(maxDuration 30초) 안에 여유 있게 끝나야 한다 */
export const MAX_WAIT_SEC = 20;
/** 기다리는 동안 DB 를 다시 보는 간격 — 1초당 가벼운 SELECT 1번 */
export const WAIT_TICK_MS = 1_000;
/** known(이미 본 요청 id) 최대 개수 — 주소 길이·SQL 인자 크기 상한 */
export const MAX_KNOWN_IDS = 20;

const ID_RE = /^[0-9a-f-]{10,64}$/i;

/**
 * ?wait= 값 → 기다릴 초(정수 0~20). 없거나 이상한 값이면 0(= 예전처럼 바로 답).
 * @param {unknown} raw
 * @returns {number}
 */
export function parseWaitSeconds(raw) {
    if (raw === null || raw === undefined || raw === "") return 0;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return Math.min(MAX_WAIT_SEC, Math.floor(n));
}

/**
 * ?known= 값(쉼표로 이은 요청 id) → 검사한 id 목록(최대 20개, 모양이 틀린 건 버림).
 * 플러그인이 «이미 알림을 띄운 대기 요청»을 알려 주는 칸이다. 이걸 빼면 결제를 못 연 대기 요청 하나 때문에
 * 서버가 매번 즉시 답해 플러그인이 1초마다 다시 묻게 된다(요청 한도 소진).
 * @param {unknown} raw
 * @returns {string[]}
 */
export function parseKnownIds(raw) {
    if (typeof raw !== "string" || !raw) return [];
    const out = [];
    for (const part of raw.split(",")) {
        const id = part.trim();
        if (ID_RE.test(id) && !out.includes(id)) out.push(id);
        if (out.length >= MAX_KNOWN_IDS) break;
    }
    return out;
}

/**
 * 목록 안에 «플러그인이 아직 모르는» 대기(PENDING) 요청이 있는지.
 * @param {{ id: string, status: string }[]} rows
 * @param {string[]} known
 */
export function hasUnknownPending(rows, known) {
    const seen = new Set(known);
    return rows.some((r) => r.status === "PENDING" && !seen.has(r.id));
}

/**
 * 롱폴링 대기 루프.
 *   1) 먼저 목록을 읽는다(listNow). 모르는 대기 요청이 있거나 wait=0 이면 바로 그 목록을 돌려준다.
 *   2) 없으면 약 1초마다 hasNew()(가벼운 EXISTS 조회)를 부른다. 참이면 목록을 다시 읽어 돌려준다.
 *   3) waitSec 이 지나면(또는 클라이언트가 끊으면) 처음 읽은 목록을 그대로 돌려준다(응답 모양은 예전과 같음).
 *
 * @template T
 * @param {{
 *   waitSec: number,
 *   known: string[],
 *   listNow: () => Promise<T[]>,
 *   hasNew: (known: string[]) => Promise<boolean>,
 *   now?: () => number,
 *   sleep?: (ms: number) => Promise<void>,
 *   signal?: { aborted: boolean } | null,
 *   tickMs?: number,
 * }} opts
 * @returns {Promise<{ rows: T[], waited: boolean, woke: "immediate" | "new" | "timeout" | "aborted" }>}
 */
export async function waitForChargeRequests(opts) {
    const now = opts.now ?? (() => Date.now());
    const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    const tick = opts.tickMs ?? WAIT_TICK_MS;
    const waitSec = parseWaitSeconds(opts.waitSec);
    const known = Array.isArray(opts.known) ? opts.known : [];

    const first = await opts.listNow();
    // wait=0(옛 플러그인·탭 화면) 이거나 새 대기 요청이 이미 있으면 기다리지 않는다
    if (waitSec === 0) return { rows: first, waited: false, woke: "immediate" };
    if (hasUnknownPending(/** @type {any} */ (first), known)) return { rows: first, waited: true, woke: "immediate" };

    const deadline = now() + waitSec * 1000;
    while (true) {
        if (opts.signal?.aborted) return { rows: first, waited: true, woke: "aborted" };
        const left = deadline - now();
        if (left <= 0) return { rows: first, waited: true, woke: "timeout" };
        // 남은 시간이 1초보다 짧으면 그만큼만 잔다(상한을 넘기지 않게)
        await sleep(Math.min(tick, left));
        if (opts.signal?.aborted) return { rows: first, waited: true, woke: "aborted" };
        if (now() >= deadline) return { rows: first, waited: true, woke: "timeout" };
        if (await opts.hasNew(known)) {
            const rows = await opts.listNow();
            return { rows, waited: true, woke: "new" };
        }
    }
}
