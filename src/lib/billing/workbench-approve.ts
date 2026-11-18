/**
 * «승인 대기» 자동 초안 한꺼번에 발행(2026-11-17 PM 결정 — 원장 목표 «눈으로 보고 승인 버튼만»).
 *
 * ■ 무엇을 하나
 *   원장이 청구 준비 화면 맨 위 «승인 대기»에서 본 자동 초안(청구일 cron 이 만든 초안)을
 *   기존 경로 그대로 «저장(원장 이름으로) → 확정 → 사이트 발행» 한다. 새 발행 코드는 없다 — 전부 mutateWorkbench.
 *   학부모 알림·결제 링크 발송은 하지 않는다(mutateWorkbench 의 ISSUE 도 외부 발송이 없다).
 *
 * ■ 왜 먼저 «저장»을 다시 하나
 *   확정·발행은 «최신 원본(sourceVersion)으로 저장된 초안»만 받는다. 자동 초안을 만든 뒤 원본이 바뀌었을 수 있고,
 *   한 행을 발행하면 그 달 청구가 바뀌어 원본 지문도 바뀐다. 그래서 묶음마다 원장이 화면에서 본 금액 그대로
 *   다시 저장(= 원장 승인 기록)하고 곧바로 확정·발행한다.
 *
 * ■ 하나가 실패해도 나머지는 처리
 *   전체를 한 거래 안에서 처리하고, 묶음(저장+확정+발행)마다 SAVEPOINT 를 건다. 묶음이 실패하면 그 묶음만 되돌리고
 *   반으로 나눠 다시 시도한다 — 끝까지 실패하는 행만 실패 목록에 남는다. 각 행은 «저장·확정·발행 전부 또는 아무것도».
 *
 * ⚠️ 원장이 본 원본 지문(sourceVersion)이 지금과 다르면 아무것도 하지 않고 «새로 조회»를 요구한다.
 */
import { mutateWorkbench, readWorkbench, type WorkbenchDb, type WorkbenchTx } from "./workbench-service";
import { WorkbenchError, isApprovableAutoDraft, shuttleRosterMissingMessage, shuttleUnlinkedMessage, validateWorkbenchMonth, type WorkbenchCalendarSnapshot, type WorkbenchRow, type WorkbenchView } from "./workbench";

export const APPROVE_AUTO_DRAFTS_ACTION = "APPROVE_AUTO_DRAFTS";
/** 원장 승인으로 다시 저장할 때 남기는 사유(감사 기록) */
export const APPROVE_REASON = "원장 승인 — 자동 초안 금액 그대로 발행";

export type ApproveCommand = { month: string; sourceVersion: string; requestId: string; rows: Array<{ id: string; expectedVersion: number }> };
export type ApproveFailure = { id: string; studentName: string; className: string; reason: string };
export type ApproveResult = { view: WorkbenchView; operationResult: { requestId: string; action: string; rowIds: string[]; paymentIds: string[]; zeroCount: number }; failures: ApproveFailure[] };

/** 요청 모양 검사 — 원장이 화면에서 본 행 id·버전만 받는다(금액은 서버의 현재 계산을 쓴다) */
export function validateApproveCommand(input: unknown): ApproveCommand {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new WorkbenchError("요청 내용을 확인해 주세요.");
  const b = input as Record<string, unknown>;
  if (b.action !== APPROVE_AUTO_DRAFTS_ACTION) throw new WorkbenchError("요청 내용을 확인해 주세요.");
  const month = validateWorkbenchMonth(b.month);
  // 요청 번호에 접미사(-s0 등)를 붙여 내부 명령 번호로 쓰므로 90자까지만 받는다
  if (typeof b.sourceVersion !== "string" || !/^[a-f0-9]{64}$/.test(b.sourceVersion) || typeof b.requestId !== "string" || !/^[a-zA-Z0-9_-]{8,90}$/.test(b.requestId)) throw new WorkbenchError("검토 내용을 다시 조회해 주세요.");
  if (!Array.isArray(b.rows) || !b.rows.length || b.rows.length > 500) throw new WorkbenchError("발행할 청구를 1~500개 선택해 주세요.");
  const seen = new Set<string>();
  const rows = b.rows.map((r: unknown) => {
    const row = r as { id?: unknown; expectedVersion?: unknown };
    if (!row || typeof row !== "object" || typeof row.id !== "string" || row.id.length > 300 || seen.has(row.id) || !Number.isSafeInteger(row.expectedVersion) || (row.expectedVersion as number) < 0 || Object.keys(row).some((k) => k !== "id" && k !== "expectedVersion")) throw new WorkbenchError("중복 항목 또는 이전 버전이 포함되어 있습니다.");
    seen.add(row.id);
    return { id: row.id, expectedVersion: row.expectedVersion as number };
  });
  if (Object.keys(b).some((k) => !["action", "month", "sourceVersion", "requestId", "rows"].includes(k))) throw new WorkbenchError("허용되지 않은 요청입니다.");
  return { month, sourceVersion: b.sourceVersion, requestId: b.requestId, rows };
}

/** 바깥 거래 안에서 mutateWorkbench 를 SAVEPOINT 로 감싸 돌린다 — 실패하면 그 부분만 되돌린다 */
function savepointDb(tx: WorkbenchTx): WorkbenchDb & { attempt<T>(work: () => Promise<T>): Promise<T> } {
  let seq = 0;
  const attempt = async <T,>(work: () => Promise<T>): Promise<T> => {
    const name = `approve_sp_${++seq}`;
    await tx.$executeRawUnsafe(`SAVEPOINT ${name}`);
    try { const result = await work(); await tx.$executeRawUnsafe(`RELEASE SAVEPOINT ${name}`); return result; }
    catch (error) { await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT ${name}`); throw error; }
  };
  // mutateWorkbench 가 여는 «거래»는 바깥 거래 안의 SAVEPOINT 가 된다(격리 수준 인자는 바깥 거래가 이미 정했다)
  return { attempt, $transaction: (work) => attempt(() => work(tx)) };
}

const errorMessage = (error: unknown) => error instanceof WorkbenchError ? error.message : "발행하지 못했습니다. 다시 시도해 주세요.";

/**
 * 자동 초안 한꺼번에 발행. 권한(원장)·쓰기 스위치는 부르는 쪽(API)이 먼저 확인하고, 여기서도 스위치를 다시 본다.
 * @param db prisma 또는 같은 모양(거래 한 번)
 */
export async function approveAutoDrafts(db: WorkbenchDb, input: unknown, actorId: string, writesEnabled = false, calendar?: WorkbenchCalendarSnapshot): Promise<ApproveResult> {
  if (!writesEnabled) throw new WorkbenchError("청구 준비 저장은 운영 적용 승인 전까지 잠겨 있습니다.", 503);
  if (!actorId) throw new WorkbenchError("관리자 확인이 필요합니다.", 403);
  const command = validateApproveCommand(input);
  return db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext('STIZ_BILLING_WORKBENCH'))`);
    const original = await readWorkbench(tx, command.month, writesEnabled, calendar);
    if (!original.storageReady) throw new WorkbenchError("청구 준비 저장 구조를 먼저 확인해 주세요.", 503);
    // 그 달 셔틀 명단이 없으면 셔틀비가 0원으로 계산돼 있다 — 한 건도 발행하지 않는다(검수 B-1)
    if (original.shuttleRosterMissing) throw new WorkbenchError(shuttleRosterMissingMessage(command.month, "APPROVE"), 409);
    // 셔틀 명단에 누군지 모르는 «이름만» 기록이 있으면 그 아이 셔틀비가 0원으로 빠졌을 수 있다 — 한 건도 발행하지 않는다(재검수 C-1)
    if (original.shuttleUnlinkedNames?.length) throw new WorkbenchError(shuttleUnlinkedMessage(command.month, original.shuttleUnlinkedNames, "APPROVE"), 409);
    // 원장이 본 화면과 지금 자료가 다르면 아무것도 하지 않는다(본 금액과 다른 금액이 나갈 수 있다)
    if (original.sourceVersion !== command.sourceVersion) throw new WorkbenchError("수강·출결·청구 자료가 변경됐습니다. 다시 조회해 주세요.", 409, true);

    const failures: ApproveFailure[] = [];
    const fail = (row: Pick<WorkbenchRow, "id" | "studentName" | "className">, reason: string) => failures.push({ id: row.id, studentName: row.studentName, className: row.className, reason });
    const candidates: WorkbenchRow[] = [];
    for (const wanted of command.rows) {
      const row = original.rows.find((r) => r.id === wanted.id);
      if (!row) { failures.push({ id: wanted.id, studentName: "", className: "", reason: "청구 목록에 없는 항목입니다. 다시 조회해 주세요." }); continue; }
      if (row.version !== wanted.expectedVersion) { fail(row, "다른 작업에서 변경한 청구입니다. 다시 조회해 주세요."); continue; }
      if (!isApprovableAutoDraft(row)) { fail(row, row.blockingReasons[0] ?? "자동 초안 승인 대상이 아닙니다. 행을 열어 확인해 주세요."); continue; }
      candidates.push(row);
    }
    // 같은 학생의 행은 같은 묶음에 오도록(셔틀비 «학생당 한 청구»·이월 합계 검사가 학생 단위다)
    candidates.sort((a, b) => a.studentId.localeCompare(b.studentId) || a.id.localeCompare(b.id));

    const sp = savepointDb(tx);
    let current = original;
    let step = 0;
    const operationResult = { requestId: command.requestId, action: APPROVE_AUTO_DRAFTS_ACTION, rowIds: [] as string[], paymentIds: [] as string[], zeroCount: 0 };
    // 묶음 하나 = 원장 이름으로 다시 저장 → 확정 → 발행. 금액은 원장이 본 화면(original)의 값 그대로.
    const runBatch = (batch: WorkbenchRow[]) => sp.attempt(async () => {
      const n = ++step;
      const versionOf = (view: WorkbenchView, id: string) => {
        const row = view.rows.find((r) => r.id === id);
        if (!row) throw new WorkbenchError("청구 목록에서 사라진 항목입니다. 다시 조회해 주세요.", 409, true);
        return row.version;
      };
      let view = current;
      ({ view } = await mutateWorkbench(sp, { action: "SAVE", month: command.month, sourceVersion: view.sourceVersion, requestId: `${command.requestId}-s${n}`,
        rows: batch.map((row) => ({ id: row.id, expectedVersion: versionOf(view, row.id), baseAmount: row.baseAmount, discountAmount: row.discountAmount,
          prorationAmount: row.prorationAmount, carryAmount: row.carryAmount, shuttleAmount: row.shuttleAmount, reason: APPROVE_REASON,
          periodStart: row.periodStart!.slice(0, 10), periodEnd: row.periodEnd!.slice(0, 10) })) }, actorId, true, calendar));
      ({ view } = await mutateWorkbench(sp, { action: "CONFIRM", month: command.month, sourceVersion: view.sourceVersion, requestId: `${command.requestId}-c${n}`,
        rows: batch.map((row) => ({ id: row.id, expectedVersion: versionOf(view, row.id) })) }, actorId, true, calendar));
      const issued = await mutateWorkbench(sp, { action: "ISSUE", month: command.month, sourceVersion: view.sourceVersion, requestId: `${command.requestId}-i${n}`,
        rows: batch.map((row) => ({ id: row.id, expectedVersion: versionOf(view, row.id) })) }, actorId, true, calendar);
      return issued;
    });
    // 실패하면 반으로 나눠 다시 — 끝까지 실패하는 한 행만 실패 목록으로
    const processBatch = async (batch: WorkbenchRow[]): Promise<void> => {
      if (!batch.length) return;
      try {
        const issued = await runBatch(batch);
        current = issued.view;
        operationResult.rowIds.push(...issued.operationResult.rowIds);
        operationResult.paymentIds.push(...issued.operationResult.paymentIds);
        operationResult.zeroCount += issued.operationResult.zeroCount;
      } catch (error) {
        // DB 오류(직렬화 충돌 40001·교착 40P01·거래 끊김 등)는 쪼개도 소용없다 — 바로 전체를 되돌리고 «다시 시도»(검수 B-3)
        if (!(error instanceof WorkbenchError)) {
          console.error("[approveAutoDrafts] DB 오류로 전체 중단:", error instanceof Error ? error.message : error);
          throw new WorkbenchError("발행 중 일시적인 문제가 생겨 아무것도 발행하지 않았습니다. 잠시 뒤 다시 시도해 주세요.", 503, true);
        }
        if (batch.length === 1) { fail(batch[0], errorMessage(error)); return; }
        const half = Math.ceil(batch.length / 2);
        await processBatch(batch.slice(0, half));
        await processBatch(batch.slice(half));
      }
    };
    await processBatch(candidates);
    return { view: current, operationResult, failures };
  }, { isolationLevel: "Serializable", timeout: 55_000 });
}
