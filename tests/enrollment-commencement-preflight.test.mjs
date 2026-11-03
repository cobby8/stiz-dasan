import assert from "node:assert/strict";
import test from "node:test";
import {checkCommencementColumns,findMissingCommencementColumns,main} from "../scripts/enrollment-commencement-db-preflight.mjs";
const rows=[{table_name:"EnrollmentApplication",column_name:"requestedStartOn",data_type:"date"},{table_name:"Enrollment",column_name:"startsOn",data_type:"date"}];
test("컬럼 존재뿐 아니라 DATE 형식까지 검사",()=>{assert.deepEqual(findMissingCommencementColumns(rows),[]);assert.equal(findMissingCommencementColumns([]).length,2);assert.equal(findMissingCommencementColumns([{...rows[0],data_type:"text"},rows[1]]).length,1);});
test("가짜 연결에서 READ ONLY·정보스키마 SELECT·ROLLBACK만 실행",async()=>{
 const calls=[];class Client {async connect(){calls.push("connect");}async query(sql){calls.push(sql);return{rows};}async end(){calls.push("end");}}
 assert.deepEqual(await checkCommencementColumns({connectionString:"synthetic-only",Client}),[]);
 assert.ok(calls.includes("BEGIN READ ONLY"));assert.ok(calls.some(sql=>sql.includes("information_schema.columns")));assert.equal(calls.at(-1),"end");assert.equal(calls.some(sql=>/ALTER|INSERT|UPDATE|DELETE|CREATE/.test(sql)),false);
});
test("접속 오류에서도 연결 종료하고 오류 문구에 연결정보를 출력하지 않음",async()=>{
 const calls=[];class Client {async connect(){throw Error("secret-connection");}async query(sql){calls.push(sql);return{rows:[]};}async end(){calls.push("end");}}
 await assert.rejects(checkCommencementColumns({connectionString:"synthetic-only",Client}));assert.equal(calls.at(-1),"end");
 const old=console.error,output=[];console.error=(...args)=>output.push(args.join(" "));try{assert.equal(await main([], {DIRECT_URL:"synthetic-only"},async()=>{throw Error("secret-connection");}),1);}finally{console.error=old;}
 assert.equal(output.join(" ").includes("secret-connection"),false);
});
test("구조 미준비·연결 미설정은 배포 실패로 차단",async()=>{
 assert.equal(await main([],{},async()=>{throw Error("must not connect");}),1);
 assert.equal(await main([],{DIRECT_URL:"synthetic-only"},async()=>[{table:"Enrollment",column:"startsOn"}]),1);
 assert.equal(await main([],{DIRECT_URL:"synthetic-only"},async()=>[]),0);
});
