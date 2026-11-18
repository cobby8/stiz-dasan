/**
 * PortOne V2 본인인증(KG이니시스 통합인증) 결과 재조회 — mybdr `src/lib/identity/portone-lookup.ts` 와 같은 방식.
 * 업턴랩스 포트원 스토어·채널을 함께 쓴다(원장 결정 2026-10-26).
 *
 * 화면이 보내 온 이름·번호는 믿지 않는다. 건 번호만 받아 서버가 포트원에 다시 묻는다.
 * 시크릿(PORTONE_V2_API_SECRET)은 서버 환경변수에만 있다 — 클라이언트로 내보내지 않는다.
 */

export type PortOneIdentityVerification = {
  /** 건 번호 — 우리가 물은 번호와 같아야 한다 */
  id?: string;
  /** 인증에 쓰인 채널 — 포트원 스토어를 MyBDR 과 함께 쓰므로 «우리 채널» 결과만 받는다 */
  channel?: { key?: string };
  status: string; // "VERIFIED" | "FAILED" | "READY" ...
  verifiedAt?: string;
  /** verifiedAt 이 없을 때의 대체 시각(상태가 바뀐 시각 = 인증 완료 시각). */
  statusChangedAt?: string;
  verifiedCustomer?: {
    name?: string;
    phoneNumber?: string;
    birthDate?: string;
    ci?: string;
  };
};

export type PortoneConfig = { apiSecret: string; storeId: string };

/**
 * 재조회 결과가 «우리가 물은 그 건 + 우리 본인인증 채널»인가(2026-11-18 보안 검수 HIGH-1).
 * 포트원 스토어를 MyBDR 과 공유하므로, 다른 채널(다른 서비스)에서 끝난 인증 결과를 받아 주면 안 된다.
 * 자녀 연결(child-links)·연락처 바꾸기(phone-change)와 같은 확인이다. 채널 키가 비어 있으면 거절한다.
 */
export function isOwnIdentityVerification(
  verification: Pick<PortOneIdentityVerification, "id" | "channel">,
  identityVerificationId: string,
  channelKey: string | undefined = process.env.NEXT_PUBLIC_PORTONE_IDENTITY_CHANNEL_KEY,
): boolean {
  return Boolean(identityVerificationId) && verification.id === identityVerificationId
    && Boolean(channelKey) && Boolean(verification.channel?.key) && verification.channel?.key === channelKey;
}

export function getPortoneConfig(): PortoneConfig | null {
  const apiSecret = process.env.PORTONE_V2_API_SECRET;
  const storeId = process.env.NEXT_PUBLIC_PORTONE_STORE_ID;
  if (!apiSecret || !storeId) return null;
  return { apiSecret, storeId };
}

export type PortoneLookupResult =
  | { ok: true; data: PortOneIdentityVerification }
  | { ok: false; httpStatus: number };

export async function fetchPortoneIdentityVerification(
  identityVerificationId: string,
  config: PortoneConfig,
): Promise<PortoneLookupResult> {
  const url = `https://api.portone.io/identity-verifications/${encodeURIComponent(identityVerificationId)}?storeId=${encodeURIComponent(config.storeId)}`;
  const res = await fetch(url, {
    method: "GET",
    headers: { Authorization: `PortOne ${config.apiSecret}`, Accept: "application/json" },
    cache: "no-store",
  });
  if (!res.ok) return { ok: false, httpStatus: res.status };
  return { ok: true, data: (await res.json()) as PortOneIdentityVerification };
}
