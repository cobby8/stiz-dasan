// 셔틀 등원시간 안내 문자의 **문안 생성**. 부수효과·DB 접근이 전혀 없는 순수 모듈이다.
//
// 왜 순수 모듈로 떼는가(dispatchReconcile.ts와 같은 이유):
//   실제 학부모에게 나가는 문자다. 잘못 나가면 회수할 수 없으므로 node --test로
//   **실제로 돌려 보고** 검증할 수 있어야 한다. DB에 붙어 있으면 그게 불가능하다.

/** 요일 인덱스(0=일 ~ 6=토) → 한글 한 글자. */
const DOW_KO = ["일", "월", "화", "수", "목", "금", "토"];

export type NoticeTime = { dow: number; minutes: number };

/** 'HH:MM 승차' / 'HH:MM' → 자정 기준 분. 못 읽으면 null. */
export function parseEtaMinutes(label: string | null | undefined): number | null {
  const m = /(\d{1,2}):(\d{2})/.exec(String(label ?? ""));
  if (!m) return null;
  const h = Number(m[1]), mi = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(mi) || h > 23 || mi > 59) return null;
  return h * 60 + mi;
}

/** 자정 기준 분 → "오전 9시 5분" / "오전 9시". */
export function toKoreanTime(minutes: number): string {
  const h = Math.floor(minutes / 60), m = minutes % 60;
  const ampm = h < 12 ? "오전" : "오후";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${ampm} ${h12}시` : `${ampm} ${h12}시 ${m}분`;
}

/**
 * 요일 목록 → "월·수" / "월~금" / "화·수·목".
 * 3일 이상이면서 연속이면 물결(~)로 줄여 읽기 쉽게 한다.
 */
export function formatDays(dows: number[]): string {
  const uniq = [...new Set(dows)].sort((a, b) => a - b);
  if (uniq.length === 0) return "";
  const consecutive = uniq.every((d, i) => i === 0 || d === uniq[i - 1] + 1);
  if (uniq.length >= 3 && consecutive) return `${DOW_KO[uniq[0]]}~${DOW_KO[uniq[uniq.length - 1]]}`;
  return uniq.map((d) => DOW_KO[d]).join("·");
}

/**
 * 정류장 표시명을 학부모용으로 다듬는다.
 * 내부 표기 "무료탑승 · 새봄중 버스정류장"은 그대로 보내면 어색하므로
 * "새봄중 버스정류장 (무료 탑승)"으로 바꾼다.
 */
export function toParentStopLabel(label: string): string {
  const raw = (label ?? "").trim();
  if (!raw) return "(위치 미지정)";
  if (!raw.replace(/\s/g, "").includes("무료탑승")) return raw;
  const cleaned = raw
    .replace(/무료\s*탑승/g, "")
    // "1호점(무료탑승)" 처럼 괄호 안에 있던 경우 빈 껍데기가 남는다. 이걸 안 지우면
    // "1호점() (무료 탑승)" 같은 문자가 학부모에게 그대로 나간다.
    .replace(/[（(]\s*[)）]/g, "")
    .replace(/^[\s·・.,\-]+|[\s·・.,\-]+$/g, "")
    .trim();
  return cleaned ? `${cleaned} (무료 탑승)` : "무료 탑승 거점";
}

/** 'YYYY-MM-DD' → "8월 10일(월)". 형식이 아니면 null. */
export function toKoreanDate(date: string | null | undefined): string | null {
  const s = String(date ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const [y, m, d] = s.split("-").map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return `${m}월 ${d}일(${DOW_KO[dow]})`;
}

export type NoticeInput = {
  studentName: string;
  stopLabel: string;
  /** 요일별 승차 시각(자정 기준 분). 같은 요일이 여러 번 들어와도 된다. */
  times: NoticeTime[];
  /** 아직 시작 전이면 첫 등원일('YYYY-MM-DD'). 이미 다니는 중이면 null. */
  startsFrom?: string | null;
};

/**
 * 요일별 시각을 **같은 시각끼리 묶어** 돌려준다. 예: [{days:"월~목", minutes:560}, {days:"금", minutes:550}]
 *
 * ⚠️ 절대 "가장 이른 시각 하나"로 합치지 마라.
 *   김대후는 월~목 09:20, 금 09:12다. 하나로 합치면 09:10이 되어 **월~목에 10분이나 일찍**
 *   나와 기다리게 된다(2026-08-03 발송 직전 발견). 요일마다 시각이 다르면 반드시 나눠 적는다.
 *
 * 같은 요일이 여러 번 들어오면 그 요일의 **가장 이른 시각**을 그 요일 값으로 삼는다.
 */
export function groupTimesByDay(times: NoticeTime[]): { dows: number[]; minutes: number }[] {
  const earliestPerDow = new Map<number, number>();
  for (const t of times) {
    if (!Number.isFinite(t.minutes)) continue;
    const cur = earliestPerDow.get(t.dow);
    if (cur == null || t.minutes < cur) earliestPerDow.set(t.dow, t.minutes);
  }
  // 시각은 **반올림하지 않고 그대로** 쓴다(원장 지시 2026-08-03).
  //   5분 단위로 뭉개면 실제와 어긋나므로, 정확한 시각을 주고 문안에서 "예상 시간"임을 밝힌다.
  const byTime = new Map<number, number[]>();
  for (const [dow, minutes] of earliestPerDow) {
    const list = byTime.get(minutes);
    if (list) list.push(dow); else byTime.set(minutes, [dow]);
  }
  return [...byTime.entries()]
    .map(([minutes, dows]) => ({ minutes, dows: dows.sort((a, b) => a - b) }))
    .sort((a, b) => a.dows[0] - b.dows[0]);
}

/**
 * 한 학생의 안내 문안을 만든다. 발송부가 앞에 "[스티즈농구교실] "를 자동으로 붙이므로 여기서는 넣지 않는다.
 * 요일마다 시각이 다르면 줄을 나눠 적는다(합치면 실제보다 이른 시각을 안내하게 된다).
 */
export function buildNoticeBody(input: NoticeInput): string {
  const groups = groupTimesByDay(input.times ?? []);
  if (groups.length === 0) throw new Error(`${input.studentName}: 탑승 시각이 없습니다.`);

  const startLine = toKoreanDate(input.startsFrom);
  const timeLines = groups.length === 1
    ? [`▪ 탑승 예상 시간 : ${formatDays(groups[0].dows)} ${toKoreanTime(groups[0].minutes)}`]
    : ["▪ 탑승 예상 시간", ...groups.map((g) => `   · ${formatDays(g.dows)} ${toKoreanTime(g.minutes)}`)];

  return [
    // 발송부가 «[스티즈농구교실] »을 앞에 붙인다(2026-11-09 머리말 통일) → «[스티즈농구교실] 등원 셔틀 안내»
    "등원 셔틀 안내",
    "",
    `${input.studentName} 학부모님, 안녕하세요.`,
    startLine
      ? `${startLine}부터 시작하는 등원 셔틀 탑승 예상 시간을 안내드립니다.`
      : "등원 셔틀 탑승 예상 시간을 안내드립니다.",
    "",
    `▪ 탑승 장소 : ${toParentStopLabel(input.stopLabel)}`,
    ...timeLines,
    "",
    "· 위 시각은 교통 상황에 따라 앞뒤로 달라질 수 있는 예상 시간입니다.",
    "  5분 전에는 나와서 기다려 주세요.",
    "· 결석이나 자차 등원 시 미리 알려주시면 감사하겠습니다.",
    "",
    "STIZ 농구교실 다산점",
  ].join("\n");
}
