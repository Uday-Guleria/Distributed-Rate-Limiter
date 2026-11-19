import mongoose from 'mongoose';
import { RateLimitRule } from '../models/RateLimitRule.js';

/** Rule storage interface: list(), upsert(name, data), remove(name). */
export class MemoryRulesRepo {
  constructor(initial = []) {
    this.rules = new Map(initial.map((r) => [r.name, { ...r }]));
  }
  async list() { return [...this.rules.values()].map((r) => ({ ...r })); }
  async get(name) { const r = this.rules.get(name); return r ? { ...r } : null; }
  async upsert(name, data) {
    const next = { ...(this.rules.get(name) ?? {}), ...data, name };
    this.rules.set(name, next);
    return { ...next };
  }
  async remove(name) { return this.rules.delete(name); }
}

export class MongoRulesRepo {
  async list() { return RateLimitRule.find().lean(); }
  async get(name) { return RateLimitRule.findOne({ name }).lean(); }
  async upsert(name, data) {
    return RateLimitRule.findOneAndUpdate(
      { name },
      { $set: { ...data, name } },
      { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true },
    ).lean();
  }
  async remove(name) { return (await RateLimitRule.deleteOne({ name })).deletedCount > 0; }
}

export async function connectMongo(uri) {
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
  return mongoose.connection;
}
