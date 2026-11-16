// «음성으로 기록» 버튼이 녹음을 시작하지 못했을 때, 원인별 안내 문구를 고른다(순수 함수 — 테스트가 그대로 실행한다).
// 왜: 예전에는 무엇이 잘못됐든 «마이크 권한을 허용해 주세요.» 한 문구라,
//     권한이 켜져 있는 선생님은 무엇을 해야 할지 알 수 없었다.

export const VOICE_START_MESSAGES = {
  /** 이 문서가 마이크 금지 상태(다른 화면에서 넘어옴) → 새로 불러오면 풀린다 */
  reload: "화면을 새로 불러온 뒤 다시 눌러 주세요.",
  /** 휴대폰·브라우저의 마이크 권한이 꺼져 있음 */
  permission: "마이크 권한이 꺼져 있어요. 휴대폰 설정 › 앱 › 권한에서 마이크를 허용해 주세요.",
  /** 마이크 장치가 없음 */
  notFound: "마이크를 찾지 못했어요.",
  /** 다른 앱이 마이크를 잡고 있음 */
  busy: "다른 앱이 마이크를 쓰고 있어요. 잠시 뒤 다시 눌러 주세요.",
  /** 이 기기·브라우저가 녹음 기능을 지원하지 않음 */
  unsupported: "이 기기에서는 음성 입력을 쓸 수 없어요. 글로 적어 주세요.",
} as const;

export type VoiceStartFailure = {
  message: string;
  /** «새로 불러오기» 버튼을 함께 보일지 */
  offerReload: boolean;
};

/** 잡은 오류에서 이름만 꺼낸다(오류 내용은 읽지 않는다). */
export function voiceErrorName(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const name = (error as { name?: unknown }).name;
  return typeof name === "string" && name ? name : null;
}

/**
 * @param errorName 브라우저가 던진 오류 이름(NotAllowedError 등). 모르면 null
 * @param featureAllowed 이 문서에서 마이크를 쓸 수 있는지(브라우저가 알려 준 값). 모르면 null
 */
export function voiceStartFailure(errorName: string | null, featureAllowed: boolean | null): VoiceStartFailure {
  const denied = errorName === "NotAllowedError" || errorName === "SecurityError";
  // 문서 자체가 마이크 금지라고 브라우저가 답했을 때만 «새로 불러오기»를 권한다
  if (denied && featureAllowed === false) return { message: VOICE_START_MESSAGES.reload, offerReload: true };
  if (errorName === "NotAllowedError") return { message: VOICE_START_MESSAGES.permission, offerReload: false };
  if (errorName === "NotFoundError" || errorName === "OverconstrainedError") return { message: VOICE_START_MESSAGES.notFound, offerReload: false };
  if (errorName === "NotReadableError" || errorName === "AbortError") return { message: VOICE_START_MESSAGES.busy, offerReload: false };
  // 그 밖: 녹음 기능 자체가 없는 기기·브라우저 등
  return { message: VOICE_START_MESSAGES.unsupported, offerReload: false };
}
