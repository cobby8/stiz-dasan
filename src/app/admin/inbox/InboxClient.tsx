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

import UiIcon from "@/components/common/UiIcon";
import dynamic from "next/dynamic";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import AdminModal from "@/components/admin/AdminModal";
import ListDetailPanel from "@/components/admin/list/ListDetailPanel";
import AdminPageHeader from "@/components/admin/AdminPageHeader";
import { adminErrorText } from "@/components/admin/adminDisplayText";
import { useAdminConfirm, type AdminConfirmOptions } from "@/components/admin/AdminConfirmDialog";
import { kstHm, kstLabel, todayKst, toKstYmd } from "@/lib/datetime/kst";
import { TONE_BADGE_CLASS } from "@/lib/ui/statusTones";
import {
  BUCKET_LABEL,
  BULK_ACTION_KINDS,
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
import { updateConsultRequest } from "@/app/actions/consult";
import { cancelRegularAbsenceByAdmin, confirmRegularAbsence } from "@/app/actions/regular-absence-admin";
import { cancelMakeupSession, deleteParentRequest, updateMakeupStatus, updateRequestStatus } from "@/app/actions/admin";
import { decidePaymentRequest } from "@/app/actions/payment-requests";
import { approveRoleRequest, rejectRoleRequest, revokeRoleGrant } from "@/app/actions/role-requests-admin";
import { reviewStaffPaymentConfirmation } from "@/app/actions/staff-billing";
import { confirmEnrollmentChangesRallyzBulk } from "@/app/actions/enrollment-changes";

// 체험·수강·대관 탭은 기존 화면 컴포넌트를 그 탭을 열 때만 내려받는다(다른 탭 첫 화면을 무겁게 하지 않게)
const ApplyAdminClient = dynamic(() => import("@/app/admin/apply/ApplyAdminClient"), { loading: () => <TabLoading /> });
const RentalAdminClient = dynamic(() => import("@/app/admin/rental/RentalAdminClient"), { loading: () => <TabLoading /> });
const EnrollmentChangeInboxDetail = dynamic(() => import("@/app/admin/enrollment-changes/EnrollmentChangeInboxDetail"), { loading: () => <TabLoading /> });
const InboxSpecializedActions = dynamic(() => import("./InboxSpecializedActions"), { loading: () => <TabLoading /> });
const RoleRequestCoachLink = dynamic(() => import("./RoleRequestCoachLink"), { loading: () => <TabLoading /> });
const SPECIALIZED_KINDS = new Set<RequestKind>(["SEASONAL_ABSENCE", "SEASONAL_MAKEUP", "KAKAO", "WITHDRAWAL", "MEDIA_REVOCATION"]);

type TrialPayload = Awaited<ReturnType<typeof getCachedAdminTrialPayload>>;

/** 탭마다 서버가 읽어 준 데이터(page.tsx loadTabData) */
export type InboxTabData =
  | { type: "TRIAL"; trial: TrialPayload }
  | { type: "ENROLL" }
  | { type: "RENTAL"; rows: AdminRentalRow[]; bankAccount: string; smsOn: Record<"approved" | "rejected" | "confirmed", boolean> }
  | {
      type: "ROWS"; open: InboxRow[]; done: InboxRow[]; failedKinds: RequestKind[]; consultFailed: boolean;
      /** «변경» 탭 — 휴원 수강료 처리에 남은 일(사람 환불·감액·토스 확인 중·남은 이월) 건수. 없으면 0 */
      openSettlementCount?: number;
    };

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
  canDecideStaffRoles?: boolean;
  /**
   * 랠리즈 은퇴(2026-11-14 원장 결정) 여부 — 서버(page.tsx)가 환경변수로 판정해 넘긴다.
   * 기본값 true(은퇴): «랠리즈 반영 확인» 일괄 버튼·고르기 칸을 그리지 않는다. false 는 스위치 "0"(옛 방식)일 때만.
   */
  rallyzRetired?: boolean;
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
 * 상세에서 기존 서버 동작을 호출하는 공통 처리 버튼.
 * 진행 중 건도 여기서 처리한다(k3) — 각 화면 ⚡ 메뉴와 같은 action·같은 인자. 취소처럼 되돌리기 어려운 건 확인 한 번.
 */
// 테스트가 버튼 목록·인자를 직접 확인할 수 있게 내보낸다(tests/inbox-consult-pause-wiring.test.mjs)
export function actionsFor(row: InboxRow): PanelAction[] {
  const who = row.studentName ?? row.title;
  switch (row.kind) {
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
      const statuses = [
        { key: "reject", label: "반려", status: "REJECTED", look: "danger" },
        { key: "reopen", label: "대기로 변경", status: "PENDING", look: "secondary" },
        { key: "seen", label: "확인함", status: "CONFIRMED", look: "secondary" },
        { key: "complete", label: "답변 완료", status: "COMPLETED", look: "primary" },
      ] as const;
      return [
        {
          key: "delete", label: "문의 삭제", look: "danger",
          confirm: { title: `${who} 문의 삭제`, description: "문의와 답변 기록을 삭제합니다. 삭제하면 복구할 수 없습니다.", confirmLabel: "삭제", tone: "danger" },
          run: () => deleteParentRequest(row.id),
        },
        ...statuses.filter(({ status }) => status !== row.rawStatus).map(({ key, label, status, look }): PanelAction => ({
          key, label, look,
          run: (note) => updateRequestStatus(row.id, status, note === (row.ref?.adminNote ?? "") ? undefined : note.trim()),
        })),
      ];
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
    case "ROLE_GRANT": {
      if (row.rawStatus === "ACTIVE" || row.rawStatus === "COACH_LINK_REQUIRED") return [{
        key: "revoke", label: "역할 회수", look: "danger",
        confirm: { title: `${row.title} 역할 회수`, description: "회수하면 이 사람의 해당 직원 화면 접근이 즉시 종료됩니다.", confirmLabel: "회수", tone: "danger" },
        run: () => revokeRoleGrant(row.id),
      }];
      if (row.rawStatus !== "PENDING") return [];
      const actions: PanelAction[] = [
        { key: "reject", label: "반려", look: "danger", run: (note) => rejectRoleRequest(row.id, note) },
      ];
      if (row.ref?.role !== "INSTRUCTOR") {
        actions.push({
          key: "approve", label: "승인", look: "primary",
          confirm: { title: `${row.title} 승인`, description: "이 순간부터 이 사람에게 선생님·기사님 화면이 열립니다.", confirmLabel: "승인", tone: "primary" },
          run: () => approveRoleRequest(row.id),
        });
      }
      return actions;
    }
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
    case "CONSULT": {
      // 상담(신설) — updateConsultRequest(id, "CONTACTED"|"DONE"|"CANCELED"|"NOTE", note)
      // (반환 {ok:true,status}|{ok:false,message} — actionFailure 가 그대로 읽는다).
      // 버튼은 행 ref.actions(지금 상태에서 누를 수 있는 것, 쉼표 구분 — consultActionsFor)에 있는 것만 보인다.
      // 메모 칸 초기값 = ref.adminNote(칸을 열 때 채운다). 메모는 어느 버튼을 눌러도 함께 저장된다(비우면 지운다).
      const allowed = new Set((row.ref?.actions ?? "").split(",").filter(Boolean));
      // 상태 버튼은 메모 칸을 고쳤을 때만 메모를 보낸다(그대로면 undefined → 서버가 기존 메모 유지).
      // 다른 관리자가 그 사이 남긴 메모를 처음 값으로 덮어쓰지 않게. «메모 저장»은 항상 보낸다.
      const changedNote = (note: string) => (note === (row.ref?.adminNote ?? "") ? undefined : note);
      const list: PanelAction[] = [];
      // 위험(취소)은 왼쪽, 주 버튼(상담 완료)은 오른쪽 끝
      if (allowed.has("CANCELED")) {
        list.push({
          key: "consult-cancel", label: "취소", look: "danger",
          confirm: { title: `${who} 상담 취소`, description: "상담 신청이 «취소»로 닫힙니다. 닫힌 상담은 다시 열 수 없습니다.", confirmLabel: "상담 취소", tone: "danger" },
          run: (note) => updateConsultRequest(row.id, "CANCELED", changedNote(note)),
        });
      }
      if (allowed.has("NOTE")) list.push({ key: "consult-note", label: "메모 저장", look: "secondary", run: (note) => updateConsultRequest(row.id, "NOTE", note) });
      if (allowed.has("CONTACTED")) list.push({ key: "consult-contacted", label: "연락함", look: "secondary", run: (note) => updateConsultRequest(row.id, "CONTACTED", changedNote(note)) });
      if (allowed.has("DONE")) list.push({ key: "consult-done", label: "상담 완료", look: "primary", run: (note) => updateConsultRequest(row.id, "DONE", changedNote(note)) });
      return list;
    }
    default:
      return [];
  }
}

/** 메모 칸이 필요한 처리(거절 사유·답변·원장 메모) */
function wantsNote(row: InboxRow, actions: PanelAction[]): boolean {
  return actions.length > 0 && row.kind !== "REGULAR_ABSENCE" && row.kind !== "MAKEUP"
    && !(row.kind === "ROLE_GRANT" && row.rawStatus !== "PENDING");
}

/**
 * 랠리즈 반영 확인을 기다리는 수강 변경 신청 id(«외부 반영 확인 필요» 반만).
 * 여러 반 휴원 묶음 줄이면 그중 확인이 남은 반만 고른다. 빈 배열이면 일괄 확인 대상이 아니다.
 */
export function rallyzCheckIds(row: InboxRow): string[] {
  if (row.kind !== "ENROLLMENT_CHANGE") return [];
  const members = row.members?.length ? row.members : [{ id: row.id, rawStatus: row.rawStatus }];
  return members.filter((member) => member.rawStatus === "SYNC_CHECK").map((member) => member.id);
}

/** 일괄 처리는 결석 신고·새 문의에서만 가능하다. 옛 방식(랠리즈 은퇴 전)에서는 랠리즈 반영 확인이 남은 수강 변경도 포함한다. */
function isBulkable(row: InboxRow, rallyzRetired: boolean): boolean {
  if (!rallyzRetired && rallyzCheckIds(row).length > 0) return true;
  return (BULK_ACTION_KINDS as readonly string[]).includes(row.kind)
    && ((row.kind === "REGULAR_ABSENCE" && row.rawStatus === "REPORTED") || (row.kind === "PARENT_REQUEST" && row.rawStatus === "PENDING"));
}

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
    <li className="bg-[var(--color-academy-soft)] px-3 py-1 text-xs font-semibold text-[var(--color-academy-muted)]">
      {label} <span className="tabular-nums">{count}</span>
    </li>
  );
}

export default function InboxClient({ tab, sub, kind, showDone, from, to, counts, data, canDecideStaffRoles = false, rallyzRetired = true }: Props) {
  const router = useRouter();
  const pathname = usePathname() || "/admin/inbox";
  const [query, setQuery] = useState("");
  const [openSelection, setOpenSelection] = useState<InboxRow | null>(null);
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
    setOpenSelection(null);
    setMessage(null);
    router.push(`${pathname}?${params}`);
  };

  // 검색은 이미 받은 줄 안에서(원생 이름·제목·요약)
  const search = query.trim();
  const match = (row: InboxRow) => !search || `${row.studentName ?? ""} ${row.title} ${row.summary}`.includes(search);
  const visibleOpen = openRows.filter(match);
  const visibleDone = doneRows.filter(match);
  const actionRows = visibleOpen.filter((row) => row.bucket === "ACTION");
  const ongoingRows = visibleOpen.filter((row) => row.bucket !== "ACTION");

  const keyOf = (row: InboxRow) => `${row.kind}:${row.id}`;
  const freshOpen = openSelection
    ? [...openRows, ...doneRows].find((row) => keyOf(row) === keyOf(openSelection))
    : undefined;
  // 상세가 자체 조회하는 작업은 완료 목록으로 옮겨진 뒤에도 후속 처리를 이어갈 수 있다.
  const open = freshOpen ?? (openSelection && (
    openSelection.kind === "ENROLLMENT_CHANGE" || SPECIALIZED_KINDS.has(openSelection.kind)
  ) ? openSelection : null);
  const openActions = open && (open.kind !== "ROLE_GRANT" || canDecideStaffRoles) ? actionsFor(open) : [];
  const filterCount = from || to ? 1 : 0;
  const bulkRows = actionRows.filter((row) => isBulkable(row, rallyzRetired));
  const selectedRows = bulkRows.filter((row) => selected.has(keyOf(row)));
  // 고른 줄을 처리 종류별로 나눈다 — 각자 자기 버튼으로 처리(서로 섞어 부르지 않는다)
  // 랠리즈 은퇴 뒤에는 랠리즈 확인 대상이 없다(빈 배열) — 일괄 버튼·«랠리즈 확인 필요 N건» 문구가 나오지 않는다.
  const rallyzIds = (row: InboxRow) => (rallyzRetired ? [] : rallyzCheckIds(row));
  const selectedRallyz = selectedRows.filter((row) => rallyzIds(row).length > 0);
  const selectedOther = selectedRows.filter((row) => rallyzIds(row).length === 0);
  const bulkRallyzCount = bulkRows.filter((row) => rallyzIds(row).length > 0).length;
  const subs = TAB_SUBS[tab] ?? [];
  const isRowsTab = data.type === "ROWS";

  async function runAction(row: InboxRow, action: PanelAction) {
    if (action.confirm && !(await confirm(action.confirm))) return;
    startTransition(async () => {
      try {
        const result = await action.run(note);
        const failure = actionFailure(result);
        if (failure) {
          setMessage({ tone: "error", text: failure });
          return;
        }
        setMessage({ tone: "ok", text: `${row.studentName ?? row.title} · ${action.label} 처리했습니다.` });
        setOpenSelection(null);
        setNote("");
        router.refresh();
      } catch (error) {
        setMessage({ tone: "error", text: adminErrorText(error, "처리하지 못했습니다. 목록을 새로고침한 뒤 다시 확인해 주세요.") });
      }
    });
  }

  // 일괄 처리(d4) — 결석 확정·문의 «확인함»만. 한 건씩 기존 함수로 처리하고 결과를 센다.
  async function runBulk() {
    const absences = selectedOther.filter((row) => row.kind === "REGULAR_ABSENCE").length;
    const asks = selectedOther.length - absences;
    const ok = await confirm({
      title: `${selectedOther.length}건 한 번에 처리`,
      description: [absences ? `결석 ${absences}건 확정` : "", asks ? `문의 ${asks}건 «확인함»` : ""].filter(Boolean).join(" · "),
      confirmLabel: "처리",
      tone: "primary",
    });
    if (!ok) return;
    startTransition(async () => {
      let done = 0;
      const failed: string[] = [];
      for (const row of selectedOther) {
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

  // 랠리즈 반영 일괄 확인 — 서버가 건마다 단건과 같은 검증·감사 기록을 한다. 확인 창에 대상 이름을 모두 보인다.
  async function runBulkRallyz() {
    const targets = selectedRallyz;
    const requestIds = [...new Set(targets.flatMap(rallyzIds))];
    if (requestIds.length === 0) return;
    if (requestIds.length > 100) {
      setMessage({ tone: "error", text: "랠리즈 반영 확인은 한 번에 100건(반 기준)까지 할 수 있습니다. 나눠서 골라 주세요." });
      return;
    }
    const ok = await confirm({
      title: `선택 ${targets.length}건 랠리즈 반영 확인`,
      description: (
        <div className="space-y-2">
          <p>랠리즈에 직접 반영을 마친 건만 확인해 주세요. 확인하면 «반영 완료»로 기록됩니다.</p>
          <ul className="max-h-48 list-disc overflow-y-auto pl-5 text-sm">
            {targets.map((row) => (
              <li key={keyOf(row)}>{row.studentName ?? row.title}{row.summary ? ` · ${row.summary}` : ""}</li>
            ))}
          </ul>
        </div>
      ),
      confirmLabel: "확인 처리",
      tone: "primary",
    });
    if (!ok) return;
    startTransition(async () => {
      try {
        const result = await confirmEnrollmentChangesRallyzBulk(requestIds);
        const parts = [`${result.done}건 확인`];
        if (result.skipped.length) parts.push(`${result.skipped.length}건 건너뜀`);
        if (result.failed.length) parts.push(`${result.failed.length}건 실패`);
        const reasons = [...result.failed, ...result.skipped].slice(0, 3).map((item) => `${item.name}: ${item.reason}`);
        const more = result.failed.length + result.skipped.length > 3 ? " 외" : "";
        setSelected(new Set());
        setMessage({
          tone: result.failed.length ? "error" : "ok",
          text: `랠리즈 반영 ${parts.join(" · ")}${reasons.length ? ` — ${reasons.join(" / ")}${more}` : ""}`,
        });
        router.refresh();
      } catch (error) {
        setMessage({ tone: "error", text: adminErrorText(error, "랠리즈 반영 확인을 처리하지 못했습니다. 목록을 새로고침한 뒤 다시 확인해 주세요.") });
      }
    });
  }

  /** 한 줄 행(높이 ≈48px). 행 전체가 상세 열기 버튼 */
  const renderRow = (row: InboxRow) => {
    const key = keyOf(row);
    const bulk = isBulkable(row, rallyzRetired) && row.bucket === "ACTION";
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
          // 저장된 메모를 채워 열고, 사용자가 수정했을 때만 새 값을 저장한다.
          onClick={() => {
            setOpenSelection(row);
            setNote(row.kind === "CONSULT" || row.kind === "PARENT_REQUEST" ? row.ref?.adminNote ?? "" : "");
            setMessage(null);
          }}
          className={`flex min-h-12 min-w-0 flex-1 items-center gap-2 py-1.5 pr-3 text-left hover:bg-[var(--color-academy-soft)] ${gutter ? "pl-0" : "pl-3"}`}
        >
          <span className="hidden w-24 shrink-0 truncate text-xs text-[var(--color-academy-muted)] sm:block">{kindLabel(row.kind)}</span>
          <span className="min-w-0 flex-1 truncate text-sm">
            <b className="font-medium text-[var(--color-academy-ink)]">{row.studentName ?? row.title}</b>
            <span className="text-[var(--color-academy-muted)]">
              {row.studentName ? ` · ${row.title}` : ""}{row.summary ? ` · ${row.summary}` : ""}
            </span>
          </span>
          <span className={`shrink-0 rounded px-2 py-0.5 text-xs ${badgeClass(row)}`}>{row.statusLabel}</span>
          <span className="hidden w-16 shrink-0 text-right text-xs tabular-nums text-[var(--color-academy-muted)] sm:block">{whenLabel(row.createdAt)}</span>
        </button>
      </li>
    );
  };

  return (
    <div className="space-y-2">
      <header className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 md:grid-cols-[auto_minmax(0,1fr)_auto]">
        <AdminPageHeader title="신청함" />
        <nav className="col-span-2 col-start-1 row-start-2 flex min-w-0 gap-1 overflow-x-auto p-0.5 md:col-span-1 md:col-start-2 md:row-start-1" aria-label="신청 종류">
          {INBOX_TABS.map((entry) => {
            const n = counts?.byTab[entry.tab] ?? 0;
            const active = entry.tab === tab;
            return (
              <button
                key={entry.tab}
                type="button"
                aria-pressed={active}
                onClick={() => go({ tab: entry.tab })}
                className={`relative inline-flex min-h-11 shrink-0 items-center gap-1 whitespace-nowrap rounded-lg px-2.5 text-sm font-medium ${active
                  ? "bg-[var(--color-academy-secondary-soft)] text-[var(--color-academy-secondary-ink)] ring-1 ring-inset ring-[var(--color-academy-secondary-strong)]"
                  : "text-[var(--color-academy-ink)] hover:bg-[var(--color-academy-soft)]"}`}
              >
                {entry.label}
                {n > 0 && (
                  <span className={`rounded-full px-1.5 text-xs tabular-nums ${active
                    ? "bg-[var(--color-academy-surface)] text-[var(--color-academy-ink)]"
                    : "bg-[var(--color-academy-warning-soft)] text-[var(--color-academy-warning)]"}`}>
                    <span className="sr-only">처리 필요 </span>{n}
                  </span>
                )}
              </button>
            );
          })}
        </nav>
        <Link href="/admin/inbox/settings" prefetch={false} className="academy-button-secondary col-start-2 row-start-1 min-h-11! min-w-11! justify-center px-0! md:col-start-3" aria-label="신청 설정(유입 통계·안내 설정·입학 점검)" title="신청 설정">
          {/* 2026-11-15 아이콘 예외(설정 = 톱니) — 글자가 없으니 이름은 aria-label */}
          <UiIcon name="settings" size={24} />
        </Link>
      </header>

      {isRowsTab && (
        <div className="flex min-w-0 items-center gap-2">
          <label className="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-xl border border-[var(--color-academy-line-input)] bg-[var(--color-academy-surface)] px-3 sm:max-w-xs">
            <span className="sr-only">원생 이름 검색</span>
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="원생 이름 검색"
              className="min-w-0 flex-1 bg-transparent py-2 text-base text-[var(--color-academy-ink)] outline-none [&::-webkit-search-cancel-button]:appearance-none"
            />
          </label>
          <button type="button" onClick={() => setFilterOpen(true)} className="academy-button-secondary shrink-0" aria-haspopup="dialog">
            필터{filterCount > 0 && <span className="tabular-nums"> {filterCount}</span>}
          </button>
        </div>
      )}

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
                className={`min-h-11 shrink-0 rounded-lg px-3 text-sm font-medium ${active
                  ? "bg-[var(--color-academy-secondary-soft)] text-[var(--color-academy-secondary-ink)] ring-1 ring-inset ring-[var(--color-academy-secondary-strong)]"
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
        <button type="button" onClick={() => go({ kind: null, sub: null })} className="inline-flex min-h-11 items-center gap-1 rounded-full border border-[var(--color-academy-line-input)] bg-[var(--color-academy-surface)] px-3 text-sm font-medium text-[var(--color-academy-ink)]">
          {kindLabel(kind)}만 보기
          <span aria-hidden="true">×</span>
          <span className="sr-only">— 눌러서 {tabLabel(tab)} 전체 보기</span>
        </button>
      )}

      {/* 적용 중인 날짜 필터 한 줄 요약 */}
      {isRowsTab && filterCount > 0 && (
        <p className="text-sm text-[var(--color-academy-muted)]">
          신청일 {from ?? "…"} ~ {to ?? "…"}
          <button type="button" onClick={() => go({ from: null, to: null })} className="academy-button-text ml-2">필터 풀기</button>
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
            <p role="status" className={`rounded px-3 py-2 text-sm font-medium ${message.tone === "ok"
              ? "bg-[var(--color-academy-success-soft)] text-[var(--color-academy-success)]"
              : "bg-[var(--color-academy-danger-soft)] text-[var(--color-academy-danger)]"}`}>{message.text}</p>
          )}
          {(rowsData.failedKinds.length > 0 || rowsData.consultFailed) && (
            <p className="rounded bg-[var(--color-academy-warning-soft)] px-3 py-2 text-sm text-[var(--color-academy-warning)]">
              {rowsData.consultFailed ? "상담" : rowsData.failedKinds.map(kindLabel).join(", ")} 목록을 읽지 못했습니다. 잠시 뒤 새로고침해 주세요.
            </p>
          )}

          {/* 정산은 해당 휴원 신청의 상세에서 이어서 처리한다. */}
          {tab === "CHANGE" && (rowsData.openSettlementCount ?? 0) > 0 && (
            <p className="rounded-lg bg-[var(--color-academy-warning-soft)] px-3 py-2 text-sm font-medium text-[var(--color-academy-warning)]">
              휴원 수강료 처리 대기 {rowsData.openSettlementCount}건 · 신청 상세에서 확인하세요.
            </p>
          )}

          {/* 일괄 처리 줄 — 고른 게 있을 때만 */}
          {selectedRows.length > 0 && (
            <div className="sticky top-14 z-10 flex flex-wrap items-center gap-2 rounded-lg border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] px-3 py-2">
              <span className="text-sm font-medium tabular-nums text-[var(--color-academy-ink)]">{selectedRows.length}건 선택</span>
              <button type="button" onClick={() => setSelected(new Set())} className="academy-button-text">선택 풀기</button>
              <span className="ml-auto flex flex-wrap gap-2">
                {selectedOther.length > 0 && (
                  <button type="button" disabled={pending} onClick={() => void runBulk()} className={selectedRallyz.length > 0 ? "academy-button-secondary" : "academy-button-primary"}>결석 확정·문의 확인함</button>
                )}
                {selectedRallyz.length > 0 && (
                  <button type="button" disabled={pending} onClick={() => void runBulkRallyz()} className="academy-button-primary">선택 {selectedRallyz.length}건 랠리즈 반영 확인</button>
                )}
              </span>
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
                {bulkRallyzCount === bulkRows.length
                  ? `랠리즈 확인 필요 ${bulkRows.length}건 모두 고르기`
                  : bulkRallyzCount > 0
                    ? `일괄 처리 가능 ${bulkRows.length}건 모두 고르기`
                    : `결석 신고·새 문의 ${bulkRows.length}건 모두 고르기`}
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
            <UiIcon name={showDone ? "expand_less" : "expand_more"} />
          </button>
        </>
      )}

      {/* 상세 칸 — PC 오른쪽 패널 · 휴대폰 아래 시트(ListDetailPanel) */}
      {open && (
        <ListDetailPanel onClose={() => setOpenSelection(null)} titleId="inbox-detail-title" panelClassName="p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))]">
          <div className="mb-3 flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <p className="text-xs text-[var(--color-academy-muted)]">{kindLabel(open.kind)} · {whenLabel(open.createdAt)} 신청</p>
              <h2 id="inbox-detail-title" className="mt-1 break-keep text-lg font-bold text-[var(--color-academy-ink)]">
                {open.studentName ? `${open.studentName} · ${open.title}` : open.title}
              </h2>
              {freshOpen && <span className={`mt-1 inline-block rounded px-2 py-0.5 text-xs ${badgeClass(open)}`}>{open.statusLabel}</span>}
            </div>
            <button type="button" onClick={() => setOpenSelection(null)} aria-label="닫기" className="academy-button-text academy-button-sm shrink-0">
              닫기
            </button>
          </div>
          {open.kind === "ENROLLMENT_CHANGE" ? (
            <EnrollmentChangeInboxDetail key={keyOf(open)} requestIds={open.members?.map(({ id }) => id) ?? [open.id]} rallyzRetired={rallyzRetired} />
          ) : (
            <dl className="grid grid-cols-[5rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm">
              {open.facts.map(([label, value]) => (
                <div key={label} className="contents">
                  <dt className="font-medium text-[var(--color-academy-muted)]">{label}</dt>
                  <dd className="whitespace-pre-wrap break-words text-[var(--color-academy-ink)]">{value}</dd>
                </div>
              ))}
            </dl>
          )}
          {SPECIALIZED_KINDS.has(open.kind) && <InboxSpecializedActions key={keyOf(open)} row={open} onChanged={refreshCounts} />}
          {open.kind === "CHILD_LINK" && open.rawStatus === "PENDING" && (
            <p className="mt-3 text-sm text-[var(--color-academy-muted)]">먼저 연결된 보호자가 학부모 화면에서 승인합니다.</p>
          )}
          {open.kind === "SHUTTLE_DAY" && open.rawStatus === "ACTIVE" && (
            <p className="mt-3 text-sm text-[var(--color-academy-muted)]">당일 운행 명단에 자동으로 반영됩니다.</p>
          )}
          {/* 상담 — 보호자에게 바로 전화(휴대폰에서 누르면 전화 앱) */}
          {open.kind === "CONSULT" && open.ref?.phone && (
            <a href={`tel:${open.ref.phone}`} className="academy-button-secondary mt-3">
              전화 걸기
            </a>
          )}
          {wantsNote(open, openActions) && (
            <label className="mt-4 block text-sm font-medium text-[var(--color-academy-ink)]">
              {open.kind === "PARENT_REQUEST" ? "답변(학부모에게 보임)" : open.kind === "CONSULT" ? "원장 메모(학부모에게 안 보임)" : "메모·거절 사유(선택)"}
              <textarea value={note} onChange={(event) => setNote(event.target.value)} rows={2} maxLength={open.kind === "PARENT_REQUEST" ? 2000 : open.kind === "CONSULT" ? 1000 : 500} className="academy-input mt-1 w-full" />
            </label>
          )}
          {message?.tone === "error" && <p role="alert" className="mt-3 text-sm text-[var(--color-academy-danger)]">{message.text}</p>}
          {canDecideStaffRoles && open.kind === "ROLE_GRANT" && open.ref?.role === "INSTRUCTOR"
            && (open.rawStatus === "PENDING" || open.rawStatus === "COACH_LINK_REQUIRED") && (
              <RoleRequestCoachLink
                key={keyOf(open) + ":" + open.rawStatus}
                grantId={open.id}
                status={open.rawStatus === "PENDING" ? "PENDING" : "ACTIVE"}
                disabled={pending}
                onConnected={(text) => {
                  setMessage({ tone: "ok", text });
                  setOpenSelection(null);
                  setNote("");
                  router.refresh();
                }}
              />
          )}
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
  const reversed = Boolean(fromValue && toValue && fromValue > toValue);
  return (
    <AdminModal onClose={onClose} titleId="inbox-filter-title" panelClassName="max-w-lg p-5">
      <h2 id="inbox-filter-title" className="text-lg font-bold text-[var(--color-academy-ink)]">필터</h2>
      <fieldset className="mt-3">
        <legend className="text-sm font-medium text-[var(--color-academy-muted)]">신청일</legend>
        <div className="mt-2 flex items-center gap-2">
          <input type="date" value={fromValue} onChange={(event) => setFromValue(event.target.value)} className="academy-input min-h-11 min-w-0 flex-1" aria-label="신청일 시작" />
          <span className="text-[var(--color-academy-muted)]">~</span>
          <input type="date" value={toValue} onChange={(event) => setToValue(event.target.value)} className="academy-input min-h-11 min-w-0 flex-1" aria-label="신청일 끝" />
        </div>
      </fieldset>
      {reversed && <p role="alert" className="mt-2 text-sm text-[var(--color-academy-danger)]">종료일은 시작일과 같거나 이후여야 합니다.</p>}
      <div className="mt-5 flex items-center gap-2">
        <button type="button" onClick={() => { setFromValue(""); setToValue(""); }} className="academy-button-text">초기화</button>
        <button type="button" onClick={onClose} className="academy-button-secondary ml-auto">닫기</button>
        <button type="button" disabled={reversed} onClick={() => onApply({ from: fromValue || null, to: toValue || null })} className="academy-button-primary">적용</button>
      </div>
    </AdminModal>
  );
}
