"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { childLinkRequest, isChildLinkState } from "./child-link-api";

/** 재원생이 있는 보호자도 새 가족의 승인 요청을 홈에서 놓치지 않도록 안내한다. */
export default function ChildConnectionNotice() {
  const [counts, setCounts] = useState({ incoming: 0, outgoing: 0 });
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    childLinkRequest(undefined, controller.signal).then((state) => {
      if (!isChildLinkState(state)) throw new Error("연결 상태 확인 실패");
      if (!controller.signal.aborted) {
        setCounts({ incoming: state.incoming.filter((row) => row.status === "PENDING").length, outgoing: state.outgoing.filter((row) => row.status === "PENDING").length });
        setError(false);
      }
    }).catch(() => { if (!controller.signal.aborted) setError(true); });
    return () => controller.abort();
  }, [attempt]);
  if (error) return <p className="text-xs text-[var(--color-academy-muted)]">가족 연결 요청을 확인하지 못했습니다. <button className="min-h-11 font-bold underline" type="button" onClick={() => setAttempt((value) => value + 1)}>다시 확인</button></p>;
  if (!counts.incoming && !counts.outgoing) return null;
  return <Link href="/mypage/children" className="academy-panel flex min-h-11 flex-wrap items-center justify-between gap-2 p-3 text-sm"><span>{counts.incoming > 0 ? <b>가족 연결 승인 요청 {counts.incoming}건</b> : <b>가족 확인 대기 {counts.outgoing}건</b>}</span><span className="font-bold text-[var(--color-academy-primary)]">확인하기 →</span></Link>;
}
