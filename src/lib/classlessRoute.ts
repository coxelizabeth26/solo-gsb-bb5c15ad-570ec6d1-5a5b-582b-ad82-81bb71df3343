/**
 * DHCP 无类静态路由（Classless Static Route, DHCP Option 121 / RFC 3442）。
 *
 * 每条路由由「目标 CIDR + 下一跳 IPv4」组成，编码为：
 *
 *   1 字节子网掩码宽度（前缀长度 0-32）
 *   目标网络的有效字节（ceil(前缀/8) 个；前缀 0 时为 0 字节）
 *   4 字节下一跳 IPv4
 *
 * 多条路由按「目标网络地址升序，同地址时前缀升序」排列，拼接为 Option 121
 * 的值（不含 option code 与长度字节），以十六进制输出。
 *
 * 纯本地只读计算，不修改规划、不产生修订历史。
 */
import {
  Cidr,
  cidrToString,
  ipv4ToLong,
  isAlignedCidr,
  longToIpv4,
  networkOf,
  parseCidr,
} from './ip';
import { IpRange, usableRangeOf } from './dhcp';

export interface ClasslessRoute {
  /** 规范化后的目标网段 */
  target: Cidr;
  /** 下一跳地址（uint32） */
  gateway: number;
}

/** 编码后的单条路由字节拆解 */
export interface EncodedRoute {
  route: ClasslessRoute;
  /** 前缀长度字节（1 字节） */
  prefixByte: number;
  /** 目标网络有效字节（ceil(前缀/8) 字节） */
  targetBytes: number[];
  /** 下一跳 4 字节 */
  gatewayBytes: number[];
  /** 该条路由编码后的全部字节 */
  bytes: number[];
}

export interface RouteParseResult {
  /** 解析通过的路由（保留输入顺序） */
  routes: ClasslessRoute[];
  /** 逐行错误信息（带行号）；非空时不应生成结果 */
  errors: string[];
}

/**
 * 逐行解析「目标 CIDR,下一跳 IPv4」。空行（含纯空白）忽略。
 * 校验：目标必须合法且对齐 CIDR 边界；下一跳必须为合法 IPv4 且完整位于
 * 子网可用主机范围内；目标网段重复按行报错。任一行出错即收集错误，不产出结果。
 */
export function parseClasslessRoutes(subnet: Cidr, text: string): RouteParseResult {
  const errors: string[] = [];
  const routes: ClasslessRoute[] = [];
  const usable: IpRange = usableRangeOf(subnet);
  const seen = new Set<string>();
  text.split('\n').forEach((raw, i) => {
    const line = raw.trim();
    const row = i + 1;
    if (!line) return;
    const parts = line.split(',');
    if (parts.length !== 2 || parts.some((p) => !p.trim())) {
      errors.push(`第 ${row} 行：格式应为「目标 CIDR,下一跳 IPv4」：${line}`);
      return;
    }
    const targetText = parts[0].trim();
    const gatewayText = parts[1].trim();
    if (!isAlignedCidr(targetText)) {
      const parsed = parseCidr(targetText);
      if (!parsed) {
        errors.push(`第 ${row} 行：目标 CIDR 非法：${targetText}`);
      } else {
        errors.push(
          `第 ${row} 行：目标未对齐 CIDR 边界，应为 ${cidrToString(parsed)}：${targetText}`,
        );
      }
      return;
    }
    const target = parseCidr(targetText)!;
    const gateway = ipv4ToLong(gatewayText);
    if (gateway === null) {
      errors.push(`第 ${row} 行：下一跳不是合法 IPv4 地址：${gatewayText}`);
      return;
    }
    if (gateway < usable.start || gateway > usable.end) {
      errors.push(
        `第 ${row} 行：下一跳 ${gatewayText} 不在子网 ${cidrToString(subnet)} 的可用主机范围 ${longToIpv4(
          usable.start,
        )} - ${longToIpv4(usable.end)} 内`,
      );
      return;
    }
    const key = cidrToString(target);
    if (seen.has(key)) {
      errors.push(`第 ${row} 行：目标 ${key} 重复（同一目标只能出现一次）`);
      return;
    }
    seen.add(key);
    routes.push({ target, gateway });
  });
  return { routes, errors };
}

/** 目标网络地址有效字节数：ceil(前缀/8)，前缀 0 时为 0。 */
export function significantOctets(prefix: number): number {
  return Math.ceil(prefix / 8);
}

/** 单条路由按 RFC 3442 编码。 */
export function encodeRoute(route: ClasslessRoute): EncodedRoute {
  const prefixByte = route.target.prefix;
  const targetOctets = [
    (route.target.base >>> 24) & 255,
    (route.target.base >>> 16) & 255,
    (route.target.base >>> 8) & 255,
    route.target.base & 255,
  ];
  const n = significantOctets(prefixByte);
  const targetBytes = targetOctets.slice(0, n);
  const gatewayBytes = [
    (route.gateway >>> 24) & 255,
    (route.gateway >>> 16) & 255,
    (route.gateway >>> 8) & 255,
    route.gateway & 255,
  ];
  return {
    route,
    prefixByte,
    targetBytes,
    gatewayBytes,
    bytes: [prefixByte, ...targetBytes, ...gatewayBytes],
  };
}

export interface EncodeResult {
  /** 按目标地址、前缀排序后的逐条编码 */
  entries: EncodedRoute[];
  /** Option 121 值（不含 code/长度字节）的全部字节 */
  bytes: number[];
  /** 大写、无分隔的十六进制字符串 */
  hex: string;
}

/**
 * 编码 Option 121：按目标网络地址升序、同地址时前缀升序排列后逐字节拼接。
 */
export function encodeClasslessRoutes(routes: ClasslessRoute[]): EncodeResult {
  const sorted = [...routes].sort(
    (a, b) => a.target.base - b.target.base || a.target.prefix - b.target.prefix,
  );
  const entries = sorted.map(encodeRoute);
  const bytes = entries.flatMap((e) => e.bytes);
  return { entries, bytes, hex: bytesToHex(bytes) };
}

export function byteToHex(b: number): string {
  return b.toString(16).toUpperCase().padStart(2, '0');
}

export function bytesToHex(bytes: readonly number[]): string {
  return bytes.map(byteToHex).join('');
}

/**
 * 将粘贴文本规范化为字节串：剥离空白与冒号/连字符分隔，支持 `0x` 前缀；
 * 兼容整串（如 `000A000000...`）与逐字节（如 `00:0A:00:00:...`）两种写法。
 * 非法（奇数位、非十六进制字符）返回错误信息。
 */
export function parseHexInput(input: string): { bytes: number[] } | { error: string } {
  let text = input.trim();
  if (!text) return { error: '十六进制内容为空' };
  if (/^0x/i.test(text)) text = text.slice(2);
  // 逐字节冒号/连字符分隔（如 00:0A:00:00 或 00-0a-00-00）
  if (/^[0-9a-fA-F]{2}(?::[0-9a-fA-F]{2})*$/.test(text)) {
    text = text.replace(/:/g, '');
  } else if (/^[0-9a-fA-F]{2}(?:-[0-9a-fA-F]{2})*$/.test(text)) {
    text = text.replace(/-/g, '');
  } else {
    text = text.replace(/[\s:.-]/g, '');
  }
  if (!/^[0-9a-fA-F]*$/.test(text)) {
    return { error: '含非十六进制字符（只允许 0-9、A-F、空白及 : - 分隔符）' };
  }
  if (text.length === 0) return { error: '十六进制内容为空' };
  if (text.length % 2 !== 0) {
    return { error: '十六进制位数为奇数，每个字节需占两位' };
  }
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i += 2) {
    bytes.push(parseInt(text.slice(i, i + 2), 16));
  }
  return { bytes };
}

export interface DecodeResult {
  routes: ClasslessRoute[];
  /** 逐条字节拆解（与线上字节顺序一致） */
  entries: EncodedRoute[];
  hex: string;
}

type StrictDecode =
  | { ok: true; routes: ClasslessRoute[]; entries: EncodedRoute[] }
  | { ok: false; error: string };

/**
 * 按给定的目标宽度策略解析字节串。
 * strict（RFC 3442）：目标占 ceil(前缀/8) 字节；fixed4：目标恒占 4 字节，
 * 仅用于在严格解析失败时识别「目标网络冗余写满 4 字节」的非规范输入。
 */
function parseRoutes(data: readonly number[], fixedTargetOctets: boolean): StrictDecode {
  const routes: ClasslessRoute[] = [];
  const entries: EncodedRoute[] = [];
  let i = 0;
  let seq = 0;
  while (i < data.length) {
    seq += 1;
    const prefix = data[i];
    i += 1;
    if (prefix > 32) {
      return { ok: false, error: `第 ${seq} 条路由：前缀长度 ${prefix} 非法（不能超过 32）` };
    }
    const n = fixedTargetOctets ? 4 : significantOctets(prefix);
    if (i + n > data.length) {
      return {
        ok: false,
        error: `第 ${seq} 条路由：数据截断，目标网络需 ${n} 个有效字节但仅剩 ${data.length - i} 字节`,
      };
    }
    const octets = [0, 0, 0, 0];
    for (let k = 0; k < n; k++) octets[k] = data[i + k];
    i += n;
    if (i + 4 > data.length) {
      return {
        ok: false,
        error: `第 ${seq} 条路由：数据截断，下一跳需 4 字节但仅剩 ${data.length - i} 字节`,
      };
    }
    const base =
      ((octets[0] << 24) >>> 0) + (octets[1] << 16) + (octets[2] << 8) + octets[3];
    const gateway =
      ((data[i] << 24) >>> 0) +
      (data[i + 1] << 16) +
      (data[i + 2] << 8) +
      data[i + 3];
    i += 4;
    if (networkOf(base, prefix) !== base) {
      return {
        ok: false,
        error: `第 ${seq} 条路由：目标 ${longToIpv4(base)}/${prefix} 非规范网络位，应为 ${cidrToString(
          { base: networkOf(base, prefix), prefix },
        )}`,
      };
    }
    const route: ClasslessRoute = { target: { base, prefix }, gateway };
    routes.push(route);
    entries.push(encodeRoute(route));
  }
  return { ok: true, routes, entries };
}

/**
 * 反向解码 Option 121 字节串。
 * 拒绝：前缀长度 > 32、任何截断（目标有效字节或下一跳不足）、
 * 非规范网络位（主机位非零）；结尾若有多余字节同样按截断拒绝。
 * 另识别「目标网络冗余写满 4 字节」的非规范编码并明确报错。
 * 成功时按线上顺序返回路由（重新编码会按地址、前缀排序）。
 */
export function decodeClasslessHex(raw: string): DecodeResult | { error: string } {
  const parsed = parseHexInput(raw);
  if ('error' in parsed) return parsed;
  const data = parsed.bytes;
  const strict = parseRoutes(data, false);
  if (strict.ok) {
    if (strict.routes.length === 0) return { error: '未解码出任何路由' };
    return { routes: strict.routes, entries: strict.entries, hex: bytesToHex(data) };
  }
  // 严格解析失败：尝试把目标网络当作恒 4 字节解析。整串恰好消费完且存在
  // 前缀 < 32（与 RFC 编码不同）的条目时，判定为冗余目标字节错误。
  const fixed4 = parseRoutes(data, true);
  if (
    fixed4.ok &&
    fixed4.routes.some((r) => r.target.prefix < 32) &&
    data.length === fixed4.routes.length * 9
  ) {
    const idx = fixed4.routes.findIndex((r) => r.target.prefix < 32) + 1;
    return {
      error: `第 ${idx} 条路由：目标网络存在冗余字节——RFC 3442 只写前缀有效字节（ceil(前缀/8) 个），请勿补零到 4 字节`,
    };
  }
  return { error: strict.error };
}

/** 解码结果回填表格：每行「目标 CIDR,下一跳」，按线上顺序输出。 */
export function formatRouteLines(routes: readonly ClasslessRoute[]): string {
  return routes.map((r) => `${cidrToString(r.target)},${longToIpv4(r.gateway)}`).join('\n');
}
