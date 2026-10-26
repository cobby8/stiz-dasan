import "server-only";
import { createClient } from "@/lib/supabase/server";
import { prisma } from "@/lib/prisma";

export class OwnAccountError extends Error {
  constructor(
    message: string,
    public status = 401,
  ) {
    super(message);
  }
}
export type OwnAccount = {
  appUserId: string;
  appUserName: string;
  appUserRole: string;
  authUserId: string;
};

/** 내 계정 관리에는 자녀·직원 권한이 필요 없다. 서버가 확인한 로그인과 직접 연결된 본인 계정만 연다. */
export async function requireOwnAccount(): Promise<OwnAccount> {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data?.user) throw new OwnAccountError("로그인이 필요합니다.");
  const rows = await prisma.$queryRawUnsafe<
    { id: string; name: string; role: string }[]
  >(
    `SELECT id,name,role::text AS role FROM "User"
      WHERE ("authUserId"=$1 OR ("authUserId" IS NULL AND id=$1)) AND "withdrawnAt" IS NULL LIMIT 2`,
    data.user.id,
  );
  if (rows.length !== 1)
    throw new OwnAccountError(
      "연결된 학원 계정을 확인하지 못했습니다. 다시 로그인해 주세요.",
      403,
    );
  return {
    appUserId: rows[0].id,
    appUserName: rows[0].name,
    appUserRole: rows[0].role,
    authUserId: data.user.id,
  };
}
