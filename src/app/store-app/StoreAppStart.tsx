"use client";

import { useEffect } from "react";
import { markStoreApp, recordStoreAppCapabilities } from "@/lib/storeApp";

export default function StoreAppStart() {
  useEffect(() => {
    markStoreApp();
    // 앱 새 버전이 «할 수 있는 것»(?caps=push,links …)을 보내면 기억해 화면 곳곳의 우회를 끈다(d2)
    recordStoreAppCapabilities(new URLSearchParams(window.location.search).get("caps"));
    // replace: 뒤로 가기로 이 빈 화면에 다시 서지 않게.
    window.location.replace("/auth/continue");
  }, []);

  return (
    <main className="grid min-h-screen place-items-center bg-white px-6 text-center" style={{ colorScheme: "light" }}>
      <p className="text-base text-gray-500" aria-live="polite">스티즈 농구교실을 여는 중...</p>
    </main>
  );
}
