/**
 * 방학특강 «반 = 교시 하나» 묶음(2026-11-19 원장 «특강반은 주2회·주3회 같은 횟수 이름이 들어가는 게 아니라
 * 횟수는 신청 학생이 선택하는 옵션. 반 이름은 "초등 고학년"처럼 하나로 통일»).
 *
 * 데이터 구조는 그대로다 — 한 교시(같은 linkedClassId)에 주2회·주3회·매일(주5회) 반(offering)이 따로 있고
 *   가격·정원·신청 항목은 지금처럼 그 반에 붙는다. 여기서는 «보여 주는 방식»만 바꾼다:
 *   같은 운영 반의 반들을 묶음 하나로 모으고, 횟수(주N회)는 묶음 안의 «고르는 옵션»으로 보여 준다.
 *
 * 횟수는 반 이름의 «주N회» 또는 반 코드 끝 «-N»(예: WINTER1-EH-2)에서 읽는다(offeringWeeklyFrequency 한 곳).
 *   그래서 반 이름에서 «주N회»를 빼도(«초등 고학년») 코드로 횟수를 계속 안다.
 *
 * ⚠️ prisma import 금지(공개 화면·관리자 화면·서버가 같이 쓴다). 순수 함수만.
 */
// @ts-expect-error -- Node 타입 제거 기반 단위 테스트는 런타임 확장자를 요구한다.
import { offeringWeeklyFrequency, resolvePeriodPrice, weeklyFrequencyLabel, type OfferingPeriodLike } from "./period-pricing.ts";

// «매일(주5회)»·«(주3회)»·«주 2회» 를 한 번에 찾는 식 — 이름에서 횟수 부분만 지울 때 쓴다
const FREQUENCY_IN_TITLE = /\s*(?:매일\s*)?\(\s*주\s*\d+\s*회\s*\)|\s*주\s*\d+\s*회/g;

/**
 * 반 이름에서 횟수 부분을 뺀 «교시 이름».
 * 예: «초등 고학년 주2회»·«초등 고학년 매일(주5회)»·«초등 고학년 주 3회» → «초등 고학년».
 * 다 지워지면 원래 이름(빈 제목 금지).
 */
export function offeringBaseTitle(title: string): string {
  const raw = String(title ?? "");
  const stripped = raw.replace(FREQUENCY_IN_TITLE, " ").replace(/\s+/g, " ").trim();
  return stripped || raw.trim();
}

/** 반 이름 안에 이미 «주N회»가 들어 있는가 */
function titleHasFrequency(title: string): boolean {
  return /주\s*\d+\s*회/.test(title);
}

/**
 * 횟수까지 붙은 반 이름 — 문자·청구서·신청 목록에 남기는 «무엇을 신청했는지» 글자.
 * 이름에 이미 «주N회»가 있으면 그대로(기존 반은 지금과 글자가 같다),
 * 이름에서 횟수를 뺐으면(«초등 고학년») 코드의 횟수를 붙인다 → «초등 고학년 주2회» / «초등 고학년 매일(주5회)».
 * 횟수를 못 읽으면 이름 그대로.
 */
export function offeringTitleWithFrequency(offering: { title?: string | null; code?: string | null }): string {
  const title = String(offering.title ?? "").trim();
  if (titleHasFrequency(title)) return title;
  const frequency = offeringWeeklyFrequency({ title, code: offering.code });
  return frequency ? `${title} ${weeklyFrequencyLabel(frequency)}`.trim() : title;
}

/**
 * «교시 이름 · 횟수» 표시(관리자 신청 목록 «초등 고학년 · 주2회»). 횟수를 못 읽으면 이름만.
 */
export function offeringGroupLabel(offering: { title?: string | null; code?: string | null }): string {
  const title = String(offering.title ?? "").trim();
  const frequency = offeringWeeklyFrequency({ title, code: offering.code });
  const base = offeringBaseTitle(title);
  return frequency ? `${base} · ${weeklyFrequencyLabel(frequency)}` : base;
}

/** 묶음에 넣을 반이 가져야 할 최소 정보 */
export type GroupableOffering = { id: string; linkedClassId?: string | null; code?: string | null };

/** 묶음 안의 «횟수 옵션» 하나 = 반 하나 */
export type FrequencyOption<T> = {
  /** 주N회의 N. 이름·코드 어디에도 없으면 null(횟수 미설정) */
  frequency: number | null;
  /** «주2회»·«매일(주5회)». 횟수를 못 읽으면 반 이름 그대로 */
  label: string;
  offering: T;
};

/** 같은 운영 반(교시)의 반 묶음 */
export type OfferingFrequencyGroup<T> = {
  /** 묶음 열쇠 = 연결 반 id(없으면 그 반 자신의 id) — 서버가 «같은 운영 반»으로 보는 범위와 같다 */
  key: string;
  /** 카드 제목 «초등 고학년» */
  title: string;
  /** 횟수 오름차순(횟수 미설정은 맨 뒤) */
  options: Array<FrequencyOption<T>>;
  /** 반이 둘 이상인데 횟수를 못 읽은 반이 있다 → 관리자에게 «횟수 미설정» 경고 */
  missingFrequency: boolean;
  /** 같은 횟수 반이 둘 이상 — 서버는 앞의 것만 고르므로 관리자에게 알린다 */
  duplicateFrequency: boolean;
};

/** 묶음 열쇠 — 서버(openScopeOfferingWhere)와 같은 범위: 연결 반이 있으면 그 반, 없으면 자기 자신 */
export function offeringGroupKey(offering: GroupableOffering): string {
  return offering.linkedClassId || offering.id;
}

/**
 * 반 목록을 운영 반(교시) 묶음으로 모은다. 묶음 순서 = 처음 나온 순서(관리자 표시 순서를 지킨다).
 * titleOf: 반 이름을 꺼내는 함수(공개 화면은 name, 서버·관리자는 title/name).
 */
export function groupOfferingsByClass<T extends GroupableOffering>(
  offerings: readonly T[],
  titleOf: (offering: T) => string,
): Array<OfferingFrequencyGroup<T>> {
  const byKey = new Map<string, T[]>();
  for (const offering of offerings) {
    const key = offeringGroupKey(offering);
    byKey.set(key, [...(byKey.get(key) ?? []), offering]);
  }
  return [...byKey.entries()].map(([key, members]) => {
    const options = members
      .map((offering, index) => {
        const title = titleOf(offering);
        const frequency = offeringWeeklyFrequency({ title, code: offering.code });
        return { frequency, label: frequency ? weeklyFrequencyLabel(frequency) : title, offering, index };
      })
      // 횟수 오름차순, 횟수 미설정은 맨 뒤, 같으면 원래 순서
      .sort((a, b) => (a.frequency ?? 99) - (b.frequency ?? 99) || a.index - b.index)
      .map(({ frequency, label, offering }) => ({ frequency, label, offering }));
    const counts = new Map<number, number>();
    for (const option of options) if (option.frequency !== null) counts.set(option.frequency, (counts.get(option.frequency) ?? 0) + 1);
    return {
      key,
      // 제목은 첫 반(횟수가 가장 작은 반) 이름에서 횟수를 뺀 것
      title: offeringBaseTitle(titleOf(options[0].offering)),
      options,
      missingFrequency: options.length > 1 && options.some((option) => option.frequency === null),
      duplicateFrequency: [...counts.values()].some((count) => count > 1),
    };
  });
}

/** 가격표 한 줄에 필요한 반 정보(공개 응답·관리자 응답 모두 같은 이름) */
export type PricedOffering = {
  price: number;
  newApplicantPrice?: number | null;
  existingApplicantPrice?: number | null;
  periods?: readonly OfferingPeriodLike[] | null;
};

/** 가격표 한 줄 «주2회 · 4주 · 신입생 240,000원 · 재원생 200,000원» */
export type GroupPriceRow = {
  frequencyLabel: string;
  /** 기간 이름(«4주»). 기간 상품이 없는 반이면 null */
  periodLabel: string | null;
  newPrice: number;
  existingPrice: number;
};

/**
 * 묶음 가격표 — 횟수마다(기간이 있으면 기간마다) 신입생·재원생 수강료.
 * 금액은 신청 화면·서버와 같은 함수(resolvePeriodPrice)로 정한다 → 표의 금액 = 실제 청구 금액.
 * 꺼진 기간(isActive=false)은 뺀다.
 */
export function groupPriceRows<T extends GroupableOffering & PricedOffering>(group: OfferingFrequencyGroup<T>): GroupPriceRow[] {
  return group.options.flatMap(({ label, offering }): GroupPriceRow[] => {
    const periods = [...(offering.periods ?? [])]
      .filter((period) => period.isActive !== false)
      .sort((a, b) => (a.displayOrder ?? 0) - (b.displayOrder ?? 0) || a.startDate.localeCompare(b.startDate));
    if (periods.length === 0) {
      return [{
        frequencyLabel: label,
        periodLabel: null,
        newPrice: offering.newApplicantPrice ?? offering.price,
        existingPrice: offering.existingApplicantPrice ?? offering.price,
      }];
    }
    return periods.map((period) => ({
      frequencyLabel: label,
      periodLabel: period.label?.trim() || `${period.startDate}~${period.endDate}`,
      newPrice: resolvePeriodPrice(period, "NEW"),
      existingPrice: resolvePeriodPrice(period, "EXISTING"),
    }));
  });
}
