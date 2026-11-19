-- Fixed window counter. Atomic INCR + PEXPIRE in one round trip.
-- KEYS[1] = counter key
-- ARGV[1] = limit, ARGV[2] = window in ms
-- Returns { allowed (1/0), count, ttlMs }
local limit = tonumber(ARGV[1])
local windowMs = tonumber(ARGV[2])

local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('PEXPIRE', KEYS[1], windowMs)
end

local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then
  -- Defensive: key somehow lost its TTL, restore it so it cannot live forever.
  redis.call('PEXPIRE', KEYS[1], windowMs)
  ttl = windowMs
end

local allowed = 0
if count <= limit then allowed = 1 end
return { allowed, count, ttl }
