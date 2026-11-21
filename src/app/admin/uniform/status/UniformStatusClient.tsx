"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { markUniformArrivedAction, markUniformReceivedAction } from "@/app/actions/uniform";
import AdminPageHeader from "@/components/admin/AdminPageHeader";
import { adminErrorText } from "@/components/admin/adminDisplayText";
import StatusCountChips from "@/components/admin/list/StatusCountChips";
import { askConfirm } from "@/components/ui/feedback";
import { TONE_BADGE_CLASS, type StatusTone } from "@/lib/ui/statusTones";
import {
  countUniformBoard,
  filterUniformBoard,
  UNIFORM_ARRIVAL_BATCH_LIMIT,
  UNIFORM_NOTICE_LABEL,
  type UniformBoardFilter,
  type UniformNoticeStatus,
  type UniformStage,
} from "@/lib/uniform/arrivalRules";
import type { UniformStatusView } from "./page";

const STAGE_TONE: Record<UniformStage, StatusTone> = {
  APPLIED: "neutral",
  OWNER_REVIEW: "warning",
  ORDERED: "info",
  ARRIVED: "success",
  RECEIVED: "neutral",
  CANCELED: "neutral",
};

const SOURCE_LABEL = { SITE: "사이트 신청", SHOP: "본사몰" } as const;
const SOURCE_FILTERS: Array<{ value: UniformBoardFilter["source"]; label: string }> = [
  { value: "ALL", label: "전체" },
  { value: "SITE", label: "사이트 신청" },
  { value: "SHOP", label: "본사몰" },
];

function sizeText(item: UniformStatusView) {
  return `${item.topSize || "–"} / ${item.bottomSize || "–"}`;
}

function noticeLabel(status: string | null) {
  if (!status) return null;
  return UNIFORM_NOTICE_LABEL[status as UniformNoticeStatus] ?? status;
}

function describeArrival(result: Awaited<ReturnType<typeof markUniformArrivedAction>>) {
  const parts = [`${result.arrived}건 학원 도착 처리`];
  if (result.notices.SENT) parts.push(`문자 ${result.notices.SENT}건 발송`);
  if (result.notices.FAILED) parts.push(`문자 실패 ${result.notices.FAILED}건`);
  if (result.notices.DISABLED) parts.push(`자동 문자 꺼짐 ${result.notices.DISABLED}건(/admin/sms)`);
  if (result.notices.SKIPPED_NO_STUDENT) parts.push(`학생 미연결 ${result.notices.SKIPPED_NO_STUDENT}건 문자 없음`);
  if (result.notices.SKIPPED_NO_PHONE) parts.push(`보호자 번호 없음 ${result.notices.SKIPPED_NO_PHONE}건`);
  if (result.already) parts.push(`이미 도착 ${result.already}건(다시 안 보냄)`);
  if (result.rejected) parts.push(`처리 안 함 ${result.rejected}건(취소·목록에 없음)`);
  return parts.join(" · ");
}

export default function UniformStatusClient({ initialItems, loadError }: { initialItems: UniformStatusView[]; loadError: string }) {
  const router = useRouter();
  const [progress, setProgress] = useState<UniformBoardFilter["progress"]>("NOT_ARRIVED");
  const [source, setSource] = useState<UniformBoardFilter["source"]>("ALL");
  const [warningsOnly, setWarningsOnly] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const [, startTransition] = useTransition();

  const sourceFiltered = useMemo(
    () => (source === "ALL" ? initialItems : initialItems.filter((item) => item.source === source)),
    [initialItems, source],
  );
  const counts = useMemo(() => countUniformBoard(sourceFiltered), [sourceFiltered]);
  const visible = useMemo(
    () => filterUniformBoard(initialItems, { progress, source, warningsOnly }),
    [initialItems, progress, source, warningsOnly],
  );
  const selectable = visible.filter((item) => item.canArrive);
  const selectedItems = initialItems.filter((item) => selected.has(item.key) && item.canArrive);

  function toggle(key: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function toggleAll() {
    setSelected((current) => {
      const allOn = selectable.length > 0 && selectable.every((item) => current.has(item.key));
      const next = new Set(current);
      for (const item of selectable) {
        if (allOn) next.delete(item.key);
        else next.add(item.key);
      }
      return next;
    });
  }

  async function arrive(items: UniformStatusView[]) {
    const targets = items.filter((item) => item.canArrive);
    if (targets.length === 0) return;
    if (targets.length > UNIFORM_ARRIVAL_BATCH_LIMIT) {
      setFeedback({ type: "error", message: `한 번에 ${UNIFORM_ARRIVAL_BATCH_LIMIT}건까지 도착 처리할 수 있어요.` });
      return;
    }
    const linked = targets.filter((item) => item.linked);
    const students = new Set(linked.map((item) => item.studentName ?? item.key)).size;
    const unlinked = targets.length - linked.length;
    const who = targets.length === 1 ? `${targets[0].studentName || "이름 없음"} 학생 유니폼을` : `유니폼 ${targets.length}건을`;
    const lines = [
      `${who} «학원 도착»으로 표시할까요?`,
      linked.length > 0 ? `학생 ${students}명의 보호자에게 도착 문자가 바로 발송됩니다(학생당 한 통).` : "",
      unlinked > 0 ? `원생과 연결되지 않은 ${unlinked}건은 문자 없이 도착만 표시됩니다.` : "",
      "한 번 보낸 문자는 되돌릴 수 없어요.",
    ].filter(Boolean);
    if (!(await askConfirm(lines.join("\n"), { tone: "primary" }))) return;
    run(async () => {
      const result = await markUniformArrivedAction(targets.map((item) => item.key));
      setSelected(new Set());
      setFeedback({ type: result.notices.FAILED > 0 ? "error" : "success", message: describeArrival(result) });
    });
  }

  async function receive(item: UniformStatusView) {
    if (!(await askConfirm(`${item.studentName || "이 학생"} 학생이 유니폼을 받아 갔나요?\n«수령 완료»로 표시합니다(문자는 보내지 않아요).`))) return;
    run(async () => {
      const result = await markUniformReceivedAction([item.key]);
      setFeedback({ type: "success", message: result.received > 0 ? "수령 완료로 표시했어요." : "이미 수령 처리된 유니폼이에요." });
    });
  }

  function run(task: () => Promise<void>) {
    setBusy(true);
    setFeedback(null);
    startTransition(async () => {
      try {
        await task();
        router.refresh();
      } catch (error) {
        setFeedback({ type: "error", message: adminErrorText(error, "처리 중 문제가 발생했습니다.") });
      } finally {
        setBusy(false);
      }
    });
  }

  const chipItems = [
    { value: "NOT_ARRIVED", label: "미도착", count: counts.notArrived },
    { value: "ARRIVED", label: "도착·수령 대기", count: counts.arrived },
    { value: "RECEIVED", label: "수령 완료", count: counts.received },
  ];
  const allSelected = selectable.length > 0 && selectable.every((item) => selected.has(item.key));

  return (
    <main className="mx-auto max-w-7xl space-y-3">
      <AdminPageHeader
        title="유니폼 신청 현황"
        description={<>전체 <span className="tabular-nums">{counts.total}</span>건 · 경고 <span className="tabular-nums">{counts.warnings}</span>건</>}
        actions={<Link href="/admin/uniform" className="academy-button-secondary">본사 전송 관리</Link>}
      />

      <p className="text-xs text-[var(--color-academy-muted)]">
        신청 → (무료 증정은 원장 확인) → 본사 주문·생산 중 → 학원 도착 → 수령. «학원 도착»을 누르면 그 학생 보호자에게 도착 문자가 갑니다(문구·켜기는 문자·알림 화면).
      </p>

      {loadError && (
        <div className="rounded-xl border border-[var(--color-academy-danger)] bg-[var(--color-academy-danger-soft)] p-3 text-sm font-medium text-[var(--color-academy-danger)]">
          {loadError}
        </div>
      )}
      {feedback && (
        <div role="status" className={`rounded-xl border px-4 py-3 text-sm font-medium ${
          feedback.type === "success"
            ? "border-[var(--color-academy-success)] bg-[var(--color-academy-success-soft)] text-[var(--color-academy-success)]"
            : "border-[var(--color-academy-danger)] bg-[var(--color-academy-danger-soft)] text-[var(--color-academy-danger)]"
        }`}>
          {feedback.message}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <StatusCountChips
          ariaLabel="유니폼 진행 상태별 건수"
          items={chipItems}
          selected={progress}
          onSelect={(value) => { setProgress(value as UniformBoardFilter["progress"]); setSelected(new Set()); }}
          allValue="ALL"
        />
        <div role="group" aria-label="출처" className="flex items-center gap-1">
          {SOURCE_FILTERS.map((option) => (
            <button
              key={option.value}
              type="button"
              aria-pressed={source === option.value}
              onClick={() => { setSource(option.value); setSelected(new Set()); }}
              className={source === option.value ? "academy-button-tonal academy-button-sm" : "academy-button-text academy-button-sm"}
            >
              {option.label}
            </button>
          ))}
        </div>
        <label className="inline-flex items-center gap-1.5 text-sm text-[var(--color-academy-muted)]">
          <input type="checkbox" checked={warningsOnly} onChange={(event) => setWarningsOnly(event.target.checked)} />
          경고만
        </label>
        <button
          type="button"
          className="academy-button-primary ml-auto"
          disabled={busy || selectedItems.length === 0}
          onClick={() => arrive(selectedItems)}
        >
          {busy ? "처리 중…" : `선택 ${selectedItems.length}건 학원 도착`}
        </button>
      </div>

      <section className="overflow-hidden rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] shadow-sm">
        <div className="overflow-x-auto">
          <table className="admin-list-table w-full border-collapse text-sm">
            <thead className="bg-[var(--color-academy-soft)] text-xs font-medium text-[var(--color-academy-muted)]">
              <tr>
                <th className="w-8 px-2 py-2">
                  <input type="checkbox" aria-label="보이는 미도착 줄 모두 고르기" checked={allSelected} disabled={selectable.length === 0} onChange={toggleAll} />
                </th>
                <th className="admin-cell-num px-2 py-2">신청일</th>
                <th className="px-2 py-2">학생</th>
                <th className="admin-cell-num px-2 py-2">등번호</th>
                <th className="hidden px-2 py-2 md:table-cell">디자인</th>
                <th className="px-2 py-2">상 / 하</th>
                <th className="admin-cell-num hidden px-2 py-2 md:table-cell">수량</th>
                <th className="hidden px-2 py-2 md:table-cell">출처</th>
                <th className="px-2 py-2">상태</th>
                <th className="admin-cell-center px-2 py-2">관리</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-academy-line)]">
              {visible.map((item) => {
                const notice = noticeLabel(item.noticeStatus);
                return (
                  <tr key={item.key} className="align-top">
                    <td className="px-2 py-1.5">
                      {item.canArrive && (
                        <input type="checkbox" aria-label={`${item.studentName || "이름 없음"} 고르기`} checked={selected.has(item.key)} onChange={() => toggle(item.key)} />
                      )}
                    </td>
                    <td className="admin-cell-num px-2 py-1.5 text-[var(--color-academy-muted)]">{item.appliedYmd}</td>
                    <td className="px-2 py-1.5">
                      <p className="font-semibold text-[var(--color-academy-ink)]">{item.studentName || "이름 없음"}</p>
                      {item.classNames.length > 0 && <p className="text-xs text-[var(--color-academy-muted)]">{item.classNames.join(", ")}</p>}
                      {item.warnings.map((warning) => (
                        <p key={warning.code} className="text-xs font-medium text-[var(--color-academy-danger)]">⚠ {warning.message}</p>
                      ))}
                    </td>
                    <td className="admin-cell-num px-2 py-1.5">{item.backNumber ? `#${item.backNumber.replace(/^#+/, "")}` : "–"}</td>
                    <td className="hidden px-2 py-1.5 text-[var(--color-academy-muted)] md:table-cell">
                      {item.design || "–"}
                      {item.printName && <span className="block text-xs">인쇄 {item.printName}</span>}
                    </td>
                    <td className="px-2 py-1.5">{sizeText(item)}</td>
                    <td className="admin-cell-num hidden px-2 py-1.5 md:table-cell">{item.quantity}벌</td>
                    <td className="hidden px-2 py-1.5 text-[var(--color-academy-muted)] md:table-cell">
                      {SOURCE_LABEL[item.source]}
                      {item.isFree && <span className="block text-xs text-[var(--color-academy-info)]">무료 증정</span>}
                    </td>
                    <td className="px-2 py-1.5">
                      <span className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs ${TONE_BADGE_CLASS[STAGE_TONE[item.stage]]}`}>
                        {item.stageLabel}
                      </span>
                      {notice && <p className="mt-0.5 text-xs text-[var(--color-academy-muted)]">{notice}</p>}
                    </td>
                    <td className="admin-cell-center px-2 py-1.5">
                      {item.canArrive && (
                        <button type="button" className="academy-button-tonal academy-button-sm" disabled={busy} onClick={() => arrive([item])}>
                          학원 도착
                        </button>
                      )}
                      {item.canReceive && (
                        <button type="button" className="academy-button-secondary academy-button-sm" disabled={busy} onClick={() => receive(item)}>
                          수령 완료
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
              {visible.length === 0 && (
                <tr>
                  <td colSpan={10} className="px-4 py-4 text-center text-sm text-[var(--color-academy-muted)]">표시할 유니폼 신청이 없습니다.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
