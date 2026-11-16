import { PrismaClient } from "@prisma/client";
import { resolveConnectionLimit, withConnectionLimit } from "@/lib/db/connectionLimit";

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient };

// 서버 한 대의 DB 동시 연결 수(2026-11-16 원장 지시로 5 → 10). 접속 주소의 그 항목 하나만 바꿔 넘긴다 —
// 주소(비밀 값)는 읽어서 기록하지 않는다. 주소가 없으면(빌드 등) 기본 설정 그대로 연다.
function createClient(): PrismaClient {
    const url = process.env.DATABASE_URL;
    if (!url) return new PrismaClient();
    const limit = resolveConnectionLimit(process.env.PRISMA_CONNECTION_LIMIT);
    return new PrismaClient({ datasources: { db: { url: withConnectionLimit(url, limit) } } });
}

export const prisma =
    globalForPrisma.prisma || createClient();

if (process.env.NODE_ENV !== "production") {
    globalForPrisma.prisma = prisma;
}
