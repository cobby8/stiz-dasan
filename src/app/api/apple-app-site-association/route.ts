import { NextResponse } from "next/server";
import { buildAppleAppSiteAssociation } from "@/lib/app-site-association";

// `/.well-known/apple-app-site-association` 으로 서빙된다(next.config rewrite).
// 팀 ID 환경변수가 없으면 404 — 파일이 없는 것과 같다. 자세한 이유는 lib/app-site-association.ts.

export const dynamic = "force-dynamic";

export async function GET() {
  const body = buildAppleAppSiteAssociation();
  if (!body) return new NextResponse("Not Found", { status: 404 });
  return NextResponse.json(body, {
    headers: {
      // 애플은 CDN 으로 가져가 오래 보관한다. 우리 쪽 캐시는 짧게 둔다.
      "Cache-Control": "public, max-age=300",
      "Content-Type": "application/json",
    },
  });
}
