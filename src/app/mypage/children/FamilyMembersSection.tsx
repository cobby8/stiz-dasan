"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import InlineConfirm from "@/components/parent/InlineConfirm";
import { customerMessage } from "@/components/parent/customerMessage";
import { listMyFamily, revokeMyFamilyMember } from "@/app/actions/child-edit";
import type { FamilyOfChild } from "@/lib/account/family-access-parent";

// «연결된 가족» 칸 (2026-11-14 원장 결정 b7) — 자녀·가족 연결 화면 위쪽.
// 아이마다 대표 보호자와 연결된 가족을 이름·관계만 보인다(전화번호 없음).
// 끊기 버튼은 그 아이의 «대표 보호자»에게만 보인다(서버도 같은 조건으로 다시 확인). 대표 보호자 변경은 없다.

export default function FamilyMembersSection() {
  const router = useRouter();
  const [family, setFamily] = useState<FamilyOfChild[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    setFamily(await listMyFamily().catch(() => []));
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function revoke(studentId: string, accessId: string, name: string) {
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await revokeMyFamilyMember(studentId, accessId);
      // 서버가 준 안내만 보이고, 고객용 문장이 아니면 준비한 문장으로 바꾼다
      if (!result.ok) { setError(customerMessage(result.error, "처리하지 못했어요. 잠시 후 다시 시도해 주세요.")); return; }
      setNotice(`${name}님의 연결을 끊었어요.`);
      await load();
      router.refresh();
    } catch {
      setError("처리하지 못했어요. 잠시 후 다시 시도해 주세요.");
    } finally {
      setBusy(false);
    }
  }

  // 아이가 없거나 아직 못 읽었으면 칸을 그리지 않는다(연결 화면의 다른 칸은 그대로)
  if (!family || family.length === 0) return null;
  return (
    <section className="academy-panel overflow-hidden" aria-labelledby="family-members-title">
      <h2 id="family-members-title" className="academy-section-title px-4 pt-3">연결된 가족</h2>
      {error && <p role="alert" className="px-4 pt-1 text-sm text-[var(--color-academy-danger)]">{error}</p>}
      {notice && <p role="status" className="px-4 pt-1 text-sm text-[var(--color-academy-success)]">{notice}</p>}
      <div className="mt-2 divide-y divide-[var(--color-academy-line)]">
        {family.map((child) => (
          <div key={child.studentId} className="px-4 py-2">
            <h3 className="text-sm font-semibold text-[var(--color-academy-ink)]">{child.studentName}</h3>
            <ul>
              {/* 대표 보호자 — 청구·연결 승인의 기준(여기서 바꾸지 않는다) */}
              <li className="flex min-h-11 items-center gap-2 text-sm">
                <span className="min-w-0 flex-1 break-keep text-[var(--color-academy-ink)]">
                  {child.representativeName?.trim() || "보호자"}
                  {child.meIsRepresentative ? " (나)" : ""}
                </span>
                <span className="shrink-0 rounded bg-[var(--color-academy-primary-soft)] px-1.5 py-0.5 text-xs text-[var(--brand-accent)]">대표 보호자</span>
              </li>
              {child.members.map((member, index) => (
                <li key={member.accessId ?? `${member.name}-${index}`} className="flex min-h-11 flex-wrap items-center gap-2 text-sm">
                  <span className="min-w-0 flex-1 break-keep text-[var(--color-academy-ink)]">
                    {member.name}
                    {member.isMe ? " (나)" : ""}
                    <span className="ml-2 text-xs text-[var(--color-academy-muted)]">{member.relation}</span>
                  </span>
                  {/* 끊기 = 대표 보호자만. 그 자리 확인 뒤 실행 */}
                  {child.meIsRepresentative && member.accessId && (
                    <InlineConfirm
                      label="연결 끊기"
                      ariaLabel={`${member.name} 연결 끊기`}
                      question={`${member.name}님이 ${child.studentName}의 수업·출결·납부를 더 볼 수 없게 돼요.`}
                      confirmLabel="연결 끊기"
                      pending={busy}
                      openClassName="basis-full"
                      onConfirm={() => revoke(child.studentId, member.accessId as string, member.name)}
                    />
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}
