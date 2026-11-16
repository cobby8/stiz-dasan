/**
 * «간편로그인 연결» — 누가 연결하는지와 돌아갈 화면을 정하는 순수 규칙(2026-11-17 원장 지시
 * 「선생님·원장 계정에도 간편로그인 연결 열어」).
 *
 * 왜 따로 두나: 연결을 시작하는 라우트·마무리하는 콜백·화면이 «같은 판정»을 써야 한다.
 * 돌아갈 화면은 주소 파라미터로 받지 않고, 서버가 지금 로그인한 계정으로 정한다
 * (주소로 받으면 남이 만든 링크로 엉뚱한 화면에 보내거나 역할을 헷갈리게 할 수 있다).
 * 이 파일은 DB·Next 없이 돌아가는 계산만 담는다 — 테스트가 직접 실행해서 못박는다.
 */

/** 학부모 연결 화면(기존) */
export const PARENT_LOGIN_METHODS_PATH = "/mypage/login-methods";
/** 직원(원장·부원장·선생님·기사님) 연결 화면 */
export const STAFF_LOGIN_METHODS_PATH = "/staff/mypage/login-methods";

/** 연결을 하는 사람 — 학부모 확인을 통과했으면 parent, 아니고 직원 확인을 통과했으면 staff */
export type LinkActor = "parent" | "staff";

/**
 * 학부모 확인이 먼저다(기존 동작 그대로). 둘 다 아니면 null = 연결을 시작할 수 없다.
 * 자녀가 등록된 직원은 학부모 확인을 통과하므로 parent 로 본다(학부모 연결 화면이 그 계정을 받는다).
 */
export function pickLinkActor(input: { parent: boolean; staff: boolean }): LinkActor | null {
  if (input.parent) return "parent";
  if (input.staff) return "staff";
  return null;
}

/**
 * 연결 결과(성공·실패)를 보여 줄 화면. 직원일 때만 직원 화면이고, 그 밖(학부모·로그인 없음)은
 * 기존처럼 학부모 화면이다 — 학부모 화면의 문지기가 로그인 없는 사람을 돌려보낸다.
 */
export function loginMethodsPath(actor: LinkActor | null): string {
  return actor === "staff" ? STAFF_LOGIN_METHODS_PATH : PARENT_LOGIN_METHODS_PATH;
}

/**
 * 직원 연결 화면의 «오류 코드» → 문구(2026-11-17 보안 검수 반영).
 * 주소에 문장을 그대로 싣지 않는다 — 문장을 실으면 누가 주소를 만들어 진짜 학원 화면의 빨간 안내 칸에
 * 가짜 안내문을 띄울 수 있다. 직원 화면은 주소의 e=<코드>만 읽고, 문구는 이 표에서만 나온다.
 * (학부모 화면은 기존 방식 그대로다 — 여기서 다루지 않는다.)
 */
export const STAFF_LINK_ERROR_MESSAGES = {
  // 시작 단계
  start: "간편로그인 연결을 시작하지 못했습니다. 아래 «연결하기»를 다시 눌러 주세요.",
  origin: "이 화면에서 바로 시작할 수 없습니다. 아래 «연결하기»를 다시 눌러 주세요.",
  closed: "지금은 이 간편로그인을 쓸 수 없습니다. 잠시 후 다시 시도해 주세요.",
  // 마무리(콜백) 단계
  already: "이 간편로그인 계정은 이미 다른 계정에 연결되어 있습니다.",
  cancelled: "연결이 취소되었거나 끝나지 않았습니다.",
  expired: "연결 시간이 지났습니다. «연결하기»를 다시 눌러 주세요.",
  failed: "간편로그인 연결을 마치지 못했습니다. 다시 시도해 주세요.",
} as const;

export type StaffLinkErrorCode = keyof typeof STAFF_LINK_ERROR_MESSAGES;

/**
 * 주소의 e 값 → 화면에 보일 문구. 표에 있는 코드일 때만 문구를 돌려주고,
 * 빈 값·모르는 코드·문장·문자열이 아닌 값은 null(= 아무것도 보이지 않는다).
 */
export function staffLinkErrorMessage(code: unknown): string | null {
  if (typeof code !== "string" || !code) return null;
  // hasOwnProperty — «constructor»·«toString» 같은 물려받은 이름이 표에 있는 것처럼 통과하지 않게
  return Object.prototype.hasOwnProperty.call(STAFF_LINK_ERROR_MESSAGES, code)
    ? STAFF_LINK_ERROR_MESSAGES[code as StaffLinkErrorCode]
    : null;
}

/** 직원이 스토어 앱 안에서 연결 화면을 열었을 때의 안내(앱에서는 «연결하기»를 보이지 않는다) */
export const STAFF_STORE_APP_LINK_NOTICE =
  "앱에서는 연결할 수 없어요. 휴대폰 브라우저(사파리·크롬)에서 www.stiz-dasan.kr 에 로그인한 뒤 연결해 주세요.";

/** 직원 연결 화면의 «연결하기»를 그릴지 — 서버(사용자 에이전트)나 화면(브라우저 저장소) 어느 쪽이든 앱이면 숨긴다. */
export function staffLinkButtonVisible(input: { serverStoreApp: boolean; clientStoreApp: boolean | null }): boolean {
  // clientStoreApp === null = 아직 모름 → 그리지 않는다(앱에서 버튼이 보였다 사라지는 일 방지)
  return !input.serverStoreApp && input.clientStoreApp === false;
}

/** 직원 연결 화면의 앱 안내 줄을 그릴지 — 어느 쪽이든 앱으로 확인됐을 때만 */
export function staffLinkNoticeVisible(input: { serverStoreApp: boolean; clientStoreApp: boolean | null }): boolean {
  return input.serverStoreApp || input.clientStoreApp === true;
}
