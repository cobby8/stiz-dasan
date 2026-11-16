// 선생님 화면의 «마이크 허용 문서» 규칙(순수 함수 — React·next·window 를 불러오지 않는다. 테스트가 그대로 실행한다).
//
// 왜 필요한가: 보안 머리글 Permissions-Policy 는 «처음 불러온 문서»에 붙는다.
// 로그인 화면(/login, microphone=())에서 새로 불러오지 않고 화면만 바뀌어 /staff 로 넘어오면
// «마이크 금지»가 그대로 남아, 휴대폰 권한이 켜져 있어도 음성 녹음이 바로 거부된다.
// 선생님 화면을 한 번 새로 불러오면 /staff 의 머리글(microphone=(self))이 붙어 풀린다.
//
// ⚠️ 아래 경로 규칙은 next.config.ts 의 머리글 규칙과 같아야 한다
//    («/staff/:path*» = microphone=(self), «/staff/install» = microphone=()).
//    한쪽만 바꾸면 tests/staff-voice-input.test.mjs 가 깨진다.

const STAFF_ROOT = "/staff";
const STAFF_INSTALL = "/staff/install";
const STAFF_RUN = "/staff/run";

/** 끝의 «/» 를 떼어 비교하기 쉽게 한다("/staff/" → "/staff"). */
function trimTrailingSlash(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

/** 처음 불러온 문서의 경로가 «마이크 허용» 머리글을 받는 선생님 화면인지. */
export function staffDocumentAllowsMic(initialDocumentPath: string | null | undefined): boolean {
  if (typeof initialDocumentPath !== "string" || !initialDocumentPath) return false;
  const path = trimTrailingSlash(initialDocumentPath);
  // 설치 안내 화면은 머리글에서 마이크를 다시 막아 둔 곳이다
  if (path === STAFF_INSTALL) return false;
  // "/staffx" 같은 비슷한 이름은 선생님 화면이 아니다
  return path === STAFF_ROOT || path.startsWith(`${STAFF_ROOT}/`);
}

/** 기사님 운행 화면(/staff/run, /staff/run/…) — 운행 중에는 화면을 끊지 않는다. */
function isStaffRunPath(path: string): boolean {
  const trimmed = trimTrailingSlash(path);
  return trimmed === STAFF_RUN || trimmed.startsWith(`${STAFF_RUN}/`);
}

/**
 * 브라우저가 «이 문서에서 마이크를 쓸 수 있는지» 직접 알려 주는 값을 읽는다.
 * document.featurePolicy 는 크롬 계열·안드로이드 웹뷰에만 있는 비표준 기능이라 타입이 없다 →
 * 모양을 확인하며 읽고, 없거나 예외가 나면 null(모름).
 */
export function readMicFeatureAllowed(doc: unknown): boolean | null {
  try {
    if (!doc || typeof doc !== "object") return null;
    const policy = (doc as { featurePolicy?: unknown }).featurePolicy;
    if (!policy || typeof policy !== "object") return null;
    const allowsFeature = (policy as { allowsFeature?: unknown }).allowsFeature;
    if (typeof allowsFeature !== "function") return null;
    const answer: unknown = allowsFeature.call(policy, "microphone");
    return typeof answer === "boolean" ? answer : null;
  } catch {
    return null;
  }
}

/** 문서 주소(전체 URL)에서 경로만 꺼낸다. 풀지 못하면 null. */
export function pathFromDocumentUrl(url: unknown): string | null {
  if (typeof url !== "string" || !url) return null;
  try {
    return new URL(url).pathname;
  } catch {
    return null;
  }
}

/**
 * 선생님 화면을 한 번 새로 불러와야 하는지.
 * 판정 순서: 운행 화면·새로 불러와도 소용없는 화면은 건너뜀 → 되풀이 방지 → 브라우저가 알려 준 값 → 처음 문서 경로.
 * 모르면 새로 불러오지 않는다(쓸데없이 화면을 끊는 것보다 낫다).
 */
export function shouldReloadStaffDocument(input: {
  /** 브라우저가 알려 준 «마이크 가능» 여부. 모르면 null */
  featureAllowed: boolean | null;
  /** 처음 불러온 문서의 경로. 모르면 null */
  initialDocumentPath: string | null;
  /** 이미 새로 불러오기를 시도한 경로(되풀이 방지 표식). 없으면 null */
  alreadyTriedFor: string | null;
  /** 지금 보고 있는 경로 */
  currentPath: string;
}): boolean {
  // 기사님 운행 중에는 끊지 않는다
  if (isStaffRunPath(input.currentPath)) return false;
  // 지금 화면 자체가 마이크 금지 머리글을 받는 곳(/staff/install 등)이면 새로 불러와도 그대로다
  if (!staffDocumentAllowsMic(input.currentPath)) return false;
  // ① 같은 화면에서 이미 한 번 해 봤으면 그만둔다(무한 반복 방지)
  if (input.alreadyTriedFor !== null && input.alreadyTriedFor === input.currentPath) return false;
  // ② 브라우저가 직접 알려 주면 그 답을 따른다
  if (typeof input.featureAllowed === "boolean") return !input.featureAllowed;
  // ③ 모르면 처음 문서의 경로로 미루어 본다. 그것도 모르면 새로 불러오지 않는다
  if (!input.initialDocumentPath) return false;
  return !staffDocumentAllowsMic(input.initialDocumentPath);
}
