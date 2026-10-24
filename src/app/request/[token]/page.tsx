import { getParentOperationsLinkPreview, interpretParentOperationsRequest, submitParentOperationsRequest } from "@/app/actions/parent-operations-request";
import ParentRequestForm, { type RequestCommand } from "./ParentRequestForm";

export const dynamic = "force-dynamic";

export default async function ParentOperationsRequestPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const preview = await getParentOperationsLinkPreview(token);

  async function interpretRequest(sourceText: string, targetMonth: string) {
    "use server";
    const result = await interpretParentOperationsRequest(token, sourceText, targetMonth);
    const label = (item: { id?: string; label?: string; classId?: string; className?: string; dayOfWeek?: string; startTime?: string; endTime?: string }) => ({
      id: item.id ?? item.classId ?? "",
      label: item.label ?? `${item.dayOfWeek ?? ""} ${item.className ?? ""} (${item.startTime ?? ""}~${item.endTime ?? ""})`.trim(),
    });
    return { ...result, currentEnrollments: result.currentEnrollments.map((item) => label(item)), availableClasses: result.availableClasses.map((item) => label(item)) };
  }

  async function submitRequest(sourceText: string, targetMonth: string, commands: RequestCommand[]) {
    "use server";
    await submitParentOperationsRequest(token, sourceText, targetMonth, { sourceText, targetMonth, commands: commands as Parameters<typeof submitParentOperationsRequest>[3] extends { commands: infer C } ? C : never });
    return { ok: true as const };
  }

  const activePreview = preview.status === "ACTIVE" ? preview : null;
  return <ParentRequestForm context={{ valid: preview.status === "ACTIVE", linkStatus: preview.status, studentHint: activePreview?.studentName ? `${activePreview.studentName.slice(0, 1)}○${activePreview.studentName.slice(-1)}` : null, expiresAt: activePreview ? new Date(activePreview.expiresAt).toISOString() : null }} interpretRequest={interpretRequest} submitRequest={submitRequest} />;
}
