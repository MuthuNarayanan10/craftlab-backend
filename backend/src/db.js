const mongoose = require('mongoose');
const { logger } = require('./utils/logger');

async function connectDB() {
  const uri = process.env.MONGODB_URI;
  if (!uri) { logger.error('config_missing', { error: 'MONGODB_URI is not set' }); process.exit(1); }
  try {
    await mongoose.connect(uri, { maxPoolSize: 20, serverSelectionTimeoutMS: 10000, socketTimeoutMS: 45000 });
    logger.info('db_connected', {});
  } catch (err) { logger.error('db_connect_failed', { error: err.message }); process.exit(1); }
  mongoose.connection.on('disconnected', () => logger.warn('db_disconnected', {}));
  mongoose.connection.on('reconnected', () => logger.info('db_reconnected', {}));
}
module.exports = connectDB;
