/**
 * 보관용 업무 자료 백업 — DB 연결부. 규칙(어떤 표를 담고/빼고/가리는지)은 ./archiveCore.ts 한 곳에 있다.
 * 자동 백업(cron/backup)·즉시 저장(backup-now)·다운로드(admin/backup GET) 세 경로가 같은 함수를 쓴다.
 */
import { prisma } from "@/lib/prisma";
import { collectArchive, DOWNLOAD_MAX_BYTES, serializeBackup, summarizeArchive } from "@/lib/backup/archiveCore";
import type { BackupArchive } from "@/lib/backup/archiveCore";

export { DOWNLOAD_MAX_BYTES, serializeBackup, summarizeArchive };
export type { BackupArchive };

/** DB 의 모든 표(제외 목록 빼고)를 읽어 보관용 묶음을 만든다. 예외를 던지지 않는다. */
export function collectBackupArchive(): Promise<BackupArchive> {
    // PgBouncer 트랜잭션 모드 — $queryRawUnsafe 만 쓴다(CLAUDE.md).
    return collectArchive((sql, ...params) => prisma.$queryRawUnsafe<Record<string, unknown>[]>(sql, ...params));
}
