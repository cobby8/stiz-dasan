import { NextResponse } from "next/server";
import { notifyAccountSecurityEvent } from "@/lib/account/social-link-notify";
import {
  LINK_RESULT_MESSAGES,
  identityLoginNoticeBody,
  isFreshVerification,
  isLinkVerificationIdFor,
  selectLinkTarget,
  type LinkCandidate,
} from "@/lib/account/social-link";
import { isUsablePhoneKey, parentPhoneDigits } from "@/lib/enrollment/parentIdentity";
import { fetchPortoneIdentityVerification, getPortoneConfig } from "@/lib/identity/portone";
import { PARENT_OAUTH_LABELS, parseParentOAuthProvider } from "@/lib/parent-oauth";
import { parentClaimProofCookieName } from "@/lib/parent-account-claim";
import { issueIdentityVerifiedSignup, oauthProviderMethod, resolveVerifiedSignupPhone } from "@/lib/parent-signup-verification";
import { LINK_START_COOKIE, LINK_START_COOKIE_MAX_AGE, LINK_HINT_COOKIE, linkStartToken } from "@/lib/account/link-start";
import { prisma } from "@/lib/prisma";
import { createAdminClient } from "@/lib/supabase/admin";
import { currentSocialOnlyUser } from "../shared";

/**
 * 본인인증 결과로 기존 학부모 계정에 간편로그인을 붙인다(원장 결정 2026-10-26).
 *
 * 순서가 중요하다:
 *  1. 건 번호가 이 간편로그인 사용자 것인지 → 포트원 재조회(VERIFIED, 10분 안)
 *  2. 명의 번호로 계정을 찾고, 학부모 하나 + 이름 일치일 때만 진행(직원이 쓰는 번호는 조건을 갖춘 계정이 정확히 하나일 때만 — selectLinkTarget)
 *  3. 방금 간편로그인으로 생긴 빈 Supabase 사용자를 지운다 — 그 Apple/Google 계정이 기존 계정에 붙을 수 있게
 *  4. 기존 계정으로 로그인시킨다(로그인 토큰은 3보다 먼저 만든다)(서버가 1회용 로그인 토큰을 만들어 바로 쓴다 — 메일은 보내지 않는다)
 *  5. 화면은 /auth/oauth/{제공자}?intent=link 로 넘어가 같은 제공자를 기존 계정에 붙인다(완료 시 알림 문자)
 */
export async function POST(request: Request) {
  const config = getPortoneConfig();
  if (!config) return NextResponse.json({ error: "본인인증 설정이 아직 끝나지 않았습니다. 학원에 문의해 주세요." }, { status: 503 });

  const body = (await request.json().catch(() => null)) as { identityVerificationId?: unknown; next?: unknown } | null;
  const identityVerificationId = typeof body?.identityVerificationId === "string" ? body.identityVerificationId : "";

  const current = await currentSocialOnlyUser();
  if ("error" in current) return NextResponse.json({ error: current.error }, { status: 401 });
  if (!isLinkVerificationIdFor(identityVerificationId, current.user.id)) {
    return NextResponse.json({ error: "본인인증 정보를 확인하지 못했어요. 다시 시도해 주세요." }, { status: 400 });
  }

  const lookup = await fetchPortoneIdentityVerification(identityVerificationId, config).catch(() => null);
  if (!lookup || !lookup.ok) {
    return NextResponse.json({ error: "본인인증 결과를 확인하지 못했어요. 잠시 후 다시 시도해 주세요." }, { status: 502 });
  }
  const verification = lookup.data;
  const verifiedAt = verification.verifiedAt ?? verification.statusChangedAt;
  if (verification.status !== "VERIFIED" || !isFreshVerification(verifiedAt)) {
    // 응답 모양이 바뀌면 기능 전체가 조용히 막히므로 원인을 남긴다(개인정보는 남기지 않는다).
    console.error("[parent-link verify] rejected:", verification.status, verifiedAt ? "stale" : "no-verifiedAt");
    return NextResponse.json({ error: "본인인증이 완료되지 않았거나 시간이 지났어요. 다시 인증해 주세요." }, { status: 400 });
  }
  const phone = parentPhoneDigits(verification.verifiedCustomer?.phoneNumber);
  if (!isUsablePhoneKey(phone)) {
    return NextResponse.json({ error: "본인인증 휴대폰 번호를 확인하지 못했어요. 학원에 문의해 주세요." }, { status: 400 });
  }

  // 숫자만 비교한다 — 하이픈 유무로 다른 가족 계정을 놓치거나 잘못 잡는 사고가 있었다(4가족 사고).
  const rows = await prisma.$queryRawUnsafe<LinkCandidate[]>(
    `SELECT u.id, u.role::text AS role, u.name, u."authUserId", u."phoneVerifiedAt",
            EXISTS(SELECT 1 FROM "UserRoleGrant" g WHERE g."userId" = u.id AND g.status = 'ACTIVE') AS "hasActiveStaffGrant"
       FROM "User" u
      WHERE regexp_replace(COALESCE(u.phone, ''), '[^0-9]', '', 'g') = $1
      LIMIT 20`,
    phone,
  );
  const verifiedName = (verification.verifiedCustomer?.name ?? "").trim();
  const target = selectLinkTarget(rows, verifiedName);

  // 2026-11-17 원장 지시 «본인인증 하나로 통일»: 로그인 수단이 있는 계정이 없는 번호(처음 오신 분·학원이 등록해 둔
  // 빈 보호자 계정)는 문자 인증을 다시 시키지 않고, 본인인증 결과로 «문자 인증을 마친» 가입 요청을 만들어 이어 간다.
  // 응답 모양은 문자 인증 확인(/api/auth/parent-signup/verify-otp)과 같다 — 화면이 같은 다음 단계를 쓴다.
  // 이 번호의 계정이 «로그인 수단이 없는 학부모 계정»뿐이면(학원이 등록해 둔 빈 보호자 계정) 이름이 달라도 가입 이어가기로 보낸다
  // — 학원 기록의 보호자 이름이 통신사 명의와 다른 집이 많고(예: 어머니 이름으로 등록·아버지 명의 휴대폰), 예전 문자 인증도
  // 이름을 보지 않았다(검수 반영). 넘겨받는 쪽(resolveVerifiedSignupPhone)이 하나·여럿·로그인 수단 유무를 다시 가른다.
  const emptyParentsOnly = rows.length > 0 && rows.every((row) => row.role === "PARENT" && !row.authUserId && !row.hasActiveStaffGrant);
  if (target.kind === "NONE" || target.kind === "NOT_READY" || emptyParentsOnly) {
    const method = oauthProviderMethod(current.provider);
    if (!method) return NextResponse.json({ error: "간편로그인으로 들어온 경우에만 쓸 수 있습니다." }, { status: 400 });
    const issued = await issueIdentityVerifiedSignup({ phone, signupMethod: method, email: current.user.email, pendingAuthUserId: current.user.id });
    if ("error" in issued) return NextResponse.json({ error: issued.error }, { status: 400 });
    const handoff = await resolveVerifiedSignupPhone({
      token: issued.token,
      proof: issued.proof,
      redirectPath: typeof body?.next === "string" ? body.next : null,
      authenticatedOAuthUser: { id: current.user.id, email: current.user.email, provider: current.provider },
    });
    if ("error" in handoff && !("kind" in handoff)) return NextResponse.json({ error: handoff.error }, { status: 400 });
    if (!("kind" in handoff) || handoff.kind === "NEW_SIGNUP") {
      return NextResponse.json({ ok: true, signup: true, challengeToken: issued.token, proof: issued.proof, verifiedName });
    }
    if (handoff.kind === "REGISTERED" || handoff.kind === "CONTACT_ACADEMY") {
      return NextResponse.json({ error: handoff.error, existingParent: handoff.kind }, { status: 409 });
    }
    if (handoff.kind === "LINKED_EXISTING") {
      return NextResponse.json({ ok: true, signup: true, existingParent: "LINKED", redirectPath: handoff.redirectPath });
    }
    const activation = NextResponse.json({ ok: true, signup: true, existingParent: "ACTIVATE", activationUrl: handoff.activationUrl });
    activation.cookies.set(parentClaimProofCookieName(handoff.claimToken), handoff.claimProof, { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 10 * 60 });
    return activation;
  }
  if (target.kind !== "OK") return NextResponse.json({ error: LINK_RESULT_MESSAGES[target.kind] }, { status: 409 });

  const admin = createAdminClient();
  const owner = await admin.auth.admin.getUserById(target.authUserId);
  const ownerEmail = owner.data.user?.email;
  if (owner.error || !ownerEmail) {
    return NextResponse.json({ error: "기존 계정 정보를 확인하지 못했어요. 학원에 문의해 주세요." }, { status: 500 });
  }
  // 한 계정에는 같은 종류의 간편로그인을 하나만 붙일 수 있다(Supabase). 이미 «다른» 구글·카카오 계정이 붙어 있으면
  // 지금 쓰신 계정은 붙지 않는데, 예전에는 그대로 진행해 «연결됨»처럼 보였다(2026-11-17 원장 신고). 여기서 멈추고 알려 준다.
  const provider = parseParentOAuthProvider(current.provider);
  const sameKind = (identity: { provider?: string | null }) => parseParentOAuthProvider(identity.provider === "custom:naver" ? "naver" : String(identity.provider || "")) === provider;
  const mine = (current.user.identities ?? []).find(sameKind);
  const theirs = (owner.data.user?.identities ?? []).find(sameKind);
  if (provider && theirs && (!mine || theirs.id !== mine.id)) {
    const label = PARENT_OAUTH_LABELS[provider];
    const hint = maskEmail(typeof theirs.identity_data?.email === "string" ? theirs.identity_data.email : "");
    return NextResponse.json({
      error: `이 계정에는 이미 다른 ${label} 계정${hint ? `(${hint})` : ""}이 연결되어 있어요. 앱에서 그 ${label} 계정을 고르면 바로 로그인됩니다. 지금 쓰신 계정으로 바꾸려면 로그인 뒤 마이페이지 ‘간편로그인 연결’에서 기존 연결을 끊고 다시 연결해 주세요.`,
    }, { status: 409 });
  }

  // 3. 기존 계정 1회용 로그인 토큰 — 메일은 보내지 않는다. 빈 사용자를 지우기 전에 만들어, 실패해도 다시 시도할 수 있게.
  const link = await admin.auth.admin.generateLink({ type: "magiclink", email: ownerEmail });
  const tokenHash = link.data.properties?.hashed_token;
  if (!tokenHash) {
    return NextResponse.json({ error: "기존 계정으로 로그인하지 못했어요. 잠시 후 다시 시도해 주세요." }, { status: 500 });
  }
  // 4. 빈 간편로그인 사용자 정리 — 앱 계정이 없는 것을 currentSocialOnlyUser 가 이미 확인했다.
  const removed = await admin.auth.admin.deleteUser(current.user.id);
  if (removed.error) {
    return NextResponse.json({ error: "연결 준비에 실패했어요. 잠시 후 다시 시도해 주세요." }, { status: 500 });
  }

  // 5. 기존 계정으로 로그인
  const signedIn = await current.supabase.auth.verifyOtp({ type: "magiclink", token_hash: tokenHash });
  if (!signedIn || signedIn.error || signedIn.data.user?.id !== target.authUserId) {
    await current.supabase.auth.signOut().catch(() => undefined);
    return NextResponse.json({ error: "기존 계정으로 로그인하지 못했어요. 아이디로 로그인한 뒤 마이페이지에서 연결해 주세요." }, { status: 500 });
  }

  // 본인인증으로 기존 계정에 들어온 사실 자체를 알린다(다음 연결 단계에서 취소해도).
  await notifyAccountSecurityEvent({ authUserId: target.authUserId, eventType: "IDENTITY_LOGIN", body: identityLoginNoticeBody() });

  const response = NextResponse.json({ next: provider ? `/auth/oauth/${provider}?intent=link` : "/mypage/login-methods" });
  if (provider) {
    // 방금 본인인증으로 로그인된 «그 계정»이 바로 이어서 연결을 시작한다는 1회용 표식(2분) — 직원 계정은 주소(GET)만으로는
    // 연결을 시작하지 못하게 막아 두었는데(다른 사이트가 몰래 시작시키는 것 방지), 이 표식이 있을 때만 통과시킨다.
    response.cookies.set(LINK_START_COOKIE, linkStartToken(target.authUserId, provider), { httpOnly: true, secure: true, sameSite: "lax", path: "/auth/oauth", maxAge: LINK_START_COOKIE_MAX_AGE });
    // 구글은 «방금 쓴 계정»을 미리 알려 주면 계정 고르기 화면을 건너뛴다(두 번 고르지 않게). 주소가 아니라 쿠키로 넘긴다.
    if (provider === "google" && current.user.email) {
      response.cookies.set(LINK_HINT_COOKIE, current.user.email, { httpOnly: true, secure: true, sameSite: "lax", path: "/auth/oauth", maxAge: LINK_START_COOKIE_MAX_AGE });
    }
  }
  return response;
}

/** 이메일 앞 3글자만 남기고 가린다(cob***@stiz.kr) — 어느 계정인지 알아볼 만큼만. */
function maskEmail(value: string): string {
  const match = /^([^@]{1,3})[^@]*(@.+)$/.exec(value.trim());
  return match ? `${match[1]}***${match[2]}` : "";
}
