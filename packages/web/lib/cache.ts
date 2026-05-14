/**
 * 转录结果缓存
 *
 * key = SHA-256(文件内容) + ":" + sourceLang
 *
 * 存储后端优先级：
 *   1. Upstash Redis（如果配置了 KV_REST_API_URL）— 跨实例持久缓存
 *   2. 进程内 LRU（仅同一 Vercel 实例有效，重启清空）
 *
 * Upstash 开通：
 *   vercel.com → Project → Storage → Upstash → Create
 *   会自动注入 KV_REST_API_URL / KV_REST_API_TOKEN
 *   免费额度：10,000 请求/天，256 MB 存储
 */

import type { Segment } from "@subgen/shared";
import { createHash } from "crypto";

export interface CacheValue {
  segments: Segment[];
  provider: string; // 记录是哪个 ASR 识别的
}

// ── 进程内 LRU（最多 50 条，TTL 24h）──────────────────────────────
const MAX_ENTRIES = 50;
const TTL_MS = 24 * 60 * 60 * 1000;

interface Entry {
  value: CacheValue;
  expiresAt: number;
}

const lru = new Map<string, Entry>();

function lruGet(key: string): CacheValue | null {
  const entry = lru.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    lru.delete(key);
    return null;
  }
  // 访问时移到末尾（LRU）
  lru.delete(key);
  lru.set(key, entry);
  return entry.value;
}

function lruSet(key: string, value: CacheValue) {
  if (lru.size >= MAX_ENTRIES) {
    // 删除最久未访问的
    lru.delete(lru.keys().next().value!);
  }
  lru.set(key, { value, expiresAt: Date.now() + TTL_MS });
}

// ── Upstash Redis（可选）─────────────────────────────────────────────
async function kvGet(key: string): Promise<CacheValue | null> {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;

  try {
    const res = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const json = await res.json() as { result: string | null };
    if (!json.result) return null;
    return JSON.parse(json.result) as CacheValue;
  } catch {
    return null;
  }
}

async function kvSet(key: string, value: CacheValue) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return;

  try {
    // ["SET", key, value, "EX", 604800]（7 天 TTL）
    await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(["SET", key, JSON.stringify(value), "EX", 604800]),
    });
  } catch {
    // 缓存写失败不影响主流程
  }
}

// ── 公开 API ─────────────────────────────────────────────────────────

/** 用文件内容 SHA-256 + sourceLang 生成 cache key */
export function hashBuffer(buf: Buffer, sourceLang: string): string {
  return createHash("sha256").update(buf).digest("hex") + ":" + sourceLang;
}

export async function cacheGet(key: string): Promise<CacheValue | null> {
  // 先查内存
  const mem = lruGet(key);
  if (mem) return mem;
  // 再查 KV
  const kv = await kvGet(key);
  if (kv) {
    lruSet(key, kv); // 回填内存
    return kv;
  }
  return null;
}

export async function cacheSet(key: string, value: CacheValue) {
  lruSet(key, value);
  await kvSet(key, value); // 异步写 KV，不阻塞
}
