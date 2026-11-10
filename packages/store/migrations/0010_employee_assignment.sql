-- Unicode name keys are rebuilt by migrateEmployeeNames in the same transaction.
DROP INDEX employees_active_name;

-- Identity belongs to the persistent Assignment, including legacy unnamed rows.
CREATE TRIGGER assignment_employee_immutable
BEFORE UPDATE OF doc ON assignments
WHEN json_extract(OLD.doc, '$.employee_id') IS NOT json_extract(NEW.doc, '$.employee_id')
BEGIN
  SELECT RAISE(ABORT, 'Assignment employee_id is immutable');
END;
