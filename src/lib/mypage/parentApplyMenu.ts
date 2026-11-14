/**
 * 학부모 앱 «신청» 메뉴 (2026-11-14 원장 결정표 c9) — 유니폼 신청·체육관 대관·방학특강 신청으로 가는 길 한 곳.
 *
 * ★ 설치된 학부모 앱은 /mypage 밖으로 나가면 돌아올 길이 없다(주소창이 뜬다). 그래서 이 메뉴의 «앱 안 주소»는
 *   전부 /mypage 로 시작해야 한다 — tests/parent-apply-menu.test.mjs 가 이 목록을 그대로 검사한다.
 *   우리 사이트 밖 주소(본사 쇼핑몰)는 outside=true 로 표시하고, 화면은 «바깥 링크» 규칙(data-outside-link — 새 창·
 *   스토어 앱에서 못 열면 주소 복사 안내)으로 연다.
 */
import { ACADEMY_GUIDE_FACTS } from "@/lib/trial-fee/guideMessages";

export type ParentApplyItem = {
  key: "uniform" | "rental" | "seasonal";
  label: string;
  /** 줄 오른쪽 한마디(없으면 비움) */
  hint: string;
  href: string;
  /** 우리 사이트 밖 주소인가(새 창으로 연다) */
  outside: boolean;
};

export const PARENT_APPLY_ITEMS: readonly ParentApplyItem[] = [
  // 유니폼은 본사 쇼핑몰에서 직접 산다(2026-11 «유니폼 신청을 본사 직접 구매로 전환») — 주소는 안내 문자와 같은 값 한 곳
  { key: "uniform", label: "유니폼 신청", hint: "본사 쇼핑몰", href: ACADEMY_GUIDE_FACTS.uniformOrderUrl, outside: true },
  { key: "rental", label: "체육관 대관", hint: "재원생 2시간 무료", href: "/mypage/rental", outside: false },
  { key: "seasonal", label: "방학특강 신청", hint: "", href: "/mypage/seasonal/apply", outside: false },
];

/** 방학특강 신청 화면들의 주소 머리(목록 → 상세 → 신청서) */
export const PARENT_SEASONAL_APPLY_BASE = "/mypage/seasonal/apply";
/** 신청 메뉴 화면 */
export const PARENT_APPLY_HOME = "/mypage/apply";
