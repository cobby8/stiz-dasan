/**
 * 관리자 «수업 피드» 화면 순수 규칙(2026-11-14 원장 승인 · 같은 날 «인스타처럼 스크롤 + 오른쪽 편집»으로 개편)
 * — DB·네트워크 없이 «입력 → 결과»만 계산한다.
 *
 * 수업 피드 한 건 = 수업 1회(Session) — 그 수업의 «오늘 수업 한 줄»(content)·사진(photosJSON)·영상(SessionVideo).
 * 학부모 피드와 같은 단위라, 관리자가 보는 게시물 하나 = 학부모가 받는 게시물 하나다.
 *
 * 담당 선생님은 수업 기록(Session.coachId)이 거의 비어 있어(운영 181/181 빈칸),
 * 시간표 칸 담당 코치 → 반 담당 강사 순으로 찾는다(classCoachNameSql).
 *
 * 필터·페이지(커서)는 서버 SQL 에서 처리한다. 이 파일은 주소 값 정규화(허용값만 통과)와 커서 모양,
 * 화면 글자(머리줄·날짜 구분줄)를 맡는다.
 *
 * ⚠️ 순수 모듈 — datetime/kst 만 import. tests/admin-feed-rules.test.mjs 가 실제로 돌린다.
 */
import { isKstYmd, kstDow } from "@/lib/datetime/kst";

// 담당 선생님 SQL 은 학부모 피드와 같이 쓰므로 rules.ts 에 둔다(학부모 리포트 검사가 허용하는 순수 모듈).
export { classCoachNameSql } from "@/lib/feed/rules";

export type AdminFeedItem = {
  sessionId: string;
  classId: string;
  /** 수업일(KST "YYYY-MM-DD") */
  ymd: string;
  className: string;
  startTime: string | null;
  endTime: string | null;
  /** 담당 선생님(없으면 null) */
  teacherName: string | null;
  /** 수업을 끝낸 사람(참고용) */
  endedByName: string | null;
  content: string | null;
  topic: string | null;
  status: string;
  published: boolean;
  photoCount: number;
  videoCount: number;
  /** 게시물에 넘겨 볼 사진 주소(최대 PHOTO_PREVIEW_LIMIT 장) */
  photos: string[];
};

export const PHOTO_PREVIEW_LIMIT = 20;
export const ADMIN_FEED_DAYS_DEFAULT = 30;
export const ADMIN_FEED_DAYS_OPTIONS = [7, 30, 90] as const;
/** 한 번에 불러오는 게시물 수 — 끝에 닿으면 다음 20개 */
export const ADMIN_FEED_PAGE_SIZE = 20;

/** 내용(한 줄·사진·영상) 중 하나라도 있는 수업인가 */
export function hasFeedContent(item: Pick<AdminFeedItem, "content" | "photoCount" | "videoCount">): boolean {
  return Boolean(item.content?.trim()) || item.photoCount > 0 || item.videoCount > 0;
}

export const WEEKDAY_LABELS = ["일", "월", "화", "수", "목", "금", "토"] as const;
/** 요일 고르기 순서 — 월요일부터 */
export const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;

/** 수업일의 요일 번호(0=일 … 6=토). 날짜 형식이 틀리면 -1 */
export function feedWeekday(ymd: string): number {
  return isKstYmd(ymd) ? kstDow(ymd) : -1;
}

export const NO_TEACHER_LABEL = "담당 미지정";

// ── 필터(주소 값) ──────────────────────────────────────────────────────────

export type AdminFeedPublish = "ALL" | "PUBLISHED" | "DRAFT";
export const ADMIN_FEED_PUBLISH_VALUES = ["ALL", "PUBLISHED", "DRAFT"] as const;

export type AdminFeedFilter = {
  /** 조회 기간(7·30·90일) */
  days: number;
  /** 선생님 이름(빈 문자열 = 전체, NO_TEACHER_LABEL = 담당 미지정) */
  teacher: string;
  /** 요일 번호(-1 = 전체) */
  weekday: number;
  /** 반 id(빈 문자열 = 전체) */
  classId: string;
  /** 발행 상태 */
  publish: AdminFeedPublish;
  /** 내용 없는 수업도 보이기 */
  includeEmpty: boolean;
};

/** 필터 모달의 고를 거리(서버가 그 기간 수업에서 뽑아 준다) */
export type AdminFeedFacets = {
  /** 고를 수 있는 선생님 이름(가나다순, 담당 미지정은 맨 뒤) */
  teachers: string[];
  /** 고를 수 있는 반 */
  classes: Array<{ id: string; name: string }>;
};

export const DEFAULT_ADMIN_FEED_FILTER: AdminFeedFilter = {
  days: ADMIN_FEED_DAYS_DEFAULT, teacher: "", weekday: -1, classId: "", publish: "ALL", includeEmpty: false,
};

/** 조회 기간 일수 — 허용값(7·30·90)만, 아니면 기본 30 */
export function normalizeFeedDays(value: unknown): number {
  const n = Number(value);
  return (ADMIN_FEED_DAYS_OPTIONS as readonly number[]).includes(n) ? n : ADMIN_FEED_DAYS_DEFAULT;
}

/** DB id 모양(cuid·uuid 등) — 영문·숫자·_- 만, 64자 이하. 아니면 빈 문자열 */
export function normalizeFeedId(value: unknown): string {
  const s = typeof value === "string" ? value.trim() : "";
  return /^[A-Za-z0-9_-]{1,64}$/.test(s) ? s : "";
}

const TEACHER_MAX = 40;

/**
 * 주소 값(문자열 사전) → 필터. 허용값이 아니면 그 항목만 기본값으로 돌린다.
 * 값은 SQL 에 «바인딩»으로만 들어가지만, 여기서 한 번 더 모양을 묶어 둔다(긴 문자열·이상한 숫자 차단).
 */
export function normalizeAdminFeedFilter(raw: Record<string, unknown>): AdminFeedFilter {
  const teacherRaw = typeof raw.teacher === "string" ? raw.teacher.trim() : "";
  const weekdayText = typeof raw.weekday === "number" ? String(raw.weekday) : typeof raw.weekday === "string" ? raw.weekday.trim() : "";
  const publishRaw = typeof raw.publish === "string" ? raw.publish.toUpperCase() : "";
  const includeRaw = raw.includeEmpty;
  return {
    days: normalizeFeedDays(raw.days),
    teacher: teacherRaw.length <= TEACHER_MAX ? teacherRaw : "",
    // 요일은 숫자 한 글자(0~6)만 — "1.0"·"1e0"·" " 같은 모양은 전체로
    weekday: /^[0-6]$/.test(weekdayText) ? Number(weekdayText) : -1,
    classId: normalizeFeedId(raw.classId),
    publish: (ADMIN_FEED_PUBLISH_VALUES as readonly string[]).includes(publishRaw) ? publishRaw as AdminFeedPublish : "ALL",
    includeEmpty: includeRaw === true || includeRaw === "1" || includeRaw === "true",
  };
}

/** 필터 → 주소 값(기본값인 항목은 빼서 주소를 짧게). normalizeAdminFeedFilter 로 되읽으면 같은 필터가 나온다 */
export function adminFeedFilterToParams(filter: AdminFeedFilter): URLSearchParams {
  const params = new URLSearchParams();
  if (filter.days !== ADMIN_FEED_DAYS_DEFAULT) params.set("days", String(filter.days));
  if (filter.teacher) params.set("teacher", filter.teacher);
  if (filter.weekday >= 0) params.set("weekday", String(filter.weekday));
  if (filter.classId) params.set("classId", filter.classId);
  if (filter.publish !== "ALL") params.set("publish", filter.publish);
  if (filter.includeEmpty) params.set("includeEmpty", "1");
  return params;
}

/** «필터 2» 버튼 숫자 — 기본값과 다른 항목 수(기간 포함) */
export function countActiveFilters(filter: AdminFeedFilter): number {
  let n = 0;
  if (filter.days !== ADMIN_FEED_DAYS_DEFAULT) n += 1;
  if (filter.teacher) n += 1;
  if (filter.weekday >= 0) n += 1;
  if (filter.classId) n += 1;
  if (filter.publish !== "ALL") n += 1;
  if (filter.includeEmpty) n += 1;
  return n;
}

// ── 커서(다음 20개) ─────────────────────────────────────────────────────────
// 정렬 = 수업일 ↓, 시작 시각 ↓(없으면 빈 문자열), 수업 id ↓ — 세 값이 모두 «내림차순»이라
// SQL 의 행 비교 (a, b, c) < ($1, $2, $3) 하나로 «이 게시물 다음»을 정확히 자른다(중간에 새 수업이 생겨도 중복·누락 없음).

export type AdminFeedCursor = { ymd: string; startTime: string; id: string };

const CURSOR_SEP = "~";

export function encodeAdminFeedCursor(item: Pick<AdminFeedItem, "ymd" | "startTime" | "sessionId">): string {
  return [item.ymd, item.startTime ?? "", item.sessionId].join(CURSOR_SEP);
}

/** 커서 문자열 → 값. 모양이 틀리면 null(= 처음부터) */
export function decodeAdminFeedCursor(value: unknown): AdminFeedCursor | null {
  if (typeof value !== "string" || value.length > 120) return null;
  const parts = value.split(CURSOR_SEP);
  if (parts.length !== 3) return null;
  const [ymd, startTime, idRaw] = parts;
  if (!isKstYmd(ymd)) return null;
  if (startTime.length > 10) return null;
  const id = normalizeFeedId(idRaw);
  if (!id || id !== idRaw) return null;
  return { ymd, startTime, id };
}

/**
 * 서버가 «한 장 + 1개»를 읽어 넘기면 화면에 보낼 몫과 다음 커서를 나눈다.
 * 한 개 더 있으면 다음 페이지가 있다는 뜻 — 다음 커서 = 이번 몫의 마지막 게시물.
 */
export function splitAdminFeedPage<T extends Pick<AdminFeedItem, "ymd" | "startTime" | "sessionId">>(
  rows: T[],
  pageSize: number = ADMIN_FEED_PAGE_SIZE,
): { items: T[]; nextCursor: string | null } {
  if (rows.length <= pageSize) return { items: rows, nextCursor: null };
  const items = rows.slice(0, pageSize);
  return { items, nextCursor: encodeAdminFeedCursor(items[items.length - 1]) };
}

/** 이미 받은 목록 뒤에 새로 받은 몫을 붙인다 — 같은 수업이 두 번 오면 뒤에 온 것을 버린다 */
export function appendAdminFeedItems<T extends { sessionId: string }>(current: T[], incoming: T[]): T[] {
  const seen = new Set(current.map((item) => item.sessionId));
  const fresh: T[] = [];
  for (const item of incoming) {
    if (seen.has(item.sessionId)) continue;
    seen.add(item.sessionId);
    fresh.push(item);
  }
  return [...current, ...fresh];
}

// ── 화면 글자 ───────────────────────────────────────────────────────────────

/** 날짜 구분줄 «11월 13일 (금)». 형식이 틀리면 원문 그대로 */
export function feedDateHeading(ymd: string): string {
  if (!isKstYmd(ymd)) return ymd;
  const [, m, d] = ymd.split("-");
  return `${Number(m)}월 ${Number(d)}일 (${WEEKDAY_LABELS[kstDow(ymd)]})`;
}

/** 게시물 머리줄 «금요일 3교시 · 11/13(금) 15:00 · 박찬이» — 빈 칸은 빼고 잇는다 */
export function feedPostHeading(item: Pick<AdminFeedItem, "className" | "ymd" | "startTime" | "teacherName">): string {
  const parts: string[] = [];
  if (item.className?.trim()) parts.push(item.className.trim());
  if (isKstYmd(item.ymd)) {
    const [, m, d] = item.ymd.split("-");
    const date = `${Number(m)}/${Number(d)}(${WEEKDAY_LABELS[kstDow(item.ymd)]})`;
    parts.push(item.startTime?.trim() ? `${date} ${item.startTime.trim()}` : date);
  }
  parts.push(item.teacherName?.trim() || NO_TEACHER_LABEL);
  return parts.join(" · ");
}

/** 바로 앞 게시물과 날짜가 다르면 구분줄을 그린다(첫 게시물은 항상) */
export function needsDateDivider(items: Array<Pick<AdminFeedItem, "ymd">>, index: number): boolean {
  if (index < 0 || index >= items.length) return false;
  if (index === 0) return true;
  return items[index].ymd !== items[index - 1].ymd;
}
