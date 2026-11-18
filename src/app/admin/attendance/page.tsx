import { requireAdmin } from "@/lib/auth-guard";
import AttendanceClient from "./AttendanceClient";
import { getCachedAdminAttendancePayload } from "@/lib/adminReadPayloads";
import { parseAttendanceOpenQuery } from "@/lib/attendance/lessonQuery";

export const revalidate = 30;

export default async function AdminAttendancePage({ searchParams }: { searchParams?: Promise<{ date?: string | string[]; lesson?: string | string[] }> }) {
    // 레이아웃 검사만 믿지 않고 화면마다 관리자 확인(d3 — 레이아웃이 바뀌거나 우회돼도 데이터가 새지 않게)
    await requireAdmin();
    // 대시보드 «오늘 수업 처리 현황» 줄이 보내는 «?date=&lesson=» — 그 날짜·그 수업을 바로 연다.
    // 값은 형식 검사를 통과한 것만 쓴다(틀리면 null = 쿼리 없이 들어온 것과 똑같이 오늘 화면).
    const target = parseAttendanceOpenQuery(await searchParams);
    // 날짜가 지정됐으면 그날 수업 목록을 넘긴다(화면이 그 목록에서 수업을 찾아 연다). 없으면 예전처럼 오늘
    const { classes } = await getCachedAdminAttendancePayload(target?.date);

    return (
        <AttendanceClient
            // 주소의 날짜·수업이 바뀌면 화면을 새로 시작한다(처음 값으로만 여는 상태라 — 쿼리가 없으면 늘 같은 key)
            key={target ? `${target.date}|${target.lesson ? `${target.lesson.kind}:${target.lesson.id}` : ""}` : "default"}
            classes={classes}
            initialOpen={target}
        />
    );
}
