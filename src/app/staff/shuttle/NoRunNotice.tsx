"use client";

import { useEffect, useState } from "react";
import { replaceUrlSyncingNext } from "@/lib/navigation/listQuery";
import { previousEntryState, type PublicNavigation } from "@/lib/navigation/publicHistory";
import { SHUTTLE_NOTICE_PARAM, SHUTTLE_NO_RUN_FLAG_KEY, canCollapseNoRunEntry, isNoRunFlagFresh } from "@/lib/staff-session-rules";

/**
 * 셔틀 명단 위의 «아직 운행 링크가 없습니다» 한 줄 안내(2026-11-18 원장 결정 G).
 *
 * 왜: 스토어 앱에서 «운행 시작»을 눌렀는데 오늘 운행 링크(열쇠)가 없으면 서버가 이 명단으로 되돌려 보낸다(?notice=no-run).
 * 예전엔 아무 말 없이 명단만 다시 보여 버튼이 안 먹은 것처럼 보였다.
 *
 * 주소 정리(둘 중 하나):
 *  1) 바로 앞 칸이 같은 명단 화면이면(«운행 시작»을 누른 그 명단) 탭 안 표시를 남기고 한 칸 뒤로 간다 —
 *     명단 칸이 둘이 되어 «뒤로»가 한 번 헛도는 것을 막는다. 돌아간 명단이 표시를 읽어 안내를 보인다.
 *  2) 앞 칸을 모르거나 다른 화면이면 지금 칸의 주소에서 표시(?notice=…)만 지운다(기록은 쌓지 않는다).
 *     Next 에도 바뀐 주소를 알리는 공용 함수를 쓴다 — 안 알리면 운행표의 30초 새로 읽기(router.refresh)가 지운 쿼리를 되살린다.
 */
export default function NoRunNotice({ fromQuery }: { fromQuery: boolean }) {
  // 주소에 표시를 달고 왔으면 서버가 그린 첫 화면부터 안내를 보인다. 탭 안 표시로 온 경우는 아래 효과가 켠다
  const [visible, setVisible] = useState(fromQuery);

  useEffect(() => {
    /** 탭 안 표시가 있으면 안내를 켜고 표시를 지운다(한 번만) */
    const showFromFlag = () => {
      try {
        const raw = window.sessionStorage.getItem(SHUTTLE_NO_RUN_FLAG_KEY);
        if (!raw) return;
        window.sessionStorage.removeItem(SHUTTLE_NO_RUN_FLAG_KEY);
        if (isNoRunFlagFresh(raw, Date.now())) setVisible(true);
      } catch {
        // 저장소가 막혔으면 안내 없이 명단만(예전 동작)
      }
    };

    if (fromQuery) {
      // 1) 앞 칸이 같은 명단이면 표시를 남기고 그 칸으로 돌아간다(앞 칸을 못 읽거나 표시를 못 남기면 2번으로)
      try {
        const previous = previousEntryState((window as Window & { navigation?: PublicNavigation }).navigation, window.location.origin);
        if (previous.kind === "ok" && canCollapseNoRunEntry(previous.path) && window.history.length > 1) {
          window.sessionStorage.setItem(SHUTTLE_NO_RUN_FLAG_KEY, String(Date.now()));
          window.history.back();
          return;
        }
      } catch {
        // 2번으로
      }
      // 2) 지금 칸의 주소에서 표시만 지운다
      try {
        const params = new URLSearchParams(window.location.search);
        if (!params.has(SHUTTLE_NOTICE_PARAM)) return;
        params.delete(SHUTTLE_NOTICE_PARAM);
        const query = params.toString();
        replaceUrlSyncingNext(`${window.location.pathname}${query ? `?${query}` : ""}`);
      } catch {
        // 주소를 못 고쳐도 안내는 그대로 보인다(새로 고치면 한 번 더 보일 뿐)
      }
      return;
    }

    showFromFlag();
    // 뒤로 와서 화면이 다시 그려지지 않고 그대로 복원된 경우(브라우저 화면 보관)에도 표시를 읽는다
    window.addEventListener("pageshow", showFromFlag);
    window.addEventListener("popstate", showFromFlag);
    return () => {
      window.removeEventListener("pageshow", showFromFlag);
      window.removeEventListener("popstate", showFromFlag);
    };
  }, [fromQuery]);

  if (!visible) return null;

  return (
    <div className="mx-auto max-w-lg px-4 pt-3">
      <p role="status" className="rounded-xl bg-[var(--color-academy-warning-soft)] px-3 py-2 text-sm text-[var(--color-academy-ink)]">
        아직 운행 링크가 없습니다. 원장님이 셔틀 배차 화면에서 기사님 운행 링크를 만들면 «운행 시작»으로 바로 열립니다.
      </p>
    </div>
  );
}
