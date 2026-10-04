-- Call lines are read to the voice agent (R-H3, R-L11). Besides the agent's own checks (CallLine:
-- NFKC + an allowlist), the database refuses lines that aren't NFKC-normalized or that carry
-- quotes, markup, paths or shell syntax, so a client that skips the schema still can't plant them.
-- NOT VALID: existing rows (TTL ≤ 30 min) aren't rechecked; every new or updated row is.
alter table chalito.call_lines
  add constraint call_lines_line_charset check (
    line is nfkc normalized
    and line !~ '["«»“”„‟‹›‘’`<>/\\{}|$~\[\]]'
    and line !~ '[[:cntrl:]]'
  ) not valid;
