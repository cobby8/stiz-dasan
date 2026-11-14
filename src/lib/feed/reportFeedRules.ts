/**
 * 학부모 «수업 리포트 피드» 순수 규칙(2026-11-14 원장 요청) — DB·네트워크 없이 «입력 → 결과»만 계산한다.
 *
 * 화면 /mypage/reports/feed 는 수업 1회를 게시물 하나로 세로로 이어 보여 준다(인스타그램식).
 * 최신이 위, 날짜가 바뀌는 곳에 «11월 13일 (금)» 구분줄, 처음 20개 + 끝에 닿으면 다음 20개.
 *
 * 다음 장은 «커서»로 받는다 — 커서 = 마지막 게시물의 (수업일, 수업 id). 책갈피 같은 것이다:
 * «여기까지 읽었으니 이보다 오래된 것부터 주세요». 번호(offset)로 받으면 그사이 새 리포트가 발행됐을 때
 * 같은 게시물이 두 번 보이거나 하나가 빠진다.
 *
 * ⚠️ 이 파일은 순수 모듈(datetime/kst 만 import). prisma·next 를 들이지 않는다.
 *    테스트(tests/parent-report-feed.test.mjs)가 실제로 돌린다.
 */
import { isKstYmd, kstDow, kstLabel } from "@/lib/datetime/kst";

/** 한 번에 받는 게시물 수 */
export const REPORT_FEED_PAGE_SIZE = 20;
/** 한 번에 받을 수 있는 최대 개수(입력값 상한) */
export const REPORT_FEED_PAGE_MAX = 50;
/** ?start= 로 들어왔을 때 그 수업까지 한 번에 받는 최대 개수 — 이보다 멀면 그냥 맨 위부터 */
export const REPORT_FEED_START_MAX = 200;

/** 수업 id 모양(uuid·옛 id) — 주소에서 오는 값이라 SQL 에 넣기 전에 모양부터 본다(바인딩은 따로 한다) */
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** 주소·요청에서 온 수업 id 가 쓸 만한 모양인가 — 아니면 null */
export function parseSessionIdParam(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  return SESSION_ID_RE.test(value) ? value : null;
}

export type ReportFeedCursor = { ymd: string; id: string };

/** 커서 → 문자열 "YYYY-MM-DD~<수업 id>" (주소에 그대로 실어도 되는 글자만) */
export function encodeReportFeedCursor(cursor: ReportFeedCursor): string {
  return `${cursor.ymd}~${cursor.id}`;
}

/** 문자열 → 커서. 모양이 틀리면 null(= 처음부터가 아니라 «잘못된 요청»으로 다룬다) */
export function parseReportFeedCursor(raw: unknown): ReportFeedCursor | null {
  if (typeof raw !== "string") return null;
  const at = raw.indexOf("~");
  if (at <= 0) return null;
  const ymd = raw.slice(0, at);
  const id = parseSessionIdParam(raw.slice(at + 1));
  if (!isKstYmd(ymd) || !id) return null;
  return { ymd, id };
}

/** 받을 개수 — 정수 1~50 으로 자른다. 잘못된 값은 기본 20 */
export function clampReportFeedLimit(raw: unknown): number {
  const n = typeof raw === "string" ? Number(raw) : typeof raw === "number" ? raw : NaN;
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) return REPORT_FEED_PAGE_SIZE;
  return Math.min(n, REPORT_FEED_PAGE_MAX);
}

/**
 * 받은 게시물로 다음 커서를 만든다. 요청한 개수보다 적게 왔으면 끝(null).
 * 게시물은 (수업일 내림차순, id 내림차순)으로 와야 한다.
 */
export function nextReportFeedCursor(posts: ReadonlyArray<{ id: string; ymd: string }>, limit: number): string | null {
  if (posts.length < limit || posts.length === 0) return null;
  const last = posts[posts.length - 1];
  return encodeReportFeedCursor({ ymd: last.ymd, id: last.id });
}

/**
 * 이어 붙이기 — 이미 있는 게시물 뒤에 새 장을 붙이되 같은 id 는 한 번만(다시 불러오기를 두 번 눌러도 안전).
 */
export function appendReportFeedPage<T extends { id: string }>(current: readonly T[], incoming: readonly T[]): T[] {
  const seen = new Set(current.map((p) => p.id));
  const result = [...current];
  for (const post of incoming) {
    if (seen.has(post.id)) continue;
    seen.add(post.id);
    result.push(post);
  }
  return result;
}

const DOW_KO = ["일", "월", "화", "수", "목", "금", "토"] as const;

/** 날짜 구분줄 글자 "11월 13일 (금)" — 잘못된 날짜는 "" */
export function reportFeedDayLabel(ymd: string): string {
  if (!isKstYmd(ymd)) return "";
  const [, m, d] = ymd.split("-");
  return `${Number(m)}월 ${Number(d)}일 (${DOW_KO[kstDow(ymd)]})`;
}

/** 게시물 머리줄의 날짜·시간 "11/13(금) 15:00" — 시간이 없으면 날짜만 */
export function reportFeedWhenLabel(ymd: string, startTime: string | null | undefined): string {
  const day = kstLabel(ymd);
  const time = typeof startTime === "string" && /^\d{1,2}:\d{2}$/.test(startTime.trim()) ? startTime.trim() : "";
  return [day, time].filter(Boolean).join(" ");
}

export type ReportFeedRow<T> = { kind: "day"; ymd: string; label: string } | { kind: "post"; post: T };

/**
 * 게시물 사이에 날짜 구분줄을 끼운다 — 첫 게시물 앞, 그리고 수업일이 바뀌는 곳마다.
 * 같은 날짜가 띄엄띄엄 와도(정렬이 깨진 입력) 바뀔 때마다 새 줄을 넣는다(순서를 바꾸지 않는다).
 */
export function withReportFeedDayDividers<T extends { ymd: string }>(posts: readonly T[]): Array<ReportFeedRow<T>> {
  const rows: Array<ReportFeedRow<T>> = [];
  let lastYmd: string | null = null;
  for (const post of posts) {
    if (post.ymd !== lastYmd) {
      rows.push({ kind: "day", ymd: post.ymd, label: reportFeedDayLabel(post.ymd) });
      lastYmd = post.ymd;
    }
    rows.push({ kind: "post", post });
  }
  return rows;
}

/** 출결 상태 → 글자(학부모 소식 상세와 같은 말). 기록이 없거나 모르는 값은 «확인 중» */
export function reportFeedAttendanceLabel(status: string | null | undefined): string {
  if (status === "PRESENT") return "출석";
  if (status === "LATE") return "지각";
  if (status === "ABSENT") return "결석";
  return "확인 중";
}

/** 피드 화면 주소 — 소식 탭·홈 카드가 같은 함수로 만든다(start 는 모양이 맞을 때만 붙인다) */
export function reportFeedHref(startSessionId?: string | null): string {
  const id = parseSessionIdParam(startSessionId ?? null);
  return id ? `/mypage/reports/feed?start=${encodeURIComponent(id)}` : "/mypage/reports/feed";
}
