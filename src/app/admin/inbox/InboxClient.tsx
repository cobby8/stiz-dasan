"use client";

/**
 * 신청함 화면 (2026-11-10 원장 결정 d1~d4)
 *
 * 왜 이렇게: 원장이 메뉴 11개를 돌며 «새로 온 신청»을 찾았다. 한 화면에 한 줄 행으로 모으고,
 * 상태 탭 3개(처리 필요/진행 중/완료) + «필터» 버튼 하나(모달) + 원생 검색만 둔다(컴팩트 UI 규칙).
 * 행을 누르면 오른쪽 상세 칸(휴대폰은 아래 시트)에서 바로 처리한다 — 처리 함수는 각 화면의 기존 server action 그대로.
 * 결제·환불·미리보기 발송처럼 복잡한 건 «기존 화면에서 열기»로 넘긴다(d3).
 */

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import AdminModal from "@/components/admin/AdminModal";
import ListDetailPanel from "@/components/admin/list/ListDetailPanel";
import { adminErrorText } from "@/components/admin/adminDisplayText";
import { useAdminConfirm, type AdminConfirmOptions } from "@/components/admin/AdminConfirmDialog";
import { kstHm, kstLabel, todayKst, toKstYmd } from "@/lib/datetime/kst";
import {
  BUCKET_LABEL,
  BULK_ACTION_KINDS,
  INBOX_BUCKETS,
  REQUEST_KINDS,
  kindLabel,
  statusBadgeClassFor,
  type InboxBucket,
  type RequestKind,
} from "@/lib/requests/catalog";
import type { InboxCounts, InboxRow } from "@/lib/requests/admin-inbox";
// 처리 = 각 화면이 쓰던 server action 을 그대로 부른다(규칙·권한 검사·알림이 한 벌로 유지된다)
import { decideEnrollmentChange } from "@/app/actions/enrollment-changes";
import { confirmRegularAbsence } from "@/app/actions/regular-absence-admin";
import { updateRequestStatus } from "@/app/actions/admin";
import { decidePaymentRequest } from "@/app/actions/payment-requests";
import { rejectWithdrawalRequest } from "@/app/actions/account-withdrawal-admin";
import { approveRoleRequest, rejectRoleRequest } from "@/app/actions/role-requests-admin";
import { reviewStaffPaymentConfirmation } from "@/app/actions/staff-billing";

type Props = {
  bucket: InboxBucket;
  kinds: RequestKind[];
  from: string | null;
  to: string | null;
  rows: InboxRow[];
  counts: InboxCounts | null;
  failedKinds: RequestKind[];
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

/** 이 행에서 상세 칸에 바로 보일 처리 버튼(없으면 «기존 화면에서 열기»만) */
function actionsFor(row: InboxRow): PanelAction[] {
  const who = row.studentName ?? row.title;
  switch (row.kind) {
    case "ENROLLMENT_CHANGE":
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
      return [{ key: "confirm", label: "결석 확정", look: "primary", run: () => confirmRegularAbsence({ id: row.id }) }];
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
    default:
      // 보강·셔틀 오늘만·특강·카카오·대관·사진 회수 = 기존 화면에서 처리
      return [];
  }
}

/** 메모 칸이 필요한 처리(거절 사유·답변·원장 메모) */
function wantsNote(row: InboxRow, actions: PanelAction[]): boolean {
  return actions.length > 0 && row.kind !== "REGULAR_ABSENCE" && row.kind !== "WITHDRAWAL";
}

/** 일괄 처리(d4) 대상 — 처리 필요 칸의 결석 신고·새 문의만 */
function isBulkable(row: InboxRow): boolean {
  return BULK_ACTION_KINDS.includes(row.kind)
    && ((row.kind === "REGULAR_ABSENCE" && row.rawStatus === "REPORTED") || (row.kind === "PARENT_REQUEST" && row.rawStatus === "PENDING"));
}

function whenLabel(iso: string): string {
  // 오늘이면 시각, 아니면 «11/9(일)» — KST 기준(서버·브라우저 시간대와 무관)
  return toKstYmd(iso) === todayKst() ? kstHm(iso) : kstLabel(iso);
}

export default function InboxClient({ bucket, kinds, from, to, rows, counts, failedKinds }: Props) {
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

  // 주소(필터 상태) 바꾸기 — 서버가 새로 읽는다
  const go = (next: Partial<{ bucket: InboxBucket; kinds: RequestKind[]; from: string | null; to: string | null }>) => {
    const params = new URLSearchParams();
    const b = next.bucket ?? bucket;
    const k = next.kinds ?? kinds;
    const f = next.from === undefined ? from : next.from;
    const t = next.to === undefined ? to : next.to;
    if (b !== "ACTION") params.set("bucket", b);
    if (k.length) params.set("kind", k.join(","));
    if (f) params.set("from", f);
    if (t) params.set("to", t);
    setSelected(new Set());
    router.push(params.size ? `${pathname}?${params}` : pathname);
  };

  // 검색은 이미 받은 줄 안에서(원생 이름·제목·요약)
  const visible = useMemo(() => {
    const q = query.trim();
    if (!q) return rows;
    return rows.filter((row) => `${row.studentName ?? ""} ${row.title} ${row.summary}`.includes(q));
  }, [rows, query]);

  const keyOf = (row: InboxRow) => `${row.kind}:${row.id}`;
  const open = visible.find((row) => keyOf(row) === openId) ?? rows.find((row) => keyOf(row) === openId) ?? null;
  const openActions = open ? actionsFor(open) : [];
  const filterCount = kinds.length + (from || to ? 1 : 0);
  const bulkRows = visible.filter((row) => bucket === "ACTION" && isBulkable(row));
  const selectedRows = bulkRows.filter((row) => selected.has(keyOf(row)));

  const tabCount = (b: InboxBucket) => (b === "ACTION" ? counts?.action : b === "ONGOING" ? counts?.ongoing : undefined);

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

  return (
    <div className="space-y-3">
      {/* 머리 한 줄: 제목 + 검색 + 필터 버튼(컴팩트 — 히어로 없음) */}
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="mr-auto text-xl font-black text-[var(--color-academy-ink)]">신청함</h1>
        {/* 검색 칸 — 신청·상담 화면과 같은 모양(돋보기는 칸 안 왼쪽, 글자와 겹치지 않게 flex 로 나란히) */}
        <label className="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-xl border border-[var(--color-academy-line-input)] bg-[var(--color-academy-surface)] px-3 sm:max-w-xs">
          <span className="sr-only">원생·제목 검색</span>
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
      </div>

      {/* 상태 탭 3개 — 누르는 칩은 둥글게(교과서 6장) */}
      <nav className="flex gap-2 overflow-x-auto" aria-label="신청 상태">
        {INBOX_BUCKETS.map((b) => {
          const n = tabCount(b);
          const active = b === bucket;
          return (
            <button
              key={b}
              type="button"
              aria-pressed={active}
              onClick={() => go({ bucket: b })}
              className={`min-h-11 shrink-0 rounded-full border px-4 text-sm font-bold ${active
                ? "border-[var(--color-academy-primary)] bg-[var(--color-academy-primary)] text-[var(--color-academy-on-primary)]"
                : "border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] text-[var(--color-academy-ink)]"}`}
            >
              {BUCKET_LABEL[b]}{n != null && <span className="ml-1 tabular-nums">{n}</span>}
            </button>
          );
        })}
      </nav>

      {/* 적용 중인 필터 한 줄 요약(누르면 모달) */}
      {filterCount > 0 && (
        <p className="text-sm text-[var(--color-academy-muted)]">
          {kinds.map(kindLabel).join(" · ")}{kinds.length && (from || to) ? " · " : ""}{from || to ? `신청일 ${from ?? "…"} ~ ${to ?? "…"}` : ""}
          <button type="button" onClick={() => go({ kinds: [], from: null, to: null })} className="ml-2 min-h-11 font-bold text-[var(--color-academy-ink)] underline">필터 풀기</button>
        </p>
      )}

      {message && (
        <p role="status" className={`rounded px-3 py-2 text-sm font-bold ${message.tone === "ok"
          ? "bg-[var(--color-academy-success-soft)] text-[var(--color-academy-success)]"
          : "bg-[var(--color-academy-danger-soft)] text-[var(--color-academy-danger)]"}`}>{message.text}</p>
      )}
      {failedKinds.length > 0 && (
        <p className="rounded bg-[var(--color-academy-warning-soft)] px-3 py-2 text-sm text-[var(--color-academy-warning)]">
          {failedKinds.map(kindLabel).join(", ")} 목록을 읽지 못했습니다. 잠시 뒤 새로고침하거나 기존 화면에서 확인해 주세요.
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

      {/* 목록 — 한 줄 행(높이 ≈48px). 행 전체가 상세 열기 버튼 */}
      <section className="overflow-hidden rounded-lg border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)]" aria-label={`${BUCKET_LABEL[bucket]} 신청 목록`}>
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
        {visible.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-[var(--color-academy-muted)]">
            {query ? "검색한 원생의 신청이 없습니다." : bucket === "ACTION" ? "처리할 신청이 없습니다." : "해당 신청이 없습니다."}
          </p>
        ) : (
          <ul className="divide-y divide-[var(--color-academy-line)]">
            {visible.map((row) => {
              const key = keyOf(row);
              const bulk = bucket === "ACTION" && isBulkable(row);
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
                    <span className={`shrink-0 rounded px-2 py-0.5 text-xs font-bold ${statusBadgeClassFor(row.kind, row.rawStatus)}`}>{row.statusLabel}</span>
                    <span className="hidden w-16 shrink-0 text-right text-xs tabular-nums text-[var(--color-academy-muted)] sm:block">{whenLabel(row.createdAt)}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* 상세 칸 — PC 오른쪽 패널 · 휴대폰 아래 시트(ListDetailPanel) */}
      {open && (
        <ListDetailPanel onClose={() => setOpenId(null)} titleId="inbox-detail-title" panelClassName="p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))]">
          <div className="mb-3 flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <p className="text-xs font-bold text-[var(--color-academy-muted)]">{kindLabel(open.kind)} · {whenLabel(open.createdAt)} 신청</p>
              <h2 id="inbox-detail-title" className="mt-1 break-keep text-lg font-black text-[var(--color-academy-ink)]">
                {open.studentName ? `${open.studentName} · ${open.title}` : open.title}
              </h2>
              <span className={`mt-1 inline-block rounded px-2 py-0.5 text-xs font-bold ${statusBadgeClassFor(open.kind, open.rawStatus)}`}>{open.statusLabel}</span>
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
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Link href={open.detailHref} prefetch={false} className="academy-button-text">
              기존 화면에서 열기
              <span className="material-symbols-outlined text-lg" aria-hidden="true">open_in_new</span>
            </Link>
            {/* 위험(거절) 은 왼쪽, 주 버튼은 오른쪽 끝(근접성 — 헷갈려 누르지 않게) */}
            <div className="ml-auto flex flex-wrap gap-2">
              {openActions.map((action) => (
                <button key={action.key} type="button" disabled={pending} onClick={() => void runAction(open, action)} className={BUTTON_CLASS[action.look]}>
                  {action.label}
                </button>
              ))}
            </div>
          </div>
        </ListDetailPanel>
      )}

      {filterOpen && (
        <FilterModal
          kinds={kinds}
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

/** 필터 모달 — 종류 칩 + 신청일 범위. «초기화»·«적용» */
function FilterModal({ kinds, from, to, onClose, onApply }: {
  kinds: RequestKind[];
  from: string | null;
  to: string | null;
  onClose: () => void;
  onApply: (next: { kinds: RequestKind[]; from: string | null; to: string | null }) => void;
}) {
  const [picked, setPicked] = useState<Set<RequestKind>>(new Set(kinds));
  const [fromValue, setFromValue] = useState(from ?? "");
  const [toValue, setToValue] = useState(to ?? "");
  return (
    <AdminModal onClose={onClose} titleId="inbox-filter-title" panelClassName="max-w-lg p-5">
      <h2 id="inbox-filter-title" className="text-lg font-black text-[var(--color-academy-ink)]">필터</h2>
      <fieldset className="mt-3">
        <legend className="text-sm font-bold text-[var(--color-academy-muted)]">종류</legend>
        <div className="mt-2 flex flex-wrap gap-2">
          {REQUEST_KINDS.map((entry) => {
            const on = picked.has(entry.kind);
            return (
              <button
                key={entry.kind}
                type="button"
                aria-pressed={on}
                onClick={() => setPicked((current) => {
                  const next = new Set(current);
                  if (on) next.delete(entry.kind); else next.add(entry.kind);
                  return next;
                })}
                className={`min-h-11 rounded-full border px-3 text-sm font-bold ${on
                  ? "border-[var(--color-academy-primary)] bg-[var(--color-academy-primary)] text-[var(--color-academy-on-primary)]"
                  : "border-[var(--color-academy-line-input)] bg-[var(--color-academy-surface)] text-[var(--color-academy-ink)]"}`}
              >
                {entry.label}
              </button>
            );
          })}
        </div>
      </fieldset>
      <fieldset className="mt-4">
        <legend className="text-sm font-bold text-[var(--color-academy-muted)]">신청일</legend>
        <div className="mt-2 flex items-center gap-2">
          <input type="date" value={fromValue} onChange={(event) => setFromValue(event.target.value)} className="academy-input min-h-11 min-w-0 flex-1" aria-label="신청일 시작" />
          <span className="text-[var(--color-academy-muted)]">~</span>
          <input type="date" value={toValue} onChange={(event) => setToValue(event.target.value)} className="academy-input min-h-11 min-w-0 flex-1" aria-label="신청일 끝" />
        </div>
      </fieldset>
      <div className="mt-5 flex items-center gap-2">
        <button type="button" onClick={() => { setPicked(new Set()); setFromValue(""); setToValue(""); }} className="academy-button-text">초기화</button>
        <button type="button" onClick={onClose} className="academy-button-secondary ml-auto">닫기</button>
        <button
          type="button"
          onClick={() => onApply({ kinds: REQUEST_KINDS.map((k) => k.kind).filter((k) => picked.has(k)), from: fromValue || null, to: toValue || null })}
          className="academy-button-primary"
        >
          적용
        </button>
      </div>
    </AdminModal>
  );
}
