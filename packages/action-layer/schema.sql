-- Tables for @venture/action-layer.
--
-- The log is the important one, and it is append-only on purpose: no update,
-- no delete. A record an agent could edit is not evidence, and the whole
-- reason this layer exists is to be able to answer "what did they actually
-- do" with something more solid than a model's own account of it.
--
-- Enforced rather than documented — see the triggers at the bottom. A
-- revoked GRANT can be restored by anyone with the right role, but a trigger
-- refuses regardless of who is asking.

create table if not exists action_scopes (
  venture_id      text    not null,
  action          text    not null,
  -- Off until the founder turns it on. Never default true.
  enabled         boolean not null default false,
  -- NULL means this action takes no target. An empty array means a target is
  -- required and nothing is permitted yet — the two are not the same, and
  -- reading the second as "anything goes" is how a scope silently opens up.
  allowed_targets text[],
  max_per_day     integer,
  max_per_week    integer,
  cooldown_ms     integer,
  primary key (venture_id, action)
);

-- One row, always. The founder's stop button.
create table if not exists action_halt (
  id         boolean primary key default true check (id),
  halted     boolean not null default false,
  reason     text,
  changed_at timestamptz not null default now()
);

create table if not exists action_log (
  id         bigserial primary key,
  at         timestamptz not null default now(),
  venture_id text not null,
  agent_id   text not null,
  action     text not null,
  target     text,
  -- 'denied' rows are the valuable ones: they are how you discover an agent
  -- has been trying something for a week.
  outcome    text not null check (outcome in ('allowed', 'denied', 'failed')),
  reason     text,
  rationale  text,
  cost_usd   double precision,
  detail     jsonb
);

-- Every hot query the gate makes is one of these two.
create index if not exists action_log_rate_idx
  on action_log (venture_id, action, outcome, at desc);
create index if not exists action_log_recent_idx
  on action_log (at desc);

-- Append-only, enforced.
create or replace function action_log_is_append_only() returns trigger as $$
begin
  raise exception 'action_log is append-only: % is not permitted', tg_op;
end;
$$ language plpgsql;

drop trigger if exists action_log_no_update on action_log;
create trigger action_log_no_update
  before update on action_log
  for each row execute function action_log_is_append_only();

drop trigger if exists action_log_no_delete on action_log;
create trigger action_log_no_delete
  before delete on action_log
  for each row execute function action_log_is_append_only();
