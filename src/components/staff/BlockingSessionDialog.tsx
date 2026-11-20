"use client";

import { useEffect, useState } from "react";
import AdminModal, { useAdminModalCloseThen } from "@/components/admin/AdminModal";
import { completeBlockingSession } from "@/app/actions/staff-sessions";
import { BLOCKING_FINISH_HINT, BLOCKING_FINISH_NETWORK_MESSAGE, BLOCKING_SLOW_MESSAGE, SLOW_RESPONSE_MS, staffReloginHref } from "@/lib/staff-session-rules";

/** 다른 수업 시작을 막고 있는 «아직 진행 중» 수업 — startClassSession 의 ACTIVE_SESSION 응답에서 만든다 */
export type BlockingSession = {
  sessionId: string;
  /** 서버가 준 안내 그대로(«○○반(11월 19일) 수업이 아직 진행 중입니다. 먼저 끝내 주세요.») */
  message: string;
  className: string | null;
  /**
   * 지난 날짜 수업인가 — 서버가 DB 시계로 판정한 값(startClassSession 의 activeIsPast). 화면은 날짜를 비교해 추측하지 않는다.
   * 참일 때만 «그 수업 종료하기»를 보인다. 오늘 수업은 그 수업 화면에서 끝낸다(알림·리포트가 정상으로 나가게).
   */
  isPast: boolean;
};

/**
 * 막힌 자리 안내 창(2026-11-20 원장 승인).
 * 왜: 어제 끝내지 못한 수업 때문에 오늘 수업을 시작하지 못할 때, 예전엔 «그 수업 화면으로 이동할까요?»만 물었다.
 *     출결이 이미 다 찍힌 수업이면 여기서 바로 끝내고(학부모 알림·리포트 발행 없음) 오늘 수업을 시작하게 한다.
 * 창 틀은 공용 AdminModal 을 그대로 쓴다 — 휴대폰 «뒤로» = 이 창만 닫기가 이미 들어 있다(따로 걸지 않는다).
 */
export function BlockingSessionDialog({
  target,
  onClose,
  onFinished,
  onOpenSession,
  onNeedsLogin,
}: {
  target: BlockingSession;
  /** «닫기»·바탕·뒤로로 닫힘 */
  onClose: () => void;
  /** 그 수업을 종료했다 — 부르는 쪽이 창을 닫고 안내 한 줄을 보인다(새 수업을 자동으로 시작하지 않는다) */
  onFinished: () => void;
  /** «그 수업 화면 열기» — 창의 기록 칸을 되돌린 뒤에 불린다 */
  onOpenSession: () => void;
  /** 로그인이 풀렸을 때 — 화면의 «다시 로그인» 안내를 켠다 */
  onNeedsLogin?: () => void;
}) {
  // 종료 요청 중 — 그동안은 버튼을 잠그고 창이 닫히지 않게 한다
  const [busy, setBusy] = useState(false);
  // 응답이 오래(SLOW_RESPONSE_MS) 없으면 안내를 보이고 그때부터는 닫을 수 있게 한다 — 응답이 영영 없으면 창에 갇힌다
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!busy) return;
    const timer = window.setTimeout(() => setSlow(true), SLOW_RESPONSE_MS);
    return () => {
      window.clearTimeout(timer);
      setSlow(false);
    };
  }, [busy]);
  // 닫히면 안 되는 동안 = 요청 중이고 아직 «응답이 늦습니다»가 뜨기 전
  const locked = busy && !slow;
  return (
    <AdminModal
      titleId="blocking-session-title"
      panelClassName="max-w-md"
      busy={locked}
      closeOnBackdrop={!locked}
      onClose={() => { if (!locked) onClose(); }}
    >
      <BlockingSessionBody
        target={target}
        busy={busy}
        slow={slow}
        setBusy={setBusy}
        onClose={onClose}
        onFinished={onFinished}
        onOpenSession={onOpenSession}
        onNeedsLogin={onNeedsLogin}
      />
    </AdminModal>
  );
}

// 창 안쪽 — «창을 닫은 뒤 이어서 할 일»(useAdminModalCloseThen)은 AdminModal 안에서만 쓸 수 있어 따로 둔다
function BlockingSessionBody({
  target,
  busy,
  slow,
  setBusy,
  onClose,
  onFinished,
  onOpenSession,
  onNeedsLogin,
}: {
  target: BlockingSession;
  busy: boolean;
  /** 응답이 늦다 — 안내를 보이고 «닫기»를 푼다 */
  slow: boolean;
  setBusy: (value: boolean) => void;
  onClose: () => void;
  onFinished: () => void;
  onOpenSession: () => void;
  onNeedsLogin?: () => void;
}) {
  const closeThen = useAdminModalCloseThen();
  // 종료 실패 문구 — 창 안에 그대로 보인다(창은 닫지 않는다)
  const [error, setError] = useState("");
  const [needsLogin, setNeedsLogin] = useState(false);

  async function finish() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await completeBlockingSession({ sessionId: target.sessionId });
      if (!result.ok) {
        // 서버 문구 그대로(예: «출결을 확인하지 않은 학생이 있습니다(보강 온 아이 포함).») — 그 수업 화면에서 출결을 찍게 한다
        setError(result.message);
        if ("needsLogin" in result && result.needsLogin) {
          setNeedsLogin(true);
          onNeedsLogin?.();
        }
        return;
      }
      onFinished();
    } catch {
      // 요청이 서버에 닿지 못했다(연결 끊김 등) — 창을 닫지 않고 다시 누르게 한다
      setError(BLOCKING_FINISH_NETWORK_MESSAGE);
    } finally {
      setBusy(false);
    }
  }

  // 창이 넣은 기록 칸을 먼저 되돌린 뒤에 이동한다(먼저 이동하면 그 되돌리기가 새 화면을 되돌린다)
  function openSession() {
    closeThen(onOpenSession);
    onClose();
  }

  return (
    <div className="p-5">
      <h2 id="blocking-session-title" className="text-lg font-bold text-[var(--color-academy-ink)]">끝나지 않은 수업이 있습니다</h2>
      <p className="mt-2 text-sm text-[var(--color-academy-ink)]">{target.message}</p>
      {/* 여기서 끝낼 수 있는 것은 지난 날짜 수업뿐이다 — 오늘 수업이면 이 줄과 «그 수업 종료하기»를 보이지 않는다 */}
      {target.isPast && <p className="mt-1 text-sm text-[var(--color-academy-muted)]">{BLOCKING_FINISH_HINT}</p>}
      {error && (
        <p role="alert" aria-live="assertive" className="mt-3 rounded-xl bg-[var(--color-academy-danger-soft)] p-3 text-sm text-[var(--color-academy-danger)]">{error}</p>
      )}
      {slow && (
        <p role="status" className="mt-3 rounded-xl bg-[var(--color-academy-warning-soft)] p-3 text-sm text-[var(--color-academy-warning)]">{BLOCKING_SLOW_MESSAGE}</p>
      )}
      <div className="mt-4 grid gap-2">
        {needsLogin ? (
          <button
            type="button"
            onClick={() => window.location.assign(staffReloginHref(`${window.location.pathname}${window.location.search}`))}
            className="academy-button-primary min-h-11 w-full"
          >
            다시 로그인
          </button>
        ) : target.isPast ? (
          <button type="button" disabled={busy} aria-busy={busy} onClick={() => void finish()} className="academy-button-primary min-h-11 w-full">
            {busy ? "종료하는 중…" : "그 수업 종료하기"}
          </button>
        ) : null}
        {/* 오늘 수업이면 «그 수업 화면 열기»가 이 창의 주 버튼이다 */}
        <button type="button" disabled={busy} onClick={openSession} className={`${target.isPast || needsLogin ? "academy-button-secondary" : "academy-button-primary"} min-h-11 w-full`}>그 수업 화면 열기</button>
        {/* 응답이 늦으면(slow) 요청 중이어도 닫을 수 있다 */}
        <button type="button" disabled={busy && !slow} data-admin-modal-initial-focus onClick={onClose} className="academy-button-text min-h-11 w-full">닫기</button>
      </div>
    </div>
  );
}
