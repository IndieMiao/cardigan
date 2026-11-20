-- Scope pre-migration identities once; never rewrite historical assignments or audit events.
UPDATE employees SET doc = json_set(doc, '$.projects', json_array('cardigan'));
