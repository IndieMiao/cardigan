-- C-399: the scoped card projection also selects reviews by verification item.
-- Keep project-only legacy readers on their existing traversal indexes.
CREATE INDEX reviews_by_work_item
  ON reviews (project_id, json_extract(doc, '$.work_item_id'))
  WHERE json_extract(doc, '$.work_item_id') IS NOT NULL;
