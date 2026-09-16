-- `paid_attempts` originally counted every 402, which meant any crawler that
-- touched a paid path was recorded as a caller trying to buy. Challenges now
-- have their own column so `paid_attempts` can mean what its name says:
-- a request that actually carried a payment payload.
ALTER TABLE endpoint_counters ADD COLUMN challenges INTEGER NOT NULL DEFAULT 0;
