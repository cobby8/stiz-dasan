"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth-guard";
import { runPosReconcile } from "@/lib/pos/reconcileService";

/**
 * 관리자가 "지금 대조하기"를 눌렀을 때 실행된다.
 *
 * Server Action 은 브라우저에서 직접 POST 로 부를 수 있으므로,
 * 화면을 가렸다고 안심하지 않고 **첫 줄에서 관리자 권한을 다시 확인**한다.
 *
 * 이 동작은 조회 + 기록 한 줄뿐이라 여러 번 눌러도 결제 데이터가 망가지지 않는다.
 * (중복 클릭은 화면 쪽 버튼이 비활성화로 막는다.)
 */
export async function runPosReconcileNow(): Promise<void> {
    await requireAdmin();
    // 결과는 화면이 DB 에서 다시 읽는다. form action 은 값을 돌려주지 않는다(반환하면 타입이 맞지 않는다).
    await runPosReconcile({ source: "MANUAL" });
    revalidatePath("/admin/pos-reconcile");
}
