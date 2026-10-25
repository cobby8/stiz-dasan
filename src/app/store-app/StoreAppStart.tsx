"use client";

import { useEffect } from "react";
import { markStoreApp } from "@/lib/storeApp";

export default function StoreAppStart() {
  useEffect(() => {
    markStoreApp();
    // replace: 뒤로 가기로 이 빈 화면에 다시 서지 않게.
    window.location.replace("/auth/continue");
  }, []);

  return (
    <main className="grid min-h-screen place-items-center bg-white px-6 text-center" style={{ colorScheme: "light" }}>
      <p className="text-base text-gray-500" aria-live="polite">스티즈 농구교실을 여는 중...</p>
    </main>
  );
}
