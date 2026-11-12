/**
 * cron 실패 알림의 순수 핵심(d4, 2026-11-13) — 바깥 의존성(슬랙·캐시)은 인자로 받는다.
 *
 * 왜: 매일·매분 도는 자동 작업(cron)이 조용히 실패하면, 백업·청구·문자 발송이 며칠씩 멈춰도 아무도 모른다.
 * 그래서 예외가 나거나 500 이상 응답을 돌려주면 원장 슬랙으로 한 줄 알린다.
 * 같은 cron 이 계속 실패해도(매분 cron 은 한 시간에 60번) 알림은 **1시간에 1번**만 보낸다.
 *
 * 원래 동작은 그대로 둔다: 응답은 그대로 돌려주고, 예외도 그대로 다시 던진다(CRON_SECRET 검사·401 도 손대지 않음).
 * 알림 자체가 실패해도 cron 결과에는 영향이 없다.
 */

export const CRON_ALERT_WINDOW_MS = 60 * 60 * 1000;

export type CronAlertDeps = {
  /** 지금 시각(ms) — 테스트에서 바꿔 끼운다 */
  now: () => number;
  /**
   * 여러 서버가 같이 쓰는 «이번 시간 칸에 이미 보냈나» 확인 + 보내기.
   * 같은 (cron 이름, 시간 칸)으로는 한 번만 send 를 실행해야 한다.
   */
  sendOncePerWindow: (cronName: string, windowKey: number, text: string) => Promise<void>;
  /** 로그(기본 console.error) */
  log?: (...args: unknown[]) => void;
};

type Handler<Args extends unknown[]> = (...args: Args) => Promise<Response> | Response;

/** 오류 문구를 짧게 — 슬랙 한 줄에 맞추고, 긴 스택·본문이 그대로 가지 않게 */
export function shortReason(value: unknown, max = 160): string {
  const text = value instanceof Error ? `${value.name}: ${value.message}` : String(value ?? "");
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine || "(내용 없음)";
}

export function buildCronAlertText(cronName: string, reason: string): string {
  return `⚠️ [자동 작업 실패] ${cronName} — ${reason} (같은 작업은 1시간에 1번만 알려요. Vercel 로그에서 자세히 확인)`;
}

/** 500 응답 본문에서 error/message 한 줄만 뽑는다(못 읽으면 상태 코드만) */
async function reasonFromResponse(res: Response): Promise<string> {
  try {
    const body = (await res.clone().json()) as { error?: unknown; message?: unknown } | null;
    const msg = body?.error ?? body?.message;
    if (typeof msg === "string" && msg.trim()) return `응답 ${res.status}: ${shortReason(msg)}`;
  } catch {
    // JSON 이 아니면 상태 코드만 알린다
  }
  return `응답 ${res.status}`;
}

export function createWithCronAlert(deps: CronAlertDeps) {
  const log = deps.log ?? ((...args: unknown[]) => console.error(...args));
  // 같은 서버 안에서는 메모리로 먼저 거른다(가장 싸다). 서버가 여러 대일 때는 sendOncePerWindow 가 거른다.
  const lastAlertAt = new Map<string, number>();

  async function alert(cronName: string, reason: string) {
    try {
      const now = deps.now();
      const last = lastAlertAt.get(cronName);
      if (last !== undefined && now - last < CRON_ALERT_WINDOW_MS) return;
      lastAlertAt.set(cronName, now);
      const windowKey = Math.floor(now / CRON_ALERT_WINDOW_MS);
      await deps.sendOncePerWindow(cronName, windowKey, buildCronAlertText(cronName, reason));
    } catch (error) {
      // 알림 실패는 cron 결과를 바꾸지 않는다 — 로그만 남긴다
      log(`[cron-alert] ${cronName} 알림 실패:`, shortReason(error));
    }
  }

  /**
   * 사용법: `export const GET = withCronAlert("backup", handleGet);`
   * - handler 가 던지면: 알림 → 같은 예외를 다시 던진다
   * - handler 가 500 이상을 돌려주면: 알림 → 같은 응답을 돌려준다
   */
  return function withCronAlert<Args extends unknown[]>(cronName: string, handler: Handler<Args>) {
    return async (...args: Args): Promise<Response> => {
      let res: Response;
      try {
        res = await handler(...args);
      } catch (error) {
        await alert(cronName, `예외: ${shortReason(error)}`);
        throw error;
      }
      if (res && res.status >= 500) {
        await alert(cronName, await reasonFromResponse(res));
      }
      return res;
    };
  };
}
