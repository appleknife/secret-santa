-- ════════════════════════════════════════════════════════════════════════
--  Secret Santa — Supabase schema
--
--  Paste this whole file into Supabase → SQL Editor → Run. Safe to re-run.
--
--  How access works
--  • The tables live in a private schema, `santa`, which the website's
--    publishable/anon key cannot query at all (not exposed, no grants, RLS on).
--  • The website only calls the functions at the bottom of this file.
--    Each one checks a person's secret token, which the database stores
--    only as a SHA-256 hash.
--  • Matches and gifts are encrypted in the browser to the reader's public
--    key before they get here, so the database (and anyone who opens the
--    Supabase dashboard) only ever sees ciphertext.
--  • Every function is SECURITY DEFINER with an empty search_path, and
--    EXECUTE is revoked from PUBLIC before being granted to anon, as
--    Supabase's own guidance recommends.
-- ════════════════════════════════════════════════════════════════════════

create schema if not exists santa;
revoke all on schema santa from public;

create table if not exists santa.events (
  id          uuid primary key default gen_random_uuid(),
  code        text not null unique,              -- shown in the join link
  title       text not null check (char_length(title) between 1 and 60),
  gift_day    date,
  cap_usd     int  not null default 20,
  status      text not null default 'open' check (status in ('open', 'drawn')),
  owner_id    uuid,                              -- participant who created it
  created_at  timestamptz not null default now(),
  drawn_at    timestamptz
);

create table if not exists santa.participants (
  id          uuid primary key default gen_random_uuid(),
  event_id    uuid not null references santa.events (id) on delete cascade,
  name        text not null check (char_length(name) between 1 and 40),
  wishlist    text not null default '' check (char_length(wishlist) <= 1000),
  gift_pref   text not null default 'either' check (gift_pref in ('handmade', 'digital', 'either')),
  public_key  jsonb not null,                    -- ECDH P-256 public JWK
  token_hash  bytea not null unique,             -- sha256(secret token)
  created_at  timestamptz not null default now()
);
create unique index if not exists participants_event_name
  on santa.participants (event_id, lower(name));
create index if not exists participants_event on santa.participants (event_id);

-- one row per giver: who they're buying for, sealed to the giver's public key
create table if not exists santa.assignments (
  event_id    uuid not null references santa.events (id) on delete cascade,
  giver_id    uuid not null references santa.participants (id) on delete cascade,
  sealed      text not null check (char_length(sealed) <= 4000),
  primary key (event_id, giver_id)
);

-- gifts are stored WITHOUT the giver's id: only a tag derived from the giver's
-- secret token, so the giver can find their own sends and nobody else can
-- link a gift back to them.
create table if not exists santa.gifts (
  id            uuid primary key default gen_random_uuid(),
  event_id      uuid not null references santa.events (id) on delete cascade,
  recipient_id  uuid not null references santa.participants (id) on delete cascade,
  sender_tag    bytea not null,                  -- sha256('gift:' || token)
  sealed        text not null check (char_length(sealed) <= 700000),
  created_at    timestamptz not null default now(),
  opened_at     timestamptz
);
create index if not exists gifts_recipient on santa.gifts (recipient_id);
create index if not exists gifts_sender on santa.gifts (sender_tag);

-- lost-link recovery: a person asks for a new link (their browser makes the new
-- key), the group starter approves it, and the others' browsers each send them
-- their own target sealed to the new key so they can work out their match.
alter table santa.participants add column if not exists pending_key jsonb;
alter table santa.participants add column if not exists pending_token_hash bytea;
alter table santa.participants add column if not exists pending_at timestamptz;
alter table santa.participants add column if not exists recovering boolean not null default false;

-- co-hosts: chosen by the group starter; they can approve new links and keep
-- backups of everyone's private link (sealed to the host's own key).
alter table santa.participants add column if not exists is_host boolean not null default false;

create table if not exists santa.link_backups (
  host_id    uuid not null references santa.participants (id) on delete cascade,
  member_id  uuid not null references santa.participants (id) on delete cascade,
  sealed     text not null check (char_length(sealed) <= 4000),
  primary key (host_id, member_id)
);

create table if not exists santa.match_votes (
  for_id    uuid not null references santa.participants (id) on delete cascade,
  voter_id  uuid not null references santa.participants (id) on delete cascade,
  sealed    text not null check (char_length(sealed) <= 4000),
  primary key (for_id, voter_id)
);

alter table santa.events       enable row level security;
alter table santa.participants enable row level security;
alter table santa.assignments  enable row level security;
alter table santa.gifts        enable row level security;
alter table santa.match_votes  enable row level security;
alter table santa.link_backups enable row level security;
revoke all on all tables in schema santa from public;

-- ───────────────────────────── helpers (not callable from the web) ─────────

create or replace function santa.hash_token(p_token text)
returns bytea language sql immutable set search_path = '' as $$
  select pg_catalog.sha256(pg_catalog.convert_to(p_token, 'UTF8'))
$$;

create or replace function santa.me(p_token text)
returns santa.participants language plpgsql stable security definer set search_path = '' as $$
declare r santa.participants;
begin
  if p_token is null or char_length(p_token) < 20 then
    raise exception 'That private link is not valid.' using errcode = 'P0001';
  end if;
  select * into r from santa.participants where token_hash = santa.hash_token(p_token);
  if not found then
    raise exception 'That private link is not valid.' using errcode = 'P0001';
  end if;
  return r;
end $$;

create or replace function santa.clean_pref(p text)
returns text language sql immutable set search_path = '' as $$
  select case when p in ('handmade', 'digital', 'either') then p else 'either' end
$$;

create or replace function santa.check_key(p_key jsonb)
returns void language plpgsql immutable set search_path = '' as $$
begin
  if p_key is null or p_key->>'kty' <> 'EC' or p_key->>'crv' <> 'P-256'
     or p_key ? 'd' or char_length(coalesce(p_key->>'x', '')) <> 43
     or char_length(coalesce(p_key->>'y', '')) <> 43 then
    raise exception 'Bad public key.' using errcode = 'P0001';
  end if;
end $$;

create or replace function santa.is_host(p santa.participants)
returns boolean language sql stable security definer set search_path = '' as $$
  select p.is_host or exists (select 1 from santa.events e where e.id = p.event_id and e.owner_id = p.id)
$$;

revoke all on all functions in schema santa from public;

-- ───────────────────────────── API (called by the website) ─────────────────

-- Start a group. The creator joins it in the same step.
create or replace function public.santa_create_event(
  p_title text, p_gift_day date, p_name text, p_wishlist text,
  p_gift_pref text, p_public_key jsonb, p_token text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_event santa.events;
  v_pid uuid;
  v_code text;
begin
  perform santa.check_key(p_public_key);
  if char_length(coalesce(p_token, '')) < 20 then
    raise exception 'Bad token.' using errcode = 'P0001';
  end if;
  v_code := pg_catalog.substr(pg_catalog.replace(gen_random_uuid()::text, '-', ''), 1, 10);
  insert into santa.events (code, title, gift_day)
    values (v_code, pg_catalog.btrim(p_title), p_gift_day) returning * into v_event;
  insert into santa.participants (event_id, name, wishlist, gift_pref, public_key, token_hash)
    values (v_event.id, pg_catalog.btrim(p_name), coalesce(p_wishlist, ''),
            santa.clean_pref(p_gift_pref), p_public_key, santa.hash_token(p_token))
    returning id into v_pid;
  update santa.events set owner_id = v_pid where id = v_event.id;
  return jsonb_build_object('code', v_code, 'participant_id', v_pid);
end $$;

-- What the join page shows before someone signs up.
create or replace function public.santa_event_preview(p_code text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v santa.events;
begin
  select * into v from santa.events where code = p_code;
  if not found then
    raise exception 'We could not find that group. Check the link?' using errcode = 'P0001';
  end if;
  return jsonb_build_object(
    'title', v.title, 'gift_day', v.gift_day, 'cap_usd', v.cap_usd, 'status', v.status,
    'names', coalesce((select jsonb_agg(p.name order by p.created_at)
                       from santa.participants p where p.event_id = v.id), '[]'::jsonb));
end $$;

create or replace function public.santa_join_event(
  p_code text, p_name text, p_wishlist text, p_gift_pref text,
  p_public_key jsonb, p_token text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v santa.events;
  v_pid uuid;
begin
  perform santa.check_key(p_public_key);
  if char_length(coalesce(p_token, '')) < 20 then
    raise exception 'Bad token.' using errcode = 'P0001';
  end if;
  select * into v from santa.events where code = p_code for update;
  if not found then
    raise exception 'We could not find that group. Check the link?' using errcode = 'P0001';
  end if;
  if v.status <> 'open' then
    raise exception 'Names have already been drawn for this group, so it is closed to new people.' using errcode = 'P0001';
  end if;
  if (select count(*) from santa.participants where event_id = v.id) >= 40 then
    raise exception 'This group is full.' using errcode = 'P0001';
  end if;
  if exists (select 1 from santa.participants
             where event_id = v.id and lower(name) = lower(pg_catalog.btrim(p_name))) then
    raise exception 'Someone in this group already uses that name. Try adding an initial.' using errcode = 'P0001';
  end if;
  insert into santa.participants (event_id, name, wishlist, gift_pref, public_key, token_hash)
    values (v.id, pg_catalog.btrim(p_name), coalesce(p_wishlist, ''),
            santa.clean_pref(p_gift_pref), p_public_key, santa.hash_token(p_token))
    returning id into v_pid;
  return jsonb_build_object('code', v.code, 'participant_id', v_pid);
end $$;

-- Everything one person's page needs, in one call.
create or replace function public.santa_my_event(p_token text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  m santa.participants;
  v santa.events;
  v_tag bytea := santa.hash_token('gift:' || p_token);
  v_open boolean;
begin
  m := santa.me(p_token);
  select * into v from santa.events where id = m.event_id;
  -- gifts stay wrapped until the morning of gift day (UTC-12h, so every timezone has arrived)
  v_open := v.gift_day is null or now() >= (v.gift_day::timestamp - interval '12 hours');
  return jsonb_build_object(
    'event', jsonb_build_object('code', v.code, 'title', v.title, 'gift_day', v.gift_day,
                                'cap_usd', v.cap_usd, 'status', v.status, 'drawn_at', v.drawn_at,
                                'gifts_open', v_open),
    'me', jsonb_build_object('id', m.id, 'name', m.name, 'wishlist', m.wishlist,
                             'gift_pref', m.gift_pref, 'is_owner', v.owner_id = m.id,
                             'is_host', santa.is_host(m), 'is_cohost', m.is_host, 'recovering', m.recovering),
    'participants', coalesce((select jsonb_agg(jsonb_build_object(
        'id', p.id, 'name', p.name, 'wishlist', p.wishlist, 'gift_pref', p.gift_pref,
        'public_key', p.public_key, 'is_owner', v.owner_id = p.id,
        'recovering', p.recovering,
        'is_host', p.is_host or v.owner_id = p.id,
        'is_cohost', p.is_host,
        'pending', case when santa.is_host(m) then p.pending_token_hash is not null else false end)
        order by p.created_at)
      from santa.participants p where p.event_id = v.id), '[]'::jsonb),
    'votes_cast', coalesce((select jsonb_agg(mv.for_id) from santa.match_votes mv
                            where mv.voter_id = m.id), '[]'::jsonb),
    'backups_given', coalesce((select jsonb_agg(lb.host_id) from santa.link_backups lb
                               where lb.member_id = m.id), '[]'::jsonb),
    'link_backups', case when m.is_host then coalesce((select jsonb_agg(jsonb_build_object(
        'member_id', lb.member_id, 'sealed', lb.sealed))
      from santa.link_backups lb where lb.host_id = m.id), '[]'::jsonb) end,
    'recovery', case when m.recovering then jsonb_build_object(
        -- everyone who still knows their own match can help
        'needed', (select count(*) from santa.participants
                   where event_id = v.id and id <> m.id and not recovering),
        'votes', coalesce((select jsonb_agg(mv.sealed) from santa.match_votes mv
                           where mv.for_id = m.id), '[]'::jsonb)) end,
    'assignment', (select a.sealed from santa.assignments a
                   where a.event_id = v.id and a.giver_id = m.id),
    'gifts_received', coalesce((select jsonb_agg(jsonb_build_object(
        'id', g.id, 'sent_at', g.created_at, 'opened_at', g.opened_at,
        'sealed', case when v_open then g.sealed end) order by g.created_at)
      from santa.gifts g where g.recipient_id = m.id), '[]'::jsonb),
    'gifts_sent', coalesce((select jsonb_agg(jsonb_build_object(
        'id', g.id, 'recipient_id', g.recipient_id, 'sent_at', g.created_at,
        'opened_at', g.opened_at) order by g.created_at)
      from santa.gifts g where g.sender_tag = v_tag and g.event_id = v.id), '[]'::jsonb));
end $$;

create or replace function public.santa_update_me(p_token text, p_wishlist text, p_gift_pref text)
returns void language plpgsql security definer set search_path = '' as $$
declare m santa.participants;
begin
  m := santa.me(p_token);
  update santa.participants
     set wishlist = coalesce(p_wishlist, ''), gift_pref = santa.clean_pref(p_gift_pref)
   where id = m.id;
end $$;

-- The group starter can remove a duplicate or mistaken sign-up before the draw.
create or replace function public.santa_remove_participant(p_token text, p_participant_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare m santa.participants; v santa.events;
begin
  m := santa.me(p_token);
  select * into v from santa.events where id = m.event_id for update;
  if v.owner_id is distinct from m.id then
    raise exception 'Only the person who started the group can remove people.' using errcode = 'P0001';
  end if;
  if v.status <> 'open' then
    raise exception 'Names have already been drawn.' using errcode = 'P0001';
  end if;
  if p_participant_id = m.id then
    raise exception 'You can''t remove yourself.' using errcode = 'P0001';
  end if;
  delete from santa.participants where id = p_participant_id and event_id = v.id;
end $$;

-- Store a finished draw. The pairing itself happens in the browser; each row
-- is the giver's match sealed to the giver's own public key.
create or replace function public.santa_submit_draw(p_token text, p_rows jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare
  m santa.participants;
  v santa.events;
  v_count int;
  v_rows int;
  v_distinct int;
  v_valid int;
begin
  m := santa.me(p_token);
  select * into v from santa.events where id = m.event_id for update;
  if v.owner_id is distinct from m.id then
    raise exception 'Only the person who started the group can draw names.' using errcode = 'P0001';
  end if;
  if v.status <> 'open' then
    raise exception 'Names have already been drawn.' using errcode = 'P0001';
  end if;
  select count(*) into v_count from santa.participants where event_id = v.id;
  if v_count < 3 then
    raise exception 'You need at least 3 people to draw names.' using errcode = 'P0001';
  end if;
  if jsonb_typeof(p_rows) <> 'array' then
    raise exception 'Bad draw.' using errcode = 'P0001';
  end if;
  select count(*), count(distinct r->>'giver_id'),
         count(*) filter (where p.id is not null
                           and char_length(coalesce(r->>'sealed', '')) between 20 and 4000)
    into v_rows, v_distinct, v_valid
    from jsonb_array_elements(p_rows) r
    left join santa.participants p on p.id::text = r->>'giver_id' and p.event_id = v.id;
  if v_rows <> v_count or v_distinct <> v_count or v_valid <> v_count then
    raise exception 'Someone joined or left while drawing. Please try again.' using errcode = 'P0001';
  end if;
  insert into santa.assignments (event_id, giver_id, sealed)
    select v.id, (r->>'giver_id')::uuid, r->>'sealed' from jsonb_array_elements(p_rows) r;
  update santa.events set status = 'drawn', drawn_at = now() where id = v.id;
end $$;

create or replace function public.santa_send_gift(p_token text, p_recipient_id uuid, p_sealed text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  m santa.participants;
  v santa.events;
  v_tag bytea := santa.hash_token('gift:' || p_token);
  v_id uuid;
begin
  m := santa.me(p_token);
  select * into v from santa.events where id = m.event_id;
  if v.status <> 'drawn' then
    raise exception 'Names haven''t been drawn yet.' using errcode = 'P0001';
  end if;
  if p_recipient_id = m.id
     or not exists (select 1 from santa.participants where id = p_recipient_id and event_id = v.id) then
    raise exception 'That person isn''t in your group.' using errcode = 'P0001';
  end if;
  if char_length(coalesce(p_sealed, '')) not between 20 and 700000 then
    raise exception 'That gift is too large. Try a smaller picture.' using errcode = 'P0001';
  end if;
  if (select count(*) from santa.gifts where sender_tag = v_tag) >= 10 then
    raise exception 'That''s plenty of gifts! (Limit 10.)' using errcode = 'P0001';
  end if;
  insert into santa.gifts (event_id, recipient_id, sender_tag, sealed)
    values (v.id, p_recipient_id, v_tag, p_sealed) returning id into v_id;
  return v_id;
end $$;

-- A giver can take back a gift until it has been opened.
create or replace function public.santa_unsend_gift(p_token text, p_gift_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare m santa.participants;
begin
  m := santa.me(p_token);
  delete from santa.gifts
   where id = p_gift_id and sender_tag = santa.hash_token('gift:' || p_token) and opened_at is null;
  if not found then
    raise exception 'That gift has already been opened, so it can''t be taken back.' using errcode = 'P0001';
  end if;
end $$;

create or replace function public.santa_open_gift(p_token text, p_gift_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare m santa.participants;
begin
  m := santa.me(p_token);
  update santa.gifts set opened_at = coalesce(opened_at, now())
   where id = p_gift_id and recipient_id = m.id;
end $$;

-- The group starter can delete the whole group: everyone, matches and gifts.
create or replace function public.santa_delete_event(p_token text)
returns void language plpgsql security definer set search_path = '' as $$
declare m santa.participants; v santa.events;
begin
  m := santa.me(p_token);
  select * into v from santa.events where id = m.event_id for update;
  if v.owner_id is distinct from m.id then
    raise exception 'Only the person who started the group can delete it.' using errcode = 'P0001';
  end if;
  delete from santa.events where id = v.id;
end $$;

-- Someone who lost their link asks for a new one. Their browser made the new
-- key and token; nothing changes until the group starter approves.
create or replace function public.santa_request_new_link(
  p_code text, p_name text, p_public_key jsonb, p_token text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v santa.events; p santa.participants; v_owner text;
begin
  perform santa.check_key(p_public_key);
  if char_length(coalesce(p_token, '')) < 20 then
    raise exception 'Bad token.' using errcode = 'P0001';
  end if;
  select * into v from santa.events where code = p_code;
  if not found then
    raise exception 'We could not find that group. Check the link?' using errcode = 'P0001';
  end if;
  select * into p from santa.participants
   where event_id = v.id and lower(name) = lower(pg_catalog.btrim(p_name)) for update;
  if not found then
    raise exception 'Nobody in this group has that name.' using errcode = 'P0001';
  end if;
  if not exists (select 1 from santa.participants h
                 where h.event_id = v.id and h.id <> p.id and (h.is_host or h.id = v.owner_id)) then
    raise exception 'Nobody else in the group can approve a new link for you. Make someone a co-host first.' using errcode = 'P0001';
  end if;
  update santa.participants
     set pending_key = p_public_key, pending_token_hash = santa.hash_token(p_token), pending_at = now()
   where id = p.id;
  select name into v_owner from santa.participants where id = v.owner_id;
  return jsonb_build_object('owner_name', v_owner);
end $$;

-- What a new, not-yet-approved link should show.
create or replace function public.santa_link_status(p_token text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare h bytea := santa.hash_token(coalesce(p_token, '')); p santa.participants; v santa.events;
begin
  if exists (select 1 from santa.participants where token_hash = h) then
    return jsonb_build_object('status', 'active');
  end if;
  select * into p from santa.participants where pending_token_hash = h;
  if not found then
    return jsonb_build_object('status', 'unknown');
  end if;
  select * into v from santa.events where id = p.event_id;
  return jsonb_build_object('status', 'pending', 'title', v.title, 'name', p.name,
    'owner_name', (select name from santa.participants where id = v.owner_id));
end $$;

create or replace function public.santa_approve_new_link(p_token text, p_participant_id uuid, p_approve boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare m santa.participants; v santa.events; p santa.participants;
begin
  m := santa.me(p_token);
  select * into v from santa.events where id = m.event_id for update;
  if not santa.is_host(m) then
    raise exception 'Only a host can approve new links.' using errcode = 'P0001';
  end if;
  if p_participant_id = m.id then
    raise exception 'Someone else has to approve your own new link.' using errcode = 'P0001';
  end if;
  select * into p from santa.participants where id = p_participant_id and event_id = v.id for update;
  if not found or p.pending_token_hash is null then
    raise exception 'That request isn''t there anymore.' using errcode = 'P0001';
  end if;
  if not p_approve then
    update santa.participants set pending_key = null, pending_token_hash = null, pending_at = null where id = p.id;
    return;
  end if;
  update santa.participants
     set token_hash = p.pending_token_hash, public_key = p.pending_key,
         pending_key = null, pending_token_hash = null, pending_at = null,
         recovering = (v.status = 'drawn')
   where id = p.id;
  delete from santa.assignments where giver_id = p.id;   -- sealed to the lost key
  delete from santa.match_votes where for_id = p.id;     -- sealed to an older key
  delete from santa.link_backups where member_id = p.id or host_id = p.id; -- old link / old key
end $$;

-- Help someone with a new link find their match: send them your own target,
-- sealed to their new key. Only they can open it.
create or replace function public.santa_cast_vote(p_token text, p_for_id uuid, p_sealed text)
returns void language plpgsql security definer set search_path = '' as $$
declare m santa.participants; v santa.events;
begin
  m := santa.me(p_token);
  select * into v from santa.events where id = m.event_id;
  if v.status <> 'drawn' or m.recovering then
    raise exception 'Not ready to help yet.' using errcode = 'P0001';
  end if;
  if p_for_id = m.id or not exists (select 1 from santa.participants
       where id = p_for_id and event_id = v.id and recovering) then
    raise exception 'Nobody needs that.' using errcode = 'P0001';
  end if;
  if char_length(coalesce(p_sealed, '')) not between 20 and 4000 then
    raise exception 'Bad vote.' using errcode = 'P0001';
  end if;
  insert into santa.match_votes (for_id, voter_id, sealed) values (p_for_id, m.id, p_sealed)
    on conflict (for_id, voter_id) do update set sealed = excluded.sealed;
end $$;

-- Once everyone else has helped, store the recovered match sealed to the new key.
create or replace function public.santa_restore_match(p_token text, p_sealed text)
returns void language plpgsql security definer set search_path = '' as $$
declare m santa.participants; v_need int; v_have int;
begin
  m := santa.me(p_token);
  if not m.recovering then
    raise exception 'Your match isn''t missing.' using errcode = 'P0001';
  end if;
  select count(*) into v_need from santa.participants
   where event_id = m.event_id and id <> m.id and not recovering;
  select count(*) into v_have from santa.match_votes where for_id = m.id;
  if v_have < v_need then
    raise exception 'Still waiting for everyone to open the app.' using errcode = 'P0001';
  end if;
  if char_length(coalesce(p_sealed, '')) not between 20 and 4000 then
    raise exception 'Bad match.' using errcode = 'P0001';
  end if;
  insert into santa.assignments (event_id, giver_id, sealed) values (m.event_id, m.id, p_sealed)
    on conflict (event_id, giver_id) do update set sealed = excluded.sealed;
  update santa.participants set recovering = false where id = m.id;
  delete from santa.match_votes where for_id = m.id;
end $$;

-- The group starter makes someone a co-host (or not).
create or replace function public.santa_set_host(p_token text, p_participant_id uuid, p_is_host boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare m santa.participants; v santa.events;
begin
  m := santa.me(p_token);
  select * into v from santa.events where id = m.event_id for update;
  if v.owner_id is distinct from m.id then
    raise exception 'Only the person who started the group can choose co-hosts.' using errcode = 'P0001';
  end if;
  -- (the starter may switch this on for themselves too, to keep everyone's links)
  update santa.participants set is_host = coalesce(p_is_host, false)
   where id = p_participant_id and event_id = v.id;
  if not coalesce(p_is_host, false) then
    delete from santa.link_backups where host_id = p_participant_id;
  end if;
end $$;

-- Each member's browser leaves a copy of their own link for each co-host,
-- sealed to that co-host's public key. The starter can approve new links
-- but only co-hosts receive these backups.
create or replace function public.santa_give_backup(p_token text, p_host_id uuid, p_sealed text)
returns void language plpgsql security definer set search_path = '' as $$
declare m santa.participants; h santa.participants;
begin
  m := santa.me(p_token);
  select * into h from santa.participants where id = p_host_id and event_id = m.event_id;
  if not found or not h.is_host or h.id = m.id then
    raise exception 'That person isn''t a co-host.' using errcode = 'P0001';
  end if;
  if char_length(coalesce(p_sealed, '')) not between 20 and 4000 then
    raise exception 'Bad backup.' using errcode = 'P0001';
  end if;
  insert into santa.link_backups (host_id, member_id, sealed) values (h.id, m.id, p_sealed)
    on conflict (host_id, member_id) do update set sealed = excluded.sealed;
end $$;

-- lock every function down, then open exactly the API to the website roles
do $$
declare f text;
begin
  foreach f in array array[
    'santa_create_event(text,date,text,text,text,jsonb,text)',
    'santa_event_preview(text)',
    'santa_join_event(text,text,text,text,jsonb,text)',
    'santa_my_event(text)',
    'santa_update_me(text,text,text)',
    'santa_remove_participant(text,uuid)',
    'santa_submit_draw(text,jsonb)',
    'santa_send_gift(text,uuid,text)',
    'santa_unsend_gift(text,uuid)',
    'santa_open_gift(text,uuid)',
    'santa_delete_event(text)',
    'santa_request_new_link(text,text,jsonb,text)',
    'santa_link_status(text)',
    'santa_approve_new_link(text,uuid,boolean)',
    'santa_cast_vote(text,uuid,text)',
    'santa_restore_match(text,text)',
    'santa_set_host(text,uuid,boolean)',
    'santa_give_backup(text,uuid,text)'
  ] loop
    execute format('revoke all on function public.%s from public', f);
    execute format('grant execute on function public.%s to anon, authenticated', f);
  end loop;
end $$;
