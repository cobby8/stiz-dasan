/**
 * 수업 영상 순수 규칙(2026-11-14) — DB·네트워크 없이 «입력 → 결과»만 계산한다.
 *
 * 왜 따로 두나: 업로드 가능 시간(수업 당일 KST 자정까지)·유튜브 하루 할당량·유튜브 응답 해석은
 * 눈으로 읽어서는 틀린 걸 못 찾는다(자정 경계·«비공개 강제»). 그래서 이 파일만 테스트가 실제로 돌린다
 * (tests/session-video-rules.test.mjs). 라우트·cron 은 여기 결과를 그대로 따른다.
 *
 * ⚠️ 이 파일은 순수 모듈(@/lib/datetime/kst 만 import). prisma·next 를 들이지 않는다.
 */
import { addDaysKst, isKstYmd, kstAt, todayKst } from "@/lib/datetime/kst";

// ── 상수 ──────────────────────────────────────────────────────────────

/** 유튜브 상태 — DB CHECK(SessionVideo_youtubeStatus_check)와 같은 집합이어야 한다(테스트가 비교). */
export const SESSION_VIDEO_YOUTUBE_STATUSES = ["PENDING", "UPLOADING", "UPLOADED", "PRIVATE_LOCKED", "FAILED", "SKIPPED"] as const;
export type SessionVideoYoutubeStatus = (typeof SESSION_VIDEO_YOUTUBE_STATUSES)[number];

/** 받는 영상 형식 — DB CHECK(SessionVideo_mimeType_check)·버킷 allowed_mime_types 와 같은 집합 */
export const SESSION_VIDEO_MIME_TYPES = ["video/mp4", "video/quicktime", "video/webm"] as const;
export type SessionVideoMimeType = (typeof SESSION_VIDEO_MIME_TYPES)[number];

/** 비공개 영상 버킷 이름 */
export const SESSION_VIDEO_BUCKET = "session-videos";
/** 버킷 상한을 못 읽었을 때 쓰는 값(50MB = Supabase 기본 전역 상한) */
export const SESSION_VIDEO_DEFAULT_MAX_BYTES = 50 * 1024 * 1024;
/** 하루(KST)에 유튜브로 옮길 최대 건수 — 할당량 10,000 units / 업로드 1,600 ≈ 6건, 여유 1건 */
export const YOUTUBE_DAILY_UPLOAD_LIMIT = 5;
/** 유튜브 업로드 실패 허용 횟수 — 넘으면 FAILED(관리자 «다시 시도»로만 되살린다) */
export const YOUTUBE_MAX_ATTEMPTS = 3;
/** 지운 영상의 유튜브 사본 삭제 시도 상한 — 넘으면 더 시도하지 않는다(관리자 화면에 «유튜브 삭제 실패» 건수로 보이고, 원장이 유튜브 스튜디오에서 직접 지운다) */
export const YOUTUBE_MAX_DELETE_ATTEMPTS = 5;
/** 유튜브 사본 삭제 실패 뒤 다시 시도하기까지(시간) */
export const YOUTUBE_DELETE_RETRY_HOURS = 1;
/** 유튜브 일부공개 성공 뒤 저장소 사본을 지우기까지의 날수 */
export const STORAGE_COPY_RETENTION_DAYS = 7;
/** 학부모에게 주는 저장소 재생 주소의 수명(초) — 짧게 */
export const PLAYBACK_URL_TTL_SECONDS = 10 * 60;
/** 유튜브 카테고리 «스포츠» */
export const YOUTUBE_CATEGORY_SPORTS = "17";

// ── 업로드 가능 시간 ──────────────────────────────────────────────────

export type UploadWindowInput = {
  /** Session.status (PLANNED · IN_PROGRESS · COMPLETED) */
  status: string;
  /** 수업 날짜(KST 달력, "YYYY-MM-DD") — SQL `s.date::date::text` */
  sessionYmd: string;
  /** 오늘(KST) — SQL `(NOW() AT TIME ZONE 'Asia/Seoul')::date::text` (서버 시계를 믿지 않는다) */
  todayYmd: string;
};

export type UploadWindowResult = { ok: true } | { ok: false; reason: "NOT_STARTED" | "NOT_TODAY" | "INVALID" };

/**
 * 영상을 올리거나 지울 수 있는가.
 * - 수업 중(IN_PROGRESS) 또는 끝난 수업(COMPLETED)
 * - 그리고 수업 날짜 = 오늘(KST). 즉 수업이 끝나도 «그날 자정 전까지»는 추가할 수 있다.
 */
export function canManageSessionVideo(input: UploadWindowInput): UploadWindowResult {
  if (!isKstYmd(input.sessionYmd) || !isKstYmd(input.todayYmd)) return { ok: false, reason: "INVALID" };
  if (input.status !== "IN_PROGRESS" && input.status !== "COMPLETED") return { ok: false, reason: "NOT_STARTED" };
  if (input.sessionYmd !== input.todayYmd) return { ok: false, reason: "NOT_TODAY" };
  return { ok: true };
}

/** 업로드 가능 시간 판정 결과를 선생님에게 보일 문장으로 */
export function uploadWindowMessage(reason: "NOT_STARTED" | "NOT_TODAY" | "INVALID"): string {
  if (reason === "NOT_STARTED") return "수업을 시작한 뒤에 영상을 올릴 수 있습니다.";
  if (reason === "NOT_TODAY") return "영상은 수업 당일 자정까지만 올리거나 지울 수 있습니다.";
  return "수업 날짜를 확인하지 못했습니다.";
}

// ── 업로드 파일 검사 ──────────────────────────────────────────────────

export function isSessionVideoMimeType(value: unknown): value is SessionVideoMimeType {
  return typeof value === "string" && (SESSION_VIDEO_MIME_TYPES as readonly string[]).includes(value);
}

/** mime → 저장 확장자 */
export function sessionVideoExtension(mimeType: SessionVideoMimeType): "mp4" | "mov" | "webm" {
  if (mimeType === "video/quicktime") return "mov";
  if (mimeType === "video/webm") return "webm";
  return "mp4";
}

/**
 * 휴대폰이 영상 형식을 비워 보내는 경우(일부 안드로이드)가 있어 파일 이름으로 한 번 더 본다.
 * 그래도 모르면 null(올리지 않는다).
 */
export function normalizeSessionVideoMime(mime: string | null | undefined, fileName: string | null | undefined): SessionVideoMimeType | null {
  const supplied = (mime || "").toLowerCase().split(";")[0].trim();
  if (isSessionVideoMimeType(supplied)) return supplied;
  if (supplied && supplied !== "application/octet-stream") return null;
  const ext = (fileName || "").toLowerCase().split(".").pop();
  if (ext === "mp4" || ext === "m4v") return "video/mp4";
  if (ext === "mov") return "video/quicktime";
  if (ext === "webm") return "video/webm";
  return null;
}

/** 버킷 상한(바이트)을 MB 로(안내 문구용, 소수점 없이) */
export function bytesToMb(bytes: number): number {
  return Math.floor(bytes / (1024 * 1024));
}

/** 크기 초과 안내 — 휴대폰 1080p 영상은 1분에 60MB 를 넘기 쉬워 «30초»로 안내한다(검수 2026-11-14) */
export function oversizeMessage(maxBytes: number): string {
  return `영상이 너무 큽니다(최대 ${bytesToMb(maxBytes)}MB). 30초 이내로 짧게 찍어 주세요.`;
}

/** 업로드 칸 안내 한 줄 */
export function uploadHintMessage(maxBytes: number): string {
  return `30초 이내로 짧게(최대 ${bytesToMb(maxBytes)}MB) 찍어 주세요. 수업 당일 자정 전에 올려 주세요.`;
}

export type VideoFileCheck = { ok: true; mimeType: SessionVideoMimeType } | { ok: false; message: string };

/** 업로드 전 파일 검사(브라우저·서버 공통) */
export function checkSessionVideoFile(input: { mimeType: string | null | undefined; fileName?: string | null; sizeBytes: number; maxBytes: number }): VideoFileCheck {
  const mimeType = normalizeSessionVideoMime(input.mimeType, input.fileName);
  if (!mimeType) return { ok: false, message: "MP4·MOV·WebM 영상만 올릴 수 있습니다." };
  if (!Number.isFinite(input.sizeBytes) || input.sizeBytes <= 0) return { ok: false, message: "영상 파일을 읽지 못했습니다. 다시 선택해 주세요." };
  if (input.sizeBytes > input.maxBytes) return { ok: false, message: oversizeMessage(input.maxBytes) };
  return { ok: true, mimeType };
}

/** 버킷 안 저장 경로 — classes/{classId}/{sessionId}/{videoId}.{ext} (경로 위조 검사 isValidSessionVideoRef 와 짝) */
export function sessionVideoStoragePath(input: { classId: string; sessionId: string; videoId: string; mimeType: SessionVideoMimeType }): string {
  return `classes/${input.classId}/${input.sessionId}/${input.videoId}.${sessionVideoExtension(input.mimeType)}`;
}

const SAFE_ID = /^[A-Za-z0-9_-]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** DB 에 적힌 경로가 우리가 만든 모양인지(다른 수업·다른 버킷 파일을 건드리지 않게) */
export function isValidSessionVideoRef(input: { storageBucket: string; storagePath: string; classId: string; sessionId: string; videoId: string }): boolean {
  if (input.storageBucket !== SESSION_VIDEO_BUCKET) return false;
  if (!SAFE_ID.test(input.classId) || !SAFE_ID.test(input.sessionId) || !UUID.test(input.videoId)) return false;
  return new RegExp(`^classes/${input.classId}/${input.sessionId}/${input.videoId}\\.(mp4|mov|webm)$`).test(input.storagePath);
}

// ── 재생(학부모) ─────────────────────────────────────────────────────

export type PlaybackKind = "youtube" | "file" | "none";

/** 재생 정보(API 응답 한 칸) — 서버(server.ts)와 화면 부품(SessionVideoPlayer)이 같은 모양을 쓴다 */
export type SessionVideoPlayback =
  | { id: string; kind: "youtube"; youtubeId: string; createdAt: string; durationSec: number | null }
  | { id: string; kind: "file"; url: string; mimeType: string; createdAt: string; durationSec: number | null }
  | { id: string; kind: "none"; createdAt: string; durationSec: number | null };

/**
 * 영상 하나를 무엇으로 재생할지.
 * - 유튜브 «일부공개» 성공(UPLOADED + 영상 ID) → 유튜브 임베드
 * - 그 밖(대기·비공개 강제·실패) → 저장소 사본(남아 있으면)
 * - 사본도 지워졌으면 재생 불가
 */
export function playbackKind(input: { youtubeStatus: string; youtubeVideoId: string | null; youtubePrivacy: string | null; storageDeletedAt: unknown }): PlaybackKind {
  if (input.youtubeStatus === "UPLOADED" && input.youtubeVideoId && input.youtubePrivacy === "unlisted") return "youtube";
  if (!input.storageDeletedAt) return "file";
  return "none";
}

/** 유튜브 영상 ID 형식(11자) — 임베드 주소에 넣기 전에 확인 */
export function isYoutubeVideoId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{11}$/.test(value);
}

/** 개인정보 보호 강화 모드 임베드 주소(쿠키 없는 도메인) */
export function youtubeNocookieEmbedUrl(videoId: string): string {
  if (!isYoutubeVideoId(videoId)) throw new Error("INVALID_YOUTUBE_ID");
  return `https://www.youtube-nocookie.com/embed/${videoId}?autoplay=1&rel=0&modestbranding=1&playsinline=1`;
}

export function youtubeThumbnailUrl(videoId: string): string {
  if (!isYoutubeVideoId(videoId)) throw new Error("INVALID_YOUTUBE_ID");
  return `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
}

// ── 유튜브 이동(cron) ─────────────────────────────────────────────────

/** 유튜브 영상 제목 «[반이름] YYYY-MM-DD 수업» — 유튜브가 막는 < > 는 지우고 100자로 자른다 */
export function youtubeVideoTitle(className: string, sessionYmd: string): string {
  const safeName = (className || "수업").replace(/[<>]/g, "").replace(/\s+/g, " ").trim() || "수업";
  const title = `[${safeName}] ${sessionYmd} 수업`;
  return Array.from(title).slice(0, 100).join("");
}

export type QuotaState = { quotaDay: string | null; quotaUsed: number; quotaBlockedUntilMs: number | null };

/**
 * 오늘(KST) 유튜브로 몇 건 더 올릴 수 있나.
 * 날짜가 바뀌면 사용량은 0 부터. 할당량 초과 응답으로 막힌 시각 전이면 0.
 */
export function remainingQuota(state: QuotaState, nowMs: number, limit: number = YOUTUBE_DAILY_UPLOAD_LIMIT): number {
  if (state.quotaBlockedUntilMs !== null && nowMs < state.quotaBlockedUntilMs) return 0;
  const today = todayKst(nowMs);
  const used = state.quotaDay === today ? Math.max(0, state.quotaUsed) : 0;
  return Math.max(0, limit - used);
}

/** 할당량 초과 응답을 받았을 때 다음 시도 시각 = 다음 KST 자정(epoch ms) */
export function quotaBlockedUntil(nowMs: number): number {
  return kstAt(addDaysKst(todayKst(nowMs), 1));
}

/** 유튜브 업로드 응답(videos.insert/update 의 status.privacyStatus) 해석 */
export function interpretYoutubePrivacy(privacyStatus: unknown): { status: "UPLOADED" | "PRIVATE_LOCKED"; privacy: string } {
  const privacy = typeof privacyStatus === "string" ? privacyStatus : "unknown";
  // 미인증 API 프로젝트는 일부공개로 요청해도 «비공개»로 강제된다 → 학부모는 계속 사이트 사본으로 본다.
  // 일부공개가 아닌 모든 경우(비공개·알 수 없음)는 사이트 사본을 유지하는 쪽으로 둔다.
  return privacy === "unlisted" ? { status: "UPLOADED", privacy } : { status: "PRIVATE_LOCKED", privacy };
}

export type YoutubeErrorKind = "QUOTA" | "AUTH" | "RETRYABLE" | "FATAL";

/** 유튜브·구글 오류 응답 분류 — 할당량 초과는 «실패 횟수»로 세지 않고 다음 날로 미룬다 */
export function classifyYoutubeError(httpStatus: number, reason: string | null | undefined): YoutubeErrorKind {
  const r = (reason || "").toLowerCase();
  if (r === "quotaexceeded" || r === "uploadlimitexceeded" || r === "dailylimitexceeded" || r === "ratelimitexceeded") return "QUOTA";
  if (httpStatus === 401 || r === "invalid_grant" || r === "autherror" || r === "unauthorized_client") return "AUTH";
  if (httpStatus === 429 || httpStatus >= 500 || httpStatus === 0) return "RETRYABLE";
  return "FATAL";
}

/** 실패 한 번을 기록한 뒤의 상태 — 할당량·인증 문제는 영상 탓이 아니라 횟수를 늘리지 않는다 */
export function nextStatusAfterFailure(input: { attempts: number; kind: YoutubeErrorKind; maxAttempts?: number }): { status: "PENDING" | "FAILED"; attempts: number } {
  if (input.kind === "QUOTA" || input.kind === "AUTH") return { status: "PENDING", attempts: input.attempts };
  const attempts = input.attempts + 1;
  if (input.kind === "FATAL") return { status: "FAILED", attempts };
  return { status: attempts >= (input.maxAttempts ?? YOUTUBE_MAX_ATTEMPTS) ? "FAILED" : "PENDING", attempts };
}

/**
 * 상태 전이 허용표 — 이 표에 없는 전이는 코드 버그다.
 *  PENDING → UPLOADING(cron 이 잡음) · SKIPPED(삭제됨)
 *  UPLOADING → UPLOADED · PRIVATE_LOCKED · PENDING(실패·재시도) · FAILED
 *  UPLOADED → PRIVATE_LOCKED(사본 삭제 전 재확인에서 일부공개가 아님) · SKIPPED(삭제됨)
 *  PRIVATE_LOCKED → PENDING(심사 통과 뒤 관리자 «다시 시도»)
 *  FAILED → PENDING(관리자 «다시 시도»)
 */
const TRANSITIONS: Record<SessionVideoYoutubeStatus, readonly SessionVideoYoutubeStatus[]> = {
  PENDING: ["UPLOADING", "SKIPPED"],
  UPLOADING: ["UPLOADED", "PRIVATE_LOCKED", "PENDING", "FAILED"],
  // 사본 삭제 전 재확인에서 유튜브가 일부공개가 아니면(비공개로 바뀜·삭제됨) 사본을 지키고 잠금으로 되돌린다
  UPLOADED: ["PRIVATE_LOCKED", "SKIPPED"],
  PRIVATE_LOCKED: ["PENDING", "SKIPPED"],
  FAILED: ["PENDING", "SKIPPED"],
  SKIPPED: [],
};

export function canTransitionYoutubeStatus(from: string, to: string): boolean {
  if (!(SESSION_VIDEO_YOUTUBE_STATUSES as readonly string[]).includes(from)) return false;
  return (TRANSITIONS[from as SessionVideoYoutubeStatus] as readonly string[]).includes(to);
}

/**
 * 보관 기간이 지난 UPLOADED 영상의 사본을 지우기 직전, 유튜브에 지금 «일부공개»로 살아 있는지 다시 본다.
 * privacy = videos.list 의 status.privacyStatus(목록에 없으면 null = 유튜브에서 지워짐).
 * 일부공개일 때만 사본을 지운다. 아니면 사본을 지키고 PRIVATE_LOCKED 로 되돌린다(학부모는 사이트 사본으로 계속 본다).
 */
export function retentionDecision(privacy: string | null | undefined): "DELETE_COPY" | "LOCK" {
  return privacy === "unlisted" ? "DELETE_COPY" : "LOCK";
}

/** 저장소 사본을 지워도 되나 — 유튜브 일부공개 성공 후 보관 기간이 지났을 때만 */
export function storageCopyExpired(input: { youtubeStatus: string; youtubeUploadedAtMs: number | null; nowMs: number; retentionDays?: number }): boolean {
  if (input.youtubeStatus !== "UPLOADED" || input.youtubeUploadedAtMs === null) return false;
  return input.nowMs - input.youtubeUploadedAtMs >= (input.retentionDays ?? STORAGE_COPY_RETENTION_DAYS) * 86_400_000;
}
