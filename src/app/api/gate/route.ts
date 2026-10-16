import { NextResponse } from 'next/server';

import {
  clearFailures,
  recordFailure,
  retryAfterSeconds,
} from '@/lib/attempt-limit';
import { readJsonBody } from '@/lib/body';
import {
  countryOf,
  GATE_COOKIE,
  GATE_MAX_AGE_SECONDS,
  gateOpen,
  isForeignCountry,
  issueGateCookie,
  passwordMatches,
  PRIVATE_HEADERS,
} from '@/lib/region-gate';

export const runtime = 'edge';

async function statusBody(request: Request) {
  const foreign = isForeignCountry(countryOf(request));
  return {
    foreign,
    open: foreign && (await gateOpen(request)),
  };
}

export async function GET(request: Request) {
  const body = await statusBody(request);
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

  // Cloudflare 会带上真实来源 IP；拿不到时所有请求共用一个计数
  const key = request.headers.get('cf-connecting-ip')?.trim() || 'unknown';
  const wait = retryAfterSeconds(key);
  if (wait > 0) {
    return NextResponse.json(
      { error: '尝试次数过多，请稍后再试' },
      {
        status: 429,
        headers: { ...PRIVATE_HEADERS, 'Retry-After': String(wait) },
      }
    );
  }

  const parsed = await readJsonBody(request, 1024);
  const raw =
    parsed.ok &&
    parsed.data &&
    typeof (parsed.data as { code?: unknown }).code === 'string'
      ? (parsed.data as { code: string }).code
      : '';
  if (!(await passwordMatches(raw))) {
    recordFailure(key);
    return NextResponse.json(
      { foreign: true, open: false },
      { status: 403, headers: PRIVATE_HEADERS }
    );
  }

  const token = await issueGateCookie();
  clearFailures(key);

  const response = NextResponse.json(
    { foreign: true, open: true },
    { headers: PRIVATE_HEADERS }
  );
  response.cookies.set(GATE_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: new URL(request.url).protocol === 'https:',
    path: '/',
    maxAge: GATE_MAX_AGE_SECONDS,
  });
  return response;
}
