/**
 * 수업 진행 중 «뒤로» 지키기 — 기록 칸 규칙(2026-11-18 원장 승인: 창은 창만 닫힘 · 홈에서도 묻기 · 종료 뒤엔 들어오기 전 화면).
 *
 * 기록 칸 모양(같은 주소의 칸을 쌓는다):
 *   [들어오기 전 화면] [바닥 칸 = 수업 화면에 들어온 칸] [가드 칸] [창 칸 …(시트·확인 창이 열려 있을 때)]
 *  - 가드 칸 위에서 «뒤로» → 바닥 칸에 닿는다 = «수업 화면을 나가려는 뒤로». 가드 칸을 다시 넣고 «저장하고 나갈까요»를 묻는다.
 *  - 창 칸 위에서 «뒤로» → 가드 칸(또는 아래 창 칸)에 닿는다 = 창만 닫힌 것. 묻지 않는다.
 *
 * ★ 왜 «바닥 칸에 닿았는가»로 판단하나: 출결 저장 같은 서버 기능이 끝나면 Next 가 «지금 칸»의 표시를 지우고 덮어쓴다
 *   (router.refresh·revalidate). 가드 칸·창 칸은 수업 중에 수시로 표시를 잃는다. 바닥 칸은 «지금 칸»인 적이 없어 표시가 남는다.
 *   그래서 «가드 표시가 있는 칸인가»가 아니라 «바닥 표시만 있는 칸인가»를 본다.
 *
 * 수업 주소(/staff/sessions/[id])의 가드와 선생님 홈(/staff)의 가드가 이 파일의 같은 판단을 쓴다.
 */
import { overlayDepthOf } from "@/lib/navigation/overlayHistory";

/** 가드 칸 표시 · 바닥 칸 표시 · «들어오기 전 화면이 있었는가» — 수업 주소의 가드가 쓰던 이름 그대로 */
export const LESSON_GUARD_MARK = "staffSessionGuard";
export const LESSON_GUARD_BASE_MARK = "staffSessionGuardBase";
export const LESSON_GUARD_HAD_PREVIOUS_MARK = "staffSessionHadPrevious";
/** 선생님 홈의 가드 열쇠(수업 주소는 `staff-session-<수업 id>`) */
export const HOME_LESSON_GUARD_KEY = "staff-home-lesson";

/** 기록 칸 하나가 빠지기를 기다리는 한도 — 일부 웹뷰에서 popstate 가 안 와도 굳지 않게 */
const POP_WAIT_MS = 400;
/** 수업 화면을 나가는 첫 «두 칸 뒤로»만 기다리는 시간 — 다른 문서로 가는 느린 이동을 «무시됨»으로 오해하지 않게 */
const FIRST_LEAVE_WAIT_MS = 1200;

export type LessonGuardWindow = {
  history: {
    readonly state: unknown;
    pushState(data: unknown, unused: string): void;
    replaceState(data: unknown, unused: string): void;
    back(): void;
    go(delta: number): void;
  };
  location: { readonly href: string };
  addEventListener(type: "popstate" | "pagehide" | "beforeunload", listener: () => void): void;
  removeEventListener(type: "popstate" | "pagehide" | "beforeunload", listener: () => void): void;
  setTimeout(fn: () => void, ms: number): unknown;
  /** Navigation API(안드로이드 웹뷰·크롬·최신 사파리) — 있으면 «지금 칸이 몇 번째인가·아래 칸의 주소»를 정확히 안다 */
  navigation?: { readonly currentEntry: { readonly index: number } | null; entries(): ReadonlyArray<{ readonly url: string | null }> } | null;
};

function record(state: unknown): Record<string, unknown> {
  return state && typeof state === "object" ? (state as Record<string, unknown>) : {};
}

/**
 * popstate 로 닿은 칸이 «바닥 칸»인가 = 수업 화면을 나가려는 뒤로인가(순수 판단).
 *  - 바닥 표시만 있는 칸: true
 *  - 가드 칸(표시가 지워졌든 남았든)·창 칸: false — 창이 닫히며 빠진 칸이다
 */
export function isLessonGuardBase(state: unknown, guardKey: string): boolean {
  const value = record(state);
  return value[LESSON_GUARD_BASE_MARK] === guardKey && value[LESSON_GUARD_MARK] !== guardKey && overlayDepthOf(state) === 0;
}

/** act() 를 하고 popstate 한 번을 기다린다. 왔으면 true, 한도까지 안 오면 false */
export function waitForPop(win: LessonGuardWindow, act: () => void, ms: number = POP_WAIT_MS): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (popped: boolean) => {
      if (done) return;
      done = true;
      win.removeEventListener("popstate", onPop);
      resolve(popped);
    };
    const onPop = () => finish(true);
    win.addEventListener("popstate", onPop);
    win.setTimeout(() => finish(false), ms);
    try {
      act();
    } catch {
      finish(false);
    }
  });
}

/**
 * 맨 위가 아직 창 칸이면(닫히는 중인 확인 창 등) 그 칸이 빠질 때까지 잠깐 기다린다.
 * 왜: 곧바로 «두 칸 뒤로»를 하면, 닫히는 창이 뒤늦게 하는 «한 칸 되돌리기»와 겹쳐 엉뚱한 칸에 닿는다.
 */
export async function waitOverlayEntriesGone(win: LessonGuardWindow, maxWaits = 2): Promise<void> {
  for (let i = 0; i < maxWaits; i += 1) {
    if (overlayDepthOf(win.history.state) === 0) return;
    await waitForPop(win, () => {});
  }
}

/**
 * 가드 칸·창 칸을 한 칸씩 걷어 «바닥 칸»까지 내려간다(수업 종료·시작 취소 뒤 나갈 때).
 * 바닥 칸에서 화면을 바꿔 끼우면(replace) 수업 화면 칸이 기록에 남지 않아, 뒤로 = 들어오기 전 화면이 된다.
 *  - maxSteps = 걷을 칸 수의 한도(가드 칸 1 + 열려 있던 창 수). 바닥 칸에 닿으면 그 전에 멈춘다 — 한도보다 더 내려가지 않는다.
 *  - 닿았으면 true
 */
export async function unwindToLessonGuardBase(win: LessonGuardWindow, guardKey: string, maxSteps: number): Promise<boolean> {
  for (let i = 0; i < maxSteps; i += 1) {
    if (isLessonGuardBase(win.history.state, guardKey)) return true;
    const popped = await waitForPop(win, () => win.history.back());
    if (!popped) return false;
  }
  return isLessonGuardBase(win.history.state, guardKey);
}

/** act() 뒤 무슨 일이 일어났나 — 같은 문서 안에서 칸이 바뀜(popped) · 다른 문서로 떠나는 중(unloading) · 아무 일 없음(none) */
function waitForLeave(win: LessonGuardWindow, act: () => void, ms: number = POP_WAIT_MS): Promise<"popped" | "unloading" | "none"> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (result: "popped" | "unloading" | "none") => {
      if (done) return;
      done = true;
      win.removeEventListener("popstate", onPop);
      win.removeEventListener("pagehide", onUnload);
      win.removeEventListener("beforeunload", onUnload);
      resolve(result);
    };
    const onPop = () => finish("popped");
    const onUnload = () => finish("unloading");
    win.addEventListener("popstate", onPop);
    win.addEventListener("pagehide", onUnload);
    win.addEventListener("beforeunload", onUnload);
    win.setTimeout(() => finish("none"), ms);
    try {
      act();
    } catch {
      finish("none");
    }
  });
}

/**
 * 수업 화면을 나간다 — 방금 되살린 가드 칸 위에서 부른다(저장이 끝난 뒤). 나갔으면 true, «앞 화면이 없으면» false.
 *
 * 왜 history.length 를 보지 않나(2026-11-18 검수 L-1): length 는 «앞으로 칸»까지 센다. 창이 칸을 넣었다 빼기만 해도 2가 되어
 * 앞 화면이 없는데 «두 칸 뒤로»를 보내고, 브라우저가 그 이동을 통째로 무시해 화면이 굳었다.
 *  - Navigation API 가 있으면: 아래로 내려가며 «주소가 다른 첫 칸»을 찾아 한 번에 간다. 같은 주소의 옛 바닥·옛 가드 칸이
 *    여러 겹이어도(가드 표시가 지워진 칸에서 새로고침 — L-3) 정확히 앞 화면에 닿는다. 없으면 같은 주소의 맨 아래 칸으로 내려가고 false.
 *  - 없으면(안전망): «두 칸 뒤로»를 보내고 기다린다. 무시됐으면 가드 칸만 걷고 false. 내려갔는데 아직 같은 주소면 한 칸씩 더 내려가 보고,
 *    더 내려갈 곳이 없을 때 false.
 * false 로 끝나면 가드 칸은 남지 않는다 — 그다음 뒤로는 묻지 않고 나간다(앱 종료 등 브라우저 기본 동작).
 */
export async function leaveLessonScreen(win: LessonGuardWindow): Promise<boolean> {
  const from = win.location.href;
  let nav: LessonGuardWindow["navigation"] = null;
  let index = -1;
  try {
    nav = win.navigation ?? null;
    index = nav?.currentEntry?.index ?? -1;
  } catch {
    nav = null;
  }
  if (nav && index >= 0) {
    try {
      const entries = nav.entries();
      const here = entries[index]?.url ?? null;
      let target = index - 1;
      while (target >= 0 && entries[target]?.url === here) target -= 1;
      if (target >= 0) {
        win.history.go(target - index);
        return true;
      }
      // 앞 화면 없음 — 같은 주소의 맨 아래 칸까지 내려가 가드 칸을 모두 걷는다
      if (index > 0) await waitForPop(win, () => win.history.go(-index));
      return false;
    } catch {
      // 목록을 못 읽으면 아래 안전망으로
    }
  }
  // 이 첫 기다림만 길게(검수 L-5): 앞 화면이 «다른 문서»이고 통신이 느리면 0.4초 안에 아무 신호가 없을 수 있다.
  // 그때 «무시됐다»로 읽고 뒤로를 한 번 더 보내면 한 칸 더 나가 버린다.
  let result = await waitForLeave(win, () => win.history.go(-2), FIRST_LEAVE_WAIT_MS);
  if (result === "unloading") return true;
  if (result === "none") {
    // «두 칸 뒤로»가 무시됐다 = 바닥 아래에 칸이 없다. 가드 칸만 걷는다
    await waitForPop(win, () => win.history.back());
    return false;
  }
  for (let i = 0; i < 4; i += 1) {
    if (win.location.href !== from) return true;
    // 내려왔는데 아직 같은 주소(옛 바닥·옛 가드 칸) — 한 칸 더
    result = await waitForLeave(win, () => win.history.back());
    if (result === "unloading") return true;
    if (result === "none") return false;
  }
  return win.location.href !== from;
}

/**
 * 가드 칸·창 칸이 다 빠져 «바닥 칸»이 맨 위가 될 때까지 기다린다(뒤로 이동을 스스로 하지는 않는다).
 * 왜: 기록 칸이 빠질 때마다(popstate) Next 는 «뒤로 이동»으로 처리하며 그때 진행 중이던 새로 불러오기(router.refresh)·이동을 버린다.
 * 수업 종료 직후처럼 «칸 되돌리기 여러 개 + 새로 불러오기»가 겹치면, 칸이 다 빠진 뒤에 새로 불러와야 한다.
 */
export async function waitUntilLessonGuardBase(win: LessonGuardWindow, guardKey: string, maxWaits = 2): Promise<boolean> {
  for (let i = 0; i < maxWaits; i += 1) {
    if (isLessonGuardBase(win.history.state, guardKey)) return true;
    await waitForPop(win, () => {});
  }
  return isLessonGuardBase(win.history.state, guardKey);
}

export type HomeLessonGuardHandlers = {
  /** «저장하고 나갈까요» — 수업 주소의 확인 창과 같은 문구·모양 */
  confirmLeave: () => Promise<boolean>;
  /** 쓰던 수업 기록 저장(prepareStaffNavigation) */
  save: () => Promise<{ ok: boolean; message?: string }>;
  /** 저장 실패 — 화면에 머무르고 안내한다 */
  onSaveFailed: (message?: string) => void;
  /** 저장은 됐지만 돌아갈 앞 화면이 없다(앱을 이 화면에서 켠 경우) — 가드 칸은 걷혔다. 한 번 더 누르면 나간다고 안내한다 */
  onNoPrevious: () => void;
};

export type HomeLessonGuard = {
  /** 진행 중 수업 칸이 펼쳐졌다 — 가드 칸을 넣는다. afterWindowClose: 방금 창이 닫혔으면 그 창의 칸이 빠진 뒤에 넣는다 */
  enable(options?: { afterWindowClose?: boolean }): void;
  /** 수업 칸이 접혔다·끝났다·화면을 떠난다 — 넣은 가드 칸을 되돌린다(다른 화면으로 떠난 뒤면 건드리지 않는다) */
  disable(): void;
  /** 직접 다른 화면으로 가기 직전 — 가드 칸을 걷고, 걷힐 때까지 기다린다 */
  release(): Promise<void>;
  /** 가드 칸이 기록에 살아 있는가 */
  isLive(): boolean;
};

/** 지금 살아 있는 홈 가드(홈 밖의 부품 — 아래 탭·메뉴 — 이 떠나기 전에 걷을 수 있게) */
let activeHomeGuard: HomeLessonGuard | null = null;

/** 선생님 홈을 떠나는 이동 직전에 부른다 — 홈 가드가 없으면 아무 일도 하지 않는다 */
export function releaseActiveLessonGuard(): Promise<void> {
  return activeHomeGuard ? activeHomeGuard.release() : Promise.resolve();
}

/** 테스트용 */
export function resetLessonGuardForTest() {
  activeHomeGuard = null;
}

/**
 * 선생님 홈(/staff)의 «수업 진행 중 뒤로» 가드. 수업 주소의 가드(SessionInProgressClient)를 본떴다:
 *  바닥 칸에 표시 → 가드 칸 넣기 → 바닥에 닿는 뒤로를 잡아 가드 칸을 되살리고 묻기 → 저장 성공 뒤에만 «두 칸 뒤로».
 * 다른 점: 홈은 수업 칸을 접으면 가드가 필요 없으므로 넣은 칸을 스스로 되돌린다(disable).
 */
export function createHomeLessonGuard(win: LessonGuardWindow, handlers: HomeLessonGuardHandlers): HomeLessonGuard {
  const key = HOME_LESSON_GUARD_KEY;
  /** 가드 칸이 기록에 살아 있는가 */
  let live = false;
  let listening = false;
  /** 켜기·끄기가 바뀔 때마다 올린다 — 미뤄 둔 일(칸 넣기·칸 되돌리기·묻는 중)이 낡았는지 본다 */
  let epoch = 0;
  let wanted = false;
  let asking = false;
  let installedHref = "";
  /** disable·release 가 보낸 «칸 되돌리기»가 아직 닿지 않았다 — 그동안은 가드 칸을 새로 넣지 않는다(L-2) */
  let flying: Promise<unknown> | null = null;
  const flyBack = () => {
    const mine: Promise<unknown> = waitForPop(win, () => win.history.back()).then(() => {
      if (flying === mine) flying = null;
    });
    flying = mine;
    return mine;
  };

  const listen = () => {
    if (listening) return;
    listening = true;
    win.addEventListener("popstate", onPop);
  };
  const unlisten = () => {
    if (!listening) return;
    listening = false;
    win.removeEventListener("popstate", onPop);
  };
  const forget = () => {
    if (activeHomeGuard === guard) activeHomeGuard = null;
  };

  function onPop() {
    if (!live) return;
    // 창 칸이 빠진 것(창만 닫힘)·가드 칸으로 돌아온 것은 «나가기»가 아니다 — 바닥 칸에 닿았을 때만 묻는다
    if (!isLessonGuardBase(win.history.state, key)) return;
    // 먼저 가드 칸을 되살려 화면을 지킨다(밀어서 뒤로 중에도)
    try {
      win.history.pushState({ ...record(win.history.state), [LESSON_GUARD_MARK]: key }, "");
    } catch {
      live = false;
      unlisten();
      forget();
      return;
    }
    // 확인 창이 떠 있는 동안 뒤로를 또 눌러도 다시 묻지 않는다
    if (asking) return;
    asking = true;
    const mine = epoch;
    const stale = () => !live || epoch !== mine;
    void (async () => {
      try {
        if (!(await handlers.confirmLeave())) return;
        if (stale()) return;
        let saved: { ok: boolean; message?: string };
        try {
          saved = await handlers.save();
        } catch {
          saved = { ok: false };
        }
        if (stale()) return;
        if (!saved.ok) {
          handlers.onSaveFailed(saved.message);
          return;
        }
        await waitOverlayEntriesGone(win);
        if (stale()) return;
        live = false;
        unlisten();
        forget();
        // 방금 되살린 가드 칸과 바닥 칸을 건너 앞 화면으로. 앞 화면이 없으면 가드 칸만 걷히고 안내한다
        if (!(await leaveLessonScreen(win))) handlers.onNoPrevious();
      } finally {
        asking = false;
      }
    })();
  }

  /** 칸 넣기. 맨 위가 아직 창 칸이면 넣지 않는다(false) — 그 위에 넣으면 창이 되돌리는 «한 칸»이 가드 칸을 빼 버린다 */
  function install(): boolean {
    try {
      const current = record(win.history.state);
      if (overlayDepthOf(current) > 0) return false;
      // 이미 가드 칸 위면(다른 화면에 갔다가 뒤로 돌아옴) 그 칸을 그대로 쓴다
      if (current[LESSON_GUARD_MARK] !== key) {
        win.history.replaceState({ ...current, [LESSON_GUARD_BASE_MARK]: key }, "");
        win.history.pushState({ ...current, [LESSON_GUARD_BASE_MARK]: key, [LESSON_GUARD_MARK]: key }, "");
      }
      installedHref = win.location.href;
      live = true;
      listen();
      activeHomeGuard = guard;
      return true;
    } catch {
      live = false;
      return false;
    }
  }

  const guard: HomeLessonGuard = {
    enable(options) {
      wanted = true;
      epoch += 1;
      const mine = epoch;
      if (live) {
        // 끄자마자 다시 켜짐(개발 모드 이중 실행 등) — 미뤄 둔 «칸 되돌리기»는 epoch 가 달라 취소됐다. 칸은 그대로 쓴다
        listen();
        return;
      }
      const tryInstall = async (waitFirst: boolean) => {
        // 방금 끈 가드가 보낸 «칸 되돌리기»가 날아가는 중이면 닿은 뒤에(맨 위가 아직 옛 가드 칸이라 «그대로 쓴다»로 오해한다)
        if (flying) await flying;
        if (epoch !== mine || !wanted || live) return;
        // 닫히는 창의 칸이 빠지기를 기다렸다가 넣는다(최대 세 번)
        for (let attempt = 0; attempt < 3; attempt += 1) {
          if (waitFirst || attempt > 0) await waitForPop(win, () => {});
          if (epoch !== mine || !wanted || live) return;
          if (install()) return;
        }
      };
      if (options?.afterWindowClose) void tryInstall(true);
      else if (flying || !install()) void tryInstall(false);
    },
    disable() {
      wanted = false;
      epoch += 1;
      const mine = epoch;
      unlisten();
      if (!live) return;
      // 한 박자 미룬다 — 곧바로 다시 켜지면(개발 모드 이중 실행) 칸을 뺐다 넣지 않게
      win.setTimeout(() => {
        if (epoch !== mine || !live) return;
        live = false;
        forget();
        // 그사이 다른 화면으로 떠났으면 맨 위는 우리 칸이 아니다 — 남의 기록을 되돌리지 않는다
        if (win.location.href !== installedHref) return;
        void flyBack();
      }, 0);
    },
    async release() {
      wanted = false;
      epoch += 1;
      unlisten();
      if (!live) return;
      live = false;
      forget();
      if (win.location.href !== installedHref) return;
      await flyBack();
    },
    isLive: () => live,
  };
  return guard;
}
