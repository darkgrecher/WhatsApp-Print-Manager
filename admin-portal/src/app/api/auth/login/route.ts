import { NextRequest, NextResponse } from 'next/server';
import { signToken, validateCredentials } from '@/lib/auth';

export async function POST(request: NextRequest) {
  try {
    const { username, password } = await request.json();

    if (!validateCredentials(username, password)) {
      return NextResponse.json(
        { message: 'Invalid credentials' },
        { status: 401 },
      );
    }

    const access_token = await signToken({ sub: 'admin', username });
    return NextResponse.json({ access_token });
  } catch {
    return NextResponse.json(
      { message: 'Internal server error' },
      { status: 500 },
    );
  }
}
