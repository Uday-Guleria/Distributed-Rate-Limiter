-- Sliding window log using a sorted set (score = timestamp in ms).
-- Uses Redis server time so app instances with skewed clocks agree.
-- KEYS[1] = zset key
-- ARGV[1] = limit, ARGV[2] = window in ms, ARGV[3] = unique request id
-- Returns { allowed (1/0), remaining, retryAfterMs }
local limit = tonumber(ARGV[1])
local windowMs = tonumber(ARGV[2])

local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)

redis.call('ZREMRANGEBYSCORE', KEYS[1], 0, now - windowMs)
local count = redis.call('ZCARD', KEYS[1])

if count < limit then
  redis.call('ZADD', KEYS[1], now, ARGV[3])
  redis.call('PEXPIRE', KEYS[1], windowMs)
  return { 1, limit - count - 1, 0 }
end

-- Denied: the caller can retry when the oldest entry leaves the window.
local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
local retry = windowMs
if oldest[2] then
  retry = tonumber(oldest[2]) + windowMs - now
  if retry < 1 then retry = 1 end
end
return { 0, 0, retry }
