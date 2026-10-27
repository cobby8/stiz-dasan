import { NextResponse } from "next/server";
import { noStoreHeaders } from "@/lib/native-auth/http";
// 등록된 앱 복귀 처리가 없는 브라우저에서 주소만 열어도 인증 정보를 표시하지 않는다.
export async function GET() {
  return new NextResponse("앱으로 돌아가 로그인을 다시 시작해 주세요.",{status:400,headers:{...noStoreHeaders,"Content-Type":"text/plain; charset=utf-8"}});
}
