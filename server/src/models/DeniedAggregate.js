import mongoose from 'mongoose';

// One document per (route, identity, minute) so a flood of denials becomes one row, not thousands.
const schema = new mongoose.Schema({
  route: { type: String, required: true },
  identity: { type: String, required: true },
  minute: { type: Date, required: true },
  count: { type: Number, default: 0 },
  firstAt: Date,
  lastAt: Date,
});
schema.index({ route: 1, identity: 1, minute: 1 }, { unique: true });
schema.index({ minute: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 14 }); // keep 14 days

export const DeniedAggregate =
  mongoose.models.DeniedAggregate || mongoose.model('DeniedAggregate', schema);
