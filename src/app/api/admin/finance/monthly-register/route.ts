import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth-guard";
import { prisma } from "@/lib/prisma";
import { MonthlyRegisterError } from "@/lib/billing/monthly-register";
import { mutateMonthlyRegister, readMonthlyRegister, validateRegisterTarget } from "@/lib/billing/monthly-register-service";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store, max-age=0" };
const writesEnabled = () => process.env.MONTHLY_REGISTER_WRITES_ENABLED === "true";
const fail = (error: unknown) => NextResponse.json({ error: error instanceof MonthlyRegisterError
  ? error.message : "월 장부를 처리하지 못했습니다. 잠시 후 다시 시도해 주세요." },
{ status: error instanceof MonthlyRegisterError ? error.status : 500, headers });

export async function GET(request: NextRequest) {
  try { await requireAdmin(); } catch { return NextResponse.json({ error: "관리자 로그인이 필요합니다." }, { status: 403, headers }); }
  try {
    const { studentId, month } = validateRegisterTarget(request.nextUrl.searchParams.get("studentId"), request.nextUrl.searchParams.get("month"));
    const view = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
      return readMonthlyRegister(tx, studentId, month, writesEnabled());
    }, { isolationLevel: "RepeatableRead" });
    return NextResponse.json(view, { headers });
  } catch (error) { return fail(error); }
}

async function readBody(request: NextRequest) {
  // 최대 20개 반의 한글 근거(각 500자)도 담되 실제 수신 바이트 상한을 둔다.
  const limit = 128 * 1024;
  if (Number(request.headers.get("content-length")) > limit) throw new MonthlyRegisterError("요청 내용이 너무 큽니다.", 413);
  const reader = request.body?.getReader();
  if (!reader) throw new MonthlyRegisterError("요청 내용이 없습니다.");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) { await reader.cancel(); throw new MonthlyRegisterError("요청 내용이 너무 큽니다.", 413); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new MonthlyRegisterError("요청 형식을 확인해 주세요."); }
}

export async function POST(request: NextRequest) {
  let admin;
  try { admin = await requireAdmin(); } catch { return NextResponse.json({ error: "관리자 로그인이 필요합니다." }, { status: 403, headers }); }
  try {
    if (!writesEnabled()) throw new MonthlyRegisterError("월 장부 저장은 운영 적용 승인 전까지 잠겨 있습니다.", 503);
    if (request.headers.get("origin") !== request.nextUrl.origin || request.headers.get("sec-fetch-site") === "cross-site") {
      throw new MonthlyRegisterError("사이트에서 다시 요청해 주세요.", 403);
    }
    if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/json") throw new MonthlyRegisterError("JSON 요청만 처리할 수 있습니다.", 415);
    const result = await mutateMonthlyRegister(prisma, await readBody(request), admin.appUserId, writesEnabled());
    return NextResponse.json({ record: result }, { headers });
  } catch (error) { return fail(error); }
}
