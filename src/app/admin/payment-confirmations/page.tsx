import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth-guard";
import { reviewStaffPaymentConfirmation } from "@/app/actions/staff-billing";
import AdminPageHeader from "@/components/admin/AdminPageHeader";

export const dynamic = "force-dynamic";

const METHOD_LABEL: Record<string, string> = {
  CASH: "현금",
  BANK_TRANSFER: "계좌이체",
};

export default async function PaymentConfirmationsPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | undefined>>;
}) {
  await requireAdmin();

  const params = (await (searchParams ?? Promise.resolve({}))) as Record<string, string | undefined>;
  const filterClass = params["class"] ?? "";
  const filterMethod = params["method"] ?? "";

  const rows = await prisma.$queryRawUnsafe<
    Array<{
      id: string;
      studentName: string;
      className: string;
      staffName: string;
      method: string;
      amount: number;
      receivedAt: Date;
      note: string | null;
    }>
  >(
    `SELECT r.id, s.name AS "studentName", c.name AS "className",
            u.name AS "staffName", r.method, r.amount, r."receivedAt", r.note
       FROM "StaffPaymentConfirmationRequest" r
       JOIN "Student" s ON s.id = r."studentId"
       JOIN "Class"   c ON c.id = r."classId"
       JOIN "User"    u ON u.id = r."requestedByUserId"
      WHERE r.status = 'PENDING'
      ORDER BY r."createdAt"`,
  );

  const classes = Array.from(new Set(rows.map((r) => r.className))).sort((a, b) =>
    a.localeCompare(b, "ko"),
  );

  const filtered = rows.filter((r) => {
    if (filterClass && r.className !== filterClass) return false;
    if (filterMethod && r.method !== filterMethod) return false;
    return true;
  });

  const totalAmount = filtered.reduce((sum, r) => sum + r.amount, 0);

  return (
    <main className="mx-auto max-w-3xl space-y-4 p-6">
      <AdminPageHeader
        title="수납 확인 요청"
        actions={
          rows.length > 0 ? (
            <div className="rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-warning-soft)] px-4 py-2 text-right text-sm">
              <p className="font-semibold tabular-nums text-[var(--color-academy-warning)]">대기 중 {rows.length}건</p>
              <p className="text-xs tabular-nums text-[var(--color-academy-warning)]">{totalAmount.toLocaleString()}원</p>
            </div>
          ) : undefined
        }
      />

      {/* 필터 — «지금 보는 조건»을 가리키는 탭 칩(보조 색, ✓ 없음). 폼 제출 방식은 그대로 */}
      {rows.length > 0 && (
        <div className="flex flex-wrap gap-2">
          <form className="contents">
            <input type="hidden" name="method" value={filterMethod} />
            <button
              name="class"
              value=""
              className={`academy-choice is-tab ${!filterClass ? "is-selected" : ""}`}
            >
              전체 반
            </button>
            {classes.map((cls) => (
              <button
                key={cls}
                name="class"
                value={cls}
                className={`academy-choice is-tab ${filterClass === cls ? "is-selected" : ""}`}
              >
                {cls}
              </button>
            ))}
            <span className="mx-1 self-center text-[var(--color-academy-faint)]" aria-hidden="true">|</span>
            <button
              name="method"
              value=""
              className={`academy-choice is-tab ${!filterMethod ? "is-selected" : ""}`}
            >
              전체
            </button>
            <button
              name="method"
              value="CASH"
              className={`academy-choice is-tab ${filterMethod === "CASH" ? "is-selected" : ""}`}
            >
              현금
            </button>
            <button
              name="method"
              value="BANK_TRANSFER"
              className={`academy-choice is-tab ${filterMethod === "BANK_TRANSFER" ? "is-selected" : ""}`}
            >
              계좌이체
            </button>
          </form>
        </div>
      )}

      {filtered.length === 0 ? (
        <p className="rounded-xl border border-[var(--color-academy-line)] p-6 text-center text-[var(--color-academy-muted)]">
          {rows.length === 0 ? "대기 중인 수납 확인 요청이 없습니다." : "선택한 조건에 해당하는 요청이 없습니다."}
        </p>
      ) : (
        <div className="space-y-3">
          {filtered.map((r) => (
            <article key={r.id} className="rounded-2xl border border-[var(--color-academy-line)] bg-white p-5">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <h2 className="font-bold text-[var(--color-academy-ink)]">
                    {r.studentName}
                    <span className="ml-2 font-semibold tabular-nums text-[var(--color-academy-ink)]">{r.amount.toLocaleString()}원</span>
                  </h2>
                  <p className="mt-1 text-sm text-[var(--color-academy-muted)]">
                    {r.className} · {r.staffName} 코치 · {METHOD_LABEL[r.method] ?? r.method}
                  </p>
                  <p className="mt-1 text-sm tabular-nums text-[var(--color-academy-muted)]">
                    수납일{" "}
                    {new Intl.DateTimeFormat("ko-KR", {
                      dateStyle: "medium",
                      timeStyle: "short",
                    }).format(r.receivedAt)}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <form
                    action={async () => {
                      "use server";
                      await reviewStaffPaymentConfirmation({ requestId: r.id, decision: "REJECTED" });
                    }}
                  >
                    <button
                      type="submit"
                      className="academy-button-danger"
                    >
                      반려
                    </button>
                  </form>
                  <form
                    action={async () => {
                      "use server";
                      await reviewStaffPaymentConfirmation({ requestId: r.id, decision: "APPROVED" });
                    }}
                  >
                    <button
                      type="submit"
                      className="academy-button-primary"
                    >
                      납부 승인
                    </button>
                  </form>
                </div>
              </div>
              {r.note && (
                <p className="mt-3 rounded-lg bg-[var(--color-academy-soft)] p-3 text-sm text-[var(--color-academy-muted)]">
                  {r.note}
                </p>
              )}
            </article>
          ))}
        </div>
      )}
    </main>
  );
}
