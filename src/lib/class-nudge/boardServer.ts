// 수업 미처리 장치(2026-11-17) — prisma·연간일정·캐시를 꽂는 연결부.
//
// 문지기(requireAdmin)는 여기에 두지 않는다 — 쿠키를 읽는 확인은 캐시 안에 넣을 수 없어 부르는 쪽(API 라우트·액션)이 한다.
// 2~3단계 크론은 캐시를 거치지 않는 loadClassDayFacts 를 직접 부른다.
import { unstable_cache } from "next/cache";
import { prisma } from "@/lib/prisma";
import { loadRegularRunPlan } from "@/lib/shuttle/regularRunDay";
import { regularRunHoliday } from "@/lib/shuttle/regularRunDayRules";
import { buildClassDayBoard, type ClassDayBoard, type ClassDayFacts } from "./board";
import { loadClassDayDbFacts, type ClassDayDbFacts } from "./boardQuery";

/** 휴강 표시·취소가 이 태그를 비운다 */
export const CLASS_DAY_CACHE_TAG = "admin-class-day";

/**
 * 그날의 휴무 판정. 기사님 운행표·선생님 홈과 같은 함수(regularRunHoliday)를 쓴다.
 * 연간일정을 못 읽으면 known=false — 휴무 판정 없이 평소대로 보이고 화면에 한 줄 안내한다.
 */
async function loadHoliday(dateYmd: string): Promise<{ holiday: { title: string } | null; holidayKnown: boolean }> {
  const plan = await loadRegularRunPlan().catch(() => null);
  if (!plan) return { holiday: null, holidayKnown: false };
  const hit = regularRunHoliday(dateYmd, plan.monthlyDates, plan.events);
  return { holiday: hit ? { title: hit.title } : null, holidayKnown: true };
}

function withHoliday(
  dateYmd: string,
  db: ClassDayDbFacts,
  holiday: { holiday: { title: string } | null; holidayKnown: boolean },
): ClassDayFacts {
  return { dateYmd, ...db, ...holiday };
}

/** 그날의 사실 전부(캐시 없음) — 시계와 무관하다. DB 조회 4번은 차례로 나간다. */
export async function loadClassDayFacts(dateYmd: string): Promise<ClassDayFacts> {
  const db = await loadClassDayDbFacts(prisma, dateYmd);
  return withHoliday(dateYmd, db, await loadHoliday(dateYmd));
}

// DB 사실만 30초 캐시한다. 날짜 인자가 캐시 열쇠에 들어간다.
// 연간일정은 이 캐시 «밖»에서 읽는다(설계와 달라진 점) — 그쪽은 자체 5분 캐시가 있고,
// 외부 일정 가져오기를 이 캐시 안에 넣으면 한 번의 읽기 실패(«휴무 모름»)가 30초 동안 같이 굳는다.
const getCachedDbFacts = unstable_cache(
  (dateYmd: string) => loadClassDayDbFacts(prisma, dateYmd),
  ["class-day-facts-v1"],
  { revalidate: 30, tags: [CLASS_DAY_CACHE_TAG, "admin-classes"] },
);

/** 그날의 사실 전부(DB 사실 30초 캐시) — 대시보드용 */
export async function getCachedClassDayFacts(dateYmd: string): Promise<ClassDayFacts> {
  const db = await getCachedDbFacts(dateYmd);
  return withHoliday(dateYmd, db, await loadHoliday(dateYmd));
}

/** 대시보드 «오늘 수업 처리 현황» 자료. 사실은 캐시, 판정은 넘겨받은 시각으로 매번 새로. */
export async function getClassDayBoard(dateYmd: string, nowMs: number): Promise<ClassDayBoard> {
  return buildClassDayBoard(await getCachedClassDayFacts(dateYmd), nowMs);
}

export { buildClassDayBoard };
