"use client";

/**
 * 신청함 화면 (2026-11-10 원장 결정 d1~d4 → 같은 날 k1~k4·m1~m3 로 재편)
 *
 * 왜 이렇게:
 * - 맨 위 = «일의 종류» 6탭(체험·수강·상담·대관·변경·기타), 탭 옆 숫자 = 처리 필요 건수(k1).
 * - 탭 안 = «처리할 것»(처리 필요 → 진행 중) 먼저, 완료는 맨 아래 «완료 보기»(k2). 필터는 날짜만, 검색은 원생 이름.
 * - 진행 중 건도 상세 칸에서 바로 처리(k3) — 각 화면 ⚡ 빠른 작업 메뉴의 server action 을 같은 확인 절차로 부른다.
 * - 체험·수강·대관은 기존 화면(목록·상세·처리) 컴포넌트를 그대로 끼운다 — 처리 로직을 두 벌로 만들지 않는다.
 * - 유입 통계·안내 설정·입학 점검은 오른쪽 위 ⚙ «신청 설정»으로(k4).
 */

import dynamic from "next/dynamic";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import AdminModal from "@/components/admin/AdminModal";
import ListDetailPanel from "@/components/admin/list/ListDetailPanel";
import { adminErrorText } from "@/components/admin/adminDisplayText";
import { useAdminConfirm, type AdminConfirmOptions } from "@/components/admin/AdminConfirmDialog";
import { kstHm, kstLabel, todayKst, toKstYmd } from "@/lib/datetime/kst";
import { TONE_BADGE_CLASS } from "@/lib/ui/statusTones";
import {
  BUCKET_LABEL,
  BULK_ACTION_KINDS,
  ENROLLMENT_CANCEL_REQUESTED,
  INBOX_TABS,
  TAB_SUBS,
  kindLabel,
  statusBadgeClassFor,
  tabLabel,
  type InboxTab,
  type RequestKind,
} from "@/lib/requests/catalog";
import type { InboxCounts, InboxRow } from "@/lib/requests/admin-inbox";
import type { AdminRentalRow } from "@/app/actions/rental";
import type { getCachedAdminTrialPayload } from "@/lib/adminReadPayloads";
// 처리 = 각 화면이 쓰던 server action 을 그대로 부른다(규칙·권한 검사·알림이 한 벌로 유지된다)
import { decideEnrollmentChange, decideEnrollmentChangeCancelRequest } from "@/app/actions/enrollment-changes";
import { cancelRegularAbsenceByAdmin, confirmRegularAbsence } from "@/app/actions/regular-absence-admin";
import { cancelMakeupSession, updateMakeupStatus, updateRequestStatus } from "@/app/actions/admin";
import { decidePaymentRequest } from "@/app/actions/payment-requests";
import { rejectWithdrawalRequest } from "@/app/actions/account-withdrawal-admin";
import { approveRoleRequest, rejectRoleRequest } from "@/app/actions/role-requests-admin";
import { reviewStaffPaymentConfirmation } from "@/app/actions/staff-billing";

// 체험·수강·대관 탭은 기존 화면 컴포넌트를 그 탭을 열 때만 내려받는다(다른 탭 첫 화면을 무겁게 하지 않게)
const ApplyAdminClient = dynamic(() => import("@/app/admin/apply/ApplyAdminClient"), { loading: () => <TabLoading /> });
const RentalAdminClient = dynamic(() => import("@/app/admin/rental/RentalAdminClient"), { loading: () => <TabLoading /> });

type TrialPayload = Awaited<ReturnType<typeof getCachedAdminTrialPayload>>;

/** 탭마다 서버가 읽어 준 데이터(page.tsx loadTabData) */
export type InboxTabData =
  | { type: "TRIAL"; trial: TrialPayload }
  | { type: "ENROLL" }
  | { type: "RENTAL"; rows: AdminRentalRow[]; bankAccount: string; smsOn: Record<"approved" | "rejected" | "confirmed", boolean> }
  | { type: "ROWS"; open: InboxRow[]; done: InboxRow[]; failedKinds: RequestKind[]; consultFailed: boolean };

type Props = {
  tab: InboxTab;
  sub: string | null;
  /** «?kind=» 탭 안 한 종류만 보기(옛 주소·오늘 업무 문의 목록) — 없으면 null */
  kind: RequestKind | null;
  showDone: boolean;
  from: string | null;
  to: string | null;
  counts: InboxCounts | null;
  data: InboxTabData;
};

type PanelAction = {
  key: string;
  label: string;
  /** primary = 주 버튼(검정) · secondary = 보조 · danger = 위험 글자 버튼 */
  look: "primary" | "secondary" | "danger";
  /** 누르기 전에 확인 창(되돌리기 어려운 처리) */
  confirm?: AdminConfirmOptions;
  run: (note: string) => Promise<unknown>;
};

const BUTTON_CLASS: Record<PanelAction["look"], string> = {
  primary: "academy-button-primary",
  secondary: "academy-button-secondary",
  danger: "academy-button-danger",
};

/**
 * 기존 server action 들의 결과 모양이 제각각이다({ok:false,message} · {error} · {saved:false} · throw).
 * 여기서 «실패 문구 하나»로 맞춘다. 성공이면 null.
 */
export function actionFailure(result: unknown): string | null {
  if (!result || typeof result !== "object") return null;
  const value = result as Record<string, unknown>;
  if (value.ok === false) return String(value.message ?? "처리하지 못했습니다.");
  if (typeof value.error === "string" && value.error) return value.error;
  if (value.saved === false) return "저장하지 못했습니다. 목록을 새로고침한 뒤 다시 확인해 주세요.";
  return null;
}

/**
 * 이 행에서 상세 칸에 바로 보일 처리 버튼(없으면 «기존 화면에서 열기»만).
 * 진행 중 건도 여기서 처리한다(k3) — 각 화면 ⚡ 메뉴와 같은 action·같은 인자. 취소처럼 되돌리기 어려운 건 확인 한 번.
 */
function actionsFor(row: InboxRow): PanelAction[] {
  const who = row.studentName ?? row.title;
  switch (row.kind) {
    case "ENROLLMENT_CHANGE":
      if (row.rawStatus === ENROLLMENT_CANCEL_REQUESTED) {
        // 학부모 «취소 요청»(d8) — 수강 변경 화면과 같은 action. 적용일이 왔으면 서버가 취소를 막으니 거절만 보인다.
        const reject: PanelAction = {
          key: "cancel-reject", label: "요청 거절", look: row.ref?.tooLate ? "primary" : "danger",
          run: (note) => decideEnrollmentChangeCancelRequest({ requestId: row.id, approve: false, note }),
        };
        if (row.ref?.tooLate) return [reject];
        return [reject, {
          key: "cancel-approve", label: "취소 승인", look: "primary",
          confirm: { title: `${who} ${row.title} 승인`, description: "승인했던 신청이 «취소»로 바뀌어 적용일에 반영되지 않습니다. 결과는 보호자에게 앱 알림으로 갑니다.", confirmLabel: "취소 승인", tone: "primary" },
          run: (note) => decideEnrollmentChangeCancelRequest({ requestId: row.id, approve: true, note }),
        }];
      }
      // 승인·적용일 대기(APPROVED)는 관리자 «적용 전 취소» action 이 없다 — 수강 변경 화면에서 시트·청구를 이어서 본다
      if (row.rawStatus !== "PENDING") return [];
      return [
        { key: "reject", label: "거절", look: "danger", run: (note) => decideEnrollmentChange({ requestId: row.id, approve: false, note }) },
        {
          key: "approve", label: "승인", look: "primary",
          confirm: { title: `${who} ${row.title} 승인`, description: "적용일이 되면 사이트에 반영됩니다. 시트·랠리즈 확인과 차액 청구는 수강 변경 화면에서 이어서 합니다.", confirmLabel: "승인", tone: "primary" },
          run: (note) => decideEnrollmentChange({ requestId: row.id, approve: true, note }),
        },
      ];
    case "REGULAR_ABSENCE":
      if (row.rawStatus !== "REPORTED") return [];
      // 정규 결석 화면 ⚡ «확정»·«신고 취소»와 같은 action
      return [
        {
          key: "cancel", label: "신고 취소", look: "danger",
          confirm: { title: `${who} 결석 신고 취소`, description: "결석 신고가 «취소»로 바뀝니다.", confirmLabel: "신고 취소", tone: "danger" },
          run: () => cancelRegularAbsenceByAdmin({ id: row.id }),
        },
        { key: "confirm", label: "결석 확정", look: "primary", run: () => confirmRegularAbsence({ id: row.id }) },
      ];
    case "MAKEUP":
      if (row.rawStatus !== "BOOKED") return [];
      // 보강 화면 ⚡ 메뉴 네 버튼 그대로(«취소 처리» = 상태 변경 · «예약 취소» = 예약 상태 확인 후 취소 — 서버 동작이 달라 둘 다 둔다)
      return [
        {
          key: "cancel", label: "예약 취소", look: "danger",
          confirm: { title: `${who} 보강 예약 취소`, description: "이 보강 예약을 취소합니다.", confirmLabel: "예약 취소", tone: "danger" },
          run: () => cancelMakeupSession(row.id),
        },
        {
          key: "status-cancelled", label: "취소 처리", look: "secondary",
          confirm: { title: `${who} 보강 취소 처리`, description: "보강 상태를 «취소»로 바꿉니다.", confirmLabel: "취소 처리", tone: "danger" },
          run: () => updateMakeupStatus(row.id, "CANCELLED"),
        },
        { key: "no-show", label: "노쇼 처리", look: "secondary", run: () => updateMakeupStatus(row.id, "NO_SHOW") },
        { key: "attended", label: "출석 처리", look: "primary", run: () => updateMakeupStatus(row.id, "ATTENDED") },
      ];
    case "PARENT_REQUEST": {
      // 답변 칸을 비워 두면 기존 답변을 그대로 둔다(updateRequestStatus 의 undefined 규칙)
      const complete: PanelAction = { key: "complete", label: "답변 완료", look: "primary", run: (note) => updateRequestStatus(row.id, "COMPLETED", note.trim() ? note.trim() : undefined) };
      if (row.rawStatus === "PENDING") {
        return [{ key: "seen", label: "확인함", look: "secondary", run: (note) => updateRequestStatus(row.id, "CONFIRMED", note.trim() ? note.trim() : undefined) }, complete];
      }
      return row.rawStatus === "CONFIRMED" ? [complete] : [];
    }
    case "PAYMENT_REQUEST": {
      if (row.rawStatus !== "PENDING") return [];
      const claim = row.ref?.requestKind === "PAYMENT_CLAIM";
      return [
        { key: "reject", label: "반려", look: "danger", run: (note) => decidePaymentRequest({ requestId: row.id, approve: false, note }) },
        {
          key: "approve", label: claim ? "입금 확인·납부 처리" : "영수증 처리 완료", look: "primary",
          confirm: claim ? { title: `${who} 입금 확인`, description: "통장에서 입금을 확인했나요? 청구가 «납부 완료»로 바뀝니다.", confirmLabel: "납부 처리", tone: "primary" } : undefined,
          run: (note) => decidePaymentRequest({ requestId: row.id, approve: true, note }),
        },
      ];
    }
    case "WITHDRAWAL":
      // 탈퇴 «처리»는 되돌릴 수 없고 업무·권한 이관 확인이 필요해 기존 화면에서만 한다. 반려만 여기서.
      if (row.rawStatus !== "REQUESTED") return [];
      return [{
        key: "reject", label: "신청 반려(계속 이용)", look: "secondary",
        confirm: { title: `${row.title} 반려`, description: "계정은 그대로 남고 탈퇴 신청 표시만 지웁니다.", confirmLabel: "반려", tone: "primary" },
        run: () => rejectWithdrawalRequest(row.id),
      }];
    case "ROLE_GRANT":
      if (row.rawStatus !== "PENDING") return [];
      return [
        { key: "reject", label: "반려", look: "danger", run: (note) => rejectRoleRequest(row.id, note) },
        {
          key: "approve", label: "승인", look: "primary",
          confirm: { title: `${row.title} 승인`, description: "이 순간부터 이 사람에게 선생님·기사님 화면이 열립니다.", confirmLabel: "승인", tone: "primary" },
          run: () => approveRoleRequest(row.id),
        },
      ];
    case "STAFF_PAYMENT":
      if (row.rawStatus !== "PENDING") return [];
      return [
        { key: "reject", label: "반려", look: "danger", run: (note) => reviewStaffPaymentConfirmation({ requestId: row.id, decision: "REJECTED", note }) },
        {
          key: "approve", label: "수납 승인", look: "primary",
          confirm: { title: `${who} 현장 수납 승인`, description: "청구가 «납부 완료»로 바뀝니다.", confirmLabel: "승인", tone: "primary" },
          run: (note) => reviewStaffPaymentConfirmation({ requestId: row.id, decision: "APPROVED", note }),
        },
      ];
    case "CONSULT":
      // 상담(신설) — 상세 칸 버튼은 상담 브랜치의 updateConsultRequest(id, "CONTACTED"|"DONE"|"CANCELED"|"NOTE", note)
      // ("@/app/actions/consult", 반환 {ok:true,status}|{ok:false,message} — actionFailure 가 그대로 읽는다)를 부른다.
      // 행 ref.phone(전화 버튼)·ref.adminNote(메모 초기값)·ref.actions(쉼표 구분 버튼 목록)를 쓴다.
      // 그 action 파일이 아직 이 브랜치에 없어 tsc 가 깨지므로, 연결은 PM 통합 단계에서 한다.
      return [];
    default:
      // 셔틀 오늘만(알림)·특강 결석/보강(처리방식 지정 필요)·카카오(미리보기 발송)·사진 회수·학부모 연결(보호자가 승인)·상담 = 기존 화면에서
      return [];
  }
}

/** 메모 칸이 필요한 처리(거절 사유·답변·원장 메모) */
function wantsNote(row: InboxRow, actions: PanelAction[]): boolean {
  return actions.length > 0 && row.kind !== "REGULAR_ABSENCE" && row.kind !== "WITHDRAWAL" && row.kind !== "MAKEUP";
}

/** 일괄 처리(d4) 대상 — 처리 필요 칸의 결석 신고·새 문의만 */
function isBulkable(row: InboxRow): boolean {
  return (BULK_ACTION_KINDS as readonly string[]).includes(row.kind)
    && ((row.kind === "REGULAR_ABSENCE" && row.rawStatus === "REPORTED") || (row.kind === "PARENT_REQUEST" && row.rawStatus === "PENDING"));
}

/** 상태 배지 색 — catalog 종류는 catalog 가, 상담 행은 행이 직접 준 색 뜻으로 */
function badgeClass(row: InboxRow): string {
  return row.tone ? TONE_BADGE_CLASS[row.tone] : statusBadgeClassFor(row.kind, row.rawStatus);
}

function whenLabel(iso: string): string {
  // 오늘이면 시각, 아니면 «11/9(일)» — KST 기준(서버·브라우저 시간대와 무관)
  return toKstYmd(iso) === todayKst() ? kstHm(iso) : kstLabel(iso);
}

function TabLoading() {
  return <p className="rounded-lg border border-[var(--color-academy-line)] px-4 py-6 text-center text-sm text-[var(--color-academy-muted)]">불러오는 중…</p>;
}

/** 탭 안 묶음 머리(처리 필요·진행 중·완료) — 얇은 한 줄 */
function GroupHead({ label, count }: { label: string; count: number }) {
  return (
    <li className="bg-[var(--color-academy-soft)] px-3 py-1 text-xs font-black text-[var(--color-academy-muted)]">
      {label} <span className="tabular-nums">{count}</span>
    </li>
  );
}

export default function InboxClient({ tab, sub, kind, showDone, from, to, counts, data }: Props) {
  const router = useRouter();
  const pathname = usePathname() || "/admin/inbox";
  const [query, setQuery] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [filterOpen, setFilterOpen] = useState(false);
  const [note, setNote] = useState("");
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pending, startTransition] = useTransition();
  const { confirm, confirmDialog } = useAdminConfirm();

  // 체험·수강 화면은 목록을 스스로 고친다 — 처리가 끝나면 서버 화면만 다시 그려 탭 배지·메뉴 숫자를 맞춘다
  const refreshCounts = () => router.refresh();
  const rowsData = data.type === "ROWS" ? data : null;
  const openRows = useMemo(() => rowsData?.open ?? [], [rowsData]);
  const doneRows = useMemo(() => rowsData?.done ?? [], [rowsData]);

  // 주소(탭·분류·완료 보기·날짜) 바꾸기 — 서버가 새로 읽는다
  const go = (next: Partial<{ tab: InboxTab; sub: string | null; kind: string | null; done: boolean; from: string | null; to: string | null }>) => {
    const params = new URLSearchParams();
    const t = next.tab ?? tab;
    // 한 종류 보기는 탭·분류를 바꾸면 풀린다(완료 보기·날짜는 유지)
    const k = (next.tab && next.tab !== tab) || next.sub !== undefined ? null : next.kind === undefined ? kind : next.kind;
    // 탭을 바꾸면 분류·완료 보기는 처음으로
    const s = next.tab && next.tab !== tab ? null : next.sub === undefined ? sub : next.sub;
    const d = next.tab && next.tab !== tab ? false : next.done ?? showDone;
    const f = next.from === undefined ? from : next.from;
    const e = next.to === undefined ? to : next.to;
    params.set("tab", t);
    if (s) params.set("sub", s);
    if (k) params.set("kind", k);
    if (d) params.set("done", "1");
    if (f) params.set("from", f);
    if (e) params.set("to", e);
    setSelected(new Set());
    setOpenId(null);
    setMessage(null);
    router.push(`${pathname}?${params}`);
  };

  // 검색은 이미 받은 줄 안에서(원생 이름·제목·요약)
  const match = (row: InboxRow) => {
    const q = query.trim();
    return !q || `${row.studentName ?? ""} ${row.title} ${row.summary}`.includes(q);
  };
  const visibleOpen = useMemo(() => openRows.filter(match), [openRows, query]); // eslint-disable-line react-hooks/exhaustive-deps
  const visibleDone = useMemo(() => doneRows.filter(match), [doneRows, query]); // eslint-disable-line react-hooks/exhaustive-deps
  const actionRows = visibleOpen.filter((row) => row.bucket === "ACTION");
  const ongoingRows = visibleOpen.filter((row) => row.bucket !== "ACTION");

  const keyOf = (row: InboxRow) => `${row.kind}:${row.id}`;
  const open = [...openRows, ...doneRows].find((row) => keyOf(row) === openId) ?? null;
  const openActions = open ? actionsFor(open) : [];
  const filterCount = from || to ? 1 : 0;
  const bulkRows = actionRows.filter(isBulkable);
  const selectedRows = bulkRows.filter((row) => selected.has(keyOf(row)));
  const subs = TAB_SUBS[tab] ?? [];
  const isRowsTab = data.type === "ROWS";

  async function runAction(row: InboxRow, action: PanelAction) {
    if (action.confirm && !(await confirm(action.confirm))) return;
    startTransition(async () => {
      try {
        const failure = actionFailure(await action.run(note));
        if (failure) { setMessage({ tone: "error", text: failure }); return; }
        setMessage({ tone: "ok", text: `${row.studentName ?? row.title} · ${action.label} 처리했습니다.` });
        setOpenId(null);
        setNote("");
        router.refresh();
      } catch (error) {
        setMessage({ tone: "error", text: adminErrorText(error, "처리하지 못했습니다. 목록을 새로고침한 뒤 다시 확인해 주세요.") });
      }
    });
  }

  // 일괄 처리(d4) — 결석 확정·문의 «확인함»만. 한 건씩 기존 함수로 처리하고 결과를 센다.
  async function runBulk() {
    const absences = selectedRows.filter((row) => row.kind === "REGULAR_ABSENCE").length;
    const asks = selectedRows.length - absences;
    const ok = await confirm({
      title: `${selectedRows.length}건 한 번에 처리`,
      description: [absences ? `결석 ${absences}건 확정` : "", asks ? `문의 ${asks}건 «확인함»` : ""].filter(Boolean).join(" · "),
      confirmLabel: "처리",
      tone: "primary",
    });
    if (!ok) return;
    startTransition(async () => {
      let done = 0;
      const failed: string[] = [];
      for (const row of selectedRows) {
        try {
          const result = row.kind === "REGULAR_ABSENCE"
            ? await confirmRegularAbsence({ id: row.id })
            : await updateRequestStatus(row.id, "CONFIRMED");
          if (actionFailure(result)) failed.push(row.studentName ?? row.title); else done += 1;
        } catch {
          failed.push(row.studentName ?? row.title);
        }
      }
      setSelected(new Set());
      setMessage(failed.length
        ? { tone: "error", text: `${done}건 처리 · ${failed.length}건 실패(${failed.slice(0, 3).join(", ")}${failed.length > 3 ? " 외" : ""}) — 목록을 다시 확인해 주세요.` }
        : { tone: "ok", text: `${done}건 처리했습니다.` });
      router.refresh();
    });
  }

  /** 한 줄 행(높이 ≈48px). 행 전체가 상세 열기 버튼 */
  const renderRow = (row: InboxRow) => {
    const key = keyOf(row);
    const bulk = isBulkable(row) && row.bucket === "ACTION";
    // 고르기 칸이 하나라도 있으면 모든 줄에 같은 폭(48px) 자리를 둔다 — 종류·이름 열이 들쭉날쭉하지 않게
    const gutter = bulkRows.length > 0;
    return (
      <li key={key} className="flex min-h-12 items-center">
        {gutter && !bulk && <span className="w-12 shrink-0" aria-hidden="true" />}
        {bulk && (
          <label className="flex min-h-12 w-12 shrink-0 items-center justify-center">
            <span className="sr-only">{row.studentName ?? row.title} 고르기</span>
            <input
              type="checkbox"
              className="h-5 w-5"
              checked={selected.has(key)}
              onChange={(event) => setSelected((current) => {
                const next = new Set(current);
                if (event.target.checked) next.add(key); else next.delete(key);
                return next;
              })}
            />
          </label>
        )}
        <button
          type="button"
          onClick={() => { setOpenId(key); setNote(""); setMessage(null); }}
          className={`flex min-h-12 min-w-0 flex-1 items-center gap-2 py-1.5 pr-3 text-left hover:bg-[var(--color-academy-soft)] ${gutter ? "pl-0" : "pl-3"}`}
        >
          <span className="hidden w-24 shrink-0 truncate text-xs font-bold text-[var(--color-academy-muted)] sm:block">{kindLabel(row.kind)}</span>
          <span className="min-w-0 flex-1 truncate text-sm">
            <b className="text-[var(--color-academy-ink)]">{row.studentName ?? row.title}</b>
            <span className="text-[var(--color-academy-muted)]">
              {row.studentName ? ` · ${row.title}` : ""}{row.summary ? ` · ${row.summary}` : ""}
            </span>
          </span>
          <span className={`shrink-0 rounded px-2 py-0.5 text-xs font-bold ${badgeClass(row)}`}>{row.statusLabel}</span>
          <span className="hidden w-16 shrink-0 text-right text-xs tabular-nums text-[var(--color-academy-muted)] sm:block">{whenLabel(row.createdAt)}</span>
        </button>
      </li>
    );
  };

  return (
    <div className="space-y-3">
      {/* 머리 한 줄: 제목 + (공통 목록 탭이면) 검색·필터 + ⚙ 신청 설정 — 컴팩트(히어로 없음) */}
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="mr-auto text-xl font-black text-[var(--color-academy-ink)]">신청함</h1>
        {isRowsTab && (
          <>
            {/* 검색 칸 — 돋보기는 칸 안 왼쪽, 글자와 겹치지 않게 flex 로 나란히 */}
            <label className="order-last flex min-h-11 w-full min-w-0 items-center gap-2 rounded-xl border border-[var(--color-academy-line-input)] bg-[var(--color-academy-surface)] px-3 sm:order-none sm:w-auto sm:max-w-xs sm:flex-1">
              <span className="sr-only">원생 이름 검색</span>
              <span className="material-symbols-outlined text-lg text-[var(--color-academy-muted)]" aria-hidden="true">search</span>
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="원생 이름 검색"
                className="min-w-0 flex-1 bg-transparent py-2 text-base text-[var(--color-academy-ink)] outline-none [&::-webkit-search-cancel-button]:appearance-none"
              />
            </label>
            <button type="button" onClick={() => setFilterOpen(true)} className="academy-button-secondary" aria-haspopup="dialog">
              <span className="material-symbols-outlined text-lg" aria-hidden="true">tune</span>
              필터{filterCount > 0 && <span className="tabular-nums"> {filterCount}</span>}
            </button>
          </>
        )}
        <Link href="/admin/inbox/settings" prefetch={false} className="academy-button-secondary" aria-label="신청 설정(유입 통계·안내 설정·입학 점검)">
          <span className="material-symbols-outlined text-lg" aria-hidden="true">settings</span>
          <span className="hidden sm:inline">신청 설정</span>
        </Link>
      </div>

      {/* 일의 종류 6탭 — 휴대폰은 가로 스크롤 한 줄. 숫자 = 처리 필요 건수(k1) */}
      <nav className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1" aria-label="신청 종류">
        {INBOX_TABS.map((entry) => {
          const n = counts?.byTab[entry.tab] ?? 0;
          const active = entry.tab === tab;
          return (
            <button
              key={entry.tab}
              type="button"
              aria-pressed={active}
              onClick={() => go({ tab: entry.tab })}
              className={`inline-flex min-h-11 shrink-0 items-center gap-1 rounded-full border px-4 text-sm font-bold ${active
                ? "border-[var(--color-academy-primary)] bg-[var(--color-academy-primary)] text-[var(--color-academy-on-primary)]"
                : "border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] text-[var(--color-academy-ink)]"}`}
            >
              {entry.label}
              {n > 0 && (
                <span className={`rounded-full px-1.5 text-xs tabular-nums ${active
                  ? "bg-[var(--color-academy-surface)] text-[var(--color-academy-ink)]"
                  : "bg-[var(--color-academy-primary)] text-[var(--color-academy-on-primary)]"}`}>
                  <span className="sr-only">처리 필요 </span>{n}
                </span>
              )}
            </button>
          );
        })}
      </nav>

      {/* 탭 안 작은 분류(변경: 결석·보강/셔틀/수강 · 수강: 신청/대기) — 글자 버튼 한 줄 */}
      {subs.length > 0 && (
        <div className="flex gap-1 overflow-x-auto" role="group" aria-label={`${tabLabel(tab)} 분류`}>
          {[...(tab === "ENROLL" ? [] : [{ key: null as string | null, label: "전체" }]), ...subs.map((s) => ({ key: s.key as string | null, label: s.label }))].map((s) => {
            // 수강 탭은 «신청»이 기본(분류 없음 = 신청)
            const active = tab === "ENROLL" ? (sub ?? "APPLY") === s.key : sub === s.key;
            return (
              <button
                key={s.key ?? "ALL"}
                type="button"
                aria-pressed={active}
                onClick={() => go({ sub: s.key, done: false })}
                className={`min-h-11 shrink-0 rounded-lg px-3 text-sm font-bold ${active
                  ? "bg-[var(--color-academy-soft)] text-[var(--color-academy-ink)]"
                  : "text-[var(--color-academy-muted)] hover:bg-[var(--color-academy-soft)]"}`}
              >
                {s.label}
              </button>
            );
          })}
        </div>
      )}

      {/* 한 종류만 보는 중(옛 «?kind=» 주소) — 누르면 탭 전체 */}
      {isRowsTab && kind && (
        <button type="button" onClick={() => go({ kind: null, sub: null })} className="inline-flex min-h-11 items-center gap-1 rounded-full border border-[var(--color-academy-line-input)] bg-[var(--color-academy-surface)] px-3 text-sm font-bold text-[var(--color-academy-ink)]">
          {kindLabel(kind)}만 보기
          <span className="material-symbols-outlined text-lg" aria-hidden="true">close</span>
          <span className="sr-only">— 눌러서 {tabLabel(tab)} 전체 보기</span>
        </button>
      )}

      {/* 적용 중인 날짜 필터 한 줄 요약 */}
      {isRowsTab && filterCount > 0 && (
        <p className="text-sm text-[var(--color-academy-muted)]">
          신청일 {from ?? "…"} ~ {to ?? "…"}
          <button type="button" onClick={() => go({ from: null, to: null })} className="ml-2 min-h-11 font-bold text-[var(--color-academy-ink)] underline">필터 풀기</button>
        </p>
      )}

      {/* ── 탭 내용 ── */}
      {data.type === "TRIAL" && (
        <ApplyAdminClient
          mode="trial"
          initialTrialLeads={data.trial.leads}
          initialTrialStats={data.trial.stats}
          initialTrialClasses={data.trial.classes}
          initialTrialPagination={data.trial.pagination}
          onChanged={refreshCounts}
        />
      )}
      {data.type === "ENROLL" && (
        // 분류가 바뀌면 화면을 새로 만든다(신청 ↔ 대기 화면의 상태가 섞이지 않게). 처리 후 배지·메뉴 숫자 갱신
        <ApplyAdminClient key={sub ?? "APPLY"} mode={sub === "WAITLIST" ? "waitlist" : "applications"} onChanged={refreshCounts} />
      )}
      {data.type === "RENTAL" && <RentalAdminClient embedded rows={data.rows} bankAccount={data.bankAccount} smsOn={data.smsOn} />}

      {rowsData && (
        <>
          {message && (
            <p role="status" className={`rounded px-3 py-2 text-sm font-bold ${message.tone === "ok"
              ? "bg-[var(--color-academy-success-soft)] text-[var(--color-academy-success)]"
              : "bg-[var(--color-academy-danger-soft)] text-[var(--color-academy-danger)]"}`}>{message.text}</p>
          )}
          {(rowsData.failedKinds.length > 0 || rowsData.consultFailed) && (
            <p className="rounded bg-[var(--color-academy-warning-soft)] px-3 py-2 text-sm text-[var(--color-academy-warning)]">
              {rowsData.consultFailed ? "상담" : rowsData.failedKinds.map(kindLabel).join(", ")} 목록을 읽지 못했습니다. 잠시 뒤 새로고침해 주세요.
            </p>
          )}

          {/* 일괄 처리 줄 — 고른 게 있을 때만 */}
          {selectedRows.length > 0 && (
            <div className="sticky top-14 z-10 flex flex-wrap items-center gap-2 rounded-lg border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] px-3 py-2">
              <span className="text-sm font-bold text-[var(--color-academy-ink)]">{selectedRows.length}건 선택</span>
              <button type="button" onClick={() => setSelected(new Set())} className="academy-button-text">선택 풀기</button>
              <button type="button" disabled={pending} onClick={() => void runBulk()} className="academy-button-primary ml-auto">결석 확정·문의 확인함</button>
            </div>
          )}

          {/* 처리할 것 — 처리 필요 → 진행 중(k2) */}
          <section className="overflow-hidden rounded-lg border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)]" aria-label={`${tabLabel(tab)} 처리할 신청`}>
            {bulkRows.length > 0 && (
              <label className="flex min-h-11 items-center border-b border-[var(--color-academy-line)] pr-3 text-sm text-[var(--color-academy-muted)]">
                <span className="flex w-12 shrink-0 justify-center">
                  <input
                    type="checkbox"
                    className="h-5 w-5"
                    checked={selectedRows.length === bulkRows.length}
                    onChange={(event) => setSelected(event.target.checked ? new Set(bulkRows.map(keyOf)) : new Set())}
                  />
                </span>
                결석 신고·새 문의 {bulkRows.length}건 모두 고르기
              </label>
            )}
            {visibleOpen.length === 0 ? (
              <p className="px-4 py-6 text-center text-sm text-[var(--color-academy-muted)]">
                {query ? "검색한 원생의 신청이 없습니다." : tab === "CONSULT" && !openRows.length ? "상담 접수가 없습니다." : "처리할 신청이 없습니다."}
              </p>
            ) : (
              <ul className="divide-y divide-[var(--color-academy-line)]">
                {actionRows.length > 0 && <GroupHead label={BUCKET_LABEL.ACTION} count={actionRows.length} />}
                {actionRows.map(renderRow)}
                {ongoingRows.length > 0 && <GroupHead label={BUCKET_LABEL.ONGOING} count={ongoingRows.length} />}
                {ongoingRows.map(renderRow)}
              </ul>
            )}
          </section>

          {/* 완료는 맨 아래 — 누를 때만 읽는다(k2) */}
          {showDone ? (
            <section className="overflow-hidden rounded-lg border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)]" aria-label={`${tabLabel(tab)} 완료된 신청`}>
              <ul className="divide-y divide-[var(--color-academy-line)]">
                <GroupHead label={BUCKET_LABEL.DONE} count={visibleDone.length} />
                {visibleDone.length === 0
                  ? <li className="px-4 py-4 text-center text-sm text-[var(--color-academy-muted)]">완료된 신청이 없습니다.</li>
                  : visibleDone.map(renderRow)}
              </ul>
            </section>
          ) : null}
          <button type="button" onClick={() => go({ done: !showDone })} aria-expanded={showDone} className="academy-button-text">
            {showDone ? "완료 접기" : "완료 보기"}
            <span className="material-symbols-outlined text-lg" aria-hidden="true">{showDone ? "expand_less" : "expand_more"}</span>
          </button>
        </>
      )}

      {/* 상세 칸 — PC 오른쪽 패널 · 휴대폰 아래 시트(ListDetailPanel) */}
      {open && (
        <ListDetailPanel onClose={() => setOpenId(null)} titleId="inbox-detail-title" panelClassName="p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))]">
          <div className="mb-3 flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <p className="text-xs font-bold text-[var(--color-academy-muted)]">{kindLabel(open.kind)} · {whenLabel(open.createdAt)} 신청</p>
              <h2 id="inbox-detail-title" className="mt-1 break-keep text-lg font-black text-[var(--color-academy-ink)]">
                {open.studentName ? `${open.studentName} · ${open.title}` : open.title}
              </h2>
              <span className={`mt-1 inline-block rounded px-2 py-0.5 text-xs font-bold ${badgeClass(open)}`}>{open.statusLabel}</span>
            </div>
            <button type="button" onClick={() => setOpenId(null)} aria-label="닫기" className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-lg text-[var(--color-academy-muted)] hover:bg-[var(--color-academy-soft)]">
              <span className="material-symbols-outlined" aria-hidden="true">close</span>
            </button>
          </div>
          <dl className="grid grid-cols-[5rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm">
            {open.facts.map(([label, value]) => (
              <div key={label} className="contents">
                <dt className="font-bold text-[var(--color-academy-muted)]">{label}</dt>
                <dd className="whitespace-pre-wrap break-words text-[var(--color-academy-ink)]">{value}</dd>
              </div>
            ))}
          </dl>
          {wantsNote(open, openActions) && (
            <label className="mt-4 block text-sm font-bold text-[var(--color-academy-ink)]">
              {open.kind === "PARENT_REQUEST" ? "답변(학부모에게 보임)" : "메모·거절 사유(선택)"}
              <textarea value={note} onChange={(event) => setNote(event.target.value)} rows={2} maxLength={500} className="academy-input mt-1 w-full" />
            </label>
          )}
          {message?.tone === "error" && <p role="alert" className="mt-3 text-sm font-bold text-[var(--color-academy-danger)]">{message.text}</p>}
          {/* 처리 버튼 — 위험(취소·거절)은 왼쪽, 주 버튼은 오른쪽 끝(근접성 — 헷갈려 누르지 않게) */}
          {openActions.length > 0 && (
            <div className="mt-4 flex flex-wrap justify-end gap-2">
              {openActions.map((action) => (
                <button key={action.key} type="button" disabled={pending} onClick={() => void runAction(open, action)} className={BUTTON_CLASS[action.look]}>
                  {action.label}
                </button>
              ))}
            </div>
          )}
          {/* 기존 화면은 작은 링크로만(k3) */}
          <Link href={open.detailHref} prefetch={false} className="mt-3 inline-flex min-h-11 items-center gap-1 text-xs font-bold text-[var(--color-academy-muted)] underline">
            기존 화면에서 열기
            <span className="material-symbols-outlined text-base" aria-hidden="true">open_in_new</span>
          </Link>
        </ListDetailPanel>
      )}

      {filterOpen && (
        <FilterModal
          from={from}
          to={to}
          onClose={() => setFilterOpen(false)}
          onApply={(next) => { setFilterOpen(false); go(next); }}
        />
      )}
      {confirmDialog}
    </div>
  );
}

/** 필터 모달 — 신청일 범위만(k2: 종류 체크박스 묶음은 탭이 대신한다). «초기화»·«적용» */
function FilterModal({ from, to, onClose, onApply }: {
  from: string | null;
  to: string | null;
  onClose: () => void;
  onApply: (next: { from: string | null; to: string | null }) => void;
}) {
  const [fromValue, setFromValue] = useState(from ?? "");
  const [toValue, setToValue] = useState(to ?? "");
  return (
    <AdminModal onClose={onClose} titleId="inbox-filter-title" panelClassName="max-w-lg p-5">
      <h2 id="inbox-filter-title" className="text-lg font-black text-[var(--color-academy-ink)]">필터</h2>
      <fieldset className="mt-3">
        <legend className="text-sm font-bold text-[var(--color-academy-muted)]">신청일</legend>
        <div className="mt-2 flex items-center gap-2">
          <input type="date" value={fromValue} onChange={(event) => setFromValue(event.target.value)} className="academy-input min-h-11 min-w-0 flex-1" aria-label="신청일 시작" />
          <span className="text-[var(--color-academy-muted)]">~</span>
          <input type="date" value={toValue} onChange={(event) => setToValue(event.target.value)} className="academy-input min-h-11 min-w-0 flex-1" aria-label="신청일 끝" />
        </div>
      </fieldset>
      <div className="mt-5 flex items-center gap-2">
        <button type="button" onClick={() => { setFromValue(""); setToValue(""); }} className="academy-button-text">초기화</button>
        <button type="button" onClick={onClose} className="academy-button-secondary ml-auto">닫기</button>
        <button type="button" onClick={() => onApply({ from: fromValue || null, to: toValue || null })} className="academy-button-primary">적용</button>
      </div>
    </AdminModal>
  );
}
