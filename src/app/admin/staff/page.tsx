import StaffClient from "./StaffClient";
import Link from "next/link";
import { getCachedAdminStaffPayload } from "@/lib/adminReadPayloads";

export const revalidate = 30;

export default async function StaffPage() {
    const { staffUsers, coaches, invitations } = await getCachedAdminStaffPayload();

    return (
        <>
        <div className="mx-auto flex max-w-7xl justify-end px-6 pt-4">
            <Link href="/admin/staff/recovery" className="rounded-lg border border-[var(--color-academy-line)] px-3 py-2 text-sm font-bold">중단된 초대 복구</Link>
        </div>
        <StaffClient
            staffUsers={staffUsers}
            coaches={coaches}
            invitations={invitations}
        />
        </>
    );
}
