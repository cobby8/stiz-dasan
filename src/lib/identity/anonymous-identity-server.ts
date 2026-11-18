import "server-only";

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { fetchPortoneIdentityVerification, getPortoneConfig } from "./portone";
import {
  ANON_IDENTITY_COOKIE_PATH,
  ANON_IDENTITY_TTL_SECONDS,
  anonIdentityCookieName,
  anonIdentityRequestKey,
  confirmAnonIdentity,
  startAnonIdentity,
  type AnonIdentityConfirmed,
  type AnonIdentityFailure,
  type AnonIdentityPurpose,
} from "./anonymous-identity";

/**
 * 로그인 전 본인인증 시작·확인의 «연결부» — 가입(/api/auth/parent-signup/identity/*)과
 * 아이디·비밀번호 찾기(/api/auth/parent-password-reset/identity/*)가 같이 쓴다. 판정은 anonymous-identity.ts 한 곳.
 */

const NOT_READY = "본인인증 설정이 아직 끝나지 않았습니다. «문자 인증으로 하기»를 이용해 주세요.";

function cookieOptions(maxAge: number) {
  return { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax" as const, path: ANON_IDENTITY_COOKIE_PATH, maxAge };
}

/** 시작 API 본문 — 건 번호는 응답으로, nonce 는 httpOnly 쿠키로만 준다(화면 스크립트가 읽지 못하게) */
export async function anonIdentityStartResponse(request: Request, purpose: AnonIdentityPurpose): Promise<NextResponse> {
  if (!getPortoneConfig()) return NextResponse.json({ error: NOT_READY }, { status: 503 });
  try {
    const started = await prisma.$transaction((tx) => startAnonIdentity(tx, { purpose, requestKey: anonIdentityRequestKey(request.headers) }));
    if (!started.ok) return NextResponse.json({ error: started.error }, { status: started.status });
    const response = NextResponse.json({ identityVerificationId: started.identityVerificationId }, { headers: { "Cache-Control": "no-store" } });
    response.cookies.set(anonIdentityCookieName(purpose), started.nonce, cookieOptions(ANON_IDENTITY_TTL_SECONDS));
    return response;
  } catch (error) {
    // 장부 표가 아직 없을 때(마이그레이션 전) 등 — 원문은 화면에 내보내지 않는다
    console.error("[anon-identity start] failed:", error instanceof Error ? error.message.slice(0, 200) : "UNKNOWN");
    return NextResponse.json({ error: "본인인증을 시작하지 못했어요. 잠시 후 다시 시도하거나 «문자 인증으로 하기»를 이용해 주세요." }, { status: 503 });
  }
}

/** 확인 — 쿠키의 nonce 와 건 번호를 대조하고 포트원에 다시 묻는다. 통과하면 명의 번호·실명·시각 */
export async function confirmAnonIdentityRequest(
  request: Request & { cookies?: { get(name: string): { value: string } | undefined } },
  purpose: AnonIdentityPurpose,
  identityVerificationId: string,
): Promise<AnonIdentityConfirmed | AnonIdentityFailure> {
  const config = getPortoneConfig();
  if (!config) return { ok: false, status: 503, error: NOT_READY };
  const nonce = readCookie(request, anonIdentityCookieName(purpose));
  try {
    return await confirmAnonIdentity(prisma, {
      purpose,
      identityVerificationId,
      nonce,
      lookup: (id) => fetchPortoneIdentityVerification(id, config),
    });
  } catch (error) {
    console.error("[anon-identity verify] failed:", error instanceof Error ? error.message.slice(0, 200) : "UNKNOWN");
    return { ok: false, status: 503, error: "본인인증을 확인하지 못했어요. 잠시 후 다시 시도해 주세요." };
  }
}

/** 소진한 nonce 쿠키를 지운다(장부 줄은 이미 소진됐다 — 쿠키만 남아도 다시 쓸 수 없지만 깔끔하게) */
export function clearAnonIdentityCookie(response: NextResponse, purpose: AnonIdentityPurpose): NextResponse {
  response.cookies.set(anonIdentityCookieName(purpose), "", cookieOptions(0));
  return response;
}

function readCookie(request: Request & { cookies?: { get(name: string): { value: string } | undefined } }, name: string): string {
  const fromNext = request.cookies?.get(name)?.value;
  if (fromNext) return fromNext;
  // 일반 Request 로 들어온 경우 — Cookie 머리글을 직접 읽는다
  const header = request.headers.get("cookie") || "";
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return "";
}
