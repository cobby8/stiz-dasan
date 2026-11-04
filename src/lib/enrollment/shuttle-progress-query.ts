import "server-only";
import { prisma } from "@/lib/prisma";
import { hashMessageRecipientPhone } from "@/lib/message-ledger";
import { koreaServiceMonth, isServiceMonth } from "@/lib/regular/serviceMonth";
import { notMergedStudent } from "@/lib/studentVisibility";
import { confirmedEtaMin } from "@/lib/shuttle/confirmedEta";
import { planLocationKey } from "@/lib/shuttle/routePlanning";
import { routeRecipientKey } from "./route-plan-recipient";
import { enrollmentShuttleProgress, requestedShuttleMonth, shuttleDeliveryEventKey, type EnrollmentShuttleProgress, type ShuttleApplication, type ShuttleClass, type ShuttleDelivery, type ShuttleLocation, type ShuttleNotice, type ShuttleRosterRow, type ShuttleRoute } from "./shuttle-progress";

type Db = { $queryRawUnsafe<T>(query: string, ...values: unknown[]): Promise<T> };
type PlanDelivery = { studentId: string; recipientKey: string; recipientPhone: string; status: string; providerId: string | null; updatedAt: string; entries: Array<{ dayOfWeek: string; direction: string; timeMin: number; locationKey: string }> };
const records = (value: unknown): Record<string, unknown>[] => Array.isArray(value) ? value.filter(item => item && typeof item === "object") : [];
// 신규 안내도 현재 보호자·실제 확정 구간과 맞는 전달 근거만 사용한다.
function applyPlanDelivery(progress: EnrollmentShuttleProgress, studentId: string | null, parent: { phone: string | null; parentId?: string | null } | undefined, routes: ShuttleRoute[], deliveries: PlanDelivery[]): EnrollmentShuttleProgress {
  if (!studentId || !["NOTICE_PENDING", "NOTICE_ACCEPTED", "COMPLETE"].includes(progress.status)) return progress;
  const latest = deliveries.find(item => item.studentId === studentId);
  if (!latest) return progress;
  const sameRecipient = Boolean(parent?.parentId && parent.phone) && latest.recipientKey === routeRecipientKey(parent!.parentId!, parent!.phone!) && latest.recipientPhone.replace(/\D/g, "") === parent!.phone!.replace(/\D/g, "");
  const coversCurrent = sameRecipient && Array.isArray(latest.entries) && progress.legs.every(leg => {
    const matches = routes.filter(route => route.dayOfWeek === leg.dayOfWeek && route.direction === leg.direction).flatMap(route => records((route.payload as { vehicles?: unknown })?.vehicles).flatMap(vehicle => records(vehicle.stops).filter(stop => records(stop.students).some(rider => rider.requestId === studentId))));
    if (matches.length !== 1) return false;
    const stop = matches[0], eta = confirmedEtaMin(stop);
    const locationKey = planLocationKey({ id: "progress-proof", label: String(stop.label ?? ""), lat: stop.lat as number, lng: stop.lng as number });
    return eta != null && locationKey !== "INVALID_LOCATION" && latest.entries.some(entry => entry.dayOfWeek === leg.dayOfWeek && entry.direction === leg.direction && entry.timeMin === eta && entry.locationKey === locationKey);
  });
  const delivered = coversCurrent && latest.status === "DELIVERED" && Boolean(latest.providerId && latest.updatedAt);
  const accepted = coversCurrent && latest.status === "ACCEPTED" && Boolean(latest.providerId);
  const status = delivered ? "COMPLETE" : accepted ? "NOTICE_ACCEPTED" : "NOTICE_PENDING";
  const label = delivered ? "안내 완료" : accepted ? "발송 접수·전달 미확인" : "안내 발송 대기";
  const detail = delivered ? `${progress.serviceMonth} · 현재 보호자에게 확정된 모든 구간의 안내 전달을 확인했습니다.` : accepted ? `${progress.serviceMonth} · 발송은 접수됐으며 최종 전달 결과는 아직 확인되지 않았습니다.` : !coversCurrent ? "현재 보호자·배차에 맞는 안내를 다시 확인해 주세요." : ["FAILED", "UNKNOWN"].includes(latest.status) ? "문자 발송 결과를 확인해 주세요. 자동 재발송하지 않습니다." : "배차는 확정됐으며 안내 발송을 기다리고 있습니다.";
  return { ...progress, status, label, detail, legs: progress.legs.map(leg => ({ ...leg, status, label: leg.label.replace(/ · .*$/, ` · ${label}`) })) };
}
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
    const ledger = await db.$queryRawUnsafe<Array<{ noticeLedger: string | null; routeNoticeLedger?: string | null }>>(`SELECT to_regclass('public."RegularShuttleNoticeBatch"')::text AS "noticeLedger",to_regclass('public."RegularRouteNoticeOutbox"')::text AS "routeNoticeLedger"`);
    const [classes, locations, roster, routes, notices, parents] = await Promise.all([
      db.$queryRawUnsafe<Array<ShuttleClass & { studentId: string }>>(`SELECT c.id,c."dayOfWeek",c."startTime",c."endTime",e."studentId",(e.status='ACTIVE') AS active FROM "Enrollment" e JOIN "Class" c ON c.id=e."classId" WHERE e."studentId"=ANY($1::text[]) AND c.id=ANY($2::text[])`, ids, classIds),
      db.$queryRawUnsafe<ShuttleLocation[]>(`SELECT "studentId",kind,latitude,longitude,"consentVersion","confirmedAt" FROM "StudentShuttleLocation" WHERE "studentId"=ANY($1::text[])`, ids),
      // 전체 명단을 비교해야 다른 정차 변경도 이전 노선 확정의 근거로 사용하지 않는다.
      db.$queryRawUnsafe<ShuttleRosterRow[]>(`SELECT id,"serviceMonth",weekday,direction,"studentId","classTime","arriveTime","stopName",latitude,longitude,"sortOrder" FROM "RegularShuttleStop" WHERE "serviceMonth"=$1 ORDER BY id`, serviceMonth),
      db.$queryRawUnsafe<ShuttleRoute[]>(`SELECT "serviceMonth","dayOfWeek",direction,payload,"classStart","classEnd" FROM "RegularDispatchRoute" WHERE "serviceMonth"=$1`, serviceMonth),
      ledger[0]?.noticeLedger ? db.$queryRawUnsafe<ShuttleNotice[]>(`SELECT "studentId","serviceMonth","stableEventKey","payloadHash",status,"messageBody","recipientPhone","sentAt","createdAt" FROM "RegularShuttleNoticeBatch" WHERE "serviceMonth"=$1 AND "studentId"=ANY($2::text[]) ORDER BY "createdAt" DESC`, serviceMonth, ids) : Promise.resolve([] as ShuttleNotice[]),
      db.$queryRawUnsafe<Array<{ studentId: string; phone: string | null; parentId: string | null }>>(`SELECT s.id AS "studentId",u.phone,u.id AS "parentId" FROM "Student" s LEFT JOIN "User" u ON u.id=s."parentId" AND u."withdrawnAt" IS NULL WHERE s.id=ANY($1::text[]) AND ${notMergedStudent("s")}`, ids),
    ]);
    const hashes = notices.map(n => shuttleDeliveryEventKey(n.payloadHash));
    const deliveries = hashes.length ? await db.$queryRawUnsafe<ShuttleDelivery[]>(`SELECT "stableEventKey",status,"providerStatus","bodyHash","recipientPhoneHash","providerMessageId","sentAt" FROM "NotificationDelivery" WHERE "eventType"='REGULAR_SHUTTLE_CHANGE' AND "stableEventKey"=ANY($1::text[])`, hashes) : [];
    const planDeliveries = ledger[0]?.routeNoticeLedger ? await db.$queryRawUnsafe<PlanDelivery[]>(`SELECT o."studentId",o."recipientKey",o."recipientPhone",o.status,o."providerId",o."updatedAt",o.entries FROM "RegularRouteNoticeOutbox" o JOIN "RegularRoutePlanVersion" v ON v.id=o."versionId" JOIN "RegularRoutePlanDraft" d ON d.id=v."draftId" AND d.status='CONFIRMED' WHERE v."serviceMonth"=$1 AND o."studentId"=ANY($2::text[]) ORDER BY o."createdAt" DESC,o.id DESC`, serviceMonth, ids) : [];
    for (const application of applications) {
      const parent = parents.find(p => p.studentId === application.convertedStudentId);
      const progress = enrollmentShuttleProgress({ application, serviceMonth, classes: classes.filter(c => c.studentId === application.convertedStudentId), locations, roster, routes, notices, deliveries, recipientPhone: parent?.phone, recipientHash: hashMessageRecipientPhone });
      result[application.id] = applyPlanDelivery(progress, application.convertedStudentId, parent, routes, planDeliveries);
    }
  } catch {
    // 미적용된 표나 조회 장애는 미배차/완료로 위장하지 않는다.
    for (const application of applications) result[application.id] = enrollmentShuttleProgress({ application, serviceMonth, classes: [], locations: [], roster: [], routes: [], readFailed: true });
  }
  return result;
}
