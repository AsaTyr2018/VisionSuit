import bcrypt from 'bcryptjs';
import jwt, { type Secret, type SignOptions } from 'jsonwebtoken';
import type { User, UserRole } from '@prisma/client';

import { appConfig } from '../config';
import { resolveAvatarUrl } from './avatar';

export interface AuthTokenPayload {
  sub: string;
  role: UserRole;
  displayName: string;
  email: string;
}

export interface AuthenticatedUser {
  id: string;
  email: string;
  displayName: string;
  role: UserRole;
  bio?: string | null;
  avatarUrl?: string | null;
}

export const hashPassword = (password: string) => bcrypt.hash(password, 12);

export const verifyPassword = (password: string, passwordHash: string | null | undefined) => {
  if (!passwordHash || passwordHash.length === 0) {
    return Promise.resolve(false);
  }

  return bcrypt.compare(password, passwordHash);
};

export const createAccessToken = (payload: AuthTokenPayload) => {
  const options = { expiresIn: appConfig.auth.tokenExpiresIn } as unknown as SignOptions;
  return jwt.sign(payload, appConfig.auth.jwtSecret as Secret, options);
};

export const verifyAccessToken = (token: string): AuthTokenPayload => {
  const decoded = jwt.verify(token, appConfig.auth.jwtSecret);
  const normalized = typeof decoded === 'string' ? JSON.parse(decoded) : decoded;

  const { sub, role, displayName, email } = normalized as Partial<AuthTokenPayload>;

  if (!sub || !role || !displayName || !email) {
    throw new Error('Invalid token payload');
  }

  return { sub, role, displayName, email };
};

export const toAuthUser = (user: Pick<User, 'id' | 'email' | 'displayName' | 'role' | 'bio' | 'avatarUrl'>): AuthenticatedUser => {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
    bio: user.bio,
    avatarUrl: resolveAvatarUrl(user.id, user.avatarUrl ?? null),
  };
};
