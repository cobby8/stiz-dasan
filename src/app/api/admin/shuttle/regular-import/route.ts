import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// 2026-10-02 구글 시트 가져오기 종료.
// 셔틀 명단은 「셔틀 명단」 화면(/admin/shuttle/regular)에서 앱이 직접 편집한다.
// 이 API 가 다시 불리면 앱에서 고친 명단이 시트 기준으로 덮어써지므로, 아무것도 하지 않고 410(종료됨)으로 막는다.
// 옛 화면·북마크·스크립트가 호출해도 DB 는 건드리지 않는다.
export async function POST() {
  return NextResponse.json(
    { error: "구글 시트 가져오기는 종료됐습니다. 셔틀 명단 화면에서 직접 편집하세요." },
    { status: 410 },
  );
}
