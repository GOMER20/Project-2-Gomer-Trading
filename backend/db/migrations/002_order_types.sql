-- 002_order_types.sql
-- Stop orders. New enum values cannot be used in the transaction that adds
-- them, so the columns and constraints that rely on them are in 003.

ALTER TYPE order_type ADD VALUE IF NOT EXISTS 'STOP';
ALTER TYPE order_type ADD VALUE IF NOT EXISTS 'STOP_LIMIT';
