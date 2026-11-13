"use client";

import { useEffect, useState, useTransition } from "react";
import { connectRoleRequestCoach, getRoleRequestCoachOptions } from "@/app/actions/role-requests-admin";
import { adminErrorText } from "@/components/admin/adminDisplayText";

type Options = Extract<Awaited<ReturnType<typeof getRoleRequestCoachOptions>>, { linked: unknown }>;

export default function RoleRequestCoachLink({ grantId, status, disabled, onConnected }: {
  grantId: string;
  status: "PENDING" | "ACTIVE";
  disabled: boolean;
  onConnected: (message: string) => void;
}) {
  const [options, setOptions] = useState<Options | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [error, setError] = useState("");
  const [saving, startSaving] = useTransition();

  useEffect(() => {
    let current = true;
    getRoleRequestCoachOptions(grantId).then((result) => {
      if (!current) return;
      if (result.error) setError(result.error);
      else if (result.linked !== undefined) setOptions(result);
    }).catch(() => {
      if (current) setError("코치 목록을 불러오지 못했습니다. 상세를 다시 열어 주세요.");
    });
    return () => { current = false; };
  }, [grantId]);

  const coachId = options?.linked?.id ?? selectedId;
  const approving = status === "PENDING";
  const label = approving ? "승인 및 연결" : "코치 연결";

  function save() {
    setError("");
    startSaving(async () => {
      try {
        const result = await connectRoleRequestCoach(grantId, coachId, status);
        if (result.ok) {
          onConnected(approving ? "선생님 역할을 승인하고 코치 프로필을 연결했습니다." : "코치 프로필을 연결했습니다.");
        } else {
          setError(result.error ?? "코치를 연결하지 못했습니다.");
        }
      } catch (cause) {
        setError(adminErrorText(cause, "코치를 연결하지 못했습니다. 다시 시도해 주세요."));
      }
    });
  }

  return (
    <section aria-label="코치 프로필 연결" className="mt-4 space-y-2 rounded-lg border border-[var(--color-academy-line)] p-3">
      {!options && !error && <p role="status" className="text-sm">코치 목록을 불러오는 중…</p>}
      {options?.phoneLast4 && (
        <p className="text-xs text-[var(--color-academy-muted)]">신청자 휴대폰 끝자리 {options.phoneLast4}</p>
      )}
      {options?.linked ? (
        <p className="text-sm font-medium">연결된 코치 · {options.linked.name} ({options.linked.role})</p>
      ) : options?.options.length ? (
        <label className="block text-sm font-medium">
          기존 코치 프로필
          <select
            value={selectedId}
            onChange={(event) => setSelectedId(event.target.value)}
            disabled={saving || disabled}
            className="academy-input mt-1 min-h-11 w-full min-w-0"
          >
            <option value="">코치를 선택해 주세요</option>
            {options.options.map((coach) => (
              <option key={coach.id} value={coach.id}>
                {coach.name} · {coach.role}{coach.phoneLast4 && " · 끝자리 " + coach.phoneLast4}{coach.matches && " · 이름·번호 일치"}
              </option>
            ))}
          </select>
        </label>
      ) : options && <p className="text-sm">연결할 수 있는 기존 코치 프로필이 없습니다.</p>}
      {error && <p role="alert" className="text-sm text-[var(--color-academy-danger)]">{error}</p>}
      {options?.canConnect && (approving || !options.linked) && (
        <div className="flex justify-end">
          <button type="button" onClick={save} disabled={!coachId || saving || disabled} className="academy-button-primary min-h-11">
            {saving ? "처리 중…" : label}
          </button>
        </div>
      )}
    </section>
  );
}
