import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth-guard";
import {
  addRosterStudent,
  copyRosterMonth,
  editRosterStop,
  getRegularRouteStatus,
  getRosterStudentContext,
  moveRosterRows,
  removeRosterRows,
  reorderRosterStops,
  RosterInputError,
  searchRosterStudents,
} from "@/lib/shuttle/regularRosterEdit";

export const dynamic = "force-dynamic";

// 셔틀 명단 편집 API(원장 전용). 각 lib 함수도 requireAdmin 을 다시 확인한다(이중 가드).
//   GET    ?q=이름                       → 학생 검색(추가 폼)
//   GET    ?routeStatus=1&month=&weekday= → 그 요일 기사님 화면이 정규 배차 저장 노선을 쓰는지(방향별, 조회 전용)
//   GET    ?context=1&studentId=          → 학생 추가: 등록 수업·상세 위치·학원/차고지 좌표(조회 전용)
//   POST   { action: "add" | "copyMonth" } → 학생 추가 / 다음 달 명단 만들기
//   PATCH  { action: "move" | "editStop" | "reorder" } → 반이동 / 정류장 수정 / 기사님 화면 순서·시각
//   DELETE { serviceMonth, ids }          → 빼기

function fail(e: unknown, tag: string) {
  const msg = String((e as { message?: string })?.message ?? "");
  if (e instanceof RosterInputError) return NextResponse.json({ error: msg }, { status: 400 });
  if (/권한|로그인|인증/.test(msg)) return NextResponse.json({ error: "관리자 권한이 필요합니다." }, { status: 403 });
  console.error(`[regular-roster ${tag}]`, e);
  return NextResponse.json({ error: "처리하지 못했습니다. 잠시 후 다시 시도해 주세요." }, { status: 500 });
}

async function body(request: Request): Promise<Record<string, unknown>> {
  const json = await request.json().catch(() => null);
  if (!json || typeof json !== "object" || Array.isArray(json)) throw new RosterInputError("요청 형식이 올바르지 않습니다.");
  return json as Record<string, unknown>;
}

export async function GET(request: Request) {
  try {
    await requireAdmin();
    const params = new URL(request.url).searchParams;
    if (params.get("routeStatus")) {
      const status = await getRegularRouteStatus(params.get("month"), params.get("weekday"));
      return NextResponse.json({ status }, { headers: { "Cache-Control": "no-store" } });
    }
    if (params.get("context")) {
      const context = await getRosterStudentContext(params.get("studentId") ?? "");
      return NextResponse.json({ context }, { headers: { "Cache-Control": "no-store" } });
    }
    const q = params.get("q") ?? "";
    const students = await searchRosterStudents(q);
    return NextResponse.json({ students }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) { return fail(e, "GET"); }
}

export async function POST(request: Request) {
  try {
    await requireAdmin();
    const b = await body(request);
    if (b.action === "add") return NextResponse.json({ ok: true, ...(await addRosterStudent(b)) });
    if (b.action === "copyMonth") return NextResponse.json({ ok: true, ...(await copyRosterMonth(b)) });
    throw new RosterInputError("알 수 없는 요청입니다.");
  } catch (e) { return fail(e, "POST"); }
}

export async function PATCH(request: Request) {
  try {
    await requireAdmin();
    const b = await body(request);
    if (b.action === "move") return NextResponse.json({ ok: true, ...(await moveRosterRows(b)) });
    if (b.action === "editStop") return NextResponse.json({ ok: true, ...(await editRosterStop(b)) });
    if (b.action === "reorder") return NextResponse.json({ ok: true, ...(await reorderRosterStops(b)) });
    throw new RosterInputError("알 수 없는 요청입니다.");
  } catch (e) { return fail(e, "PATCH"); }
}

export async function DELETE(request: Request) {
  try {
    await requireAdmin();
    return NextResponse.json({ ok: true, ...(await removeRosterRows(await body(request))) });
  } catch (e) { return fail(e, "DELETE"); }
}
