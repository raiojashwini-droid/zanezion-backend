import { sendResponse } from '../utils/response.js';

export const globalErrorHandler = (err, req, res, next) => {
  err.statusCode = err.statusCode || 500;
  err.message = err.message || 'Internal Server Error';

  // Log error in development
  if (process.env.NODE_ENV === 'development') {
    console.error('ERROR 💥', err);
  }

  // Handle Prisma errors specifically to prevent database exposure
  if (err.name === 'PrismaClientKnownRequestError') {
    if (err.code === 'P2002') {
      err.message = 'Duplicate field value entered';
      err.statusCode = 400;
    }
  } else if (err.name === 'PrismaClientInitializationError' || err.name === 'PrismaClientRustPanicError') {
    err.statusCode = 500;
    err.message = 'Database service temporarily unavailable';
  } else if (err.statusCode === 500 && process.env.NODE_ENV === 'production') {
    err.message = 'Internal Server Error';
  }

  sendResponse(res, err.statusCode, err.message);
};
