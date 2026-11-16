"use client";

import { useEffect } from "react";
import { markStoreApp, markStoreAppStart, recordStoreAppCapabilities } from "@/lib/storeApp";
import { STORE_APP_START_DONE_FLAG } from "@/lib/storeAppStartScript";

/**
 * destination: 서버(page.tsx)가 정한 «갈 주소». 같은 일을 문서 맨 앞의 짧은 스크립트가 먼저 하고,
 * 여기는 그 스크립트가 돌지 못했을 때의 대비다. 스크립트가 이미 이동을 걸었으면 표식만 다시 찍고 이동은 또 걸지 않는다
 * (같은 주소라도 두 번 걸면 앞의 요청이 취소되고 목적 화면 요청이 서버에 두 번 간다).
 */
export default function StoreAppStart({ destination }: { destination: string }) {
  useEffect(() => {
    markStoreApp();
    // 업데이트 안내용 표식 — «앱 시작 주소를 거쳤다»만 따로 찍는다(다른 앱이 연 브라우저와 가르기 위해)
    markStoreAppStart();
    // 앱 새 버전이 «할 수 있는 것»(?caps=push,links …)을 보내면 기억해 화면 곳곳의 우회를 끈다(d2)
    recordStoreAppCapabilities(new URLSearchParams(window.location.search).get("caps"));
    if ((window as unknown as Record<string, unknown>)[STORE_APP_START_DONE_FLAG]) return;
    // replace: 뒤로 가기로 이 빈 화면에 다시 서지 않게.
    window.location.replace(destination);
  }, [destination]);

  return (
    <main className="grid min-h-screen place-items-center bg-white px-6 text-center" style={{ colorScheme: "light" }}>
      <p className="text-base text-gray-500" aria-live="polite">스티즈 농구교실을 여는 중...</p>
    </main>
  );
}
