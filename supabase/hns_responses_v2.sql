-- Decision Tool V2.0 — response storage
--
-- Deliberately a SEPARATE table from hns_responses (V1). Owner's call,
-- 2026-08-02: V1's output stays frozen and unchanged, and V2 gets columns
-- named for what V2 actually measures rather than being squeezed into V1's
-- vocabulary (inspire_score / genio_score / nine 0-10 priorities / a scored
-- adhesive modifier — none of which V2 produces).
--
-- Run once in the Supabase SQL editor. Safe and additive: it creates a new
-- empty table and touches nothing existing.

create table if not exists public.hns_responses_v2 (
  id                 bigint generated always as identity primary key,
  created_at         timestamptz not null default now(),

  -- version stamp; lets a future V2.1 stay in this table without ambiguity
  tool_version       text not null default '2.0',
  tool_page          text,

  -- how the visitor found the tool. NOTE: the V1 API read these from a
  -- nested body.utm object while the site has always sent them flat, so every
  -- UTM column in hns_responses is null. Fixed in the V2 route.
  referrer_host      text,
  landing_path       text,
  utm_source         text,
  utm_medium         text,
  utm_campaign       text,
  utm_term           text,
  utm_content        text,

  -- Lane 1: gates. Facts, never scored. gate_outcome is 'passed', 'stopped'
  -- (a hard criterion excluded them) or 'incomplete'.
  gates              jsonb,
  gate_outcome       text,

  -- Lane 2: the four paired trade-offs, each -2..+2 (negative = Inspire).
  tradeoffs          jsonb,
  tradeoffs_answered smallint,

  -- MRI is a yes/no question in V2, not a weighted slider.
  mri_relevant       boolean,

  -- Output. lean_percent is rounded to the nearest 5 and is a SINGLE figure,
  -- not a mirrored pair. evidence_share is the share of that lean resting on
  -- documented differences between the devices.
  lean_toward        text,
  lean_percent       smallint,
  evidence_share     smallint,
  brief              jsonb,

  demographics       jsonb
);

comment on table public.hns_responses_v2 is
  'Decision Tool V2.0 responses. V1 lives in hns_responses and is frozen — do not merge the two: the instruments measure different things and their results are not comparable.';

create index if not exists hns_responses_v2_created_at_idx
  on public.hns_responses_v2 (created_at desc);

-- Writes arrive only from the API route using the service-role key, which
-- bypasses RLS. Enabling RLS with no public policy means nothing else can
-- read or write this table.
alter table public.hns_responses_v2 enable row level security;
