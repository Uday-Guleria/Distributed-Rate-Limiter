import mongoose from 'mongoose';
import { ALGORITHMS } from '../limiter/algorithms.js';

const schema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true, trim: true },
    algorithm: { type: String, enum: ALGORITHMS },
    limit: { type: Number, min: 1 },
    windowMs: { type: Number, min: 100 },
    bucketSize: { type: Number, min: 1 },
    refillRatePerSec: { type: Number, min: 0.001 },
    failOpen: { type: Boolean },
    enabled: { type: Boolean, default: true },
  },
  { timestamps: true },
);

export const RateLimitRule = mongoose.models.RateLimitRule || mongoose.model('RateLimitRule', schema);
