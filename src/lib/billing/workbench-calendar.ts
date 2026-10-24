import { createHash } from "node:crypto";
import { loadAnnualPlanEventsWithSource } from "@/lib/enrollment/monthlyClassDates";
import { prisma } from "@/lib/prisma";
import { WorkbenchError, type WorkbenchCalendarSnapshot } from "./workbench";

export function createWorkbenchCalendarSnapshot(input: Pick<WorkbenchCalendarSnapshot,"kind"|"events">): WorkbenchCalendarSnapshot {
  const entries=new Map<string,WorkbenchCalendarSnapshot["events"][number]>();
  for(const event of input.events){
    if(typeof event.title!=="string"||!Number.isFinite(Date.parse(event.date))||(event.endDate&&!Number.isFinite(Date.parse(event.endDate))))throw new WorkbenchError("공식 일정을 확인하지 못했습니다. 다시 시도해 주세요.",503);
    const normalized={title:event.title,date:new Date(event.date).toISOString(),...(event.endDate?{endDate:new Date(event.endDate).toISOString()}:{})};
    entries.set(JSON.stringify(normalized),normalized);
  }
  const events=[...entries.values()].sort((a,b)=>a.date.localeCompare(b.date)||a.title.localeCompare(b.title)||(a.endDate??"").localeCompare(b.endDate??""));
  const fingerprint=createHash("sha256").update(JSON.stringify({kind:input.kind,events})).digest("hex");
  return{kind:input.kind,events,fingerprint};
}

/** 인증 후, 금융 거래를 시작하기 전에 한 번만 호출한다. URL·인증값은 결과에 넣지 않는다. */
export async function loadWorkbenchCalendar(fresh=false):Promise<WorkbenchCalendarSnapshot> {
  try{
    // 캐시 조회가 장애를 기본값으로 바꿔 공식 일정 설정을 누락하지 않도록 필요한 항목만 직접 읽는다.
    const [settingsRows,dbEvents]=await Promise.all([
      prisma.$queryRawUnsafe<Array<{googleCalendarIcsUrl:string|null}>>(`SELECT "googleCalendarIcsUrl" FROM "AcademySettings" WHERE id='singleton' LIMIT 1`),
      prisma.$queryRawUnsafe<Array<{title:string;date:Date|string;endDate:Date|string|null}>>(`SELECT title,date,"endDate" FROM "AnnualEvent" ORDER BY date,id`),
    ]);
    if(!settingsRows[0])throw new Error("일정 설정을 확인하지 못했습니다.");
    return createWorkbenchCalendarSnapshot(await loadAnnualPlanEventsWithSource({strict:true,fresh},{settings:settingsRows[0],dbEvents}));
  }
  catch{throw new WorkbenchError("공식 일정을 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.",503);}
}
