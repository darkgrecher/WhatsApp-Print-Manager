import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

// Public — Electron app reads a single setting by key
export async function GET(
  _request: NextRequest,
  { params }: { params: { key: string } },
) {
  try {
    const row = await prisma.setting.findUnique({
      where: { key: params.key },
    });

    return NextResponse.json(
      row ? { key: row.key, value: row.value } : { key: params.key, value: '' },
    );
  } catch {
    return NextResponse.json(
      { message: 'Internal server error' },
      { status: 500 },
    );
  }
}
