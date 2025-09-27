import http from 'node:http';
import type { IncomingHttpHeaders, IncomingMessage, RequestOptions } from 'node:http';
import type { Socket } from 'node:net';
import { pipeline } from 'node:stream/promises';
import { URL } from 'node:url';

import type { RequestHandler } from 'express';

import { appConfig } from '../config';
import { prisma } from '../lib/prisma';
import { verifyAccessToken } from '../lib/auth';
import { PRISMA_STUDIO_COOKIE_NAME } from './constants';

type UpgradeHandler = (req: IncomingMessage, socket: Socket, head: Buffer) => Promise<boolean>;

const isPrismaRequest = (url: string | undefined) => Boolean(url && url.startsWith('/db'));

const sanitizeProxyPath = (originalUrl: string | undefined): string => {
  if (!originalUrl) {
    return '/';
  }

  if (!originalUrl.startsWith('/db')) {
    return originalUrl;
  }

  const trimmed = originalUrl.slice(3);
  if (trimmed.length === 0) {
    return '/';
  }

  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
};

const cloneHeaders = (headers: IncomingHttpHeaders) => {
  const cloned: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === 'undefined') {
      continue;
    }

    if (key.toLowerCase() === 'connection') {
      cloned[key] = 'keep-alive';
      continue;
    }

    if (key.toLowerCase() === 'host') {
      cloned[key] = `${appConfig.prismaStudio.host}:${appConfig.prismaStudio.port}`;
      continue;
    }

    cloned[key] = value;
  }

  return cloned;
};

const applyProxyResponse = async (res: Parameters<RequestHandler>[1], proxyRes: IncomingMessage) => {
  res.status(proxyRes.statusCode ?? 500);
  for (const [key, value] of Object.entries(proxyRes.headers)) {
    if (typeof value === 'undefined') {
      continue;
    }

    res.setHeader(key, value);
  }

  await pipeline(proxyRes, res);
};

const extractCookieValue = (cookieHeader: string | undefined, name: string): string | null => {
  if (!cookieHeader) {
    return null;
  }

  const segments = cookieHeader.split(';');
  for (const segment of segments) {
    const [rawName, ...rawValue] = segment.split('=');
    if (!rawName) {
      continue;
    }

    if (rawName.trim() !== name) {
      continue;
    }

    const value = rawValue.join('=').trim();
    if (!value) {
      return null;
    }

    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }

  return null;
};

const extractTokenFromHeaders = (headers: IncomingHttpHeaders): string | null => {
  const authorization = headers['authorization'];
  if (typeof authorization === 'string') {
    const trimmed = authorization.trim();
    if (trimmed.toLowerCase().startsWith('bearer ')) {
      const token = trimmed.slice(7).trim();
      if (token) {
        return token;
      }
    }

    if (trimmed) {
      return trimmed;
    }
  }

  return null;
};

const extractTokenForUpgrade = (req: IncomingMessage): string | null => {
  const headerToken = extractTokenFromHeaders(req.headers);
  if (headerToken) {
    return headerToken;
  }

  if (req.url) {
    try {
      const parsed = new URL(req.url, 'http://localhost');
      const queryToken = parsed.searchParams.get('accessToken') ?? parsed.searchParams.get('token');
      if (queryToken && queryToken.trim().length > 0) {
        return queryToken.trim();
      }
    } catch {
      // Ignore malformed URLs
    }
  }

  const cookieToken = extractCookieValue(req.headers.cookie, PRISMA_STUDIO_COOKIE_NAME);
  if (cookieToken) {
    return cookieToken;
  }

  return null;
};

const respondWithSocketError = (socket: Socket, status: number, message: string) => {
  const statusText = (() => {
    switch (status) {
      case 401:
        return 'Unauthorized';
      case 403:
        return 'Forbidden';
      case 502:
        return 'Bad Gateway';
      default:
        return 'Error';
    }
  })();

  const body = Buffer.from(message, 'utf8');
  socket.write(
    `HTTP/1.1 ${status} ${statusText}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n`,
  );
  socket.write(body);
  socket.destroy();
};

const ensureAdminForToken = async (token: string) => {
  const payload = verifyAccessToken(token);
  const user = await prisma.user.findUnique({
    where: { id: payload.sub },
    select: { role: true, isActive: true },
  });

  if (!user || !user.isActive) {
    throw new Error('User inactive or missing');
  }

  if (user.role !== 'ADMIN') {
    throw new Error('Administrator privileges required');
  }
};

export const createPrismaStudioProxy = (): RequestHandler => {
  return async (req, res) => {
    const targetPath = sanitizeProxyPath(req.originalUrl);
    const requestOptions: RequestOptions = {
      hostname: appConfig.prismaStudio.host,
      port: appConfig.prismaStudio.port,
      method: req.method,
      path: targetPath,
      headers: cloneHeaders(req.headers),
    };

    const proxyReq = http.request(requestOptions, (proxyRes) => {
      void applyProxyResponse(res, proxyRes).catch(() => {
        if (!res.headersSent) {
          res.status(502).json({ message: 'Prisma Studio response failed.' });
        }
      });
    });

    proxyReq.on('error', (error) => {
      if (!res.headersSent) {
        res.status(502).json({ message: 'Prisma Studio service unavailable.', detail: String(error) });
      } else {
        res.end();
      }
    });

    req.on('aborted', () => {
      proxyReq.destroy();
    });

    if (req.readable) {
      req.pipe(proxyReq);
    } else {
      proxyReq.end();
    }
  };
};

export const createPrismaStudioUpgradeHandler = (): UpgradeHandler => {
  return async (req, socket, head) => {
    if (!isPrismaRequest(req.url)) {
      return false;
    }

    try {
      const token = extractTokenForUpgrade(req);
      if (!token) {
        respondWithSocketError(socket, 401, 'Authentication token missing.');
        return true;
      }

      await ensureAdminForToken(token);
    } catch (error) {
      respondWithSocketError(socket, 403, error instanceof Error ? error.message : 'Access denied.');
      return true;
    }

    const targetPath = sanitizeProxyPath(req.url);
    const requestOptions: RequestOptions = {
      hostname: appConfig.prismaStudio.host,
      port: appConfig.prismaStudio.port,
      method: req.method ?? 'GET',
      path: targetPath,
      headers: cloneHeaders(req.headers),
    };

    const proxyReq = http.request(requestOptions);

    proxyReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
      const statusLine = `HTTP/1.1 ${proxyRes.statusCode ?? 101} Switching Protocols\r\n`;
      const headerLines = Object.entries(proxyRes.headers)
        .flatMap(([key, value]) => {
          if (typeof value === 'undefined') {
            return [] as string[];
          }
          if (Array.isArray(value)) {
            return value.map((entry) => `${key}: ${entry}`);
          }
          return [`${key}: ${value}`];
        })
        .join('\r\n');

      socket.write(`${statusLine}${headerLines}\r\n\r\n`);

      if (head && head.length > 0) {
        proxySocket.write(head);
      }
      if (proxyHead && proxyHead.length > 0) {
        socket.write(proxyHead);
      }

      proxySocket.pipe(socket);
      socket.pipe(proxySocket);
    });

    proxyReq.on('error', () => {
      respondWithSocketError(socket, 502, 'Failed to reach Prisma Studio service.');
    });

    proxyReq.end(head);
    return true;
  };
};
