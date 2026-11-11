import { redirect } from "next/navigation";

export default function TrialCrmPage() {
    redirect("/admin/inbox?tab=TRIAL");
}
