const mongoose = require('mongoose');

/** A single document per counter name, incremented atomically.
 *  findOneAndUpdate with $inc is atomic in MongoDB even under concurrent
 *  requests — two simultaneous checkouts can never get the same number,
 *  unlike counting existing documents (the old, buggy approach). */
const counterSchema = new mongoose.Schema({
  _id: { type: String, required: true }, // e.g. 'orderNumber'
  seq: { type: Number, default: 1000 },
});

const Counter = mongoose.model('Counter', counterSchema);

async function getNextSequence(name, start = 1000) {
  // Make sure the counter exists (starting at `start`), then increment atomically.
  await Counter.updateOne({ _id: name }, { $setOnInsert: { seq: start } }, { upsert: true }).catch(() => {});
  const counter = await Counter.findByIdAndUpdate(name, { $inc: { seq: 1 } }, { new: true });
  return counter.seq;
}

module.exports = { Counter, getNextSequence };
