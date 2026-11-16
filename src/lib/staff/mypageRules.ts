/**
 * 선생님 «마이페이지»(/staff/mypage)의 순수 규칙 — 이번 달 범위·역할 이름·담당 반 정렬(2026-11-16 원장 지시).
 *
 * ⚠️ 순수 모듈 — @/lib/datetime/kst 만 import 한다(prisma·next 금지). tests/staff-mypage.test.mjs 가 실제로 돌린다.
 *    날짜는 "YYYY-MM-DD"(KST) 글자로만 다룬다. 서버 시계의 getDate()/getMonth() 는 쓰지 않는다
 *    (배포 서버는 UTC 라 매달 1일 00~09시(KST)에 «지난달»이 나온다).
 */
import { addDaysKst, addMonthsYm, isKstYmd, todayKst } from "@/lib/datetime/kst";

export type KstMonthRange = {
  /** "YYYY-MM" */
  ym: string;
  /** 그 달 1일 */
  startYmd: string;
  /** 다음 달 1일 — 조회는 «startYmd 이상, nextStartYmd 미만»으로 한다 */
  nextStartYmd: string;
  /** 그 달 마지막 날 */
  lastYmd: string;
  /** 화면 표시 «11월» */
  label: string;
};

/**
 * 어떤 KST 날짜가 속한 달의 범위. 잘못된 날짜는 null.
 * 달력 글자만 센다 — 시간대가 끼어들 자리가 없다(연말 12월 → 다음 해 1월, 윤년 2월 29일 포함).
 */
export function kstMonthRangeOf(ymd: string): KstMonthRange | null {
  if (!isKstYmd(ymd)) return null;
  const ym = ymd.slice(0, 7);
  const nextYm = addMonthsYm(ym, 1);
  if (!nextYm) return null;
  const nextStartYmd = `${nextYm}-01`;
  return {
    ym,
    startYmd: `${ym}-01`,
    nextStartYmd,
    lastYmd: addDaysKst(nextStartYmd, -1),
    label: `${Number(ym.slice(5, 7))}월`,
  };
}

/** 지금 시각이 속한 KST 달의 범위 — «이번 달». KST 00:00(= UTC 전날 15:00)에 달이 넘어간다 */
export function kstMonthRangeAt(nowMs: number = Date.now()): KstMonthRange | null {
  return kstMonthRangeOf(todayKst(nowMs));
}

/** 내 정보 칸의 역할 이름 — 원장 · 부원장 · 선생님 · 기사님(선생님과 기사님을 겸하면 둘 다) */
export function staffRoleLabel(primaryRole: string, roles: { teacher: boolean; driver: boolean }): string {
  if (primaryRole === "ADMIN") return "원장";
  if (primaryRole === "VICE_ADMIN") return "부원장";
  const names = [roles.teacher ? "선생님" : "", roles.driver ? "기사님" : ""].filter(Boolean);
  return names.length > 0 ? names.join(" · ") : "직원";
}

// 반 요일(Class.dayOfWeek = "Mon" 등) — 월요일부터 일요일 순
const CLASS_DAY_ORDER = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
const CLASS_DAY_LABELS: Record<string, string> = { Mon: "월", Tue: "화", Wed: "수", Thu: "목", Fri: "금", Sat: "토", Sun: "일" };

/** 반 요일의 한글 한 글자. 모르는 값은 빈 글자(영어 원문을 화면에 내지 않는다) */
export function classDayLabel(dayOfWeek: string): string {
  return CLASS_DAY_LABELS[dayOfWeek] ?? "";
}

export type StaffMyClassRow = {
  id: string;
  name: string;
  dayOfWeek: string;
  startTime: string;
  endTime: string;
  studentCount: number;
};

/** 담당 반 정렬 — 요일(월→일) · 시작 시간 · 반 이름 순. 모르는 요일은 맨 뒤 */
export function sortStaffClasses<T extends Pick<StaffMyClassRow, "name" | "dayOfWeek" | "startTime">>(rows: readonly T[]): T[] {
  const dayIndex = (day: string) => {
    const index = (CLASS_DAY_ORDER as readonly string[]).indexOf(day);
    return index === -1 ? CLASS_DAY_ORDER.length : index;
  };
  return [...rows].sort((a, b) =>
    dayIndex(a.dayOfWeek) - dayIndex(b.dayOfWeek)
    || String(a.startTime).localeCompare(String(b.startTime))
    || String(a.name).localeCompare(String(b.name), "ko"));
}

/** 연락처 표시 — 숫자 11자리(010…)·10자리만 «-»를 넣고, 그 밖은 적힌 그대로. 비어 있으면 "" */
export function staffPhoneLabel(phone: string | null | undefined): string {
  const raw = String(phone ?? "").trim();
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 11) return `${digits.slice(0, 3)}-${digits.slice(3, 7)}-${digits.slice(7)}`;
  if (digits.length === 10) return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
  return raw;
}

export type StaffMonthSessionStats = {
  /** 이번 달 완료한 수업 */
  completed: number;
  /** 수업 내용·사진·영상이 하나도 없는 수업(«지난 수업»의 «피드 없음»과 같은 판정) */
  noFeed: number;
  /** 학부모에게 아직 안 보낸 수업(«지난 수업»의 «안 보냄»과 같은 판정) */
  unpublished: number;
};

/** «지난 수업 보기» 링크를 보일까 — 안 쓴 수업이나 안 보낸 수업이 하나라도 있을 때 */
export function needsPastSessionsLink(stats: StaffMonthSessionStats): boolean {
  return stats.noFeed > 0 || stats.unpublished > 0;
}
