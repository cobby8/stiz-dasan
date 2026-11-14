/**
 * 관리자 «수업 피드» 화면 순수 규칙(2026-11-14 원장 승인) — DB·네트워크 없이 «입력 → 결과»만 계산한다.
 *
 * 수업 피드 한 건 = 수업 1회(Session) — 그 수업의 «오늘 수업 한 줄»(content)·사진(photosJSON)·영상(SessionVideo).
 * 학부모 피드와 같은 단위라, 관리자가 보는 한 줄 = 학부모가 받는 게시물 하나다.
 *
 * 담당 선생님은 수업 기록(Session.coachId)이 거의 비어 있어(운영 181/181 빈칸),
 * 시간표 칸 담당 코치 → 반 담당 강사 순으로 찾는다(classCoachNameSql).
 *
 * ⚠️ 순수 모듈 — datetime/kst 만 import. tests/admin-feed-rules.test.mjs 가 실제로 돌린다.
 */
import { isKstYmd, kstDow } from "@/lib/datetime/kst";

// 담당 선생님 SQL 은 학부모 피드와 같이 쓰므로 rules.ts 에 둔다(학부모 리포트 검사가 허용하는 순수 모듈).
export { classCoachNameSql } from "@/lib/feed/rules";

export type AdminFeedItem = {
  sessionId: string;
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
  /** 상세 패널 미리보기용 사진 주소(최대 PHOTO_PREVIEW_LIMIT 장) */
  photos: string[];
};

export const PHOTO_PREVIEW_LIMIT = 12;
export const ADMIN_FEED_DAYS_DEFAULT = 30;
export const ADMIN_FEED_DAYS_OPTIONS = [7, 30, 90] as const;

/** 내용(한 줄·사진·영상) 중 하나라도 있는 수업인가 */
export function hasFeedContent(item: Pick<AdminFeedItem, "content" | "photoCount" | "videoCount">): boolean {
  return Boolean(item.content?.trim()) || item.photoCount > 0 || item.videoCount > 0;
}

/** 목록 행의 글 앞부분 — 줄바꿈을 공백으로, 앞 n자(글자 단위)만. 비면 빈 문자열 */
export function feedPreview(content: string | null | undefined, max = 40): string {
  const flat = (content ?? "").replace(/\s+/g, " ").trim();
  if (!flat) return "";
  const chars = Array.from(flat);
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : flat;
}

export const WEEKDAY_LABELS = ["일", "월", "화", "수", "목", "금", "토"] as const;
/** 요일별 보기 순서 — 월요일부터 */
export const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;

/** 수업일의 요일 번호(0=일 … 6=토). 날짜 형식이 틀리면 -1 */
export function feedWeekday(ymd: string): number {
  return isKstYmd(ymd) ? kstDow(ymd) : -1;
}

export type AdminFeedView = "all" | "weekday" | "teacher";
export type AdminFeedGroup = { key: string; label: string; items: AdminFeedItem[] };

export const NO_TEACHER_LABEL = "담당 미지정";

/**
 * 보기 방식대로 묶는다. 묶음 안 순서는 들어온 순서(서버가 최신 날짜부터) 그대로.
 * - all: 묶음 하나
 * - weekday: 월~일 순, 수업이 있는 요일만
 * - teacher: 선생님 이름 가나다순, «담당 미지정»은 맨 뒤
 */
export function groupAdminFeed(items: AdminFeedItem[], view: AdminFeedView): AdminFeedGroup[] {
  if (view === "all") return items.length ? [{ key: "all", label: "전체", items }] : [];
  if (view === "weekday") {
    const buckets = new Map<number, AdminFeedItem[]>();
    for (const item of items) {
      const dow = feedWeekday(item.ymd);
      if (dow < 0) continue;
      const bucket = buckets.get(dow) ?? [];
      bucket.push(item);
      buckets.set(dow, bucket);
    }
    return WEEKDAY_ORDER.filter((dow) => buckets.has(dow)).map((dow) => ({
      key: `dow-${dow}`,
      label: `${WEEKDAY_LABELS[dow]}요일`,
      items: buckets.get(dow)!,
    }));
  }
  const buckets = new Map<string, AdminFeedItem[]>();
  for (const item of items) {
    const name = item.teacherName?.trim() || NO_TEACHER_LABEL;
    const bucket = buckets.get(name) ?? [];
    bucket.push(item);
    buckets.set(name, bucket);
  }
  return [...buckets.keys()]
    .sort((a, b) => {
      if (a === NO_TEACHER_LABEL) return 1;
      if (b === NO_TEACHER_LABEL) return -1;
      return a.localeCompare(b, "ko");
    })
    .map((name) => ({ key: `t-${name}`, label: name, items: buckets.get(name)! }));
}

export type AdminFeedFilter = {
  /** 발행 상태 — ALL·PUBLISHED·DRAFT */
  publish: "ALL" | "PUBLISHED" | "DRAFT";
  /** 내용 없는 수업도 보이기 */
  includeEmpty: boolean;
  /** 선생님 이름(빈 문자열 = 전체) */
  teacher: string;
  /** 요일 번호(-1 = 전체) */
  weekday: number;
};

export const DEFAULT_ADMIN_FEED_FILTER: AdminFeedFilter = { publish: "ALL", includeEmpty: false, teacher: "", weekday: -1 };

export function applyAdminFeedFilter(items: AdminFeedItem[], filter: AdminFeedFilter): AdminFeedItem[] {
  return items.filter((item) => {
    if (!filter.includeEmpty && !hasFeedContent(item)) return false;
    if (filter.publish === "PUBLISHED" && !item.published) return false;
    if (filter.publish === "DRAFT" && item.published) return false;
    if (filter.teacher && (item.teacherName?.trim() || NO_TEACHER_LABEL) !== filter.teacher) return false;
    if (filter.weekday >= 0 && feedWeekday(item.ymd) !== filter.weekday) return false;
    return true;
  });
}

/** «필터 2» 버튼 숫자 — 기본값과 다른 항목 수(기간은 따로 표시하므로 세지 않는다) */
export function countActiveFilters(filter: AdminFeedFilter): number {
  let n = 0;
  if (filter.publish !== "ALL") n += 1;
  if (filter.includeEmpty) n += 1;
  if (filter.teacher) n += 1;
  if (filter.weekday >= 0) n += 1;
  return n;
}

/** 조회 기간 일수 — 허용값(7·30·90)만, 아니면 기본 30 */
export function normalizeFeedDays(value: unknown): number {
  const n = Number(value);
  return (ADMIN_FEED_DAYS_OPTIONS as readonly number[]).includes(n) ? n : ADMIN_FEED_DAYS_DEFAULT;
}
