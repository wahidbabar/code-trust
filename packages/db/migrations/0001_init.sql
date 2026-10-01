-- Everything stored here is derived from git history, so any table can be rebuilt by analyzing
-- the repo again. The shapes mirror the zod schemas in packages/shared/src/domain.ts.
--
-- Every table hangs off repos with ON DELETE CASCADE: deleting a repo row removes all of its data
-- in one statement.

create table repos (
  -- GitHub's repository id, so a webhook can name a repo without a lookup.
  id bigint primary key check (id > 0),
  owner text not null check (owner ~ '^[A-Za-z0-9._-]{1,100}$'),
  name text not null check (name ~ '^[A-Za-z0-9._-]{1,100}$'),
  default_branch text not null check (char_length(default_branch) between 1 and 255),
  installation_id bigint check (installation_id > 0),
  head_sha text check (head_sha ~ '^[0-9a-f]{40}$'),
  head_committed_at timestamptz,
  observed_at timestamptz,
  -- All null before the first analysis, all set after.
  constraint repos_head_all_or_nothing check (num_nulls(head_sha, head_committed_at, observed_at) in (0, 3))
);

-- No author name or email: the metric needs neither.
create table commits (
  repo_id bigint not null references repos (id) on delete cascade,
  sha text not null check (sha ~ '^[0-9a-f]{40}$'),
  authored_at timestamptz not null,
  committed_at timestamptz not null,
  -- When the commit reached the mainline. The survival clock starts here.
  landed_at timestamptz not null,
  cohort text not null check (cohort in ('ai', 'human', 'automation')),
  primary key (repo_id, sha)
);

create table attributions (
  repo_id bigint not null references repos (id) on delete cascade,
  commit_sha text not null,
  signal text not null check (signal in ('co_author_trailer', 'author_identity')),
  tool text not null check (tool ~ '^[a-z0-9][a-z0-9-]{0,39}$'),
  confidence double precision not null check (confidence >= 0 and confidence <= 1),
  -- The matched AI identity or AI trailer only. One short line cannot hold a trailer block, which
  -- is where a human co-author would ride along.
  evidence text not null check (char_length(evidence) <= 200 and evidence !~ '[\r\n]'),
  primary key (repo_id, commit_sha, signal, tool),
  foreign key (repo_id, commit_sha) references commits (repo_id, sha) on delete cascade
);

-- One row per group of lines that share a birth and a fate. Alive groups have no end time: they
-- are censored at repos.observed_at, so a new analysis never rewrites them.
create table survival_observations (
  repo_id bigint not null references repos (id) on delete cascade,
  introduced_by text not null,
  removed_by text,
  line_count integer not null check (line_count > 0),
  introduced_at timestamptz not null,
  removed_at timestamptz,
  -- NULLS NOT DISTINCT (Postgres 15+): a commit has at most one alive group.
  constraint survival_observations_birth_and_fate unique nulls not distinct (repo_id, introduced_by, removed_by),
  constraint survival_observations_removed_together check ((removed_by is null) = (removed_at is null)),
  foreign key (repo_id, introduced_by) references commits (repo_id, sha) on delete cascade,
  foreign key (repo_id, removed_by) references commits (repo_id, sha) on delete cascade
);

-- Lets a commit delete find the groups it removed without scanning the table.
create index survival_observations_removed_by on survival_observations (repo_id, removed_by)
  where removed_by is not null;

-- The latest numbers per repo and measured cohort. head_sha has no commit key: the head need not
-- introduce or remove a tracked line, so it may have no commits row.
create table survival_rollups (
  repo_id bigint not null references repos (id) on delete cascade,
  cohort text not null check (cohort in ('ai', 'human')),
  head_sha text not null check (head_sha ~ '^[0-9a-f]{40}$'),
  observed_at timestamptz not null,
  lines_total integer not null check (lines_total >= 0),
  lines_removed integer not null check (lines_removed >= 0),
  lines_censored integer not null check (lines_censored >= 0),
  -- Null when no line has been observed that long yet.
  survival_30d double precision check (survival_30d >= 0 and survival_30d <= 1),
  survival_90d double precision check (survival_90d >= 0 and survival_90d <= 1),
  survival_180d double precision check (survival_180d >= 0 and survival_180d <= 1),
  -- The whole step function. It is written and read as one value, and zod checks it on the way out.
  curve jsonb not null check (jsonb_typeof(curve) = 'array'),
  primary key (repo_id, cohort),
  constraint survival_rollups_lines_add_up check (lines_total = lines_removed + lines_censored)
);
