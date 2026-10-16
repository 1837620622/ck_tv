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
  gateConfigProblems,
  gateOpen,
  isForeignCountry,
  issueGateCookie,
  passwordMatches,
  PRIVATE_HEADERS,
} from '@/lib/region-gate';

export const runtime = 'edge';

async function statusBody(request: Request) {
  const foreign = isForeignCountry(countryOf(request));
  // problems 为空表示配置完整；不为空时列出缺的项，方便在页面上直接看到
  const problems = gateConfigProblems();
  return {
    foreign,
    open: foreign && (await gateOpen(request)),
    problems,
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
  // 没配口令或签名密钥时不接受任何尝试，免得访客误以为是口令不对
  const problems = gateConfigProblems();
  if (problems.length > 0) {
    return NextResponse.json(
      {
        error: `栏目口令还没有配好：${problems.join(
          '；'
        )}。请在部署环境的环境变量里设置，然后重新部署。`,
        problems,
      },
      { status: 503, headers: PRIVATE_HEADERS }
    );
  }

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
  if (!token) {
    return NextResponse.json(
      { error: '服务器未配置栏目口令' },
      { status: 503, headers: PRIVATE_HEADERS }
    );
  }
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
