/**
 * 방학특강 «날짜별 정원» 판정(2026-11-18 기간 선택·날짜별 선택).
 *
 * 왜 날짜별인가: 기간(앞 3주만)·날짜 하나씩 고르기가 생기면 «요일별 인원»만으론 틀린다.
 *   1월 첫 주는 꽉 찼어도 셋째 주는 비어 있을 수 있다. 그래서 회차가 있는 날마다
 *   «그날 나오는 신청서 수»를 세고, 이번 신청이 차지할 날짜 중 정원 이상인 날을 찾는다.
 *
 * 공개 신청(service.ts)과 관리자 승인 경로가 **같은 함수**를 쓴다 — 한쪽만 고치면 정원이 어긋난다.
 * 단 «무슨 상태를 세는가»는 경로마다 다르다: 공개 신청 = PENDING+APPROVED(기본값), 관리자 승인 = APPROVED(statuses 로 넘김).
 * 출석 판정은 attendance-rule.ts 한 곳 규칙(countOccupancyByDate)을 그대로 쓴다.
 */
import type { Prisma } from "@prisma/client";
import { countOccupancyByDate, type AttendanceSessionLike, type SeasonalAttendanceRule } from "./attendance-rule";
import { fullDateKeysFromOccupancy, occupiedDateKeys } from "./application-plan";

/** 정원을 차지하는 신청 항목 상태 — service.ts OCCUPYING_ITEM_STATUSES 와 같다. */
export const DATE_CAPACITY_OCCUPYING_STATUSES = ["PENDING", "APPROVED"] as const;

export type FindFullDatesArgs = {
  /** 같은 운영 범위(같은 연결 반)의 특강 반 id 전부 — 주2회·주3회 반이 한 교실을 나눠 쓴다. */
  scopeOfferingIds: string[];
  /** 그 반의 정원. null 이면 정원 없음 → 언제나 빈 배열. */
  capacity: number | null;
  /** 운영 범위의 회차 전부(날짜가 겹쳐도 된다 — 날짜 단위로 묶어 센다). */
  sessionDates: ReadonlyArray<AttendanceSessionLike>;
  /** 이번에 넣으려는 신청서의 출석 규칙(요일·기간·고른 날짜). */
  rule: SeasonalAttendanceRule;
  /**
   * 세지 않을 신청서 id — 관리자 승인처럼 «이미 정원을 차지 중인 그 신청서 자신»을 다시 판정할 때 넣는다.
   * (대기 → 승인은 대기 항목이 정원을 차지하지 않으므로 넣을 필요 없다.)
   */
  excludeApplicationIds?: string[];
  /**
   * 정원을 차지한다고 볼 항목 상태. 안 넘기면 PENDING+APPROVED(공개 신청 — 대기 접수 판단용).
   * 관리자 승인 경로는 기존처럼 APPROVED 만 넘긴다(승인 대기 신청이 많아도 승인할 수 있어야 한다 · 검수 M-1).
   */
  statuses?: readonly string[];
};

/**
 * 이번 신청이 차지할 날짜 중 이미 정원 이상인 날짜(KST 'YYYY-MM-DD', 오름차순).
 * 빈 배열이면 들어갈 수 있다. 거래(tx) 안에서 특강 행 잠금 뒤에 부를 것.
 */
export async function findFullDates(
  tx: Prisma.TransactionClient,
  { scopeOfferingIds, capacity, sessionDates, rule, excludeApplicationIds = [], statuses }: FindFullDatesArgs,
): Promise<string[]> {
  if (capacity === null || capacity === undefined || scopeOfferingIds.length === 0) return [];
  const wanted = occupiedDateKeys(sessionDates, rule);
  if (wanted.length === 0) return [];
  // 빈 배열·미지정이면 기본(PENDING+APPROVED) — 공개 신청 동작은 그대로
  const countedStatuses = statuses && statuses.length > 0 ? [...statuses] : [...DATE_CAPACITY_OCCUPYING_STATUSES];

  // 같은 범위에서 정원을 차지 중인 항목의 신청서 규칙을 모은다.
  const items = await tx.specialProgramApplicationItem.findMany({
    where: {
      offeringId: { in: scopeOfferingIds },
      status: { in: countedStatuses },
      ...(excludeApplicationIds.length ? { applicationId: { notIn: excludeApplicationIds } } : {}),
    },
    select: {
      applicationId: true,
      application: {
        select: {
          selectionMode: true,
          selectedWeekdays: true,
          selectedDates: true,
          periodStartDate: true,
          periodEndDate: true,
        },
      },
    },
  });
  // 한 신청서가 같은 범위에 항목을 둘 가졌어도 학생은 한 명이다 — 신청서 단위로 묶어 두 번 세지 않는다.
  const rules = new Map<string, SeasonalAttendanceRule>();
  for (const item of items) {
    if (!rules.has(item.applicationId)) rules.set(item.applicationId, item.application);
  }
  const occupancy = countOccupancyByDate([...rules.values()], sessionDates);
  return fullDateKeysFromOccupancy(occupancy, capacity, wanted);
}
