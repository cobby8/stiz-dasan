/**
 * 관리자 «탭 줄» 묶음 정의 — 2026-11-13 관리자 메뉴 정리(원장 점검표 승인).
 *
 * 왜 한 곳에 두나:
 *   비슷한 화면 여러 개를 사이드바 메뉴 하나 + 화면 위 탭 줄로 묶었다.
 *   «어느 메뉴를 켤지»(사이드바)와 «어느 탭을 켤지»(탭 줄)가 같은 목록을 봐야
 *   한쪽만 고쳐져 메뉴가 꺼지는 사고가 나지 않는다. 그래서 목록은 이 파일 하나뿐이다.
 *
 * 화면 주소는 하나도 바꾸지 않았다 — 옛 주소·북마크는 그대로 열리고, 그 화면 위에 탭 줄만 생긴다.
 *
 * ⚠️ 이 파일은 다른 모듈을 import 하지 않는다(테스트가 그대로 불러 실행한다).
 */

export type AdminSectionTab = {
  /** 탭을 누르면 가는 주소(기존 화면 주소 그대로) */
  href: string;
  /** 탭 이름 */
  label: string;
  /** Material Symbols 아이콘 이름 */
  icon: string;
  /** 원장(ADMIN) 전용 탭 — 부원장에게는 탭 줄에서 뺀다(2026-11-14 부원장 금액 가림). 화면 자체는 서버에서 막는다 */
  ownerOnly?: boolean;
};

export type AdminSection = {
  /** 사이드바 메뉴 이름(탭 줄의 화면 낭독용 이름에도 쓴다) */
  label: string;
  tabs: readonly AdminSectionTab[];
};

export const ADMIN_SECTIONS = {
  // 사이드바 «수업·출결» — 출결 화면에 결석 신고·보강·수업 리포트를 탭으로 붙였다
  attendance: {
    label: "수업·출결",
    tabs: [
      { href: "/admin/attendance", label: "출결", icon: "fact_check" },
      { href: "/admin/absence", label: "정규 결석 신고", icon: "event_busy" },
      { href: "/admin/makeup", label: "보강", icon: "event_repeat" },
      { href: "/admin/attendance/report", label: "수업 리포트", icon: "edit_document" },
      { href: "/admin/attendance/feed", label: "수업 피드", icon: "photo_library" },
    ],
  },
  // 사이드바 «청구·수납» — 옛 «돈·수납» 묶음을 없애고 이 탭 줄로 모았다
  finance: {
    label: "청구·수납",
    tabs: [
      { href: "/admin/finance", label: "청구·수납", icon: "payments" },
      { href: "/admin/payment-requests", label: "입금 확인·영수증", icon: "receipt_long" },
      { href: "/admin/payment-confirmations", label: "현장 수납 승인", icon: "account_balance_wallet" },
      // POS 대사 = 하루 결제 합계를 맞추는 화면이라 원장 전용(부원장 탭 줄에서 숨김)
      { href: "/admin/pos-reconcile", label: "POS 결제 대사", icon: "calculate", ownerOnly: true },
    ],
  },
  // 사이드바 «홈페이지 관리» — 학원 소개(/admin/settings)가 첫 탭. 사진 공개 회수는 갤러리 바로 뒤에 둔다
  homepage: {
    label: "홈페이지 관리",
    tabs: [
      { href: "/admin/settings", label: "학원 소개", icon: "school" },
      { href: "/admin/coaches", label: "코치/강사진", icon: "person" },
      { href: "/admin/programs", label: "프로그램", icon: "assignment" },
      { href: "/admin/gallery", label: "갤러리", icon: "photo_library" },
      { href: "/admin/media-revocations", label: "사진 공개 회수", icon: "hide_image" },
      { href: "/admin/faq", label: "FAQ", icon: "help" },
      { href: "/admin/testimonials", label: "학부모 후기", icon: "star" },
    ],
  },
  // 사이드바 «문자·알림»
  messaging: {
    label: "문자·알림",
    tabs: [
      { href: "/admin/sms", label: "문자/템플릿", icon: "chat" },
      { href: "/admin/notification-deliveries", label: "담당자 전달 장부", icon: "notifications" },
      { href: "/admin/kakao-policy", label: "카카오 정책 답변", icon: "menu_book" },
    ],
  },
  // 사이드바 «약관·방침»
  policy: {
    label: "약관·방침",
    tabs: [
      { href: "/admin/terms", label: "이용약관", icon: "description" },
      { href: "/admin/privacy", label: "개인정보처리방침", icon: "lock" },
    ],
  },
} as const satisfies Record<string, AdminSection>;

export type AdminSectionKey = keyof typeof ADMIN_SECTIONS;

// 접두사가 같은 다른 주소까지 켜지 않도록 경로 경계(/)를 확인한다.
// 예: "/admin/students-extra" 는 "/admin/students" 가 아니다.
export function matchesAdminPath(pathname: string, path: string): boolean {
  return pathname === path || pathname.startsWith(`${path}/`);
}

/**
 * 지금 주소가 속한 탭 묶음과 켜질 탭을 찾는다. 없으면 null(탭 줄을 그리지 않는다).
 * 가장 «긴» 주소를 고른다 — /admin/attendance/report 는 «출결»이 아니라 «수업 리포트» 탭이다.
 */
export function findAdminSection(pathname: string): { key: AdminSectionKey; section: AdminSection; activeHref: string } | null {
  let best: { key: AdminSectionKey; section: AdminSection; activeHref: string } | null = null;
  for (const key of Object.keys(ADMIN_SECTIONS) as AdminSectionKey[]) {
    const section: AdminSection = ADMIN_SECTIONS[key];
    for (const tab of section.tabs) {
      if (!matchesAdminPath(pathname, tab.href)) continue;
      if (!best || tab.href.length > best.activeHref.length) best = { key, section, activeHref: tab.href };
    }
  }
  return best;
}

/** 지금 주소가 이 묶음 안인가 — 사이드바 부모 메뉴를 켤 때 쓴다 */
export function isInAdminSection(pathname: string, key: AdminSectionKey): boolean {
  return findAdminSection(pathname)?.key === key;
}

/**
 * 이 사람에게 보일 탭만 남긴다 — 원장이 아니면 ownerOnly 탭을 뺀다(2026-11-14 부원장 금액 가림).
 * ⚠️ 이 파일은 import 를 하지 않으므로 역할 문자열 대신 «원장인가» 불리언을 받는다(판정은 moneyAccess 쪽).
 */
export function visibleSectionTabs(tabs: readonly AdminSectionTab[], isOwner: boolean): AdminSectionTab[] {
  return tabs.filter((tab) => isOwner || !tab.ownerOnly);
}
