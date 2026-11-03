import pg from 'pg';
import { pathToFileURL } from 'node:url';

/** 운영 DB를 변경하지 않고 검토 표와 접근 제한 준비 상태만 읽는다. */
export async function checkShuttleReviewSchema(connectionString) {
  if (!connectionString) throw new Error('DB 연결 정보가 없습니다.');
  const client = new pg.Client({connectionString,connectionTimeoutMillis:8000,statement_timeout:8000,application_name:'stiz-shuttle-review-preflight'});
  try {
    await client.connect(); await client.query('BEGIN READ ONLY');
    const {rows}=await client.query(`SELECT c.relrowsecurity AS rls,
      has_table_privilege('anon',c.oid,'SELECT,INSERT,UPDATE,DELETE') AS anon_access,
      has_table_privilege('authenticated',c.oid,'SELECT,INSERT,UPDATE,DELETE') AS authenticated_access,
      EXISTS(SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='EnrollmentShuttleReview_one_current' AND indexdef LIKE 'CREATE UNIQUE INDEX%') AS unique_current,
      (SELECT count(*)=13 FROM information_schema.columns WHERE table_schema='public' AND table_name='EnrollmentShuttleReview' AND column_name=ANY(ARRAY['id','applicationId','studentId','serviceMonth','driverUserId','sourceFingerprint','status','note','proposals','requestedByUserId','requestedAt','reviewedAt','supersededAt'])) AS columns_ready
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='EnrollmentShuttleReview'`);
    await client.query('ROLLBACK');
    return rows.length===1 && rows[0].rls===true && rows[0].anon_access===false && rows[0].authenticated_access===false && rows[0].unique_current===true && rows[0].columns_ready===true;
  } finally { try { await client.query('ROLLBACK'); } catch {} await client.end().catch(()=>{}); }
}
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url){
  try{const ready=await checkShuttleReviewSchema(process.env.DIRECT_URL||process.env.DATABASE_URL);console.log(ready?'[통과] 셔틀 검토 표·접근 제한을 읽기 전용으로 확인했습니다.':'[보류] 셔틀 검토 표와 접근 제한 준비가 필요합니다.');if(!ready)process.exitCode=1;}
  catch{console.error('[보류] 셔틀 검토 준비 상태를 확인하지 못했습니다. 연결·별도 DB 적용 승인을 확인해 주세요.');process.exitCode=1;}
}
