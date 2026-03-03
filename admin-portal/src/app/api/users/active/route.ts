import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { authenticate } from '@/lib/auth';

export async function GET(request: NextRequest) {
  const authResult = await authenticate(request);
  if (authResult instanceof NextResponse) return authResult;

  try {
    // Auto-expire
    await prisma.user.updateMany({
      where: {
        status: 'ACTIVE',
        planEndDate: { lt: new Date() },
      },
      data: { status: 'EXPIRED' },
    });

    const users = await prisma.user.findMany({
      where: { status: 'ACTIVE' },
      orderBy: { createdAt: 'desc' },
    });

    return NextResponse.json(users);
  } catch {
    return NextResponse.json(
      { message: 'Internal server error' },
      { status: 500 },
    );
  }
}
