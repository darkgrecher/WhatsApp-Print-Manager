import { PrismaClient } from '@prisma/client';

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient };

export const prisma =
  globalForPrisma.prisma ||
  new PrismaClient();

// Cache the client on globalThis to avoid exhausting connections in both
// development (HMR) and production (serverless warm containers).
globalForPrisma.prisma = prisma;
