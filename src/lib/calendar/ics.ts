/**
 * 캘린더 구독 파일(.ics) 만들기 — **순수 모듈**(DB·next 를 쓰지 않는다. 테스트가 그대로 실행한다).
 *
 * 왜 따로 두는가: 휴대폰 캘린더(구글·아이폰)는 형식이 조금만 어긋나도 일정을 통째로 버리거나
 * 날짜를 하루 밀어 보여 준다. 눈으로 읽어서는 못 잡으므로 규칙을 여기 모으고 실행 테스트로 못박는다.
 *
 * 지키는 규칙(RFC 5545)
 *  - 줄바꿈은 CRLF, 한 줄은 75옥텟(바이트)까지 — 넘으면 다음 줄을 빈칸 하나로 시작해 잇는다(한글을 반으로 자르지 않는다)
 *  - 글자 이스케이프: `\` `;` `,` 줄바꿈
 *  - 종일 일정: DTSTART;VALUE=DATE, DTEND 는 «끝 다음 날»(배타)
 *  - 시간 일정: 모두 UTC `Z` 표기로 통일한다(시간대 정의 블록 없이도 어느 캘린더에서나 같은 시각)
 *  - UID 는 부르는 쪽이 주는 값 그대로 — 같은 일정은 매번 같은 UID 여야 캘린더가 중복으로 넣지 않는다
 */

export type IcsEvent = {
  /** 같은 일정이면 항상 같은 값(바뀌면 캘린더에 일정이 두 번 생긴다) */
  uid: string;
  title: string;
  description?: string | null;
  location?: string | null;
} & (
  | {
      allDay: true;
      /** 시작일 "YYYY-MM-DD"(KST 달력) */
      startYmd: string;
      /** 마지막 날 "YYYY-MM-DD" — **포함**. 없으면 하루짜리 */
      endYmd?: string | null;
    }
  | {
      allDay: false;
      /** 시작·끝 절대 시각(ms). KST 시각은 kstAt(ymd, "HH:MM") 으로 만들어 넘긴다 */
      startMs: number;
      endMs: number;
    }
);

export type IcsCalendarInput = {
  /** 캘린더 앱에 보이는 이름 */
  name: string;
  events: readonly IcsEvent[];
  /** 캘린더 앱이 다시 받아 오는 간격(시간). 기본 6시간 */
  refreshHours?: number;
  /** 만든 시각(DTSTAMP). 테스트가 고정값을 넣는다 */
  nowMs?: number;
};

const YMD_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const pad = (n: number, width = 2) => String(n).padStart(width, "0");

/** 글자 이스케이프 — `\` 를 가장 먼저 바꿔야 뒤에서 붙인 `\` 가 또 바뀌지 않는다 */
export function escapeIcsText(value: unknown): string {
  return String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n");
}

/**
 * 한 줄을 75옥텟(UTF-8 바이트) 이하로 접는다. 이어지는 줄은 빈칸 하나로 시작한다(그 빈칸도 75 안에 센다).
 * 글자 단위로 세어 한글(3바이트)·이모지(4바이트)가 반으로 잘리지 않게 한다.
 */
export function foldIcsLine(line: string): string {
  const encoder = new TextEncoder();
  if (encoder.encode(line).length <= 75) return line;
  const out: string[] = [];
  let current = "";
  let bytes = 0;
  for (const ch of line) {
    const size = encoder.encode(ch).length;
    if (bytes + size > 75) {
      out.push(current);
      current = " "; // 이어지는 줄의 첫 칸
      bytes = 1;
    }
    current += ch;
    bytes += size;
  }
  out.push(current);
  return out.join("\r\n");
}

/** "YYYY-MM-DD" → "YYYYMMDD". 실재하지 않는 날짜면 "" */
export function icsDate(ymd: string): string {
  const m = YMD_RE.exec(String(ymd ?? ""));
  if (!m) return "";
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  // 달력 숫자 그대로 UTC 로 만들어 확인한다 — 시간대가 끼어들지 않는다
  const probe = new Date(Date.UTC(y, mo - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) return "";
  return `${m[1]}${m[2]}${m[3]}`;
}

/** 다음 날 "YYYYMMDD" — 종일 일정의 끝(배타). 월말·연말·윤년을 달력 계산으로 넘긴다 */
export function icsNextDate(ymd: string): string {
  if (!icsDate(ymd)) return "";
  const m = YMD_RE.exec(ymd)!;
  const next = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + 1));
  return `${pad(next.getUTCFullYear(), 4)}${pad(next.getUTCMonth() + 1)}${pad(next.getUTCDate())}`;
}

/** 절대 시각(ms) → UTC "YYYYMMDDTHHMMSSZ". 잘못된 값이면 "" */
export function icsUtcStamp(ms: number): string {
  if (!Number.isFinite(ms)) return "";
  const d = new Date(ms);
  return `${pad(d.getUTCFullYear(), 4)}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`
    + `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

/**
 * 안정적인 UID — 같은 재료면 항상 같은 값. 캘린더가 허용하는 글자만 남긴다.
 * 예) icsUid("class", classId, "2026-11-16") → "class-<id>-2026-11-16@stiz-dasan.kr"
 */
export function icsUid(...parts: Array<string | number>): string {
  const body = parts
    .map((part) => String(part).replace(/[^A-Za-z0-9._-]/g, "_"))
    .filter(Boolean)
    .join("-");
  return `${body}@stiz-dasan.kr`;
}

/** 일정 하나의 줄들. 날짜가 잘못된 일정은 빈 배열(통째로 건너뛴다 — 깨진 줄 하나가 전체 캘린더를 못 읽게 만든다) */
function eventLines(event: IcsEvent, stamp: string): string[] {
  const lines: string[] = ["BEGIN:VEVENT", `UID:${escapeIcsText(event.uid)}`, `DTSTAMP:${stamp}`];
  if (event.allDay) {
    const start = icsDate(event.startYmd);
    if (!start) return [];
    // 끝이 없거나 시작보다 앞서면 하루짜리로 본다
    const lastYmd = event.endYmd && icsDate(event.endYmd) && event.endYmd >= event.startYmd ? event.endYmd : event.startYmd;
    lines.push(`DTSTART;VALUE=DATE:${start}`, `DTEND;VALUE=DATE:${icsNextDate(lastYmd)}`);
  } else {
    const start = icsUtcStamp(event.startMs);
    if (!start) return [];
    // 끝이 시작보다 앞서거나 같으면 1시간짜리로 본다
    const endMs = Number.isFinite(event.endMs) && event.endMs > event.startMs ? event.endMs : event.startMs + 3_600_000;
    lines.push(`DTSTART:${start}`, `DTEND:${icsUtcStamp(endMs)}`);
  }
  lines.push(`SUMMARY:${escapeIcsText(event.title)}`);
  if (event.location) lines.push(`LOCATION:${escapeIcsText(event.location)}`);
  if (event.description) lines.push(`DESCRIPTION:${escapeIcsText(event.description)}`);
  lines.push("END:VEVENT");
  return lines;
}

/** 캘린더 전체 글 — 줄마다 접고 CRLF 로 잇는다(마지막 줄도 CRLF 로 끝난다) */
export function buildIcsCalendar(input: IcsCalendarInput): string {
  const hours = Math.max(1, Math.floor(input.refreshHours ?? 6));
  const stamp = icsUtcStamp(input.nowMs ?? Date.now());
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//STIZ//Academy Calendar//KO",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeIcsText(input.name)}`,
    "X-WR-TIMEZONE:Asia/Seoul",
    // 다시 받아 오는 간격 — 표준(REFRESH-INTERVAL)과 옛 방식(X-PUBLISHED-TTL) 둘 다 적는다
    `REFRESH-INTERVAL;VALUE=DURATION:PT${hours}H`,
    `X-PUBLISHED-TTL:PT${hours}H`,
  ];
  // 같은 UID 가 두 번 나가면 캘린더마다 처리 방식이 달라 먼저 온 것만 남긴다
  const seen = new Set<string>();
  for (const event of input.events) {
    if (!event?.uid || seen.has(event.uid)) continue;
    const block = eventLines(event, stamp);
    if (block.length === 0) continue;
    seen.add(event.uid);
    lines.push(...block);
  }
  lines.push("END:VCALENDAR");
  return lines.map(foldIcsLine).join("\r\n") + "\r\n";
}
