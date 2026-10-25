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
import { parseParentOAuthProvider } from "@/lib/parent-oauth";
import { prisma } from "@/lib/prisma";
import { createAdminClient } from "@/lib/supabase/admin";
import { currentSocialOnlyUser } from "../shared";

/**
 * 본인인증 결과로 기존 학부모 계정에 간편로그인을 붙인다(원장 결정 2026-10-26).
 *
 * 순서가 중요하다:
 *  1. 건 번호가 이 간편로그인 사용자 것인지 → 포트원 재조회(VERIFIED, 10분 안)
 *  2. 명의 번호로 계정을 찾고, 학부모 하나 + 이름 일치일 때만 진행(직원 계정은 열지 않는다)
 *  3. 방금 간편로그인으로 생긴 빈 Supabase 사용자를 지운다 — 그 Apple/Google 계정이 기존 계정에 붙을 수 있게
 *  4. 기존 계정으로 로그인시킨다(로그인 토큰은 3보다 먼저 만든다)(서버가 1회용 로그인 토큰을 만들어 바로 쓴다 — 메일은 보내지 않는다)
 *  5. 화면은 /auth/oauth/{제공자}?intent=link 로 넘어가 같은 제공자를 기존 계정에 붙인다(완료 시 알림 문자)
 */
export async function POST(request: Request) {
  const config = getPortoneConfig();
  if (!config) return NextResponse.json({ error: "본인인증 설정이 아직 끝나지 않았습니다. 학원에 문의해 주세요." }, { status: 503 });

  const body = (await request.json().catch(() => null)) as { identityVerificationId?: unknown } | null;
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
  const target = selectLinkTarget(rows, verification.verifiedCustomer?.name ?? "");
  if (target.kind !== "OK") return NextResponse.json({ error: LINK_RESULT_MESSAGES[target.kind] }, { status: 409 });

  const admin = createAdminClient();
  const owner = await admin.auth.admin.getUserById(target.authUserId);
  const ownerEmail = owner.data.user?.email;
  if (owner.error || !ownerEmail) {
    return NextResponse.json({ error: "기존 계정 정보를 확인하지 못했어요. 학원에 문의해 주세요." }, { status: 500 });
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

  const provider = parseParentOAuthProvider(current.provider);
  return NextResponse.json({ next: provider ? `/auth/oauth/${provider}?intent=link` : "/mypage/login-methods" });
}
