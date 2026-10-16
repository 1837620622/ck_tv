/* eslint-disable no-console */

import { NextRequest, NextResponse } from 'next/server';

import { LOCAL_AUTH_SUBJECT } from '@/lib/auth';
import { DEFAULT_JSON_BODY_BYTES, readJsonBody } from '@/lib/body';
import { db, hasServerStorage } from '@/lib/db';
import { gateClosedFor, isGatedKey } from '@/lib/record-gate';
import { gateDenial } from '@/lib/region-gate';
import { PlayRecord } from '@/lib/types';
import { isAdultSource } from '@/lib/yellow';

export const runtime = 'edge';

export async function GET(request: NextRequest) {
  try {
    if (!hasServerStorage()) {
      return NextResponse.json(
        { error: '本地存储模式不提供服务端数据接口' },
        { status: 400 }
      );
    }

    const records = await db.getAllPlayRecords(LOCAL_AUTH_SUBJECT);
    // 没通过门控的访客看不到成人源和黄果的记录（key 形如 source+id）
    if ((await gateDenial(request)) === null) {
      return NextResponse.json(records, { status: 200 });
    }
    const visible = Object.fromEntries(
      Object.entries(records).filter(
        ([key]) => !isAdultSource({ key: key.split('+')[0] })
      )
    );
    return NextResponse.json(visible, { status: 200 });
  } catch (err) {
    console.error('获取播放记录失败', err);
    return NextResponse.json(
      { error: 'Internal Server Error' },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    if (!hasServerStorage()) {
      return NextResponse.json(
        { error: '本地存储模式不提供服务端数据接口' },
        { status: 400 }
      );
    }

    const parsed = await readJsonBody(request, DEFAULT_JSON_BODY_BYTES);
    if (!parsed.ok) {
      return NextResponse.json(
        { error: parsed.error },
        { status: parsed.status }
      );
    }
    const { key, record } = parsed.data as {
      key: string;
      record: PlayRecord;
    };

    if (!key || !record) {
      return NextResponse.json(
        { error: 'Missing key or record' },
        { status: 400 }
      );
    }

    // 验证播放记录数据
    if (!record.title || !record.source_name || record.index < 1) {
      return NextResponse.json(
        { error: 'Invalid record data' },
        { status: 400 }
      );
    }

    // 从key中解析source和id
    const [source, id] = key.split('+');
    if (!source || !id) {
      return NextResponse.json(
        { error: 'Invalid key format' },
        { status: 400 }
      );
    }

    // 成人源和黄果的记录，没通过门控不能写入
    if (isGatedKey(key) && (await gateClosedFor(request))) {
      return NextResponse.json({ error: '需要通过栏目口令' }, { status: 403 });
    }

    const finalRecord = {
      ...record,
      save_time: record.save_time ?? Date.now(),
    } as PlayRecord;

    await db.savePlayRecord(LOCAL_AUTH_SUBJECT, source, id, finalRecord);

    return NextResponse.json({ success: true }, { status: 200 });
  } catch (err) {
    console.error('保存播放记录失败', err);
    return NextResponse.json(
      { error: 'Internal Server Error' },
      { status: 500 }
    );
  }
}

export async function DELETE(request: NextRequest) {
  try {
    if (!hasServerStorage()) {
      return NextResponse.json(
        { error: '本地存储模式不提供服务端数据接口' },
        { status: 400 }
      );
    }

    const username = LOCAL_AUTH_SUBJECT;
    const { searchParams } = new URL(request.url);
    const key = searchParams.get('key');

    if (key) {
      // 如果提供了 key，删除单条播放记录
      const [source, id] = key.split('+');
      if (!source || !id) {
        return NextResponse.json(
          { error: 'Invalid key format' },
          { status: 400 }
        );
      }

      if (isGatedKey(key) && (await gateClosedFor(request))) {
        return NextResponse.json(
          { error: '需要通过栏目口令' },
          { status: 403 }
        );
      }

      await db.deletePlayRecord(username, source, id);
    } else {
      // 未提供 key，则清空全部播放记录
      // 目前 DbManager 没有对应方法，这里直接遍历删除
      const all = await db.getAllPlayRecords(username);
      // 没通过门控时，成人源和黄果的记录留着，不替别人删
      const closed = await gateClosedFor(request);
      await Promise.all(
        Object.keys(all).map(async (k) => {
          const [s, i] = k.split('+');
          if (s && i && !(closed && isGatedKey(k))) {
            await db.deletePlayRecord(username, s, i);
          }
        })
      );
    }

    return NextResponse.json({ success: true }, { status: 200 });
  } catch (err) {
    console.error('删除播放记录失败', err);
    return NextResponse.json(
      { error: 'Internal Server Error' },
      { status: 500 }
    );
  }
}
