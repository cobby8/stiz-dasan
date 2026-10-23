import { NextResponse } from "next/server";
import { userFacingError } from "@/lib/user-facing-error";
import { prisma } from "@/lib/prisma";
import { linkEnrollmentAccount } from "@/lib/enrollment-account-handoff";
import { createClient } from "@/lib/supabase/server";

export async function POST(request: Request) {
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const token = typeof body?.handoff === "string"
    ? body.handoff
    : typeof body?.enrollmentHandoff === "string"
      ? body.enrollmentHandoff
      : "";
  const { data } = await (await createClient()).auth.getUser();
  if (!data.user) {
    return NextResponse.json({ error: "로그인 후 수강신청을 연결해 주세요." }, { status: 401 });
  }

  // Supabase 프로필 메타데이터가 아니라 STIZ DB의 역할·휴대전화 인증 상태를 신뢰한다.
  const users = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
    `SELECT id FROM "User"
      WHERE ("authUserId" = $1 OR ("authUserId" IS NULL AND id = $1))
        AND role = 'PARENT' AND "phoneVerifiedAt" IS NOT NULL
      ORDER BY CASE WHEN "authUserId" = $1 THEN 0 ELSE 1 END
      LIMIT 1`,
    data.user.id,
  );
  if (!users[0]) {
    return NextResponse.json(
      { error: "휴대전화 인증을 완료한 학부모 계정으로 로그인해 주세요." },
      { status: 403 },
    );
  }

  try {
    const result = await linkEnrollmentAccount({ token, parentUserId: users[0].id });
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: userFacingError(error, "수강신청을 계정에 연결하지 못했습니다.") },
      { status: 400 },
    );
  }
}
