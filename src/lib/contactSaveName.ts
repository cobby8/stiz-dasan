/**
 * 신청 알림 문자에 넣는 "연락처 저장용 이름" — `yymm 이름 반 학년`.
 *
 * 원장님이 학부모 번호를 휴대폰에 `2610 이성빈 목7 초6` 형식으로 저장한다.
 * 알림 문자에서 이 한 줄만 길게 눌러 복사하면 바로 저장할 수 있게 서버에서 만들어 준다.
 *
 * - yymm: 신청한 달(KST). 서버는 UTC 라 반드시 kst 모듈로 구한다.
 * - 반: 수업 키 `Thu-7` → `목7`. 여러 개면 요일 순서로 붙인다(`화6목6`). 없으면 생략.
 * - 학년: 신청서 값 그대로(`초6`). 없으면 생략.
 */
import { todayKst } from "@/lib/datetime/kst";

// 수업 키 요일 코드 → 한글 (월요일부터의 순서가 정렬 기준)
const DAY_CODES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
const DAY_KO = ["월", "화", "수", "목", "금", "토", "일"];
const SLOT_KEY_RE = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)-(\d+)$/;

/** `Thu-7` / `Tue-6,Thu-6` / 배열 → `목7` / `화6목6`. 모르는 형식은 버린다. */
export function slotKeysToShortLabel(slotKeys: string | string[] | null | undefined): string {
  const keys = Array.isArray(slotKeys) ? slotKeys : String(slotKeys ?? "").split(",");
  const slots = new Map<string, { day: number; period: number }>();
  for (const raw of keys) {
    const m = SLOT_KEY_RE.exec(raw.trim());
    if (!m) continue;
    const day = DAY_CODES.indexOf(m[1] as (typeof DAY_CODES)[number]);
    const period = Number(m[2]);
    slots.set(`${day}-${period}`, { day, period }); // 같은 반 중복 제거
  }
  return [...slots.values()]
    .sort((a, b) => a.day - b.day || a.period - b.period)
    .map((s) => `${DAY_KO[s.day]}${s.period}`)
    .join("");
}

/** 신청한 달(KST)의 `yymm`. 예: 2026-10-23 → `2610` */
export function kstYymm(nowMs: number = Date.now()): string {
  const ymd = todayKst(nowMs); // "YYYY-MM-DD"
  return `${ymd.slice(2, 4)}${ymd.slice(5, 7)}`;
}

/** `2610 이성빈 목7 초6` — 빈 칸은 건너뛴다. */
export function buildContactSaveName(input: {
  childName: string;
  childGrade?: string | null;
  slotKeys?: string | string[] | null;
  nowMs?: number;
}): string {
  return [
    kstYymm(input.nowMs),
    input.childName.trim(),
    slotKeysToShortLabel(input.slotKeys),
    (input.childGrade ?? "").trim(),
  ]
    .filter(Boolean)
    .join(" ");
}
