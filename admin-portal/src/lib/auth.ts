import { SignJWT, jwtVerify } from 'jose';
import { NextRequest, NextResponse } from 'next/server';

const JWT_SECRET = new TextEncoder().encode(
  process.env.JWT_SECRET || 'whatsapp-print-manager-secret-key',
);
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

export async function signToken(payload: Record<string, unknown>) {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('24h')
    .sign(JWT_SECRET);
}

export async function verifyToken(token: string) {
  const { payload } = await jwtVerify(token, JWT_SECRET);
  return payload;
}

export function validateCredentials(username: string, password: string) {
  return username === ADMIN_USERNAME && password === ADMIN_PASSWORD;
}

/**
 * Extracts and verifies the JWT from the Authorization header.
 * Returns the payload on success, or a 401 NextResponse on failure.
 */
export async function authenticate(
  request: NextRequest,
): Promise<NextResponse | Record<string, unknown>> {
  const authHeader = request.headers.get('authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return NextResponse.json(
      { message: 'Missing or invalid token' },
      { status: 401 },
    );
  }

  const token = authHeader.split(' ')[1];
  try {
    const payload = await verifyToken(token);
    return payload as Record<string, unknown>;
  } catch {
    return NextResponse.json(
      { message: 'Invalid or expired token' },
      { status: 401 },
    );
  }
}
