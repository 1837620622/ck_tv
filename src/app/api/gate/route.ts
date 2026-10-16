import { NextResponse } from 'next/server';

import { readJsonBody } from '@/lib/body';
import {
  countryOf,
  GATE_COOKIE,
  GATE_TOKEN,
  gateOpen,
  isForeignCountry,
  passwordMatches,
  PRIVATE_HEADERS,
} from '@/lib/region-gate';

export const runtime = 'edge';

function statusBody(request: Request) {
  const foreign = isForeignCountry(countryOf(request));
  return {
    foreign,
    open: foreign && gateOpen(request),
  };
}

export async function GET(request: Request) {
  const body = statusBody(request);
  return NextResponse.json(body, {
    status: body.foreign ? 200 : 403,
    headers: PRIVATE_HEADERS,
  });
}

export async function POST(request: Request) {
  const foreign = isForeignCountry(countryOf(request));
  if (!foreign) {
    return NextResponse.json(
      { foreign: false, open: false },
      { status: 403, headers: PRIVATE_HEADERS }
    );
  }

  const parsed = await readJsonBody(request, 1024);
  const raw =
    parsed.ok &&
    parsed.data &&
    typeof (parsed.data as { code?: unknown }).code === 'string'
      ? (parsed.data as { code: string }).code
      : '';
  if (!passwordMatches(raw)) {
    return NextResponse.json(
      { foreign: true, open: false },
      { status: 403, headers: PRIVATE_HEADERS }
    );
  }

  const response = NextResponse.json(
    { foreign: true, open: true },
    { headers: PRIVATE_HEADERS }
  );
  response.cookies.set(GATE_COOKIE, GATE_TOKEN, {
    httpOnly: true,
    sameSite: 'lax',
    secure: new URL(request.url).protocol === 'https:',
    path: '/',
  });
  return response;
}
