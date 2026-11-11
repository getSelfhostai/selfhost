-- Revoking someone from a team ends their membership there, not only the tokens issued for it.
-- A person's token from another team of the org reads and acts only in teams where their
-- membership is active (revoked_at IS NULL), so a revoked person cannot reach the team through it.
ALTER TABLE people ADD COLUMN revoked_at timestamptz;

-- People who joined a team and hold no live person token there any more were revoked from it (or
-- left it). People added from another team never held a token in it, so they stay members.
UPDATE people p SET revoked_at = last.revoked_at
FROM (
  SELECT team_id, person_id, max(revoked_at) AS revoked_at
  FROM tokens WHERE kind = 'person'
  GROUP BY team_id, person_id
  HAVING bool_and(revoked_at IS NOT NULL)
) last
WHERE p.team_id = last.team_id AND p.id = last.person_id;
