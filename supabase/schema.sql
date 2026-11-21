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

alter table santa.events       enable row level security;
alter table santa.participants enable row level security;
alter table santa.assignments  enable row level security;
alter table santa.gifts        enable row level security;
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
                             'gift_pref', m.gift_pref, 'is_owner', v.owner_id = m.id),
    'participants', coalesce((select jsonb_agg(jsonb_build_object(
        'id', p.id, 'name', p.name, 'wishlist', p.wishlist, 'gift_pref', p.gift_pref,
        'public_key', p.public_key, 'is_owner', v.owner_id = p.id) order by p.created_at)
      from santa.participants p where p.event_id = v.id), '[]'::jsonb),
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
    'santa_open_gift(text,uuid)'
  ] loop
    execute format('revoke all on function public.%s from public', f);
    execute format('grant execute on function public.%s to anon, authenticated', f);
  end loop;
end $$;
