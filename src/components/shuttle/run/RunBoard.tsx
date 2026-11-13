"use client";

import { useEffect, useLayoutEffect, useRef, type PointerEvent, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { tmapNavigationCoordinateUrl } from "@/lib/maps/coordinate-links";
import styles from "../DriverWorkspace.module.css";
import { groupRunBlocks, type RunBlock } from "@/lib/shuttle/runBlocks";
import type { UnifiedRider, UnifiedRow } from "@/lib/shuttle/unifiedDriverRunLogic";

// 운행표 카드 목록 부품(레고 블록 하나) — 정류장 1곳 = 카드 1장.
// ─────────────────────────────────────────────────────────────────────────────
// 왜 따로 떼는가?
//   기사님 화면과 관리자 운행표(다음 단계)가 **같은 카드 모양·같은 순서**를 그려야 한다.
//   카드 틀(번호·정류장 이름·정차 시각·묶음 라벨·순서 손잡이)은 여기 한 곳에 두고,
//   탑승 체크 버튼처럼 화면마다 다른 부분은 바깥에서 끼워 넣는다(renderRider · renderStopMeta).
//
// ⚠️ 1단계 = 기사님 화면 리팩터. 기사님 화면(UnifiedDriverClient)에서 옮겨 온 마크업은 글자 그대로다.
//    정렬·편집 상태(순서 덮어쓰기·시각 덮어쓰기·끌기)는 바깥(UnifiedDriverClient)이 들고, 여기는 그리기만 한다.
//
// 2026-11-09 원장 점검(2차):
//   · 묶음 머리 — 같은 수업·같은 방향 카드를 블록으로 묶고 «16:00~17:00 수업 · 등원» 머리를 단다(기사님·관리자 공통).
//     카드 순서는 그대로다(runBlocks.groupRunBlocks 가 이어지는 같은 묶음만 자른다).
//   · 관리자 편집 카드 = 한 줄(손잡이·순번·정류장·시각·학생·정류장 수정·▲▼) — PC 공간 낭비 줄이기.
//   · 관리자 끌기 피드백 — 끄는 카드가 손가락/마우스를 따라 떠다니고(그림자), 제자리는 흐린 자리표시,
//     놓일 자리에 삽입선, 놓으면 짧게 미끄러지는 이동 애니메이션. 기사님 끌기(카드 전체)는 예전 그대로.
//   · (3차) 삽입선 → «실시간 재배치»: 끄는 카드가 따라오고 다른 카드들이 밀려 빈 자리가 생긴다. 기사님 카드 끌기도 같은 동작.
// 2026-11-13 UI 통일(원장 «아이콘 빼고 글자로»): 묶음 머리의 연필 아이콘 버튼 → 글자 «수정» 작은 버튼, 머리의 등원/하원·지도 장식 아이콘 제거.
//   남긴 기호: 끌기 손잡이(drag_indicator — 글자를 둘 자리가 없는 조작)·▲▼·길안내 화살표(near_me — 방향을 전하는 기호).
// 2026-11-10 원장 점검: «수정 버튼이 섹션마다 있는 게 자연스러움, 연필 모양 아이콘 버튼만 작게».
//   · (관리자) 화면 위 [수정] 하나 → 묶음 머리 오른쪽 작은 연필. 누른 묶음만 편집 모드(editingGroupKey),
//     그 머리 줄에 [취소][저장](renderEditActions)·아래 한 줄에 적용 범위(renderEditBar). 다른 묶음은 보기 그대로.
//   · 기사님 화면은 editingGroupKey 를 안 넘긴다 → 예전처럼 editing 하나로 전체 편집(변경 없음).

export type RunBoardMode = "driver" | "admin";

/** 밀림·안착 애니메이션 시간(ms)과 곡선 — 짧고 끝이 부드럽게 멈추는 곡선. */
const SHIFT_MS = 180;
const EASE = "cubic-bezier(.2,.8,.2,1)";

/**
 * 끄는 동안의 기록(화면 다시 그리기 없이 ref 로만 든다 — 손가락 움직임마다 React 를 돌리지 않아 부드럽다).
 * tops/heights = 끌기 시작 때 잰 같은 묶음 카드들의 문서 좌표 위치·높이. target = 지금 놓일 자리(묶음 안 순번).
 */
type DragSession = {
  /** 이 끌기를 시작한 포인터(손가락 하나·마우스) — 다른 손가락의 움직임·떼기는 무시한다. */
  pointerId: number;
  cards: HTMLElement[]; tops: number[]; heights: number[];
  from: number; target: number; startDocY: number; pointerY: number;
  /** 다른 카드가 밀리는 거리 = 끄는 카드 높이 + 카드 사이 틈. */
  step: number;
  /** 놓은 뒤 안착 애니메이션 중(새 끌기·움직임 무시). */
  settling: boolean;
  /** 끌기 시작 때 창에 건 Esc·스크롤 감시를 떼는 함수(함수는 렌더마다 새로 만들어지므로 건 그 함수를 기억해 둔다). */
  detach: () => void;
};

/**
 * 눌렀지만 아직 들어 올리지 않은 상태 — LIFT_PX 이상 움직여야 끌기로 본다(가볍게 탭만 하면 카드가 떴다 내려앉는 깜빡임이 없다).
 */
type PendingDrag = { pointerId: number; row: UnifiedRow; cardEl: HTMLElement; startClientY: number; startScrollY: number };
const LIFT_PX = 5;

// 움직임 줄이기 설정을 켠 사람에게는 밀림·안착 애니메이션 없이 바로 자리만 바뀐다.
function reducedMotion() {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export default function RunBoard({
  rows, mode, editing, dragKey, onDragKeyChange, onDropOn, onMove, displayTime, onTimeChange, upcoming, renderStopMeta, renderRider, focusKey,
  selectedGroupKey, onSelectBlock, editingGroupKey, onEditBlock, renderEditActions, renderEditBar,
}: {
  /** 이미 화면 순서로 정렬된 카드 목록(정렬은 바깥이 한다 — 편집 중 덮어쓰기 포함). */
  rows: UnifiedRow[];
  /** driver = 기사님(길안내·다가오는 정차 강조). admin = 관리자 운행표(다음 단계에서 편집 손잡이를 끼운다). */
  mode: RunBoardMode;
  /** 순서·시각 편집 중인가(정규 카드에만 손잡이가 붙는다). */
  editing: boolean;
  /** 끌고 있는 카드 키(없으면 null). */
  dragKey: string | null;
  onDragKeyChange: (key: string | null) => void;
  /** 끌던 카드를 이 카드 자리로 옮긴다. */
  onDropOn: (target: UnifiedRow) => void;
  /** ▲(-1)/▼(1) 한 칸 옮기기. */
  onMove: (row: UnifiedRow, dir: -1 | 1) => void;
  /** 화면에 보일 정차 시각(편집 중 덮어쓰기 반영). */
  displayTime: (row: UnifiedRow) => string | null;
  onTimeChange: (row: UnifiedRow, value: string) => void;
  /** 다가오는 정차(기사님 휴대폰 시계 기준). 없으면 강조하지 않는다. */
  upcoming?: { nextKey: string | null; remainingMinutes: number | null };
  /** 카드 머리 보조 정보 줄에 끼워 넣을 것(기사님 = 체크 개수·결석 N명). 묶음 라벨 뒤, 무료 거점 앞에 놓인다. */
  renderStopMeta?: (row: UnifiedRow) => ReactNode;
  /** 학생 한 명 줄(기사님 = 탑승/미탑승 버튼). 반환 요소에 key 를 달아야 한다. */
  renderRider: (row: UnifiedRow, rider: UnifiedRider) => ReactNode;
  /**
   * 바로 보여 줄 카드(알림 «노선 확인하기» → 바뀐 등원/하원 묶음). 그 카드에만 id="run-focus" 를 달아
   * 바깥 화면이 그 자리로 스크롤한다. 없으면 아무것도 달지 않는다(평소 화면 HTML 그대로).
   */
  focusKey?: string | null;
  /** (관리자) 지도에 보이는 묶음 — 그 블록에 강조 테두리. */
  selectedGroupKey?: string | null;
  /** (관리자) 블록 머리를 누르면 그 묶음을 지도에 띄운다. 없으면 머리는 글자만(기사님). */
  onSelectBlock?: (groupKey: string) => void;
  /**
   * (관리자) 지금 편집 중인 묶음 하나 — 이 묶음 카드만 편집 카드(손잡이·시각 칸)로 그린다.
   * 안 넘기면(undefined, 기사님) editing 하나로 모든 카드가 편집 카드다(예전 그대로).
   */
  editingGroupKey?: string | null;
  /** (관리자) 묶음 머리 오른쪽 연필을 누르면 그 묶음을 편집한다. 없으면 연필을 안 그린다(기사님). */
  onEditBlock?: (groupKey: string) => void;
  /** (관리자) 편집 중인 묶음 머리 줄 오른쪽에 끼울 것([취소][저장]) — 연필 자리에 놓인다. */
  renderEditActions?: (block: RunBlock) => ReactNode;
  /** (관리자) 편집 중인 묶음 머리 바로 아래 한 줄(끌기 안내·적용 범위). */
  renderEditBar?: (block: RunBlock) => ReactNode;
}) {
  // 이 카드(묶음)가 편집 중인가 — 관리자는 고른 묶음 하나만, 기사님은 editing 하나로 전체.
  function inEditGroup(groupKey: string) {
    return editing && (editingGroupKey === undefined || editingGroupKey === groupKey);
  }
  // ── 끌기 = «실시간 재배치(live reorder)» (관리자 손잡이 ⠿ · 기사님 카드 전체 공통) ──
  // 2026-11-09 원장 점검(3차): «줄 표시보다는 위치할 자리로 옮겨가고 다른 카드들이 실제로 밀리는 동작».
  //   · 끄는 카드 자체가 손가락/마우스를 따라 떠서 움직인다(그림자·살짝 확대).
  //   · 놓일 자리가 바뀌는 순간 같은 묶음의 다른 카드들이 transform 애니메이션(180ms)으로 위·아래로 밀려 빈 자리가 생긴다.
  //   · 놓으면 끄는 카드가 그 빈 자리로 미끄러져 안착하고, 그때 «한 번만» 데이터 순서를 바꾼다(끄는 중엔 화면 위치만 바꾼다).
  // 왜 직접 계산하나? 휴대폰에서 손가락으로 끌면 브라우저가 «누른 요소»에 포인터를 붙잡아 두어
  // 다른 카드의 onPointerEnter 가 오지 않는다. 그래서 끌기 시작할 때 같은 묶음 카드들의 위치를 한 번 재 두고(문서 좌표),
  // 손가락 위치와 비교해 놓일 자리를 계산한다. 외부 라이브러리 없이 transform 만 쓴다(레이아웃은 그대로 → 흔들림 없음).
  const listRef = useRef<HTMLDivElement>(null);
  // 타이머·창 이벤트에서 최신 rows·onDropOn 을 쓰도록 ref 로 들고 있는다(옛 클로저 방지).
  const latest = useRef({ rows, onDropOn, onDragKeyChange });
  latest.current = { rows, onDropOn, onDragKeyChange };
  const session = useRef<DragSession | null>(null);
  const pending = useRef<PendingDrag | null>(null);
  const scrollFrame = useRef<number | null>(null);
  // 안착 애니메이션 뒤 순서를 바꾸는 타이머 — 화면을 떠나면 지운다.
  const settleTimer = useRef<number | null>(null);

  // 끌기 범위 카드 요소들 — 화면 순서대로. «누른 카드가 든 블록(section)» 안의 같은 묶음 카드만.
  // 왜 블록으로 좁히나? 같은 묶음이 «(이어서)» 블록으로 끊겨 사이에 다른 묶음이 끼면, 목록 전체에서 고를 때
  // 블록 간 거리(수백 px)를 한 칸으로 계산해 끄는 중 카드가 크게 밀려 겹쳤다(리뷰 지적).
  function groupCards(cardEl: HTMLElement, groupKey: string): HTMLElement[] {
    const scope = cardEl.closest("section") ?? listRef.current;
    const all = scope?.querySelectorAll<HTMLElement>("[data-run-group]") ?? [];
    return [...all].filter((el) => el.dataset.runGroup === groupKey);
  }
  // 이 포인터 이벤트가 지금 끌기(또는 들어 올리기 대기)를 시작한 포인터인가 — 두 번째 손가락은 무시.
  function ownPointer(event: PointerEvent<HTMLElement>) {
    const id = session.current?.pointerId ?? pending.current?.pointerId;
    return id != null && id === event.pointerId;
  }

  // 누르기 — 아직 들어 올리지 않고 «대기»만 한다(LIFT_PX 움직이면 liftDrag).
  function pressDrag(event: PointerEvent<HTMLElement>, row: UnifiedRow, cardEl: HTMLElement | null) {
    // 마우스 왼쪽 버튼(터치·펜은 0)만 끌기 — 오른쪽·가운데 버튼은 무시. 끌기·안착 중이면 새 누르기를 받지 않는다.
    if (event.button !== 0 || session.current || pending.current || !cardEl) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    pending.current = { pointerId: event.pointerId, row, cardEl, startClientY: event.clientY, startScrollY: window.scrollY };
  }

  // 들어 올리기 — 같은 묶음 카드 위치를 재 두고 끌기 시작.
  function liftDrag(p: PendingDrag, pointerY: number) {
    pending.current = null;
    const { row, cardEl } = p;
    const cards = groupCards(cardEl, row.groupKey);
    const from = cards.indexOf(cardEl);
    if (from < 0) return;
    // 위치는 «문서 좌표»(화면 좌표 + 스크롤)로 재 둔다 — 자동 스크롤이 돌아도 계산이 그대로 맞는다.
    const sy = window.scrollY;
    const rects = cards.map((el) => el.getBoundingClientRect());
    const tops = rects.map((r) => r.top + sy);
    const heights = rects.map((r) => r.height);
    // 카드 사이 틈(space-y) — 옆 카드와의 실제 간격을 잰다. 카드가 하나뿐이면 8px.
    const spacing = from + 1 < cards.length ? tops[from + 1] - (tops[from] + heights[from]) : from > 0 ? tops[from] - (tops[from - 1] + heights[from - 1]) : 8;
    const motion = reducedMotion() ? "none" : `transform ${SHIFT_MS}ms ${EASE}`;
    cards.forEach((el, i) => {
      el.style.transition = i === from ? "none" : motion;
      el.style.willChange = "transform";
    });
    // 끄는 카드를 다른 카드들 위로 띄운다(그림자·테두리는 dragKey 클래스로).
    cardEl.style.position = "relative";
    cardEl.style.zIndex = "30";
    // 창 감시 — Esc 는 취소, 스크롤(휠·자동 스크롤)은 끄는 카드 위치 다시 맞추기.
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") finishDrag(false); };
    const onScroll = () => updateDrag();
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, { passive: true });
    const detach = () => { window.removeEventListener("keydown", onKey); window.removeEventListener("scroll", onScroll); };
    // 시작점 = 처음 누른 자리(대기 중 움직인 5px 만큼 카드가 바로 따라붙는다).
    session.current = { pointerId: p.pointerId, cards, tops, heights, from, target: from, startDocY: p.startClientY + p.startScrollY, pointerY, step: heights[from] + spacing, settling: false, detach };
    latest.current.onDragKeyChange(row.key);
    updateDrag();
  }

  // 손가락 위치로 끄는 카드를 옮기고, 놓일 자리가 바뀌면 다른 카드들을 밀어 빈 자리를 만든다.
  function updateDrag() {
    const s = session.current;
    if (!s || s.settling) return;
    const { cards, tops, heights, from } = s;
    const h = heights[from];
    // 묶음 맨 위~맨 아래 안에서만 움직인다(다른 묶음으로는 못 넘어간다 — 기존 규칙).
    const minTop = tops[0];
    const maxTop = tops[tops.length - 1] + heights[heights.length - 1] - h;
    const top = Math.min(maxTop, Math.max(minTop, tops[from] + (s.pointerY + window.scrollY - s.startDocY)));
    cards[from].style.transform = `translateY(${top - tops[from]}px) scale(1.02)`;
    // 놓일 자리 = 끄는 방향 쪽 «가장자리»가 옆 카드 가운데를 넘을 때마다 한 칸씩
    // (위로 끌면 끄는 카드 윗변, 아래로 끌면 아랫변). 가운데끼리 비교하면 묶음 맨 위·맨 끝까지 끌어도 한 칸 모자랐다.
    // 비교 기준은 끌기 시작 때 잰 위치라, 다른 카드가 밀려도 판정이 흔들리지 않는다.
    let target = from;
    for (let i = from - 1; i >= 0 && top < tops[i] + heights[i] / 2; i--) target = i;
    for (let i = from + 1; i < cards.length && top + h > tops[i] + heights[i] / 2; i++) target = i;
    if (target === s.target) return;
    s.target = target;
    // 끄는 카드가 지나간 카드들만 한 칸(끄는 카드 높이 + 틈)씩 밀린다. 나머지는 제자리로 돌아온다.
    cards.forEach((el, i) => {
      if (i === from) return;
      const shift = from < target && i > from && i <= target ? -s.step : target < from && i >= target && i < from ? s.step : 0;
      el.style.transform = shift ? `translateY(${shift}px)` : "";
    });
  }

  // 가장자리 자동 스크롤 — 손가락이 멈춰 있어도 계속 내려가게 requestAnimationFrame 으로 돈다.
  function stopAutoScroll() {
    if (scrollFrame.current != null) cancelAnimationFrame(scrollFrame.current);
    scrollFrame.current = null;
  }
  function autoScrollStep() {
    const s = session.current;
    if (!s || s.settling) { scrollFrame.current = null; return; }
    // 위·아래 70px 안쪽이면 가장자리에 가까울수록 빠르게(최대 프레임당 16px).
    const edge = 70;
    const y = s.pointerY;
    const dy = y < edge ? -Math.ceil(((edge - y) / edge) * 16) : y > window.innerHeight - edge ? Math.ceil(((y - (window.innerHeight - edge)) / edge) * 16) : 0;
    if (dy === 0) { scrollFrame.current = null; return; }
    window.scrollBy(0, dy);
    updateDrag();
    scrollFrame.current = requestAnimationFrame(autoScrollStep);
  }

  function moveDrag(event: PointerEvent<HTMLElement>) {
    if (!ownPointer(event)) return;
    // 아직 대기 중이면 LIFT_PX 이상 움직였을 때 들어 올린다.
    const p = pending.current;
    if (p) {
      if (Math.abs(event.clientY - p.startClientY) < LIFT_PX) return;
      liftDrag(p, event.clientY);
    }
    const s = session.current;
    if (!s || s.settling) return;
    s.pointerY = event.clientY;
    updateDrag();
    // 가장자리에 들어오면 루프 시작(이미 돌고 있으면 그대로).
    if (scrollFrame.current == null) autoScrollStep();
  }
  // 손가락 떼기(commit=true) · 취소(pointercancel·포인터 붙잡기 풀림 = false) — 그 끌기를 시작한 포인터만.
  function endPointer(event: PointerEvent<HTMLElement>, commit: boolean) {
    if (!ownPointer(event)) return;
    // 들어 올리기 전에 뗐으면 = 그냥 탭 — 아무것도 바뀌지 않는다.
    if (pending.current) { pending.current = null; return; }
    finishDrag(commit);
  }

  // 놓기(commit=true) / 취소(false) — 끄는 카드를 빈 자리(취소면 원래 자리)로 미끄러뜨린 뒤 데이터 순서를 한 번 바꾼다.
  function finishDrag(commit: boolean) {
    const s = session.current;
    if (!s || s.settling) return;
    s.settling = true;
    stopAutoScroll();
    s.detach();
    const { cards, tops, heights, from } = s;
    const target = commit ? s.target : from;
    // 안착 위치 — 아래로 옮기면 «목표 카드 아래끝 - 내 높이», 위로 옮기면 «목표 카드 위끝».
    const finalTop = target > from ? tops[target] + heights[target] - heights[from] : tops[target];
    const reduce = reducedMotion();
    cards[from].style.transition = reduce ? "none" : `transform ${SHIFT_MS}ms ${EASE}`;
    cards[from].style.transform = finalTop === tops[from] ? "" : `translateY(${finalTop - tops[from]}px)`;
    // 취소(또는 제자리)면 밀렸던 카드들도 제자리로.
    if (target === from) cards.forEach((el, i) => { if (i !== from) el.style.transform = ""; });
    const targetKey = cards[target]?.dataset.runKey;
    settleTimer.current = window.setTimeout(() => {
      settleTimer.current = null;
      // flushSync = 순서 바꾸기를 «지금 이 순간» 화면에 반영 → 바로 뒤에 transform 을 지워도 깜빡이지 않는다
      // (새 순서의 제자리 = 지금 카드들이 transform 으로 가 있는 자리).
      flushSync(() => {
        const targetRow = target !== from ? latest.current.rows.find((r) => r.key === targetKey) : undefined;
        if (targetRow) latest.current.onDropOn(targetRow);
        latest.current.onDragKeyChange(null);
      });
      for (const el of cards) {
        el.style.transition = "";
        el.style.transform = "";
        el.style.willChange = "";
        el.style.zIndex = "";
        el.style.position = "";
      }
      session.current = null;
    }, reduce ? 0 : SHIFT_MS + 10);
  }
  // 화면을 떠나면(언마운트) 돌던 스크롤·키 감시·안착 타이머를 멈추고, 바깥의 «끄는 중» 표시도 지운다
  // (안착 타이머가 언마운트 뒤에 순서를 바꾸지 않게).
  useEffect(() => () => {
    stopAutoScroll();
    if (settleTimer.current != null) window.clearTimeout(settleTimer.current);
    settleTimer.current = null;
    pending.current = null;
    if (session.current) {
      session.current.detach();
      session.current = null;
      latest.current.onDragKeyChange(null);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 기사님 카드 끌기 시작 — 정규 카드·편집 중에만. 버튼(탑승 체크 포함)·입력칸·링크를 누른 건 끌기가 아니다.
  function startCardDrag(event: PointerEvent<HTMLLIElement>, row: UnifiedRow) {
    if (!inEditGroup(row.groupKey) || row.kind !== "REGULAR" || row.isTerminal) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest("button,input,a")) return;
    pressDrag(event, row, event.currentTarget);
  }
  // 관리자 손잡이(⠿) 끌기 시작 — 손잡이가 든 카드 줄(li)이 통째로 움직인다.
  function startHandleDrag(event: PointerEvent<HTMLButtonElement>, row: UnifiedRow) {
    pressDrag(event, row, event.currentTarget.closest("li"));
  }

  // ── ▲▼ 의 «미끄러지는» 이동 애니메이션(FLIP: 옮기기 전 위치를 기억 → 새 위치에서 거꾸로 출발해 제자리로) ──
  const flipFrom = useRef<Map<string, number> | null>(null);
  function rememberPositions() {
    const map = new Map<string, number>();
    for (const el of listRef.current?.querySelectorAll<HTMLElement>("[data-run-key]") ?? []) map.set(el.dataset.runKey!, el.getBoundingClientRect().top);
    flipFrom.current = map;
    // 안전장치 — 바깥에서 순서가 안 바뀌어 다시 그리기가 없으면 한 프레임 뒤 기억값을 버린다.
    requestAnimationFrame(() => { if (flipFrom.current === map) flipFrom.current = null; });
  }
  useLayoutEffect(() => {
    const before = flipFrom.current;
    if (!before) return;
    flipFrom.current = null;
    // 움직임 줄이기 설정을 켠 사람에게는 애니메이션 없이 바로 옮긴다.
    if (reducedMotion()) return;
    for (const el of listRef.current?.querySelectorAll<HTMLElement>("[data-run-key]") ?? []) {
      const old = before.get(el.dataset.runKey!);
      if (old == null) continue;
      const dy = old - el.getBoundingClientRect().top;
      if (Math.abs(dy) < 1) continue;
      el.animate?.([{ transform: `translateY(${dy}px)` }, { transform: "translateY(0)" }], { duration: 220, easing: EASE });
    }
  }, [rows]);
  // ▲▼ 도 같은 애니메이션으로 옮긴다. 맨 위에서 ▲ 처럼 못 옮길 땐 위치를 기억하지 않는다
  // (기억값이 남으면 다음에 시각만 바꿔도 엉뚱한 애니메이션이 돈다).
  function moveWithAnimation(row: UnifiedRow, dir: -1 | 1) {
    const same = rows.filter((r) => r.groupKey === row.groupKey && !r.isTerminal);
    if (same[same.findIndex((r) => r.key === row.key) + dir]) rememberPositions();
    onMove(row, dir);
  }

  // 안내 줄(차고지 출발 등)을 뺀 정차 번호(1, 2, 3 …). 묶음이 나뉘어도 처음부터 이어서 센다(기사님 화면 그대로).
  let seq = 0;
  const blocks = groupRunBlocks(rows);

  function renderRow(row: UnifiedRow) {
    // 차고지 출발·학원 도착 같은 안내 줄 — 얇은 회색 한 줄(탑승 체크 없음).
    if (row.isTerminal) {
      return (
        <li key={row.key} className="flex items-center gap-2 rounded-xl bg-[var(--color-academy-soft)] px-4 py-2.5 text-[15px] font-medium text-[var(--color-academy-ink)]">
          <span className="shrink-0 text-[15px] font-semibold text-[var(--color-academy-muted)]">{row.time}</span>
          <span className="min-w-0 flex-1">{row.label}</span>
          {row.subLabel && <span className="shrink-0 text-sm font-normal text-[var(--color-academy-faint)]">{row.subLabel}</span>}
        </li>
      );
    }
    seq += 1;
    const isPickup = row.direction === "PICKUP";
    // 길안내(T맵)는 운전하는 기사님 화면에만 둔다.
    const url = mode === "driver" ? tmapNavigationCoordinateUrl({ latitude: row.lat, longitude: row.lng, name: row.label }) : null;
    const editable = inEditGroup(row.groupKey) && row.kind === "REGULAR";
    const isUpcoming = mode === "driver" && !editing && upcoming != null && upcoming.nextKey === row.key;
    // 관리자 편집 카드 = 한 줄(손잡이 · 순번 · 정류장 · 시각 · 학생들 · 정류장 수정 · ▲▼). 좁은 화면에서는 줄바꿈된다.
    if (mode === "admin" && editable) {
      // 끄는 카드 = 떠 있는 모습(굵은 테두리·큰 그림자·불투명 바탕). 다른 카드들은 그 아래로 밀린다.
      const dragging = dragKey === row.key;
      return (
        <li key={row.key} data-run-key={row.key} data-run-group={row.groupKey} data-dragging={dragging || undefined}
          className={`relative flex flex-wrap items-center gap-x-1.5 gap-y-1 rounded-xl border px-2 py-1.5 lg:flex-nowrap ${dragging ? "border-[var(--color-academy-info)] bg-[var(--color-academy-surface)] shadow-2xl ring-2 ring-[var(--color-academy-info)]" : "border-[var(--color-academy-info)] bg-[var(--color-academy-info-soft)]"}`}>
          {/* 손잡이는 마우스·손가락 전용 — 키보드 탭 순서에서 빼고(▲▼ 가 키보드 대안), 이름표로 안내한다. */}
          <button type="button" tabIndex={-1} aria-label={`${row.label} 끌어서 순서 옮기기 · ▲▼ 버튼으로도 옮길 수 있어요`} title="끌어서 순서 옮기기 · ▲▼ 버튼으로도 옮길 수 있어요"
            onPointerDown={(event) => startHandleDrag(event, row)}
            onPointerMove={moveDrag}
            onPointerUp={(event) => endPointer(event, true)}
            // 끌기 취소(전화 수신·시스템 제스처 등) — 순서는 그대로, 카드들이 제자리로 돌아간다.
            onPointerCancel={(event) => endPointer(event, false)}
            // 포인터 붙잡기가 풀려도(창 전환·요소 교체 등) 끌기가 허공에 남지 않게 취소한다. 정상 떼기 뒤에 오는 것은 이미 안착 중이라 무시된다.
            onLostPointerCapture={(event) => endPointer(event, false)}
            // ⚠️ touch-none 클래스만으로는 안 된다 — academy-theme.css 의 `.academy-app :is(button, a) { touch-action: manipulation }`
            //    (레이어 밖 규칙)이 Tailwind 유틸리티를 이겨, 휴대폰에서 손가락을 움직이면 브라우저가 끌기를 취소(pointercancel)했다.
            //    인라인 style 은 그 규칙보다 우선한다.
            style={{ touchAction: "none" }}
            className="grid h-11 w-11 shrink-0 touch-none cursor-grab place-items-center rounded-lg border border-[var(--color-academy-line-input)] bg-white text-[var(--color-academy-muted)] active:cursor-grabbing">
            <span aria-hidden="true" className="material-symbols-outlined text-[24px]">drag_indicator</span>
          </button>
          <span className={`${styles.sequence} shrink-0`}>{seq}</span>
          <span className="min-w-0 flex-1 text-[15px] font-semibold leading-tight text-[var(--color-academy-ink)] lg:w-36 lg:flex-none">{row.label}</span>
          {/* 시각 칸 — «오후 03:40» 이 잘리지 않는 폭(글자 16px·숫자 고정폭). 24시간/12시간 표기는 기기 설정을 따른다. */}
          <input
            type="time"
            value={displayTime(row) ?? ""}
            onChange={(event) => onTimeChange(row, event.target.value)}
            className="h-11 w-[8.75rem] shrink-0 rounded-lg border-2 border-[var(--color-academy-line-input)] bg-white px-1.5 text-[15px] font-semibold tabular-nums text-[var(--color-academy-ink)]"
            aria-label={`${row.label} 정차 시간`}
          />
          {/* 학생 이름들 — 한 줄에 칩으로(넘치면 칸 안에서 줄바꿈) */}
          <div className="flex min-w-0 basis-full flex-wrap items-center gap-1 lg:basis-auto lg:flex-1">
            {row.riders.map((rider) => renderRider(row, rider))}
          </div>
          <span className="ml-auto flex shrink-0 items-center gap-1">
            {renderStopMeta?.(row)}
            <button type="button" onClick={() => moveWithAnimation(row, -1)} aria-label={`${row.label} 순서 위로`} className="h-11 w-11 rounded-lg border border-[var(--color-academy-line-input)] bg-white text-[15px] font-medium text-[var(--color-academy-muted)]">▲</button>
            <button type="button" onClick={() => moveWithAnimation(row, 1)} aria-label={`${row.label} 순서 아래로`} className="h-11 w-11 rounded-lg border border-[var(--color-academy-line-input)] bg-white text-[15px] font-medium text-[var(--color-academy-muted)]">▼</button>
          </span>
        </li>
      );
    }
    return (
      <li
        key={row.key}
        // 기사님 카드 끌기도 관리자와 같은 «실시간 재배치» — 카드 전체를 잡아 끈다(버튼·입력칸·링크 위는 제외).
        // 예전 HTML 끌어놓기(draggable)·onPointerEnter 즉시 교체는 뺐다(손가락에선 pointerenter 가 안 와 동작이 갈렸다).
        // draggable=false 는 브라우저 기본 끌기(유령 이미지)가 포인터 끌기를 가로채지 않게 남겨 둔다.
        draggable={false}
        data-run-key={editable ? row.key : undefined}
        data-run-group={editable ? row.groupKey : undefined}
        data-dragging={dragKey === row.key || undefined}
        onPointerDown={(event) => startCardDrag(event, row)}
        onPointerMove={moveDrag}
        onPointerUp={(event) => endPointer(event, true)}
        onPointerCancel={(event) => endPointer(event, false)}
        onLostPointerCapture={(event) => endPointer(event, false)}
        // ⚠️ 끌기 중 손가락 움직임을 화면 스크롤이 가로채지 않게 — 클래스(touch-none)만 믿지 않고 인라인으로도 건다.
        style={editable ? { touchAction: "none" } : undefined}
        id={focusKey && focusKey === row.key ? "run-focus" : undefined}
        data-upcoming={isUpcoming || undefined}
        aria-current={isUpcoming ? "step" : undefined}
        className={`${styles.stop} ${isUpcoming ? styles.upcoming : ""} academy-driver-stop rounded-2xl border p-3 ${editable ? "touch-none cursor-grab active:cursor-grabbing" : ""} ${dragKey === row.key ? "shadow-2xl ring-2 ring-[var(--color-academy-info)]" : ""} ${
        inEditGroup(row.groupKey) ? "border-[var(--color-academy-info)] bg-[var(--color-academy-info-soft)]" : row.warn ? "border-[var(--color-academy-warning)] bg-[var(--color-academy-warning-soft)]" : row.isHub ? "border-[var(--color-academy-success)] bg-[var(--color-academy-success-soft)]" : "border-[var(--color-academy-line)] bg-white"
      }`}>
        <div className={styles.stopHeading}>
          {editable ? (
            <div className="flex shrink-0 flex-col gap-0.5" aria-label="순서 변경">
              <button type="button" onClick={() => onMove(row, -1)}
                aria-label={`${row.label} 순서 위로`} className="h-11 w-11 rounded-lg border border-[var(--color-academy-line-input)] text-base font-medium text-[var(--color-academy-muted)]">▲</button>
              <button type="button" onClick={() => onMove(row, 1)}
                aria-label={`${row.label} 순서 아래로`} className="h-11 w-11 rounded-lg border border-[var(--color-academy-line-input)] text-base font-medium text-[var(--color-academy-muted)]">▼</button>
            </div>
          ) : (
            <span className={styles.sequence}>
              {seq}
            </span>
          )}
          <div className={`${styles.stopName} ${row.label.length > 18 ? styles.longStopName : ""} ${/\s/.test(row.label) ? styles.spacedStopName : ""}`}><span>{row.label}</span></div>
          {editable ? (
            <input
              type="time"
              value={displayTime(row) ?? ""}
              onChange={(event) => onTimeChange(row, event.target.value)}
              className="col-span-3 mt-2 h-12 w-full min-w-0 rounded-xl border-2 border-[var(--color-academy-line-input)] bg-white px-3 text-[22px] font-semibold text-[var(--color-academy-ink)]"
              aria-label={`${row.label} 정차 시간`}
            />
          ) : (
            <div className={styles.timeNavigation}>
              <span className={displayTime(row) ? styles.time : styles.unknownTime}>{displayTime(row) ?? "시간 미정"}</span>
              {url && (
                <a href={url} className={styles.navigation}>
                  <span aria-hidden="true" className="material-symbols-outlined text-[17px]">near_me</span> 길안내
                </a>
              )}
            </div>
          )}
          <div className={styles.stopMeta}>
            <span className="font-semibold text-[var(--color-academy-ink)]">{row.kind === "SEASONAL" ? "특강" : "정규"} · {isPickup ? "등원" : "하원"}</span>
            {row.groupLabel && <span>{row.groupLabel}</span>}
            {row.subLabel && row.subLabel !== row.groupLabel && <span>{row.subLabel}</span>}
            {renderStopMeta?.(row)}
            {row.isHub && <span className="font-semibold text-[var(--color-academy-success)]">무료 거점</span>}
            {row.pending && <span className="font-semibold text-[var(--color-academy-warning)]">순서 확인 필요</span>}
            {row.warn && <span className="font-semibold text-[var(--color-academy-warning)]">노선 밖 승객 · 정차 확인 필요</span>}
            {isUpcoming && upcoming && <span className={styles.upcomingBadge}>{upcoming.remainingMinutes != null && upcoming.remainingMinutes <= 5 ? upcoming.remainingMinutes === 0 ? "곧 도착 · 예정 시각" : `곧 도착 · ${upcoming.remainingMinutes}분 후` : `다음 정류장 · ${upcoming.remainingMinutes}분 후`}</span>}
          </div>
        </div>

        {row.isHub && row.riders.length === 0 && <p className="mt-1.5 text-[15px] font-semibold text-[var(--color-academy-success)]">무료 거점(워크인, 정원 별도)</p>}

        {row.riders.length > 0 && (
          <div className={`${styles.riders} space-y-1`}>
            {row.riders.map((rider) => renderRider(row, rider))}
          </div>
        )}
      </li>
    );
  }

  // 블록 머리 — «16:00~17:00 수업 · 등원» + 정류장·학생 수·시각 범위.
  // 색이 아니라 글자로 방향을 구분한다(색 규칙 · 2026-11-13 장식 아이콘 제거). 관리자는 머리를 눌러 그 묶음을 지도에 띄운다.
  function renderBlockHead(block: RunBlock) {
    const stopsInBlock = block.rows.filter((r) => !r.isTerminal);
    const riderCount = new Set(stopsInBlock.flatMap((r) => r.riders.map((x) => x.key))).size;
    const times = stopsInBlock.map((r) => displayTime(r)).filter((t): t is string => Boolean(t));
    const range = times.length > 0 ? (times[0] === times[times.length - 1] ? times[0] : `${times[0]}~${times[times.length - 1]}`) : null;
    const selected = selectedGroupKey != null && selectedGroupKey === block.groupKey;
    const content = (
      <>
        <span className="text-base font-bold text-[var(--color-academy-ink)]">{block.label}{block.continued && <span className="ml-1 text-sm font-normal text-[var(--color-academy-muted)]">(이어서)</span>}</span>
        <span className="text-sm text-[var(--color-academy-muted)]">
          정류장 {stopsInBlock.length}곳 · 학생 {riderCount}명{range ? ` · ${range}` : ""}
        </span>
        {onSelectBlock && <span className={`ml-auto hidden items-center gap-0.5 text-sm font-medium lg:inline-flex ${selected ? "text-[var(--color-academy-info)]" : "text-[var(--color-academy-muted)]"}`}>
          {selected ? "지도에 표시 중" : "지도 보기"}
        </span>}
      </>
    );
    const head = onSelectBlock ? (
      <button type="button" onClick={() => onSelectBlock(block.groupKey)} aria-pressed={selected}
        className="flex min-h-11 w-full flex-wrap items-center gap-x-2 gap-y-0.5 rounded-xl px-2 text-left">
        {content}
      </button>
    ) : (
      <h3 className="flex min-h-9 flex-wrap items-center gap-x-2 gap-y-0.5 px-1">{content}</h3>
    );
    // 기사님 화면(연필 없음·묶음 편집 없음)은 머리 그대로 — 마크업을 바꾸지 않는다.
    if (!onEditBlock && editingGroupKey === undefined) return head;
    const blockEditing = editing && editingGroupKey != null && editingGroupKey === block.groupKey;
    return (
      // 편집 중인 묶음 머리는 긴 묶음을 내려도 [저장]이 보이게 붙어 따라온다(sticky — 관리자 머리 h-14 아래, 블록 안에서만).
      <div className={blockEditing ? "sticky top-14 z-10 rounded-xl border border-[var(--color-academy-info)] bg-[var(--color-academy-surface)] shadow-sm" : ""}>
        <div className="flex items-center gap-1">
          <div className="min-w-0 flex-1">{head}</div>
          {blockEditing
            ? <span className="flex shrink-0 items-center gap-1 pr-1">{renderEditActions?.(block)}</span>
            : onEditBlock && block.kind === "REGULAR" && (
              // 2026-11-13 UI 통일: 연필 아이콘 버튼 → 글자 «수정»(테마 작은 보조 버튼 — PC 36px · 터치 화면 44px). 이름표는 그대로.
              <button type="button" onClick={() => onEditBlock(block.groupKey)} aria-label={`${blockEditName(block)} 묶음 수정`}
                title="이 묶음 수정(순서·시각·정류장·학생)" className="academy-button-secondary academy-button-sm shrink-0">
                수정
              </button>
            )}
        </div>
        {blockEditing && renderEditBar?.(block)}
      </div>
    );
  }

  return (
    <div ref={listRef} className="space-y-4">
      {blocks.map((block) => (
        // 블록 = 같은 수업·같은 방향. 머리와 카드를 가깝게(근접성), 블록끼리는 16px 띄운다.
        <section key={block.key} aria-label={block.label} data-run-block={block.groupKey}
          className={`rounded-2xl ${selectedGroupKey != null && selectedGroupKey === block.groupKey ? "bg-[var(--color-academy-info-soft)] p-1.5 ring-2 ring-[var(--color-academy-info)]" : ""}`}>
          {renderBlockHead(block)}
          <ol className={mode === "admin" && inEditGroup(block.groupKey) ? "mt-1 space-y-2" : "mt-1 space-y-2.5"}>
            {block.rows.map(renderRow)}
          </ol>
        </section>
      ))}
    </div>
  );
}

// 연필 이름표 글자 — «16:00~17:00 수업 · 등원» → «16:00 등원»(화면 읽기 프로그램이 짧게 읽도록). 시각이 없으면 머리 글자 그대로.
function blockEditName(block: RunBlock): string {
  const start = block.label.match(/\d{1,2}:\d{2}/)?.[0];
  return start ? `${start} ${block.direction === "PICKUP" ? "등원" : "하원"}` : block.label;
}
