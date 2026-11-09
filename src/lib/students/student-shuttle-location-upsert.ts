/**
 * 학생 셔틀 탑승·하차 위치(StudentShuttleLocation) 저장 한 곳 (2026-11-09 원생 등록 재설계로 추출).
 *
 * ■ 왜 따로 두는가
 *   신청서 승인(approveEnrollApplication)이 학부모가 지도에서 확인한 위치를 학생에게 복사하던 SQL 을
 *   새 «원생 등록»(registerStudent)도 그대로 써야 한다. 같은 INSERT … ON CONFLICT 를 두 군데 두지 않으려고
 *   이 파일로 옮겼다. SQL 은 승인 경로에 있던 원문 그대로다(테스트로 고정).
 *
 * ■ 이 파일은 prisma·next 를 import 하지 않는다 — db 를 인자로 받아 가짜 db 로 실행 검증한다.
 */

type Writer = { $executeRawUnsafe(sql: string, ...values: unknown[]): Promise<number> };

/** 저장할 위치 한 건 — 값 검증은 부르는 쪽 몫(승인 경로는 신청서 검증, 등록 경로는 normalizeRegisterLocation) */
export type StudentShuttleLocationRow = {
    studentId: string;
    kind: "PICKUP" | "DROPOFF";
    /** 장소명(라벨). 없으면 도로명 → 지번 순으로 대신 쓴다 */
    name: unknown;
    address: unknown;
    roadAddress: unknown;
    latitude: unknown;
    longitude: unknown;
    placeId: unknown;
    source: unknown;
    accuracyMeters: unknown;
    confirmedAt: unknown;
    consentVersion: unknown;
};

/** 승인 경로에서 옮겨 온 SQL 원문 — ($12 = 장소명) */
export const STUDENT_SHUTTLE_LOCATION_UPSERT_SQL = `INSERT INTO "StudentShuttleLocation" (
                    id, "studentId", kind, name, address, "roadAddress",
                    latitude, longitude, "placeId", source, "accuracyMeters",
                    "confirmedAt", "consentVersion", "createdAt", "updatedAt"
                 ) VALUES (
                    gen_random_uuid()::text, $1, $2, $12, $3, $4,
                    $5, $6, $7, $8, $9, $10::timestamptz, $11, NOW(), NOW()
                 )
                 ON CONFLICT ("studentId", kind) DO UPDATE SET
                    name = EXCLUDED.name,
                    address = EXCLUDED.address,
                    "roadAddress" = EXCLUDED."roadAddress",
                    latitude = EXCLUDED.latitude,
                    longitude = EXCLUDED.longitude,
                    "placeId" = EXCLUDED."placeId",
                    source = EXCLUDED.source,
                    "accuracyMeters" = EXCLUDED."accuracyMeters",
                    "confirmedAt" = EXCLUDED."confirmedAt",
                    "consentVersion" = EXCLUDED."consentVersion",
                    "updatedAt" = NOW()`;

/** [트랜잭션 안에서] 위치 한 건을 학생에게 저장(있으면 갱신). 인자 순서는 승인 경로와 같다. */
export function upsertStudentShuttleLocation(tx: Writer, row: StudentShuttleLocationRow) {
    return tx.$executeRawUnsafe(
        STUDENT_SHUTTLE_LOCATION_UPSERT_SQL,
        row.studentId,
        row.kind,
        row.address,
        row.roadAddress,
        row.latitude,
        row.longitude,
        row.placeId,
        row.source,
        row.accuracyMeters,
        row.confirmedAt,
        row.consentVersion,
        // $12: 장소명 — 비어 있으면 도로명주소 → 지번주소 순으로 대신 쓴다(name null 방지, 승인 경로와 같음)
        row.name ?? row.roadAddress ?? row.address,
    );
}
