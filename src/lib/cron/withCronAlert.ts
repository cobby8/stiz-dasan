/**
 * cron 실패 슬랙 알림 래퍼(d4, 2026-11-13) — 실제 연결부. 핵심 규칙은 cronAlertCore.ts.
 *
 * 사용법(새 cron 도 이렇게):
 *   async function handleGet(req: NextRequest) { ...기존 GET 본문 그대로... }
 *   export const GET = withCronAlert("cron-이름", handleGet);
 *
 * 받는 곳: CRON_ALERT_SLACK_CHANNEL(있으면) → 없으면 SLACK_OWNER_USER_ID(원장 DM).
 * 둘 다 없거나 SLACK_BOT_TOKEN 이 없으면 로그만 남기고 조용히 넘어간다.
 *
 * «1시간에 1번»을 여러 서버가 같이 지키는 방법:
 *   Next 데이터 캐시(unstable_cache)에 (cron 이름, 시간 칸) 키로 «보냈다»를 남긴다. 같은 키로 다시 부르면
 *   캐시에서 바로 돌아와 슬랙을 다시 부르지 않는다. 보내기가 실패하면 캐시에 남지 않아 다음 실패 때 다시 시도한다.
 *   (스키마를 늘리지 않으려고 고른 방법 — 캐시가 비워지면 드물게 한 번 더 갈 수 있다)
 */
import { unstable_cache } from "next/cache";
import { postMessage } from "@/lib/slack/client";
import { createWithCronAlert } from "@/lib/cron/cronAlertCore";

function alertChannel(): string {
  return (process.env.CRON_ALERT_SLACK_CHANNEL || process.env.SLACK_OWNER_USER_ID || "").trim();
}

export const withCronAlert = createWithCronAlert({
  now: () => Date.now(),
  async sendOncePerWindow(cronName, windowKey, text) {
    const channel = alertChannel();
    if (!channel || !(process.env.SLACK_BOT_TOKEN ?? "").trim()) {
      console.error(`[cron-alert] 슬랙 설정이 없어 로그로만 남김: ${text}`);
      return;
    }
    await unstable_cache(
      async () => {
        await postMessage({ channel, text });
        return true;
      },
      ["cron-alert-v1", cronName, String(windowKey)],
      { revalidate: 2 * 60 * 60 },
    )();
  },
});
