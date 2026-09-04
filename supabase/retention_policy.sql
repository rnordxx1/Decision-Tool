-- Retention policy for decision-tool responses — NOT APPLIED.
--
-- Owner decision pending (raised 2026-09-03 with the privacy review). The
-- site's privacy page (/privacy, shipping with the September 2026 site
-- update) says individual responses are kept until deleted by hand. When a
-- retention period is chosen, (1) enable pg_cron in the Supabase dashboard
-- (Integrations → Cron, or Database → Extensions → pg_cron), (2) run this in
-- the SQL editor, and (3) update the "How long" sentence on /privacy in the
-- same sitting so the page stays accurate. Disabling the extension later
-- deletes every scheduled job.
--
-- Only the V2 table is covered. hns_responses (V1) is the frozen dataset
-- behind /patient-priorities; whether its raw rows should ever be deleted is
-- a separate call, because the published analysis cannot be re-run without
-- them.

create extension if not exists pg_cron with schema pg_catalog;
grant usage on schema cron to postgres;
grant all privileges on all tables in schema cron to postgres;

-- Runs daily at 03:17 UTC; deletes V2 responses older than 24 months.
select cron.schedule(
  'hns-responses-v2-retention',
  '17 3 * * *',
  $$ delete from public.hns_responses_v2 where created_at < now() - interval '24 months' $$
);

-- To change or stop it later:
--   select cron.unschedule('hns-responses-v2-retention');
