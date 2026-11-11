// 셔틀 명단 변경 → 기사님 알림 문구·링크·묶음 키(순수 함수, DB 접근 없음) — 2026-11-09 원장 결정 D5.
// ─────────────────────────────────────────────────────────────────────────────
// 왜: 정규 셔틀 기사님은 한 분이다. 원장이 명단을 고치면(추가·빼기·정류장/시각·재배정·위치 반영) 기사님이 바로 알아야
//   다음 운행에서 엉뚱한 곳에 서지 않는다. 알림 = «무엇이 바뀌었는지 한 줄» + «노선 확인하기»(바뀐 요일의 다음 운행일 운행표).
// 스팸 방지: 같은 달·같은 요일×방향 묶음 변경은 BUNDLE_MS(10분) 칸 하나에 한 번만 보낸다(전달 장부 dedupeKey).
//   묶음 안 두 번째 변경은 알림이 따로 가지 않지만, 링크는 «지금 운행표»를 열어 최신 상태를 보여 준다.
// ⚠️ node 타입 제거 실행으로 테스트하므로 '@/' 경로 import·enum 을 쓰지 않는다(런타임 import 는 .ts 확장자).
// 달력 값(요일·날짜 더하기)은 프로젝트 공용 kst 모듈만 쓴다(서버 UTC 함정 방지).

// @ts-expect-error -- TypeScript runtime test compatibility
import { addDaysKst, isKstYmd, kstDow } from "../datetime/kst.ts";

export type RosterChangeDirection = "BOARD" | "ALIGHT";
/** 바뀐 칸 = 요일 × 방향(같은 요일·방향의 여러 수업은 기사님 화면 한 장에 같이 보이므로 하나로 본다). */
export type RosterChangeCell = { weekday: number; direction: RosterChangeDirection };

/** 연속 변경 묶음 단위(밀리초) — 10분. */
export const ROSTER_NOTICE_BUNDLE_MS = 10 * 60 * 1000;
/** 알림 종류(Notification.type · 전달 장부 eventType). */
export const ROSTER_NOTICE_TYPE = "SHUTTLE_ROSTER_CHANGED";

const WD = ["일", "월", "화", "수", "목", "금", "토"];
const DIR_KO: Record<RosterChangeDirection, string> = { BOARD: "등원", ALIGHT: "하원" };
const rank = (w: number) => (w === 0 ? 7 : w);

/** 칸 목록 정리 — 형식이 이상한 칸은 버리고, 중복 제거, 요일(월→일)·등원 먼저 순. */
export function normalizeChangeCells(cells: readonly { weekday: unknown; direction: unknown }[]): RosterChangeCell[] {
  const seen = new Set<string>();
  const out: RosterChangeCell[] = [];
  for (const c of cells ?? []) {
    const w = Number(c?.weekday);
    const d = c?.direction;
    if (!Number.isInteger(w) || w < 0 || w > 6 || (d !== "BOARD" && d !== "ALIGHT")) continue; // 운영 정차(PIVOT/RETURN)는 알리지 않는다
    const key = `${w}|${d}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ weekday: w, direction: d });
  }
  return out.sort((a, b) => rank(a.weekday) - rank(b.weekday) || (a.direction === b.direction ? 0 : a.direction === "BOARD" ? -1 : 1));
}

/** «월 등원·수 하원» */
export function changeCellsLabel(cells: readonly RosterChangeCell[]): string {
  return cells.map((c) => `${WD[c.weekday]} ${DIR_KO[c.direction]}`).join("·");
}

/**
 * 그 달 안에서 그 요일의 다음 운행일(오늘 포함) — 'YYYY-MM-DD'. 그 달이 이미 지났거나 그 달 안에 없으면 null.
 * 미래 달이면 그 달 1일부터 센다. 요일은 kstDow(시간대 개입 없음)로만 구한다.
 */
export function nextRunDateInMonth(month: string, weekday: number, todayYmd: string): string | null {
  if (!/^20\d{2}-(0[1-9]|1[0-2])$/.test(String(month)) || !isKstYmd(todayYmd) || !Number.isInteger(weekday) || weekday < 0 || weekday > 6) return null;
  const first = `${month}-01`;
  // 'YYYY-MM-DD' 는 사전순 = 시간순이라 문자열로 비교한다.
  let d = todayYmd > first ? todayYmd : first;
  for (let i = 0; i < 7; i++) {
    if (d.slice(0, 7) !== month) return null; // 그 달을 넘어감
    if (kstDow(d) === weekday) return d;
    d = addDaysKst(d, 1);
  }
  return null;
}

/** «노선 확인하기» 링크 — 기사님 로그인 운행표. 날짜를 모르면 오늘 운행표. focus = 바뀐 방향(화면이 그 묶음으로 바로 가도록). */
export function rosterChangeLink(date: string | null, direction: RosterChangeDirection | null): string {
  const q: string[] = [];
  if (date) q.push(`date=${date}`);
  if (direction) q.push(`focus=${direction}`);
  return q.length ? `/staff/shuttle?${q.join("&")}` : "/staff/shuttle";
}

export type RosterChangeNotice = { title: string; message: string; linkUrl: string; stableEventKey: string };

/**
 * 알림 한 건 만들기. 바뀐 칸이 없으면 null(알릴 것 없음).
 * - 링크 = 바뀐 칸 중 다음 운행일이 가장 빠른 칸의 운행표.
 * - 묶음 키 = 달 + 바뀐 칸 목록 + 10분 칸 번호(nowMs 기준, 시간대 무관한 숫자 나눗셈).
 */
export function buildRosterChangeNotice(input: {
  month: string;
  cells: readonly { weekday: unknown; direction: unknown }[];
  summary: string;
  todayYmd: string;
  nowMs: number;
}): RosterChangeNotice | null {
  const cells = normalizeChangeCells(input.cells);
  if (cells.length === 0) return null;
  const dated = cells
    .map((c) => ({ c, date: nextRunDateInMonth(input.month, c.weekday, input.todayYmd) }))
    .sort((a, b) => (a.date && b.date ? a.date.localeCompare(b.date) : a.date ? -1 : b.date ? 1 : 0));
  const first = dated[0];
  const label = changeCellsLabel(cells);
  const summary = String(input.summary ?? "").trim().slice(0, 120) || "명단이 바뀌었어요";
  const monthNo = Number(input.month.slice(5, 7));
  const bucket = Math.floor(Number(input.nowMs) / ROSTER_NOTICE_BUNDLE_MS);
  return {
    title: `셔틀 명단 변경 · ${label}`,
    message: `${monthNo}월 ${label} — ${summary}. 노선 확인하기를 눌러 바뀐 운행표를 확인해 주세요.`,
    linkUrl: rosterChangeLink(first.date, first.c.direction),
    stableEventKey: `regular-roster-change:${input.month}:${cells.map((c) => `${c.weekday}${c.direction[0]}`).join(",")}:${bucket}`,
  };
}
