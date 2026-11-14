import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth-guard";
import { getStudentActivity } from "@/lib/queries";
import { maskStudentActivityForRole } from "@/lib/payments/financeRoleMask";

export const dynamic = "force-dynamic";

export async function GET(
    _request: NextRequest,
    { params }: { params: Promise<{ id: string }> },
) {
    let role: string;
    try {
        role = (await requireAdmin()).appUserRole;
    } catch {
        return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    }

    const { id } = await params;
    const data = await getStudentActivity(id);

    if (!data) {
        return NextResponse.json({ error: "Student not found" }, { status: 404 });
    }

    return NextResponse.json(
        // 부원장: 청구 목록·월별 낸 돈·이월액을 뺀다(화면 page.tsx 와 같은 함수)
        { data: maskStudentActivityForRole(data, role) },
        {
            headers: {
                "Cache-Control": "no-store",
            },
        },
    );
}
