/**
 * 수업 피드 순수 규칙(2026-11-14 원장 결정) — DB·네트워크 없이 «입력 → 결과»만 계산한다.
 *
 * 수업 피드 = 수업 리포트(Session.content·published) + 사진(staff-session-private) + 영상(SessionVideo).
 * 학부모가 «볼 수 있는가»는 사진·영상·홈 카드·소식 상세가 **같은 기준 하나**를 쓴다:
 *   1) 수업이 끝났고(COMPLETED) 발행됐다(published)
 *   2) 내 아이가 그 수업에 «참여»했다 = 그 수업 출결 기록이 있거나, 그 반 ACTIVE 수강(개시일이 수업일 이전)
 * 사진 공개 동의(StudentMediaConsent)·«나온 학생» 태그는 더 이상 보지 않는다(원장 결정 1).
 * 공개 홈페이지·갤러리·인스타 게시는 관리자 수동 승인 흐름이 따로 있다.
 *
 * ⚠️ 이 파일은 순수 모듈(sessionVideo/rules → datetime/kst 만 import). prisma·next 를 들이지 않는다.
 *    테스트(tests/feed-rules.test.mjs)가 실제로 돌린다.
 */
import { canManageSessionVideo, type UploadWindowInput, type UploadWindowResult } from "@/lib/sessionVideo/rules";
import { isKstYmd } from "@/lib/datetime/kst";

// ── 학부모 공개 범위 ──────────────────────────────────────────────────

/** 학부모에게 보이는 수업인가 — 끝났고 발행된 수업만(리포트·사진·영상 공통) */
export function isParentVisibleSession(input: { status: string; published: boolean | null | undefined }): boolean {
  return input.status === "COMPLETED" && input.published === true;
}

/**
 * 학부모 공개 수업 조건(SQL) — isParentVisibleSession 과 같은 문장.
 * @param se Session 별칭
 */
export function feedVisibleSessionSql(se: string): string {
  return `${se}.status = 'COMPLETED' AND ${se}.published = true`;
}

/**
 * 수업일(KST 달력 date)을 SQL 로 — Session.date 는 시간대 없는 timestamp 라 «두 번» 변환한다(전역 규칙).
 * 새 기록은 'YYYY-MM-DD 00:00'(KST 날짜 자정)으로, 옛 기록 일부는 'KST 자정의 UTC 시각'(전날 15:00)으로 들어 있다.
 * UTC 로 읽은 뒤 서울로 옮기면 두 모양 모두 같은 KST 날짜가 된다(00:00→09:00 같은 날, 전날 15:00→다음 날 00:00).
 * 한 번만 걸거나 ::date 로 자르면 옛 기록이 하루 밀린다(tests/feed-rules.test.mjs 가 두 모양을 다 확인).
 * @param se Session 별칭
 */
export function sessionKstDateSql(se: string): string {
  return `((${se}.date AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Seoul')::date`;
}

/** 수강 등록일(KST date, SQL) — Enrollment.createdAt 은 무tz(UTC 벽시계)라 «두 번» 변환 */
export function enrollmentCreatedKstDateSql(e: string): string {
  return `((${e}."createdAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Seoul')::date`;
}

/** 오늘(KST, SQL) — NOW() 는 timestamptz 라 «한 번»만 변환한다. 서버(UTC) 시계를 믿지 않는다 */
export const TODAY_KST_SQL = `(NOW() AT TIME ZONE 'Asia/Seoul')::date`;

/**
 * «이 학생이 이 수업에 참여했다»(SQL) — 출결 기록 또는 그 반 ACTIVE 수강(시작일 ≤ 수업일).
 * 시작일 = 개시일(startsOn), 비어 있으면 등록일(createdAt 의 KST 날짜) — 2026-11-14 보안 검수 HIGH:
 *   개시일이 빈 수강(관리자 «수강 추가»·대기자 등록·시트 가져오기·특강 전환이 예전에 비워 두던 것)을
 *   «처음부터 참여»로 보면 입학 전 수업의 사진·소식·영상이 열렸다. 그래서 비면 등록일로 막는다.
 *   되살린 수강(그만둔 반에 다시 등록)은 등록일이 옛날이라, 되살리는 4곳이 개시일을 «되살린 날»로 적는다.
 * 수업일은 sessionKstDateSql(두 번 변환), Enrollment.startsOn 은 @db.Date(달력 날짜 그대로),
 * Enrollment.createdAt 은 시간대 없는 timestamp(Prisma 기본 = UTC 벽시계)라 «두 번» 변환.
 * @param st Student 별칭(또는 학생 id 를 담은 SQL 식의 테이블 별칭)
 * @param se Session 별칭
 */
export function feedParticipantSql(st: string, se: string): string {
  return `(
    EXISTS (SELECT 1 FROM "Attendance" fa WHERE fa."sessionId" = ${se}.id AND fa."studentId" = ${st}.id)
    OR EXISTS (
      SELECT 1 FROM "Enrollment" fe
       WHERE fe."studentId" = ${st}.id AND fe."classId" = ${se}."classId" AND fe.status = 'ACTIVE'
         AND COALESCE(fe."startsOn", ${enrollmentCreatedKstDateSql("fe")}) <= ${sessionKstDateSql(se)}
    )
  )`;
}

/** 참여 판정(순수판) — feedParticipantSql 과 같은 규칙. 테스트·문서용 */
export function isFeedParticipant(input: {
  hasAttendance: boolean;
  /** startsOnYmd = 개시일(없으면 null), createdYmd = 등록일(KST) — 개시일이 비면 등록일이 시작일 */
  enrollment: { status: string; startsOnYmd: string | null; createdYmd: string | null } | null;
  sessionYmd: string;
}): boolean {
  if (input.hasAttendance) return true;
  const e = input.enrollment;
  if (!e || e.status !== "ACTIVE") return false;
  const start = e.startsOnYmd ?? e.createdYmd;
  // 시작일을 모르면 닫는다(입학 전 수업이 열리지 않게)
  if (!start || !isKstYmd(start) || !isKstYmd(input.sessionYmd)) return false;
  return start <= input.sessionYmd;
}

// ── 선생님: 사진·영상·한 줄 가능 시간 ──────────────────────────────────

/** 사진·영상 올리기·지우기 가능 시간 — 영상과 같은 규칙(수업 중 또는 끝난 당일 KST 자정까지) */
export function canManageSessionMedia(input: UploadWindowInput): UploadWindowResult {
  return canManageSessionVideo(input);
}

/** 사진 쪽 안내 문장(영상 문장과 같은 뜻) */
export function photoWindowMessage(reason: "NOT_STARTED" | "NOT_TODAY" | "INVALID"): string {
  if (reason === "NOT_STARTED") return "수업을 시작한 뒤에 사진을 올릴 수 있습니다.";
  if (reason === "NOT_TODAY") return "사진은 수업 당일 자정까지만 올리거나 지울 수 있습니다.";
  return "수업 날짜를 확인하지 못했습니다.";
}

export type FeedLineWindowResult = { ok: true } | { ok: false; reason: "NOT_TODAY" | "INVALID" };

/**
 * «오늘 수업 한 줄»(Session.content)을 쓰고 고칠 수 있는가 — 수업 전·중·후, 수업 당일(KST) 자정까지.
 * (예전엔 수업 종료 확인 창에서만 쓸 수 있었고, 종료 뒤에는 수업 화면 자체가 닫혀 못 고쳤다.)
 */
export function canEditFeedLine(input: UploadWindowInput): FeedLineWindowResult {
  if (!isKstYmd(input.sessionYmd) || !isKstYmd(input.todayYmd)) return { ok: false, reason: "INVALID" };
  if (!["PLANNED", "IN_PROGRESS", "COMPLETED"].includes(input.status)) return { ok: false, reason: "INVALID" };
  if (input.sessionYmd !== input.todayYmd) return { ok: false, reason: "NOT_TODAY" };
  return { ok: true };
}

export function feedLineWindowMessage(reason: "NOT_TODAY" | "INVALID"): string {
  if (reason === "NOT_TODAY") return "수업 한 줄은 수업 당일 자정까지만 쓰거나 고칠 수 있습니다.";
  return "수업 상태를 확인하지 못했습니다.";
}

/** 한 줄 최대 길이(수업 종료 저장과 같은 2000자) */
export const FEED_LINE_MAX = 2000;

/** 저장할 한 줄 — 앞뒤 공백을 지우고 2000자로 자른다. 비면 null(지우기) */
export function normalizeFeedLine(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? Array.from(trimmed).slice(0, FEED_LINE_MAX).join("") : null;
}

// ── 볼 수 있는 사진 ──────────────────────────────────────────────────

const PRIVATE_PHOTO_PATH = /^\/api\/staff\/sessions\/([^/]+)\/photos\/([^/]+)$/;

export type FeedPhotoView = { src: string };

/**
 * 화면에 넘길 사진만 고른다 — 넘긴 사진은 모두 실제로 열려야 한다(403·404 헛요청 없게).
 * - 비공개 사진 주소(/api/staff/sessions/{sessionId}/photos/{photoId})는 **이 수업** 주소이고,
 *   사진 원장(SocialPostDraft)에 실제로 있는 사진(availablePrivateIds)일 때만
 * - 옛 공개 주소(문자열)는 그대로
 * - 같은 사진은 한 번만
 */
export function selectViewablePhotos(srcs: string[], sessionId: string, availablePrivateIds: ReadonlySet<string>): FeedPhotoView[] {
  const seen = new Set<string>();
  const result: FeedPhotoView[] = [];
  for (const raw of srcs) {
    const src = typeof raw === "string" ? raw.trim() : "";
    if (!src || seen.has(src)) continue;
    const match = PRIVATE_PHOTO_PATH.exec(src);
    if (match) {
      if (match[1] !== sessionId || !availablePrivateIds.has(match[2])) continue;
    } else if (src.startsWith("/api/")) {
      continue; // 다른 내부 주소는 사진이 아니다
    }
    seen.add(src);
    result.push({ src });
  }
  return result;
}

// ── 학부모 홈 «최신 수업 피드» 카드 ──────────────────────────────────

/** 홈 카드에 보일 사진 최대 장수 */
export const FEED_CARD_PHOTO_LIMIT = 3;

export type FeedCandidate = {
  studentId: string;
  sessionId: string;
  /** 수업일(KST "YYYY-MM-DD") */
  ymd: string;
  /** 발행 시각(ms) — 같은 날 수업이 둘이면 나중 발행 */
  publishedAtMs: number | null;
  className: string;
  coachName: string | null;
  content: string | null;
  topic: string | null;
  photos: FeedPhotoView[];
  videoCount: number;
};

export type FeedCard = Omit<FeedCandidate, "studentId" | "publishedAtMs"> & { photoCount: number };

/**
 * 이 아이의 최신 공개 수업 1건을 카드 모양으로 고른다. 없으면 null(카드 숨김).
 * 다른 아이의 후보는 절대 고르지 않는다(형제 계정에서 섞이지 않게).
 */
export function pickFeedCard(candidates: FeedCandidate[], studentId: string): FeedCard | null {
  const mine = candidates.filter((c) => c.studentId === studentId && isKstYmd(c.ymd));
  if (mine.length === 0) return null;
  const latest = mine.reduce((best, c) => {
    if (c.ymd !== best.ymd) return c.ymd > best.ymd ? c : best;
    return (c.publishedAtMs ?? 0) > (best.publishedAtMs ?? 0) ? c : best;
  });
  return {
    sessionId: latest.sessionId,
    ymd: latest.ymd,
    className: latest.className,
    coachName: latest.coachName,
    content: latest.content?.trim() || null,
    topic: latest.topic?.trim() || null,
    photos: latest.photos.slice(0, FEED_CARD_PHOTO_LIMIT),
    photoCount: latest.photos.length,
    videoCount: Math.max(0, latest.videoCount),
  };
}

/** 소식 목록 행의 작은 개수 표시 «사진 2 · 영상 1» — 둘 다 0 이면 빈 문자열 */
export function feedMediaCountLabel(counts: { photoCount: number; videoCount: number }): string {
  const parts: string[] = [];
  if (counts.photoCount > 0) parts.push(`사진 ${counts.photoCount}`);
  if (counts.videoCount > 0) parts.push(`영상 ${counts.videoCount}`);
  return parts.join(" · ");
}

// ── 선생님: 실패한 사진만 다시 올리기 ────────────────────────────────

/**
 * 여러 장을 올린 결과에서 «다시 올릴 파일»만 남긴다(성공한 사진을 두 번 올리지 않게).
 * results 의 순서는 files 와 같다.
 */
export function failedUploadsOnly<T>(files: readonly T[], succeeded: readonly boolean[]): T[] {
  return files.filter((_, index) => succeeded[index] !== true);
}
