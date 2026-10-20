import assert from 'node:assert/strict';
import test from 'node:test';
import { capturePreviewSnapshot, sanitizePublicPreviewUrl } from '../scripts/lib/real-preview-snapshot.mjs';

const publicColumns = {
  User: ['id','email','name','role','phone','createdAt','updatedAt'],
  Program: ['id','name','description','imageUrl'],
  Coach: ['id','name','description','imageUrl','phone'],
  AcademySettings: ['id','introductionText','privacyPolicy','termsOfService','youtubeUrl','facilitiesImagesJSON','googleCalendarIcsUrl','paymentSecret','instagramBusinessAccountId'],
  Notice: ['id','title','content','targetType','isPinned','createdAt','updatedAt','authorUserId','targetClassIds','attachmentsJSON'],
  GalleryPost: ['id','title','caption','mediaJSON','classId','isPublic','createdAt','updatedAt','instagramMediaId'],
  Testimonial: ['id','name','info','text','rating','order','isPublic','createdAt','updatedAt'],
  Faq: ['id','question','answer','order','isPublic','createdAt','updatedAt'],
};
function source({missing={}, rows={}}={}) {
  const calls=[];
  const client={async query(sql,params) {
    calls.push({sql,params});
    assert.match(sql,/^SELECT /);
    if(sql.includes('information_schema.columns')) return {rows:Object.entries(publicColumns).flatMap(([table_name,cols])=>cols.filter(c=>!(missing[table_name]||[]).includes(c)).map(column_name=>({table_name,column_name,is_nullable:'YES',data_type:'text'})))};
    if(sql.includes('lower("email")'))return {rows:[{id:'admin-stable',role:'ADMIN'}]};
    const table=sql.match(/FROM "public"\."([^"]+)"/)?.[1];
    if(table==='User')return {rows:[{id:'admin-stable',name:'관리자',role:'ADMIN'}]};
    const selected=sql.slice(0,sql.indexOf(' FROM '));
    return {rows:(rows[table]||[]).map(row=>Object.fromEntries(Object.entries(row).filter(([key])=>selected.includes('"'+key+'"'))))};
  }};
  return {client,calls};
}

test('공개 자료는 공개 조건과 개수 제한으로만 읽고 비공개 컬럼을 제외한다',async()=>{
 const {client,calls}=source(); await capturePreviewSnapshot(client);
 for(const [name,predicate,limit] of [['Notice','"targetType" = $1','LIMIT 30'],['GalleryPost','"isPublic" = true','LIMIT 24'],['Testimonial','"isPublic" = true','LIMIT 100'],['Faq','"isPublic" = true','LIMIT 100']]){
  const call=calls.find(c=>c.sql.includes('FROM "public"."'+name+'"'));assert.ok(call);assert.ok(call.sql.includes(predicate));assert.ok(call.sql.includes(limit));
  for(const column of ['authorUserId','targetClassIds','attachmentsJSON','instagramMediaId'])assert.ok(!call.sql.includes('"'+column+'"'));
 }
 const settings=calls.find(c=>c.sql.includes('FROM "public"."AcademySettings"')).sql;
 for(const column of ['googleCalendarIcsUrl','paymentSecret','instagramBusinessAccountId'])assert.ok(!settings.includes('"'+column+'"'));
});
for(const [name,column] of [['Notice','targetType'],['GalleryPost','isPublic'],['Faq','isPublic'],['Testimonial','isPublic'],['GalleryPost','createdAt']])test(`${name} ${column}이 없으면 해당 표 조회를 생략한다`,async()=>{
 const {client,calls}=source({missing:{[name]:[column]}});const result=await capturePreviewSnapshot(client);assert.ok(result.summary.redactions.omittedTables.includes(name));assert.ok(!calls.some(c=>c.sql.includes('FROM "public"."'+name+'"')));
});
test('공개 글과 안전한 미디어만 복사하고 개인 연락처·미디어 부가정보는 가린다',async()=>{
 const {client}=source({rows:{GalleryPost:[{id:'photo',title:'즐거운 농구',caption:'연락 010-1234-5678',isPublic:true,mediaJSON:JSON.stringify([{type:'image',url:'https://abc.supabase.co/storage/v1/object/public/gallery/a.jpg',email:'private@example.invalid'},{type:'image',url:'https://abc.supabase.co/storage/v1/object/sign/gallery/a.jpg?token=secret'}])}], Program:[{id:'class',description:'함께 뛰는 수업',imageUrl:'https://stiz.kr/images/team.jpg'}],AcademySettings:[{id:'singleton',youtubeUrl:'https://www.youtube.com/watch?v=abcdefghijk',introductionText:'농구로 성장합니다',privacyPolicy:'개인정보를 안전하게 관리합니다'}]}});
 const result=await capturePreviewSnapshot(client);const byName=Object.fromEntries(result.tables.map(t=>[t.name,t.rows]));
 assert.equal(byName.GalleryPost[0].caption,'비공개');assert.deepEqual(JSON.parse(byName.GalleryPost[0].mediaJSON),[{type:'image',url:'https://abc.supabase.co/storage/v1/object/public/gallery/a.jpg'}]);assert.equal(byName.Program[0].description,'함께 뛰는 수업');assert.equal(byName.AcademySettings[0].introductionText,'농구로 성장합니다');assert.equal(byName.AcademySettings[0].youtubeUrl,'https://www.youtube.com/watch?v=abcdefghijk');
 assert.ok(!JSON.stringify(result).includes('private@example.invalid'));
});
for(const url of ['http://stiz.kr/a.jpg','https://evil.invalid/a.jpg','https://user:password@stiz.kr/a.jpg','https://stiz.kr/a.jpg?token=secret','https://abc.supabase.co/storage/v1/object/authenticated/bucket/a.jpg','https://abc.supabase.co/storage/v1/object/public/bucket/a.jpg?download=x','https://docs.google.com/spreadsheets/d/private/edit','//evil.invalid/image.jpg','/uploads/../secret.jpg'])test(`서명·비공개·허용하지 않은 URL 차단: ${url.replace(/secret|password/g,'masked')}`,()=>assert.equal(sanitizePublicPreviewUrl(url),null));
