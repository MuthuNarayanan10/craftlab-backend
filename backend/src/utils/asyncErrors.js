/** Express 4 does not catch rejected promises from async route handlers —
 *  a single DB error would leave the request hanging and (on modern Node)
 *  can crash the process. This forwards async errors to the error handler,
 *  same behaviour as the express-async-errors package, without a dependency. */
const Layer = require('express/lib/router/layer');

Layer.prototype.handle_request = function handle(req, res, next) {
  const fn = this.handle;
  if (fn.length > 3) return next(); // error-handling middleware: skip
  try {
    const ret = fn(req, res, next);
    if (ret && typeof ret.catch === 'function') ret.catch(next);
  } catch (err) {
    next(err);
  }
};
