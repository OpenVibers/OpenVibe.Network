-- phase: expand
-- plan T2. Widen resource offer kinds with the v0.85.0 per-kind detail contracts.

ALTER TABLE platform_resource_offers DROP CONSTRAINT IF EXISTS platform_resource_offers_kind_check;
ALTER TABLE platform_resource_offers ADD CONSTRAINT platform_resource_offers_kind_check
    CHECK (kind IN ('node','provider','storage','delivery','runtime','agent','harness'));
