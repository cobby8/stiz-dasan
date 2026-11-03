import { pathToFileURL } from "node:url";
import pg from "pg";

export const REQUIRED_COMMENCEMENT_COLUMNS = {EnrollmentApplication:["requestedStartOn"],Enrollment:["startsOn"]};
export function findMissingCommencementColumns(rows) {
 const actual=new Map(rows.map(row=>[`${row.table_name}.${row.column_name}`,row.data_type]));
 return Object.entries(REQUIRED_COMMENCEMENT_COLUMNS).flatMap(([table,columns])=>columns.filter(column=>actual.get(`${table}.${column}`)!=="date").map(column=>({table,column})));
}
/** 읽기 전용 구조 조회만 수행한다. 자동 마이그레이션·기존 데이터 보정은 없다. */
export async function checkCommencementColumns({connectionString,Client=pg.Client}) {
 if(!connectionString?.trim())throw new Error("연결 정보가 없습니다.");
 const client=new Client({connectionString,application_name:"stiz-enrollment-commencement-preflight",connectionTimeoutMillis:8000,statement_timeout:8000});
 try {
  await client.connect();await client.query("BEGIN READ ONLY");
  const {rows}=await client.query(`SELECT table_name,column_name,data_type FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=ANY($1::text[])`,[Object.keys(REQUIRED_COMMENCEMENT_COLUMNS)]);
  await client.query("ROLLBACK");return findMissingCommencementColumns(rows);
 } finally {try{await client.query("ROLLBACK");}catch{} await client.end().catch(()=>{});}
}
export async function main(args=process.argv.slice(2),env=process.env,check=checkCommencementColumns) {
 if(args.includes("--skip-db")){console.warn("[건너뜀] 수강 개시일 구조 검사를 생략했습니다. 배포 검증 결과가 아닙니다.");return 0;}
 const connectionString=env.DIRECT_URL||env.DATABASE_URL;
 if(!connectionString?.trim()){console.error("[실패] 수강 개시일 DB 구조를 확인할 연결 정보가 없습니다.");return 1;}
 try {
  const missing=await check({connectionString});
  if(missing.length){console.error("[실패] 수강 개시일 날짜 컬럼이 없거나 DATE 형식이 아닙니다.");for(const {table,column} of missing)console.error(`- ${table}.${column}`);console.error("별도 운영 승인 후 prisma/migrations/20261103103000_enrollment_commencement 를 적용하고 다시 확인하세요. 이 검사는 DB를 변경하지 않습니다.");return 1;}
  console.log("[통과] 수강 개시일 DATE 컬럼 2개를 읽기 전용으로 확인했습니다.");return 0;
 }catch{console.error("[실패] 수강 개시일 DB 구조 조회에 실패했습니다. 연결 상태와 접근 권한을 확인해 주세요.");return 1;}
}
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url)process.exitCode=await main();
