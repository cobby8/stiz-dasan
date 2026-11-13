"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { cancelStaffRoleRequest, requestStaffRoles } from "@/app/actions/role-requests";
import InlineConfirm from "@/components/parent/InlineConfirm";
import { customerMessage } from "@/components/parent/customerMessage";

type RoleRow = { role: "INSTRUCTOR" | "DRIVER"; label: string; state: "ACTIVE" | "PENDING" | "NONE" };

// 각 역할이 무엇을 여는지 — 고르기 전에 알아야 「왜 확인이 필요한지」를 납득한다.
const ROLE_DESCRIPTIONS: Record<RoleRow["role"], string> = {
  INSTRUCTOR: "수업 출결·리포트·학생 연락을 맡습니다. 학생 정보를 보게 되어 원장님 확인이 필요합니다.",
  DRIVER: "셔틀 운행과 승하차 체크를 맡습니다. 배정된 노선의 학생만 보입니다.",
};

export default function RolesClient({
  initial,
  preselected,
}: {
  initial: RoleRow[];
  preselected: RoleRow["role"][];
}) {
  const router = useRouter();
  const [rows, setRows] = useState(initial);
  // 이미 열렸거나 신청 중인 역할은 다시 고를 수 없다.
  const [selected, setSelected] = useState<RoleRow["role"][]>(
    preselected.filter((role) => initial.find((row) => row.role === role)?.state === "NONE"),
  );
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pending, startTransition] = useTransition();

  function toggle(role: RoleRow["role"]) {
    setSelected((current) => (current.includes(role) ? current.filter((value) => value !== role) : [...current, role]));
  }

  function submit() {
    setError("");
    setNotice("");
    startTransition(async () => {
      // 통신 실패는 그 자리 안내(d1) — 고른 역할은 그대로 둔다
      const result = await requestStaffRoles(selected).catch(() => ({ error: "NETWORK" as const }));
      if ("error" in result && result.error === "NETWORK") {
        setError("보내지 못했습니다. 다시 시도해 주세요.");
        return;
      }
      if ("error" in result && result.error) {
        setError(customerMessage(result.error, "신청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요."));
        return;
      }
      setRows((current) =>
        current.map((row) => (selected.includes(row.role) && row.state === "NONE" ? { ...row, state: "PENDING" } : row)),
      );
      setSelected([]);
      setNotice("신청했습니다. 원장님이 확인하면 화면이 열립니다.");
      router.refresh();
    });
  }

  function cancel(role: RoleRow["role"]) {
    setError("");
    setNotice("");
    startTransition(async () => {
      const result = await cancelStaffRoleRequest(role).catch(() => ({ error: "NETWORK" as const }));
      if ("error" in result && result.error === "NETWORK") {
        setError("보내지 못했습니다. 다시 시도해 주세요.");
        return;
      }
      if ("error" in result && result.error) {
        setError(customerMessage(result.error, "신청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요."));
        return;
      }
      setRows((current) => current.map((row) => (row.role === role ? { ...row, state: "NONE" } : row)));
      router.refresh();
    });
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-6">
      <div className="mb-2 flex items-center gap-2">
        {/* 뒤로가기 = 누르는 영역 44×44(academy-back-link) */}
        <Link href="/mypage" aria-label="마이페이지로" className="academy-back-link">
          <span aria-hidden="true">←</span>
        </Link>
        <h1 className="academy-heading">
          역할 추가 신청
        </h1>
      </div>
      {/* 화면 맨 위 설명 한 줄 = 본문 14px */}
      <p className="mb-4 text-sm text-[var(--color-academy-muted)]">
        학원에서 선생님·기사님으로도 일하시면 신청해 주세요. 원장님이 확인하면 한 계정으로 화면을 오갈 수 있습니다.
      </p>

      <div className="mb-4 grid gap-2">
        {rows.map((row) => (
          <div key={row.role} className="flex flex-wrap items-start gap-3 rounded-2xl border border-[var(--color-academy-line)] p-3.5">
            {row.state === "NONE" ? (
              <input
                id={`role-${row.role}`}
                type="checkbox"
                checked={selected.includes(row.role)}
                onChange={() => toggle(row.role)}
                className="mt-1 h-4 w-4 rounded border-[var(--color-academy-line-input)] text-[var(--color-academy-ink)] focus:ring-[var(--color-academy-primary)]"
              />
            ) : null}
            <label htmlFor={`role-${row.role}`} className="min-w-0 flex-1">
              <span className="flex flex-wrap items-center gap-2 text-sm font-medium text-[var(--color-academy-ink)]">
                {row.label}
                {row.state === "ACTIVE" && <span className="rounded bg-[var(--color-academy-success-soft)] px-1.5 py-0.5 text-xs font-normal text-[var(--color-academy-success)]">사용 중</span>}
                {row.state === "PENDING" && <span className="rounded bg-[var(--color-academy-warning-soft)] px-1.5 py-0.5 text-xs font-normal text-[var(--color-academy-warning)]">원장님 확인 중</span>}
              </span>
              <span className="mt-0.5 block text-xs text-[var(--color-academy-muted)]">{ROLE_DESCRIPTIONS[row.role]}</span>
            </label>
            {row.state === "PENDING" && (
              // 신청 취소 = 그 자리 확인(C-M1) 후 기존 cancel(row.role) 그대로
              <InlineConfirm
                label="신청 취소"
                question={`${row.label} 역할 신청을 취소할까요?`}
                confirmLabel="신청 취소하기"
                onConfirm={() => cancel(row.role)}
                pending={pending}
                openClassName="basis-full"
              />
            )}
          </div>
        ))}
      </div>

      {error && (
        <p className="mb-3 rounded-xl bg-[var(--color-academy-danger-soft)] px-3 py-2 text-sm font-medium text-[var(--color-academy-danger)]">{error}</p>
      )}
      {notice && (
        <p role="status" className="mb-3 rounded-xl bg-[var(--color-academy-info-soft)] px-3 py-2 text-sm text-[var(--color-academy-info)]">{notice}</p>
      )}

      {rows.some((row) => row.state === "NONE") && (
        <button
          type="button"
          onClick={submit}
          disabled={selected.length === 0 || pending}
          className="academy-button-primary"
        >
          {pending ? "처리 중..." : "신청하기"}
        </button>
      )}
    </div>
  );
}
