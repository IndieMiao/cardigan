-- Background loops select live statuses without a recipient. The existing
-- recipient index cannot seek status unless recipient/assignment are known.
CREATE INDEX notifications_by_status
  ON notifications (project_id, status, seq, id);
