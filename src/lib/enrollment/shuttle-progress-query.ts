import "server-only";
import { prisma } from "@/lib/prisma";
import { hashMessageRecipientPhone } from "@/lib/message-ledger";
import { koreaServiceMonth, isServiceMonth } from "@/lib/regular/serviceMonth";
import { notMergedStudent } from "@/lib/studentVisibility";
import { enrollmentShuttleProgress, requestedShuttleMonth, shuttleDeliveryEventKey, type EnrollmentShuttleProgress, type ShuttleApplication, type ShuttleClass, type ShuttleDelivery, type ShuttleLocation, type ShuttleNotice, type ShuttleRosterRow, type ShuttleRoute } from "./shuttle-progress";

type Db = { $queryRawUnsafe<T>(query: string, ...values: unknown[]): Promise<T> };
// 호출부의 관리자 권한 검사를 유지한다. 조회만 하며 표 생성·자료 보정·발송은 하지 않는다.
export async function getEnrollmentShuttleProgress(applications: ShuttleApplication[], serviceMonth?: string, db: Db = prisma): Promise<Record<string, EnrollmentShuttleProgress>> {
  if (serviceMonth == null) {
    const currentMonth = koreaServiceMonth();
    const groups = new Map<string, ShuttleApplication[]>();
    for (const application of applications) {
      const startMonth = requestedShuttleMonth(application.requestedStartOn);
      const month = startMonth && startMonth > currentMonth ? startMonth : currentMonth;
      groups.set(month, [...(groups.get(month) ?? []), application]);
    }
    const rows = await Promise.all([...groups].map(([month, apps]) => getEnrollmentShuttleProgress(apps, month, db)));
    return Object.assign({}, ...rows);
  }
  if (!isServiceMonth(serviceMonth)) throw new Error("적용 월을 확인해 주세요.");
  const result: Record<string, EnrollmentShuttleProgress> = {};
  const ids = [...new Set(applications.flatMap(a => a.shuttleNeeded && a.convertedStudentId ? [a.convertedStudentId] : []))];
  const classIds = [...new Set(applications.flatMap(a => (a.assignedClassId ?? "").split(",").map(s => s.trim()).filter(Boolean)))];
  if (!ids.length) {
    for (const application of applications) result[application.id] = enrollmentShuttleProgress({ application, serviceMonth, classes: [], locations: [], roster: [], routes: [] });
    return result;
  }
  try {
    // 명단·노선·전달 장부를 같은 시점의 읽기 스냅샷으로 대조한다.
    if (db === prisma) return await prisma.$transaction(tx => getEnrollmentShuttleProgress(applications, serviceMonth, tx), { isolationLevel: "RepeatableRead", timeout: 10_000 });
    // 안내 기능을 아직 사용하지 않은 학원에는 발송 기록표가 없을 수 있다.
    // 표를 만들지 않고 존재 여부만 읽어, 발송 이력 없음과 조회 장애를 구분한다.
    const ledger = await db.$queryRawUnsafe<Array<{ noticeLedger: string | null }>>(`SELECT to_regclass('public."RegularShuttleNoticeBatch"')::text AS "noticeLedger"`);
    const [classes, locations, roster, routes, notices, parents] = await Promise.all([
      db.$queryRawUnsafe<Array<ShuttleClass & { studentId: string }>>(`SELECT c.id,c."dayOfWeek",c."startTime",c."endTime",e."studentId",(e.status='ACTIVE') AS active FROM "Enrollment" e JOIN "Class" c ON c.id=e."classId" WHERE e."studentId"=ANY($1::text[]) AND c.id=ANY($2::text[])`, ids, classIds),
      db.$queryRawUnsafe<ShuttleLocation[]>(`SELECT "studentId",kind,latitude,longitude,"consentVersion","confirmedAt" FROM "StudentShuttleLocation" WHERE "studentId"=ANY($1::text[])`, ids),
      // 전체 명단을 비교해야 다른 정차 변경도 이전 노선 확정의 근거로 사용하지 않는다.
      db.$queryRawUnsafe<ShuttleRosterRow[]>(`SELECT id,"serviceMonth",weekday,direction,"studentId","classTime","arriveTime","stopName",latitude,longitude,"sortOrder" FROM "RegularShuttleStop" WHERE "serviceMonth"=$1 ORDER BY id`, serviceMonth),
      db.$queryRawUnsafe<ShuttleRoute[]>(`SELECT "serviceMonth","dayOfWeek",direction,payload,"classStart","classEnd" FROM "RegularDispatchRoute" WHERE "serviceMonth"=$1`, serviceMonth),
      ledger[0]?.noticeLedger ? db.$queryRawUnsafe<ShuttleNotice[]>(`SELECT "studentId","serviceMonth","stableEventKey","payloadHash",status,"messageBody","recipientPhone","sentAt","createdAt" FROM "RegularShuttleNoticeBatch" WHERE "serviceMonth"=$1 AND "studentId"=ANY($2::text[]) ORDER BY "createdAt" DESC`, serviceMonth, ids) : Promise.resolve([] as ShuttleNotice[]),
      db.$queryRawUnsafe<Array<{ studentId: string; phone: string | null }>>(`SELECT s.id AS "studentId",u.phone FROM "Student" s LEFT JOIN "User" u ON u.id=s."parentId" WHERE s.id=ANY($1::text[]) AND ${notMergedStudent("s")}`, ids),
    ]);
    const hashes = notices.map(n => shuttleDeliveryEventKey(n.payloadHash));
    const deliveries = hashes.length ? await db.$queryRawUnsafe<ShuttleDelivery[]>(`SELECT "stableEventKey",status,"providerStatus","bodyHash","recipientPhoneHash","providerMessageId","sentAt" FROM "NotificationDelivery" WHERE "eventType"='REGULAR_SHUTTLE_CHANGE' AND "stableEventKey"=ANY($1::text[])`, hashes) : [];
    for (const application of applications) result[application.id] = enrollmentShuttleProgress({ application, serviceMonth, classes: classes.filter(c => c.studentId === application.convertedStudentId), locations, roster, routes, notices, deliveries, recipientPhone: parents.find(p => p.studentId === application.convertedStudentId)?.phone, recipientHash: hashMessageRecipientPhone });
  } catch {
    // 미적용된 표나 조회 장애는 미배차/완료로 위장하지 않는다.
    for (const application of applications) result[application.id] = enrollmentShuttleProgress({ application, serviceMonth, classes: [], locations: [], roster: [], routes: [], readFailed: true });
  }
  return result;
}
