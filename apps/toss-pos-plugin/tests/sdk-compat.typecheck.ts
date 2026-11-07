// 타입 전용 검사(실행하지 않음 — npm run typecheck 가 읽는다).
// core 가 쓰는 «최소 모양»(pos-types.ts)이 실제 SDK 0.0.31 타입과 맞는지 컴파일러로 확인한다.
// SDK 를 올렸는데 모양이 바뀌면 여기서 빨간 줄이 난다.
import { posPluginSdk } from "@tossplace/pos-plugin-sdk";
import { buildLineItem } from "../src/core/order.ts";
import type { ChargeRequest } from "../src/core/contract.ts";
import type { DraftOrderLike, HttpLike, OrderLike, PaymentLike } from "../src/core/pos-types.ts";

declare const req: ChargeRequest;

export async function compatCheck(): Promise<void> {
  // 우리가 만든 항목을 실제 addLineItem 이 받는가
  const d: DraftOrderLike = await posPluginSdk.draftOrder.addLineItem(buildLineItem(req));
  const d2: DraftOrderLike = await posPluginSdk.draftOrder.get();
  const o: OrderLike = await posPluginSdk.order.getOrder("x");
  const p: PaymentLike = await posPluginSdk.payment.getPayment("x");
  posPluginSdk.toast.success({ message: "m", button: { text: "t", onClick: () => undefined } });
  posPluginSdk.alert.open({ message: "m" });
  const s: string | undefined = await posPluginSdk.storage.get("k");
  // 롱폴링: http.get 세 번째 인자 { timeoutMs } (docs.tossplace.com/reference/plugin-sdk/pos/http.html)
  const h: HttpLike = posPluginSdk.http;
  const r = await posPluginSdk.http.get("https://www.stiz-dasan.kr/x", [["A", "b"]], { timeoutMs: 25_000 });
  const code: number = r.code;
  void [d, d2, o, p, s, h, code];
}
