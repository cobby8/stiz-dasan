"use server";

// 3년 이상 재원생 유니폼 무료 신청(공개, 로그인 없음 — 추측 불가 토큰이 곧 권한)
//
// 🚫 본사 발송(dispatchUniformOrderById)을 부르지 않는다. 무료 주문은 NEEDS_REVIEW 로 저장되고,
//    원장이 /admin/uniform 에서 «재전송» 을 눌러야 본사로 나간다.
// 오류는 throw 대신 결과값으로 돌려준다 — 운영 빌드의 서버 액션은 throw 문구를 가려서
// 학부모가 «무엇을 고쳐야 하는지» 못 보게 되기 때문이다.
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import {
  submitFreeUniformOrderInTx,
  type FreeUniformOrderInput,
  type FreeUniformSubmitResult,
} from "@/lib/uniform-free-grant";

export async function submitFreeUniformOrder(
  token: string,
  input: FreeUniformOrderInput,
): Promise<FreeUniformSubmitResult> {
  try {
    const result = await prisma.$transaction((tx) => submitFreeUniformOrderInTx(tx, String(token ?? ""), input));
    if (result.ok) revalidatePath("/admin/uniform");
    return result;
  } catch (error) {
    console.error("[uniform-free] 신청 실패", error);
    return { ok: false, reason: "INVALID", message: "신청 중 문제가 발생했습니다. 잠시 후 다시 시도해 주세요." };
  }
}
