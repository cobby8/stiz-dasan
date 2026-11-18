/**
 * 방학특강 «홈 안내 띠»와 «검색용 제목·설명»을 정하는 순수 규칙(2026-11-18 원장 승인).
 *
 * 왜 따로 두나:
 *   홈(app/page.tsx)·시즌 상세 메타(app/seasonal/[slug]/page.tsx)가 같은 공개 시즌 자료(listPublishedSeasons)를 쓰는데,
 *   «어느 시즌을 띠로 보일지»·«제목에 무엇을 넣을지»를 화면마다 따로 만들면 한쪽만 고쳐진다.
 *   DB 를 읽지 않는 순수 함수라 테스트가 그대로 돌려 본다.
 *
 * ⚠️ 공개 화면 규칙: 신청 인원·남은 자리 숫자는 넣지 않는다(재원생 수 비공개, 원장 11-06).
 * 날짜 표시는 공용 KST 모듈(kstLabel·toKstYmd·todayKst)만 쓴다.
 */
import { kstLabel, todayKst, toKstYmd } from "@/lib/datetime/kst";

/** 홈 띠·메타가 읽는 공개 시즌 칸(listPublishedSeasons 결과의 일부) */
export type PublicSeasonSummary = {
  slug: string;
  title: string;
  /** OPEN(모집 중) · CLOSED(마감) · UPCOMING(모집 전) · ENDED(끝남) */
  status: string;
  /** 모집은 마감됐지만 남은 수업 날에 중간 합류 신청을 받는 중 */
  lateJoinOpen?: boolean;
  /** 수업 시작·종료(ISO 시각) */
  operationStart: string;
  operationEnd: string;
  classes?: Array<{ targetGrade?: string | null }>;
};

export type HomeSeasonBanner = {
  href: string;
  /** 띠 본문 — 예: «2027 겨울방학특강 모집 중 · 1/4(월) 개강» */
  text: string;
};

/**
 * 홈 첫 화면에 보일 방학특강 띠 하나(없으면 null = 띠를 그리지 않는다).
 * - 모집 중(OPEN)을 먼저, 없으면 중간 합류 가능(lateJoinOpen) 시즌.
 * - 같은 무리 안에서는 수업 시작이 빠른 시즌.
 * - 모집 전·마감(중간 합류 없음)·끝난 시즌은 보이지 않는다.
 */
export function pickHomeSeasonBanner(seasons: readonly PublicSeasonSummary[], today: string = todayKst()): HomeSeasonBanner | null {
  const usable = seasons.filter((season) => season.slug && season.title);
  const byStart = (a: PublicSeasonSummary, b: PublicSeasonSummary) => a.operationStart.localeCompare(b.operationStart);
  const open = usable.filter((season) => season.status === "OPEN").sort(byStart)[0];
  const lateJoin = usable.filter((season) => season.status === "CLOSED" && season.lateJoinOpen).sort(byStart)[0];
  const season = open ?? lateJoin;
  if (!season) return null;
  const href = `/seasonal/${encodeURIComponent(season.slug)}`;
  if (season === lateJoin) return { href, text: `${season.title} 중간 합류 신청 가능` };
  // 아직 개강 전이면 개강일을 함께 적는다(이미 시작했으면 «모집 중»만)
  const startYmd = toKstYmd(season.operationStart);
  const startText = startYmd && startYmd > today ? ` · ${kstLabel(startYmd)} 개강` : "";
  return { href, text: `${season.title} 모집 중${startText}` };
}

/** 대상 학년 글자를 겹치지 않게 최대 3개까지 «·»로 잇는다(반마다 같은 글자가 반복되므로) */
function targetText(season: PublicSeasonSummary): string {
  const grades = [...new Set((season.classes ?? []).map((item) => item.targetGrade?.trim()).filter((value): value is string => Boolean(value)))];
  return grades.slice(0, 3).join("·");
}

/** 공개 시즌을 못 찾았을 때(주소 오타·비공개 전환) 쓰는 기본 제목·설명 */
export const SEASON_DETAIL_FALLBACK_SEO = {
  title: "남양주 다산 농구 방학특강 | STIZ 농구교실 다산2호점",
  description: "스티즈 농구교실 다산2호점 방학특강 일정과 모집 상태를 확인하고 모바일로 신청하세요.",
} as const;

/**
 * 시즌 상세(/seasonal/[slug]) 검색 제목·설명.
 * 제목 = «시즌명 | 남양주 다산 농구 방학특강 | STIZ 다산2호점»(지역어를 앞쪽에 둔다),
 * 설명 = 수업 기간 + 대상 + 신청 안내. 인원·자리 숫자는 넣지 않는다.
 */
export function seasonDetailSeo(season: PublicSeasonSummary | null | undefined): { title: string; description: string } {
  if (!season?.title) return { ...SEASON_DETAIL_FALLBACK_SEO };
  const start = kstLabel(season.operationStart);
  const end = kstLabel(season.operationEnd);
  const period = start && end ? `수업 기간 ${start}~${end}` : "";
  const target = targetText(season);
  const parts = [period, target ? `대상 ${target}` : ""].filter(Boolean).join(" · ");
  return {
    title: `${season.title} | 남양주 다산 농구 방학특강 | STIZ 다산2호점`,
    description: `${season.title}${parts ? ` — ${parts}` : ""}. 스티즈 농구교실 다산2호점 방학특강 안내를 확인하고 모바일로 신청하세요.`,
  };
}
