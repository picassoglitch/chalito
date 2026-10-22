-- #82 audit: the deletion job claims the owner ('deleting') before any irreversible step, so a cancel
-- can't answer "cancelled" for an account that then gets deleted. A crashed run stays 'deleting' and is retried.
alter table chalito_private.account_deletions drop constraint if exists account_deletions_status_check;
alter table chalito_private.account_deletions
  add constraint account_deletions_status_check check (status in ('scheduled', 'cancelled', 'deleting'));

drop index if exists chalito_private.account_deletions_due;
create index account_deletions_due on chalito_private.account_deletions (due_at)
  where status in ('scheduled', 'deleting');
