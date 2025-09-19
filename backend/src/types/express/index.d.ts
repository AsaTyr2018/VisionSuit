import type { AuthenticatedUser } from '../../lib/auth';

declare global {
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
    }
  }
}

export {};
