/**
 * 구글·유튜브 API 호출(2026-11-14) — 서버 전용. 토큰 값은 로그·오류 문장에 넣지 않는다.
 *
 * 쓰는 API(할당량 비용):
 *   oauth2 token(교환·갱신) · channels.list mine=true(1) · videos.insert resumable(1,600)
 *   videos.update status(50) · videos.delete(50) · oauth2 revoke
 */
import { YOUTUBE_CATEGORY_SPORTS } from "@/lib/sessionVideo/rules";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const API = "https://www.googleapis.com/youtube/v3";
const UPLOAD_API = "https://www.googleapis.com/upload/youtube/v3/videos";

/** 구글 오류 — httpStatus·reason 으로 classifyYoutubeError 가 분류한다 */
export class YoutubeApiError extends Error {
  constructor(public httpStatus: number, public reason: string | null, message: string) {
    super(message);
  }
}

async function readGoogleError(response: Response, fallback: string): Promise<YoutubeApiError> {
  const body = await response.json().catch(() => null) as {
    error?: string | { message?: string; errors?: Array<{ reason?: string }>; status?: string };
    error_description?: string;
  } | null;
  // OAuth 오류는 error 가 문자열(invalid_grant 등), API 오류는 객체(errors[0].reason)
  if (typeof body?.error === "string") {
    return new YoutubeApiError(response.status, body.error, `${fallback}: ${body.error}${body.error_description ? ` (${body.error_description})` : ""}`);
  }
  const reason = body?.error?.errors?.[0]?.reason || body?.error?.status || null;
  const message = body?.error?.message || `HTTP ${response.status}`;
  return new YoutubeApiError(response.status, reason, `${fallback}: ${reason || ""} ${message}`.trim().slice(0, 500));
}

export type GoogleTokens = { accessToken: string; refreshToken: string | null; scope: string | null };

/** 콜백의 1회용 code → access/refresh token */
export async function exchangeYoutubeCode(input: { code: string; clientId: string; clientSecret: string; redirectUri: string }): Promise<GoogleTokens> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code: input.code,
      client_id: input.clientId,
      client_secret: input.clientSecret,
      redirect_uri: input.redirectUri,
      grant_type: "authorization_code",
    }),
    cache: "no-store",
  });
  if (!response.ok) throw await readGoogleError(response, "구글 인증 코드 교환 실패");
  const body = await response.json() as { access_token?: string; refresh_token?: string; scope?: string };
  if (!body.access_token) throw new YoutubeApiError(500, null, "구글 응답에 access token 이 없습니다.");
  return { accessToken: body.access_token, refreshToken: body.refresh_token || null, scope: body.scope || null };
}

/** refresh token → 새 access token(1시간짜리, 저장하지 않는다) */
export async function refreshYoutubeAccessToken(input: { refreshToken: string; clientId: string; clientSecret: string }): Promise<string> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: input.refreshToken,
      client_id: input.clientId,
      client_secret: input.clientSecret,
      grant_type: "refresh_token",
    }),
    cache: "no-store",
  });
  if (!response.ok) throw await readGoogleError(response, "유튜브 토큰 갱신 실패");
  const body = await response.json() as { access_token?: string };
  if (!body.access_token) throw new YoutubeApiError(500, null, "구글 응답에 access token 이 없습니다.");
  return body.access_token;
}

/** 연결한 계정의 채널(첫 번째) — 없으면 null(유튜브 채널이 없는 구글 계정) */
export async function fetchMyChannel(accessToken: string): Promise<{ id: string; title: string } | null> {
  const response = await fetch(`${API}/channels?part=snippet&mine=true`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: "no-store",
  });
  if (!response.ok) throw await readGoogleError(response, "유튜브 채널 확인 실패");
  const body = await response.json() as { items?: Array<{ id?: string; snippet?: { title?: string } }> };
  const item = body.items?.[0];
  return item?.id ? { id: item.id, title: item.snippet?.title || "" } : null;
}

/** 연결 해제 시 구글 쪽 토큰도 무효화(실패해도 우리 쪽 삭제는 진행) */
export async function revokeGoogleToken(token: string): Promise<void> {
  await fetch(REVOKE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token }),
    cache: "no-store",
  }).catch(() => undefined);
}

function isGoogleApiUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && (url.hostname === "www.googleapis.com" || url.hostname.endsWith(".googleapis.com"));
  } catch {
    return false;
  }
}

export type UploadedVideo = { id: string; privacyStatus: string | null };

/**
 * 유튜브 resumable 업로드(videos.insert).
 * 1) 메타데이터로 업로드 세션을 열고(Location 주소) 2) 영상 본문을 «스트림»으로 흘려보낸다.
 * 본문을 메모리에 통째로 올리지 않는다(Vercel 함수 메모리·시간 보호).
 */
export async function uploadYoutubeVideo(input: {
  accessToken: string;
  title: string;
  description: string;
  mimeType: string;
  sizeBytes: number;
  body: ReadableStream<Uint8Array>;
}): Promise<UploadedVideo> {
  const metadata = {
    snippet: { title: input.title, description: input.description, categoryId: YOUTUBE_CATEGORY_SPORTS },
    // 일부공개 요청 — 미인증 프로젝트면 유튜브가 «비공개»로 바꿔 돌려준다(interpretYoutubePrivacy 가 해석)
    status: { privacyStatus: "unlisted", selfDeclaredMadeForKids: false, embeddable: true },
  };
  const start = await fetch(`${UPLOAD_API}?uploadType=resumable&part=snippet,status`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.accessToken}`,
      "Content-Type": "application/json; charset=UTF-8",
      "X-Upload-Content-Length": String(input.sizeBytes),
      "X-Upload-Content-Type": input.mimeType,
    },
    body: JSON.stringify(metadata),
    cache: "no-store",
  });
  if (!start.ok) throw await readGoogleError(start, "유튜브 업로드 시작 실패");
  const location = start.headers.get("location");
  // 업로드 주소는 구글 API 도메인이어야 한다(다른 곳으로 영상을 흘려보내지 않게)
  if (!location || !isGoogleApiUrl(location)) {
    throw new YoutubeApiError(500, null, "유튜브 업로드 주소를 받지 못했습니다.");
  }
  const put = await fetch(location, {
    method: "PUT",
    headers: { "Content-Type": input.mimeType, "Content-Length": String(input.sizeBytes) },
    body: input.body,
    // Node fetch 로 스트림 본문을 보내려면 반이중(half) 표시가 필요하다
    duplex: "half",
    cache: "no-store",
  } as RequestInit & { duplex: "half" });
  if (!put.ok) throw await readGoogleError(put, "유튜브 영상 전송 실패");
  const video = await put.json() as { id?: string; status?: { privacyStatus?: string } };
  if (!video.id) throw new YoutubeApiError(500, null, "유튜브 응답에 영상 ID 가 없습니다.");
  return { id: video.id, privacyStatus: video.status?.privacyStatus || null };
}

/** 이미 올라간(비공개로 잠긴) 영상을 일부공개로 다시 요청 — 심사 통과 뒤 «다시 시도» */
export async function setYoutubeVideoUnlisted(accessToken: string, videoId: string): Promise<string | null> {
  const response = await fetch(`${API}/videos?part=status`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ id: videoId, status: { privacyStatus: "unlisted", selfDeclaredMadeForKids: false, embeddable: true } }),
    cache: "no-store",
  });
  if (!response.ok) throw await readGoogleError(response, "유튜브 공개 범위 변경 실패");
  const body = await response.json() as { status?: { privacyStatus?: string } };
  return body.status?.privacyStatus || null;
}

/**
 * 영상들의 지금 공개 범위(videos.list part=status, 1 unit). 목록에 없는 ID 는 결과에서 빠진다(유튜브에서 지워짐).
 * 한 번에 50개까지.
 */
export async function fetchYoutubePrivacy(accessToken: string, videoIds: string[]): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (videoIds.length === 0) return result;
  const response = await fetch(`${API}/videos?part=status&id=${videoIds.slice(0, 50).map(encodeURIComponent).join(",")}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: "no-store",
  });
  if (!response.ok) throw await readGoogleError(response, "유튜브 공개 범위 확인 실패");
  const body = await response.json() as { items?: Array<{ id?: string; status?: { privacyStatus?: string } }> };
  for (const item of body.items ?? []) {
    if (item.id) result.set(item.id, item.status?.privacyStatus || "unknown");
  }
  return result;
}

/** 유튜브 영상 삭제 — 이미 없으면(404) 성공으로 본다 */
export async function deleteYoutubeVideo(accessToken: string, videoId: string): Promise<void> {
  const response = await fetch(`${API}/videos?id=${encodeURIComponent(videoId)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: "no-store",
  });
  if (response.ok || response.status === 404) return;
  throw await readGoogleError(response, "유튜브 영상 삭제 실패");
}
