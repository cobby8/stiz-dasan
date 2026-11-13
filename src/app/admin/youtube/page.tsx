import { requireAdmin } from "@/lib/auth-guard";
import AdminPageHeader from "@/components/admin/AdminPageHeader";
import { readYoutubeConfig, youtubeRedirectUri } from "@/lib/youtube/config";
import { getYoutubeConnection } from "@/lib/youtube/connection";
import { youtubeQueueSummary } from "@/lib/sessionVideo/youtubeJob";
import { kstLabel } from "@/lib/datetime/kst";
import { YOUTUBE_DAILY_UPLOAD_LIMIT } from "@/lib/sessionVideo/rules";
import YoutubeConnectionClient from "./YoutubeConnectionClient";

export const dynamic = "force-dynamic";

/** 콜백이 돌려준 결과 코드 → 원장에게 보일 문장 */
const RESULT_MESSAGES: Record<string, string> = {
  connected: "유튜브 채널을 연결했습니다.",
  owner_only: "원장 계정으로만 연결할 수 있습니다.",
  config: "서버 설정(구글 OAuth 값·암호화 키)이 아직 없습니다.",
  state: "연결 요청이 만료되었거나 올바르지 않습니다. «유튜브 연결»을 다시 눌러 주세요.",
  denied: "구글 동의 화면에서 취소했습니다.",
  code: "구글이 연결 코드를 보내지 않았습니다. 다시 시도해 주세요.",
  no_refresh: "구글이 장기 연결 권한을 주지 않았습니다. 구글 계정 → 보안 → 서드파티 연결에서 이 앱을 지운 뒤 다시 연결해 주세요.",
  scope: "«YouTube 동영상 관리(업로드)» 권한에 체크해야 연결됩니다. 다시 연결해 주세요.",
  no_channel: "이 구글 계정에는 유튜브 채널이 없습니다. 채널 주인 계정으로 로그인해 주세요.",
  exchange: "구글과 연결을 마치지 못했습니다. 잠시 뒤 다시 시도해 주세요.",
};

/**
 * 설정 → 유튜브 연결(원장만).
 * 수업 영상을 원장 유튜브 채널(일부공개)로 옮기는 연결을 켜고 끈다. 연결 상태·채널명·마지막 오류·대기 현황을 보인다.
 */
export default async function YoutubeConnectionPage({ searchParams }: { searchParams: Promise<{ connected?: string; error?: string }> }) {
  const admin = await requireAdmin();
  if (admin.appUserRole !== "ADMIN") {
    return (
      <main className="p-4 md:p-6">
        <AdminPageHeader title="유튜브 연결" />
        <p className="mt-2 text-sm text-[var(--color-academy-muted)]">원장만 볼 수 있는 화면입니다.</p>
      </main>
    );
  }
  const params = await searchParams;
  const resultKey = params.connected ? "connected" : params.error || "";
  const config = readYoutubeConfig();
  const [connection, summary] = await Promise.all([getYoutubeConnection(), youtubeQueueSummary()]);
  return (
    <main className="space-y-4 p-4 md:p-6">
      <div>
        <AdminPageHeader title="유튜브 연결" />
        <p className="mt-1 max-w-3xl text-sm text-[var(--color-academy-muted)]">
          선생님이 수업 화면에서 찍은 영상을 원장님 유튜브 채널에 «일부공개»로 옮깁니다. 학부모는 학부모 화면 안에서만 봅니다.
        </p>
        {/* 심사 전 안내 — 원장 결정표 문구 */}
        <p className="mt-1 max-w-3xl text-sm font-medium text-[var(--color-academy-warning)]">
          구글 심사 통과 전에는 유튜브에 비공개로만 올라가 학부모는 사이트 사본으로 봅니다.
        </p>
      </div>
      <YoutubeConnectionClient
        configReady={config.ready}
        missingEnv={config.ready ? [] : config.missing}
        redirectUri={youtubeRedirectUri(process.env)}
        connection={connection ? {
          channelId: connection.channelId,
          channelTitle: connection.channelTitle,
          connectedAt: kstLabel(connection.connectedAt),
          lastError: connection.lastError,
          lastErrorAt: connection.lastErrorAt ? kstLabel(connection.lastErrorAt) : null,
          quotaText: `${connection.quotaDay ?? "-"} · ${connection.quotaUsed}/${YOUTUBE_DAILY_UPLOAD_LIMIT}건`,
        } : null}
        summary={summary}
        resultMessage={resultKey ? RESULT_MESSAGES[resultKey] ?? null : null}
        resultIsError={Boolean(params.error)}
      />
    </main>
  );
}
