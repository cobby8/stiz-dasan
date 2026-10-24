import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth-guard";
import { prisma } from "@/lib/prisma";
import { parseMonthlyLedgerMonth, readMonthlyClassLedger } from "@/lib/billing/monthly-class-ledger-read";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store, max-age=0" };

export async function GET(request: NextRequest) {
  try {
    await requireAdmin();
  } catch {
    return NextResponse.json({ error: "관리자 로그인이 필요합니다." }, { status: 403, headers });
  }
  const targetMonth = request.nextUrl.searchParams.get("month") ?? "";
  try {
    parseMonthlyLedgerMonth(targetMonth);
  } catch {
    return NextResponse.json({ error: "조회할 월을 확인해 주세요." }, { status: 400, headers });
  }
  try {
    const result = await prisma.$transaction(async (tx) => {
      // 화면 조회가 실수로 운영 장부를 바꾸지 못하게 DB에서도 쓰기를 금지한다.
      await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
      return readMonthlyClassLedger(tx, targetMonth);
    }, { isolationLevel: "RepeatableRead" });
    return NextResponse.json(result, { headers });
  } catch (error) {
    const tooLarge = error instanceof Error && error.message === "MONTHLY_LEDGER_LIMIT";
    return NextResponse.json({
      error: tooLarge
        ? "조회 가능한 건수를 초과했습니다. 일부 합계를 표시하지 않습니다. 관리자에게 확인해 주세요."
        : "반별 월 장부를 조회하지 못했습니다. 잠시 후 다시 조회해 주세요.",
    }, { status: tooLarge ? 422 : 500, headers });
  }
}
