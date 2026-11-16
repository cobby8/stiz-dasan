"use client";

import { useEffect } from "react";
import { pathFromDocumentUrl, readMicFeatureAllowed, shouldReloadStaffDocument } from "@/lib/staff/documentPolicy";

// 되풀이 방지 표식: «새로 불러오기를 시도한 경로»를 탭 안에만 적어 둔다
const RELOAD_MARK_KEY = "stiz-staff-doc-reload";

/**
 * 다른 화면(로그인 등)에서 새로 불러오지 않고 선생님 화면으로 넘어왔으면 한 번 새로 불러온다.
 * 왜: 마이크 허용 머리글은 «처음 불러온 문서»에 붙어, 넘어온 화면에서는 음성 녹음이 바로 거부된다.
 * 그리는 것은 없다. 레이아웃에 한 번 놓이고, 화면 전환마다 다시 판정하지 않는다(입력 중인 화면을 날리지 않게).
 */
export default function StaffDocumentReload() {
  useEffect(() => {
    const currentPath = window.location.pathname;
    const featureAllowed = readMicFeatureAllowed(document);
    let initialDocumentPath: string | null = null;
    try {
      // 처음 불러온 문서의 주소 — 화면만 바뀌는 전환으로는 달라지지 않는다
      initialDocumentPath = pathFromDocumentUrl(performance.getEntriesByType("navigation")[0]?.name);
    } catch {
      initialDocumentPath = null;
    }

    let alreadyTriedFor: string | null;
    try {
      alreadyTriedFor = window.sessionStorage.getItem(RELOAD_MARK_KEY);
    } catch {
      return; // 저장소를 못 읽으면 새로 불러오지 않는다(무한 반복보다 낫다)
    }

    const input = { featureAllowed, initialDocumentPath, currentPath };
    if (!shouldReloadStaffDocument({ ...input, alreadyTriedFor })) {
      // 문서가 이미 괜찮아서 안 불러오는 경우엔 표식을 지운다 —
      // 나중에 다시 로그인 화면을 거쳐 들어왔을 때 옛 표식 때문에 건너뛰지 않게
      if (alreadyTriedFor !== null && !shouldReloadStaffDocument({ ...input, alreadyTriedFor: null })) {
        try { window.sessionStorage.removeItem(RELOAD_MARK_KEY); } catch { /* 못 지워도 동작에는 지장 없다 */ }
      }
      return;
    }

    try {
      window.sessionStorage.setItem(RELOAD_MARK_KEY, currentPath);
    } catch {
      return; // 표식을 못 남기면 새로 불러오지 않는다
    }
    // 같은 주소를 다시 받아 온다. location.replace(같은 주소)는 주소에 #이 있으면 문서를 다시 받지 않아 reload 를 쓴다
    window.location.reload();
  }, []);

  return null;
}
