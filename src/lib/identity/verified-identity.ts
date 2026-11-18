/**
 * 본인인증 실명·시각 보관 (2026-11-18 원장 결정 «가입·본인인증 통일»).
 *
 * ■ 왜 따로 두는가
 *   User.name 은 이제 «닉네임»(본인이 고칠 수 있는 이름)이다. 결제창·법적 확인처럼 «실제 이름»이 필요한 곳은
 *   본인인증(포트원) 결과의 실명을 따로 적어 두고 그것을 먼저 쓴다. 실명을 적는 길이 여러 곳(가입·기존 계정 연결·
 *   활성화·직원 기록 연결·연락처 바꾸기)이라, 정리·저장 규칙을 이 파일 한 곳에 모은다 — 한쪽만 고쳐지는 사고 방지.
 *
 * ■ 지키는 것
 *   - 문자 인증(SMS)은 번호만 확인한다 → 실명을 적지 않는다. 본인인증(IDENTITY)일 때만 적는다.
 *   - CI·생년월일은 저장하지 않는다(실명과 시각만).
 *   - 실명은 로그·오류 문구에 남기지 않는다(이 파일은 아무것도 출력하지 않는다).
 *
 * ■ 이 파일은 prisma·next 를 import 하지 않는다 — db 를 인자로 받아 `node --test` 에서 가짜 db 로 실행 검증한다.
 */

/** 가입 요청(ParentSignupVerification)이 어떤 인증으로 통과했는가. DB CHECK 와 같은 목록 — 테스트가 마이그레이션과 대조한다. */
export const PARENT_SIGNUP_VERIFICATION_METHODS = ["SMS", "IDENTITY"] as const;
export type ParentSignupVerificationMethod = (typeof PARENT_SIGNUP_VERIFICATION_METHODS)[number];

/** 실명 칸 최대 길이 — 통신사 명의 이름은 이보다 훨씬 짧다. 이상한 값이 와도 칸이 넘치지 않게 자른다. */
export const VERIFIED_NAME_MAX = 100;

/** 포트원이 준 실명을 저장용으로 다듬는다. 비었으면 null(= 적지 않는다). */
export function cleanVerifiedName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  // 한글 자모가 풀려 오는 경우(NFD)를 합치고, 앞뒤·연속 공백을 정리한다
  const text = value.normalize("NFC").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, VERIFIED_NAME_MAX) : null;
}

/** 포트원 결과의 인증 시각. 없거나 읽을 수 없으면 지금 시각(서버 재조회 직후라 몇 분 안쪽 차이다). */
export function identityVerifiedAtOf(
  verification: { verifiedAt?: string | null; statusChangedAt?: string | null },
  now: Date = new Date(),
): Date {
  const at = Date.parse(verification.verifiedAt ?? verification.statusChangedAt ?? "");
  return Number.isFinite(at) ? new Date(at) : now;
}

/**
 * 가입 요청 한 줄 → User 에 옮길 실명·시각. 본인인증으로 통과한 줄만 값을 준다.
 * 문자 인증(SMS)·예전 줄(방식 없음)은 이름이 적혀 있어도 null — 문자 인증은 명의자 이름을 확인하지 않는다.
 */
export function signupRowIdentity(row: {
  verificationMethod?: string | null;
  verifiedName?: string | null;
  verifiedAt?: Date | string | null;
}): { verifiedName: string; verifiedAt: Date } | null {
  if (row.verificationMethod !== "IDENTITY") return null;
  const verifiedName = cleanVerifiedName(row.verifiedName);
  if (!verifiedName || !row.verifiedAt) return null;
  const verifiedAt = row.verifiedAt instanceof Date ? row.verifiedAt : new Date(row.verifiedAt);
  if (!Number.isFinite(verifiedAt.getTime())) return null;
  return { verifiedName, verifiedAt };
}

type Writer = { $executeRawUnsafe(sql: string, ...values: unknown[]): Promise<number> };

/** User 한 줄에 실명·시각을 적는 SQL — 탈퇴한 계정에는 적지 않는다. */
export const RECORD_IDENTITY_SQL =
  `UPDATE "User" SET "identityVerifiedName" = $2, "identityVerifiedAt" = $3, "updatedAt" = NOW()
    WHERE id = $1 AND "withdrawnAt" IS NULL`;

/**
 * 본인인증을 마친 계정에 실명·시각을 적는다(다시 인증하면 최신 값으로 덮는다).
 * 이름이 비었으면 아무것도 하지 않는다. 적었으면 true.
 * 부르는 쪽이 같은 거래(tx)를 넘기면 계정 연결·변경과 함께 남거나 함께 되돌아간다.
 */
export async function recordIdentityVerification(
  db: Writer,
  input: { userId: string; verifiedName: unknown; verifiedAt: Date },
): Promise<boolean> {
  const verifiedName = cleanVerifiedName(input.verifiedName);
  if (!input.userId || !verifiedName || !Number.isFinite(input.verifiedAt?.getTime?.())) return false;
  const changed = await db.$executeRawUnsafe(RECORD_IDENTITY_SQL, input.userId, verifiedName, input.verifiedAt);
  return Number(changed) === 1;
}

/**
 * 결제창에 넘길 이름 SQL 조각 — 본인인증 실명이 있으면 실명, 없으면 닉네임(User.name).
 * alias 는 코드에 적힌 테이블 별칭만 받는다(바깥 값이 SQL 에 섞이지 않게).
 */
export function payerDisplayNameSql(alias: string): string {
  if (!/^[a-z][a-z0-9_]*$/.test(alias)) throw new Error("payerDisplayNameSql: 별칭이 올바르지 않습니다.");
  return `COALESCE(NULLIF(btrim(${alias}."identityVerifiedName"), ''), ${alias}.name)`;
}

/**
 * 본인인증 이름과 «비교할» 계정 이름 — 실명이 있으면 실명, 없으면 닉네임(User.name). (검수 N-1)
 * 닉네임은 본인이 마음대로 바꿀 수 있으므로, 실명이 적힌 계정은 실명으로 비교해야 닉네임을 바꾼 사람이
 * 새 기기 연결·연락처 바꾸기에서 막히지 않는다. 이름이 달라 막는 장치(다른 사람 계정 연결 차단)는 그대로 — 기준 값만 바뀐다.
 * 정규화(공백·대소문자)는 부르는 쪽 비교 함수가 한다.
 */
export function identityComparableName(row: { identityVerifiedName?: string | null; name?: string | null }): string {
  return payerDisplayName(row) ?? "";
}

/** [순수] 위 SQL 과 같은 규칙 — 실명 → 닉네임 순서. 둘 다 없으면 null. */
export function payerDisplayName(row: { identityVerifiedName?: string | null; name?: string | null }): string | null {
  const verified = typeof row.identityVerifiedName === "string" ? row.identityVerifiedName.trim() : "";
  return verified || row.name || null;
}
