import { createRequire } from 'module';

const require = createRequire(import.meta.url);

class AppError extends Error {
  constructor(statusCode, message, stack) {
    super(message);
    this.statusCode = statusCode;

    if (stack) {
      this.stack = stack;
    } else {
      Error.captureStackTrace(this, this.constructor);
    }
  }
}

export default AppError;
