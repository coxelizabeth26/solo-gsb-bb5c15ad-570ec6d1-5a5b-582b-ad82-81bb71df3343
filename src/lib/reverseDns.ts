/**
 * 反向 DNS（in-addr.arpa）BIND 委派片段生成。
 *
 * 按子网前缀选择委派策略：
 *  - /0、/8、/16、/24：生成单个 in-addr.arpa 区；
 *  - 其余 /1～/23：拆成下一个八位边界（/8、/16 或 /24）上的最小区域集合；
 *  - /25～/31：RFC 2317 风格——父区 NS 委派 + 覆盖子网全部地址的 CNAME + 子区名；
 *  - /32：单条 PTR 所有者提示。
 *
 * 权威 NS 逐行填写（/32 可留空），非空项必须是带末尾点的绝对域名；
 * 任一 NS 非法则不生成。纯本地计算，不修改规划、不产生历史记录。
 */
import { Cidr, blockSize, cidrToString, lastAddr } from './ip';

/** 生成记录使用的固定 TTL */
const TTL = 3600;

/**
 * 权威 NS 校验：带末尾点的绝对域名。
 * 标签 1-63 字符（字母数字加连字符，不得以连字符开头/结尾），
 * 去掉末尾点后全长 ≤ 253。
 */
export function isAbsoluteDomain(name: string): boolean {
  if (!name.endsWith('.')) return false;
  const body = name.slice(0, -1);
  if (body.length === 0 || body.length > 253) return false;
  return body
    .split('.')
    .every((label) => /^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label));
}

export interface NsParseResult {
  ns: string[];
  /** 逐行错误信息（带行号）；非空时不应生成结果 */
  errors: string[];
}

/** 逐行解析权威 NS：空行跳过；任一非空行非法即按行收集错误。 */
export function parseNsLines(text: string): NsParseResult {
  const ns: string[] = [];
  const errors: string[] = [];
  text.split('\n').forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    if (!isAbsoluteDomain(line)) {
      errors.push(`第 ${i + 1} 行：NS 必须是带末尾点的绝对域名（如 ns1.example.com.）：${line}`);
      return;
    }
    ns.push(line);
  });
  return { ns, errors };
}

export interface ChildZone {
  /** 子区区名（绝对，带末尾点），如 0.1.10.in-addr.arpa. */
  name: string;
  /** 覆盖块首地址（uint32），结果按此数值升序 */
  firstAddr: number;
  /** 覆盖块末地址（uint32） */
  lastAddr: number;
}

export type ReverseDnsKind = 'zones' | 'rfc2317' | 'ptr';

export interface ReverseDnsPlan {
  kind: ReverseDnsKind;
  /** 父区记录应加入的父区区名（绝对）；/32 时为 PTR 所属的 /24 区名 */
  parentZone: string | null;
  /** 父区记录：委派 NS；/25～/31 另含覆盖子网全部地址的 CNAME。按地址数值升序 */
  parentRecords: string[];
  /** 需创建的子区（按首地址数值升序） */
  childZones: ChildZone[];
  /** /32：PTR 所有者名（绝对） */
  ptrOwner: string | null;
}

/** 由地址与前缀的八位边界层数（0-4）生成 in-addr.arpa 名（绝对，带末尾点）。 */
function arpaName(addr: number, octets: number): string {
  const o = [(addr >>> 24) & 255, (addr >>> 16) & 255, (addr >>> 8) & 255, addr & 255];
  const labels = o.slice(0, octets).map(String).reverse();
  return `${labels.length ? `${labels.join('.')}.` : ''}in-addr.arpa.`;
}

/** 去掉最左侧标签得到父区区名（如 10.in-addr.arpa. → in-addr.arpa.）。 */
function parentZoneOf(zone: string): string {
  return zone.slice(zone.indexOf('.') + 1);
}

/**
 * 计算反向 DNS 委派方案。ns 须已通过 parseNsLines 校验；
 * 除 /32 外至少需要一个 NS（由 generateReverseDns 保证）。
 */
export function planReverseDns(c: Cidr, ns: string[]): ReverseDnsPlan {
  if (c.prefix === 32) {
    // 单地址：无需委派，仅给出 PTR 所有者名与其所属 /24 区
    return {
      kind: 'ptr',
      parentZone: arpaName(c.base, 3),
      parentRecords: [],
      childZones: [],
      ptrOwner: arpaName(c.base, 4),
    };
  }

  if (c.prefix >= 25) {
    // RFC 2317：父区为所属 /24 区，子区名 <首地址>-<末地址>.<父区>
    const parentZone = arpaName(c.base, 3);
    const first = c.base & 255;
    const last = lastAddr(c) & 255;
    const childName = `${first}-${last}.${parentZone}`;
    const parentRecords: string[] = [];
    for (const server of ns) {
      parentRecords.push(`${childName} ${TTL} IN NS ${server}`);
    }
    for (let d = first; d <= last; d++) {
      parentRecords.push(`${d}.${parentZone} ${TTL} IN CNAME ${d}.${childName}`);
    }
    return {
      kind: 'rfc2317',
      parentZone,
      parentRecords,
      childZones: [{ name: childName, firstAddr: c.base, lastAddr: lastAddr(c) }],
      ptrOwner: null,
    };
  }

  // /0～/24：八位边界区。/0、/8、/16、/24 为单区；其余拆成下一个八位边界的最小区域集合
  const octets = c.prefix === 0 ? 0 : c.prefix <= 8 ? 1 : c.prefix <= 16 ? 2 : 3;
  const boundary = octets * 8;
  const count = 2 ** (boundary - c.prefix);
  const step = blockSize(boundary);
  const childZones: ChildZone[] = [];
  for (let i = 0; i < count; i++) {
    const firstAddr = (c.base + i * step) >>> 0;
    childZones.push({
      name: arpaName(firstAddr, octets),
      firstAddr,
      lastAddr: (firstAddr + step - 1) >>> 0,
    });
  }
  childZones.sort((a, b) => a.firstAddr - b.firstAddr);
  const parentZone = parentZoneOf(childZones[0].name);
  const parentRecords: string[] = [];
  for (const z of childZones) {
    for (const server of ns) {
      parentRecords.push(`${z.name} ${TTL} IN NS ${server}`);
    }
  }
  return { kind: 'zones', parentZone, parentRecords, childZones, ptrOwner: null };
}

export interface ReverseDnsSnippet {
  /** 父区记录文本；/32 为空串 */
  parentText: string;
  /** 需创建的子区文本；/32 为空串 */
  childText: string;
  /** /32 的 PTR 所有者提示文本，其余为空串 */
  ptrText: string;
  /** 完整可复制片段 */
  fullText: string;
}

/** 子区区文件名：去掉末尾点，加 db. 前缀 */
function zoneFile(zone: string): string {
  return `db.${zone.slice(0, -1)}`;
}

/** 把委派方案格式化为可复制的 BIND 片段（父区记录与需创建的子区分段展示）。 */
export function formatReverseDns(c: Cidr, plan: ReverseDnsPlan, ns: string[]): ReverseDnsSnippet {
  if (plan.kind === 'ptr') {
    const ptrText = [
      `; ${cidrToString(c)} 为单地址子网：PTR 记录直接加入所属区 ${plan.parentZone}`,
      '; PTR 所有者名（将 <主机名.> 替换为实际主机名后使用）：',
      `${plan.ptrOwner} ${TTL} IN PTR <主机名.>`,
    ].join('\n');
    return { parentText: '', childText: '', ptrText, fullText: ptrText };
  }

  const parentLines = [`; ===== 父区记录（加入父区 ${plan.parentZone}）=====`];
  if (plan.kind === 'rfc2317') {
    parentLines.push(
      `; RFC 2317：${cidrToString(c)} 的 NS 委派，以及覆盖子网全部 ${blockSize(c.prefix)} 个地址的 CNAME`,
    );
  }
  parentLines.push(...plan.parentRecords);
  const parentText = parentLines.join('\n');

  const childLines = [`; ===== 需创建的子区（${plan.childZones.length} 个）=====`];
  for (const z of plan.childZones) {
    childLines.push(`zone "${z.name.slice(0, -1)}" { type master; file "${zoneFile(z.name)}"; };`);
  }
  childLines.push('; 每个子区文件中的 NS 记录：');
  for (const server of ns) {
    childLines.push(`; @ ${TTL} IN NS ${server}`);
  }
  const childText = childLines.join('\n');

  return { parentText, childText, ptrText: '', fullText: `${parentText}\n\n${childText}` };
}

export interface ReverseDnsResult {
  plan: ReverseDnsPlan;
  snippet: ReverseDnsSnippet;
}

/**
 * 从 NS 文本直接生成委派方案：任一非空 NS 非法、或非 /32 却未填写 NS 时
 * 返回错误且不生成结果。
 */
export function generateReverseDns(
  c: Cidr,
  nsText: string,
): { errors: string[]; result: ReverseDnsResult | null } {
  const { ns, errors } = parseNsLines(nsText);
  if (errors.length > 0) return { errors, result: null };
  if (c.prefix !== 32 && ns.length === 0) {
    return { errors: ['请至少填写一个权威 NS（仅 /32 可留空）'], result: null };
  }
  const plan = planReverseDns(c, ns);
  return { errors: [], result: { plan, snippet: formatReverseDns(c, plan, ns) } };
}
