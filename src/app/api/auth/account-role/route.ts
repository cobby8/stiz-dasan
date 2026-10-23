import { NextResponse } from "next/server";
import { getAccountViewAccess } from "@/lib/account-view-access";

export async function GET() {
  const { role, views } = await getAccountViewAccess();

  return NextResponse.json(
    { role, views },
    {
      headers: {
        "Cache-Control": "private, no-store, max-age=0",
      },
    },
  );
}
