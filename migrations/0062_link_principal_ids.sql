-- phase: expand
-- Move paired-machine principal IDs to lnk_ while preserving all referencing rows.
-- Old table and column names remain for a later contract migration.
DO $$
DECLARE
    fk record;
    definition text;
BEGIN
    FOR fk IN
        SELECT c.conrelid::regclass AS relation, c.conname, pg_get_constraintdef(c.oid) AS definition
        FROM pg_constraint c
        WHERE c.contype = 'f' AND c.confrelid = 'platform_node_principals'::regclass
    LOOP
        definition := regexp_replace(fk.definition, 'ON UPDATE (NO ACTION|RESTRICT|CASCADE|SET NULL|SET DEFAULT)', 'ON UPDATE CASCADE');
        IF definition = fk.definition THEN
            definition := definition || ' ON UPDATE CASCADE';
        END IF;
        EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', fk.relation, fk.conname);
        EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I %s', fk.relation, fk.conname, definition);
    END LOOP;
END $$;

ALTER TABLE platform_node_principals DROP CONSTRAINT platform_node_principals_id_check;
UPDATE platform_node_principals
SET id = 'lnk_' || substring(id FROM 5)
WHERE id ~ '^nod_[0-9A-HJKMNP-TV-Z]{26}$';
ALTER TABLE platform_node_principals
    ADD CONSTRAINT platform_node_principals_id_check CHECK (id ~ '^lnk_[0-9A-HJKMNP-TV-Z]{26}$');
