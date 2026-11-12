"use client";

import { useEffect, useState } from "react";
import { storeAppLacks, type StoreAppCapability } from "@/lib/storeApp";

/**
 * 스토어 앱에서 cap 을 못 하면 true(d2). 판정은 @/lib/storeApp 의 storeAppLacks 한 곳.
 * 서버는 앱인지 모르므로 첫 그림은 «브라우저»(false)로 그리고, 화면이 뜬 뒤 확인해서 바꾼다
 * (useInstalledApp 과 같은 방식 — 브라우저 사용자에게 버튼이 깜빡 사라지는 일이 없게).
 */
export function useStoreAppLacks(cap: StoreAppCapability): boolean {
  const [lacks, setLacks] = useState(false);
  useEffect(() => {
    setLacks(storeAppLacks(cap));
  }, [cap]);
  return lacks;
}
