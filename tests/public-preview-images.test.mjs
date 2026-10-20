import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { cachePublicPreviewImages } from '../scripts/lib/real-preview-images.mjs';

const address = 'https://preview.supabase.co/storage/v1/object/public/gallery/test.png';
async function owned(run) {
  const root = await mkdtemp(path.resolve('.tmp/public-images-'));
  try { return await run(path.join(root, '__public_media')); }
  finally { assert.ok(root.startsWith(path.resolve('.tmp/public-images-'))); await rm(root, { recursive:true, force:true }); }
}
test('공개 사진은 인증 없이 한 번만 읽고 로컬 자료로 대체한다', () => owned(async directory => {
  let calls=0; const snapshot={tables:[{name:'Program',rows:[{imageUrl:address}]},{name:'GalleryPost',rows:[{mediaJSON:JSON.stringify([{url:address,type:'image',alt:'공개 수업'}])}]}]};
  const result=await cachePublicPreviewImages(snapshot,{directory,fetchImpl:async (url,options)=>{calls++;assert.equal(url,address);assert.equal(options.redirect,'manual');assert.equal(options.credentials,'omit');return new Response(Buffer.from('fixture-image'),{headers:{'content-type':'image/png'}});}});
  assert.equal(calls,1);assert.equal(result.copied,1);const url=snapshot.tables[0].rows[0].imageUrl;assert.match(url,/^\/__public_media\/[a-f0-9]{24}\.png$/);assert.equal(JSON.parse(snapshot.tables[1].rows[0].mediaJSON)[0].url,url);assert.equal((await readFile(path.join(directory,path.basename(url)))).toString(),'fixture-image');
}));
test('비공개·서명 주소와 영상은 요청하지 않고 원본 URL을 남기지 않는다',()=>owned(async directory=>{
  const snapshot={tables:[{name:'GalleryPost',rows:[{mediaJSON:JSON.stringify([{url:address+'?token=secret',type:'image'},{url:'https://outside.invalid/p.png',type:'image'},{url:address,type:'video'}])}]}]};
  await cachePublicPreviewImages(snapshot,{directory,fetchImpl:()=>{throw Error('요청 금지');}});assert.equal(snapshot.tables[0].rows[0].mediaJSON,'[]');
}));
test('리다이렉트·HTML·큰 이미지 실패는 로컬 미리보기에서 제외한다',()=>owned(async directory=>{
  for(const response of [new Response(null,{status:302}),new Response('html',{headers:{'content-type':'text/html'}}),new Response('too-big',{headers:{'content-type':'image/png','content-length':'9999999'}})]){
    const snapshot={tables:[{name:'Coach',rows:[{imageUrl:address}]}]};const result=await cachePublicPreviewImages(snapshot,{directory,fetchImpl:async()=>response});assert.equal(result.copied,0);assert.equal(result.skipped,1);assert.equal(snapshot.tables[0].rows[0].imageUrl,null);
  }
}));
