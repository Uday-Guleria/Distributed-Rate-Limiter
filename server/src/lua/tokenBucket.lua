-- Token bucket with continuous refill, computed lazily on each call.
-- KEYS[1] = hash key (fields: tokens, ts)
-- ARGV[1] = capacity, ARGV[2] = refill rate (tokens/second), ARGV[3] = cost
-- Returns { allowed (1/0), floor(tokens left), retryAfterMs }
local capacity = tonumber(ARGV[1])
local rate = tonumber(ARGV[2])
local cost = tonumber(ARGV[3])

local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)

local data = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(data[1])
local ts = tonumber(data[2])
if tokens == nil then
  tokens = capacity
  ts = now
end

local elapsed = math.max(0, now - ts)
tokens = math.min(capacity, tokens + (elapsed / 1000) * rate)

local allowed = 0
local retry = 0
if tokens >= cost then
  tokens = tokens - cost
  allowed = 1
else
  retry = math.ceil(((cost - tokens) / rate) * 1000)
end

redis.call('HSET', KEYS[1], 'tokens', tostring(tokens), 'ts', now)
-- Keep the key only as long as it takes to fully refill (plus slack).
local ttl = math.max(1000, math.ceil((capacity / rate) * 1000) * 2)
redis.call('PEXPIRE', KEYS[1], ttl)

return { allowed, math.floor(tokens), retry }
