CREATE TABLE "RegularRoutePlanDraft" (id text PRIMARY KEY,"reviewId" text NOT NULL UNIQUE REFERENCES "EnrollmentShuttleReview"(id) ON DELETE RESTRICT,"driverUserId" text NOT NULL REFERENCES "User"(id) ON DELETE RESTRICT,"serviceMonth" text NOT NULL,"effectiveFrom" text NOT NULL,status text NOT NULL DEFAULT 'DRAFT' CHECK(status IN ('DRAFT','SUBMITTED','CONFIRMED')),revision int NOT NULL DEFAULT 1 CHECK(revision>0),data jsonb NOT NULL,"createdAt" timestamptz NOT NULL DEFAULT now(),"updatedAt" timestamptz NOT NULL DEFAULT now());
CREATE INDEX "RegularRoutePlanDraft_driverUserId_serviceMonth_status_idx" ON "RegularRoutePlanDraft"("driverUserId","serviceMonth",status);
CREATE TABLE "RegularRoutePlanVersion" (id text PRIMARY KEY,"draftId" text NOT NULL UNIQUE REFERENCES "RegularRoutePlanDraft"(id) ON DELETE RESTRICT,"serviceMonth" text NOT NULL,"effectiveFrom" text NOT NULL,"beforeSnapshot" jsonb NOT NULL,"afterSnapshot" jsonb NOT NULL,"confirmedByUserId" text NOT NULL REFERENCES "User"(id) ON DELETE RESTRICT,"confirmedAt" timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE INDEX "RegularRoutePlanVersion_serviceMonth_effectiveFrom_confirmedAt_idx" ON "RegularRoutePlanVersion"("serviceMonth","effectiveFrom","confirmedAt");
CREATE TABLE "RegularRouteNoticeOutbox" (id text PRIMARY KEY,"versionId" text NOT NULL REFERENCES "RegularRoutePlanVersion"(id) ON DELETE RESTRICT,"studentId" text NOT NULL REFERENCES "Student"(id) ON DELETE RESTRICT,"recipientPhone" text NOT NULL,"recipientKey" text NOT NULL,message text NOT NULL,entries jsonb NOT NULL,status text NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','SENDING','ACCEPTED','DELIVERED','FAILED','UNKNOWN')),"providerId" text UNIQUE,"errorCode" text,"createdAt" timestamptz NOT NULL DEFAULT now(),"updatedAt" timestamptz NOT NULL DEFAULT now(),UNIQUE("versionId","studentId"));
CREATE INDEX "RegularRouteNoticeOutbox_status_createdAt_idx" ON "RegularRouteNoticeOutbox"(status,"createdAt");
CREATE TABLE "RegularRouteNoticeSnapshot" (id text PRIMARY KEY,"studentId" text NOT NULL REFERENCES "Student"(id) ON DELETE RESTRICT,"serviceMonth" text NOT NULL,source text NOT NULL CHECK(source IN ('DELIVERED','ADMIN_CONFIRMED')),entries jsonb NOT NULL,"recipientKey" text NOT NULL,"outboxId" text UNIQUE REFERENCES "RegularRouteNoticeOutbox"(id) ON DELETE RESTRICT,"confirmedByUserId" text REFERENCES "User"(id) ON DELETE RESTRICT,"createdAt" timestamptz NOT NULL DEFAULT now());
CREATE INDEX "RegularRouteNoticeSnapshot_studentId_serviceMonth_createdAt_idx" ON "RegularRouteNoticeSnapshot"("studentId","serviceMonth","createdAt");
ALTER TABLE "RegularRoutePlanDraft" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RegularRoutePlanVersion" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RegularRouteNoticeOutbox" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RegularRouteNoticeSnapshot" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "RegularRoutePlanDraft","RegularRoutePlanVersion","RegularRouteNoticeOutbox","RegularRouteNoticeSnapshot" FROM PUBLIC;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN REVOKE ALL ON "RegularRoutePlanDraft","RegularRoutePlanVersion","RegularRouteNoticeOutbox","RegularRouteNoticeSnapshot" FROM anon; END IF; IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN REVOKE ALL ON "RegularRoutePlanDraft","RegularRoutePlanVersion","RegularRouteNoticeOutbox","RegularRouteNoticeSnapshot" FROM authenticated; END IF; END $$;
-- 기존 저장 기능도 날짜별 조회에 반영한다. 한 SQL 문장당 월별 마지막 상태만 기록한다.
CREATE TABLE "RegularRouteLegacyChange" (id text PRIMARY KEY DEFAULT gen_random_uuid()::text,"serviceMonth" text NOT NULL,"effectiveFrom" text NOT NULL,snapshot jsonb NOT NULL,"observedAt" timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE INDEX "RegularRouteLegacyChange_month_date_time_idx" ON "RegularRouteLegacyChange"("serviceMonth","effectiveFrom","observedAt");
ALTER TABLE "RegularRouteLegacyChange" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "RegularRouteLegacyChange" FROM PUBLIC;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN REVOKE ALL ON "RegularRouteLegacyChange" FROM anon; END IF; IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN REVOKE ALL ON "RegularRouteLegacyChange" FROM authenticated; END IF; END $$;
CREATE FUNCTION stiz_capture_regular_route_legacy_change() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE m text; q text; begins text; payload jsonb;
BEGIN
 IF current_setting('stiz.route_plan_writing',true)='1' THEN RETURN NULL; END IF;
 q:=CASE TG_OP WHEN 'INSERT' THEN 'SELECT DISTINCT "serviceMonth" FROM new_rows' WHEN 'DELETE' THEN 'SELECT DISTINCT "serviceMonth" FROM old_rows' ELSE 'SELECT "serviceMonth" FROM new_rows UNION SELECT "serviceMonth" FROM old_rows' END;
 FOR m IN EXECUTE q LOOP
   SELECT max("effectiveFrom") INTO begins FROM public."RegularRoutePlanVersion" WHERE "serviceMonth"=m;
   IF begins IS NULL THEN CONTINUE; END IF;
   begins:=GREATEST(begins,to_char(clock_timestamp() AT TIME ZONE 'Asia/Seoul','YYYY-MM-DD'));
   SELECT jsonb_build_object('rows',COALESCE((SELECT jsonb_agg(to_jsonb(s) ORDER BY s.id) FROM public."RegularShuttleStop" s WHERE s."serviceMonth"=m),'[]'::jsonb),'routes',COALESCE((SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id) FROM public."RegularDispatchRoute" r WHERE r."serviceMonth"=m),'[]'::jsonb)) INTO payload;
   INSERT INTO public."RegularRouteLegacyChange"(id,"serviceMonth","effectiveFrom",snapshot) VALUES(txid_current()::text||':'||m,m,begins,payload) ON CONFLICT(id) DO UPDATE SET snapshot=EXCLUDED.snapshot,"observedAt"=clock_timestamp();
 END LOOP;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION stiz_capture_regular_route_legacy_change() FROM PUBLIC;
CREATE TRIGGER regular_stop_dated_insert AFTER INSERT ON "RegularShuttleStop" REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION stiz_capture_regular_route_legacy_change();
CREATE TRIGGER regular_stop_dated_update AFTER UPDATE ON "RegularShuttleStop" REFERENCING NEW TABLE AS new_rows OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION stiz_capture_regular_route_legacy_change();
CREATE TRIGGER regular_stop_dated_delete AFTER DELETE ON "RegularShuttleStop" REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION stiz_capture_regular_route_legacy_change();
CREATE TRIGGER regular_route_dated_insert AFTER INSERT ON "RegularDispatchRoute" REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION stiz_capture_regular_route_legacy_change();
CREATE TRIGGER regular_route_dated_update AFTER UPDATE ON "RegularDispatchRoute" REFERENCING NEW TABLE AS new_rows OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION stiz_capture_regular_route_legacy_change();
CREATE TRIGGER regular_route_dated_delete AFTER DELETE ON "RegularDispatchRoute" REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION stiz_capture_regular_route_legacy_change();
