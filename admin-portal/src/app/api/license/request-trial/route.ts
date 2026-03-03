import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

export async function POST(request: NextRequest) {
  try {
    const { phoneNumber, name } = await request.json();

    const existing = await prisma.user.findUnique({
      where: { phoneNumber },
    });

    if (existing) {
      if (existing.status === 'PENDING') {
        return NextResponse.json({
          success: true,
          message: 'Trial request already submitted. Awaiting approval.',
        });
      }
      if (existing.status === 'ACTIVE') {
        return NextResponse.json({
          success: false,
          message: 'You already have an active plan.',
        });
      }
      // Re-request for expired/rejected users
      await prisma.user.update({
        where: { id: existing.id },
        data: {
          status: 'PENDING',
          displayName: name || existing.displayName,
        },
      });
      return NextResponse.json({
        success: true,
        message: 'Trial request submitted successfully.',
      });
    }

    await prisma.user.create({
      data: {
        phoneNumber,
        displayName: name,
        status: 'PENDING',
      },
    });

    return NextResponse.json({
      success: true,
      message: 'Trial request submitted successfully.',
    });
  } catch {
    return NextResponse.json(
      { message: 'Internal server error' },
      { status: 500 },
    );
  }
}
