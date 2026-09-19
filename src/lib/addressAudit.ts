/**
 * 地址观测冲突审计（只读）。
 *
 * 输入为多行「ISO 时间, IPv4, MAC, 有效秒数」观测：
 *  - 先逐字段严格校验并规范化（IPv4 去前导零；MAC 统一为 aa:bb:cc:dd:ee:ff），
 *    任一非空行非法即按物理行号报错且不生成结果；
 *  - 每行观测视为以观测时刻为起点的半开区间 [t, t + 有效秒数)；
 *  - 按 IP 扫描不同 MAC 的区间重叠：同一时刻同一 IP 有 ≥2 个不同 MAC 有效即为冲突；
 *  - 时间轴上相邻（端点相接、无空隙）且参与 MAC 集合相同的冲突段合并为一段；
 *  - 非重叠的历史换机（旧租约结束后新 MAC 才生效）不会误报；
 *  - 每段附带该 IP 当前落位的子网分配（取包含该地址的最具体分配）。
 *
 * 纯本地计算，不修改规划、不产生撤销/重做历史。
 */
import { Allocation, Plan, RootBlock } from './model';
import { Cidr, contains, ipv4ToLong, lastAddr, parseCidr } from './ip';

export interface AddressObservation {
  /** 物理行号（从 1 开始，空行也计入） */
  lineNo: number;
  /** 规范化 IPv4 点分字符串 */
  ip: string;
  ipLong: number;
  /** 规范化 MAC：小写冒号形式 aa:bb:cc:dd:ee:ff */
  mac: string;
  /** 半开有效区间 [startMs, endMs)，毫秒时间戳（UTC 口径） */
  startMs: number;
  endMs: number;
  ttlSeconds: number;
}

export interface SubnetRef {
  name: string;
  cidr: string;
  kind: Allocation['kind'];
}

export interface AuditConflict {
  ip: string;
  ipLong: number;
  /** 冲突段（半开）起止毫秒时间戳 */
  startMs: number;
  endMs: number;
  /** 参与冲突的 MAC（规范化、升序去重） */
  macs: string[];
  /** 构成该冲突段的输入物理行号（升序去重） */
  lines: number[];
  /** 该 IP 当前所属的最具体分配；未落在任何分配内为 null */
  subnet: SubnetRef | null;
  /** 该 IP 落位的根网段名称（未落在根网段内为 null） */
  rootName: string | null;
}

export interface AuditResult {
  observations: AddressObservation[];
  conflicts: AuditConflict[];
  /** 去重后的观测 IP 数 */
  ipCount: number;
}

// ---- 字段规范化与校验 ----

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/**
 * 严格 IPv4 校验并规范化：必须恰好 4 个十进制段、每段 0-255；
 * 拒绝前导零（如 01.2.3.4）与十六进制段（如 1.2.3.0x1）等歧义写法。
 */
export function normalizeIpv4(input: string): string | null {
  const text = input.trim();
  const m = IPV4_RE.exec(text);
  if (!m) return null;
  const parts = [m[1], m[2], m[3], m[4]];
  const octets: number[] = [];
  for (const p of parts) {
    if (p.length > 1 && p[0] === '0') return null; // 禁止前导零
    const v = Number(p);
    if (v > 255) return null;
    octets.push(v);
  }
  return octets.join('.');
}

/**
 * MAC 校验并规范化为小写冒号形式 aa:bb:cc:dd:ee:ff。
 * 接受三种常规写法：aa:bb:cc:dd:ee:ff / aa-bb-cc-dd-ee-ff / aaaa.bbbb.cccc；
 * 不允许混用分隔符或位数不足。
 */
export function normalizeMac(input: string): string | null {
  const text = input.trim().toLowerCase();
  if (/^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/.test(text)) return text;
  if (/^[0-9a-f]{2}(-[0-9a-f]{2}){5}$/.test(text)) return text.replace(/-/g, ':');
  const dotted = /^([0-9a-f]{4})\.([0-9a-f]{4})\.([0-9a-f]{4})$/.exec(text);
  if (dotted) {
    const hex = dotted[1] + dotted[2] + dotted[3];
    return hex.match(/../g)!.join(':');
  }
  return null;
}

// ISO 8601：YYYY-MM-DDTHH:mm:ss[.fff][Z|±HH:mm]；T 与空格均可；省略时区按本地时间解释
const ISO_RE =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})?$/;

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate(); // month 1-12
}

/**
 * 严格 ISO 8601 日期时间解析并校验日历合法性（不接受 2026-02-30 这类被 Date 静默回卷的值）。
 * 带 Z/偏移时按该时区换算为绝对毫秒；不带时区时按浏览器本地时区解释。
 */
export function parseIsoTime(input: string): number | null {
  const text = input.trim();
  const m = ISO_RE.exec(text);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = Number(m[6]);
  const frac = m[7] ? Number(m[7].padEnd(3, '0')) : 0;
  const zone = m[8];
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  if (hour > 23 || minute > 59 || second > 59) return null; // 不接受闰秒
  let offsetSeconds = 0;
  if (zone && zone !== 'Z') {
    const oh = Number(zone.slice(1, 3));
    const om = Number(zone.slice(4, 6));
    if (oh > 23 || om > 59) return null;
    offsetSeconds = (oh * 3600 + om * 60) * (zone[0] === '-' ? -1 : 1);
  }
  let ms: number;
  if (zone) {
    ms = Date.UTC(year, month - 1, day, hour, minute, second, frac) - offsetSeconds * 1000;
  } else {
    ms = new Date(year, month - 1, day, hour, minute, second, frac).getTime();
  }
  return Number.isFinite(ms) ? ms : null;
}

/** 有效秒数：不小于 1 的整数，且区间末端须在安全整数范围内。 */
export function parseTtlSeconds(input: string): number | null {
  const text = input.trim();
  if (!/^\d+$/.test(text)) return null;
  const seconds = Number(text);
  if (!Number.isSafeInteger(seconds) || seconds < 1) return null;
  if (seconds > Math.floor(Number.MAX_SAFE_INTEGER / 1000)) return null;
  return seconds;
}

// ---- 逐行解析 ----

interface ParsedLines {
  observations: AddressObservation[];
  /** 带行号的错误；非空时 observations 不可使用 */
  errors: string[];
}

/** 解析多行观测文本。空行/纯空白行跳过；任一非空行非法即按行收集全部错误。 */
export function parseObservations(text: string): ParsedLines {
  const observations: AddressObservation[] = [];
  const errors: string[] = [];
  const lines = text.split(/\r?\n/);
  let filled = 0;

  lines.forEach((rawLine, i) => {
    const lineNo = i + 1;
    const line = rawLine.trim();
    if (!line) return;
    filled += 1;

    const fields = line.split(',').map((f) => f.trim());
    if (fields.length !== 4) {
      errors.push(
        `第 ${lineNo} 行：应为 4 个逗号分隔字段（ISO 时间, IPv4, MAC, 有效秒数），实际 ${fields.length} 个：${line}`,
      );
      return;
    }
    if (fields.some((f) => f === '')) {
      errors.push(`第 ${lineNo} 行：存在空字段（ISO 时间, IPv4, MAC, 有效秒数 均必填）：${line}`);
      return;
    }
    const [timeToken, ipToken, macToken, ttlToken] = fields;

    const startMs = parseIsoTime(timeToken);
    if (startMs === null) {
      errors.push(`第 ${lineNo} 行：ISO 时间非法（应为 YYYY-MM-DDTHH:mm:ss[.fff][Z|±HH:mm]）：${timeToken}`);
    }
    const ip = normalizeIpv4(ipToken);
    if (!ip) {
      errors.push(`第 ${lineNo} 行：IPv4 地址非法（四段十进制、每段 0-255、无前导零）：${ipToken}`);
    }
    const mac = normalizeMac(macToken);
    if (!mac) {
      errors.push(
        `第 ${lineNo} 行：MAC 地址非法（接受 aa:bb:cc:dd:ee:ff、aa-bb-cc-dd-ee-ff、aaaa.bbbb.cccc）：${macToken}`,
      );
    }
    const ttlSeconds = parseTtlSeconds(ttlToken);
    if (ttlSeconds === null) {
      errors.push(`第 ${lineNo} 行：有效秒数非法（须为不小于 1 的整数）：${ttlToken}`);
    }

    if (startMs !== null && ip && mac && ttlSeconds !== null) {
      observations.push({
        lineNo,
        ip,
        ipLong: ipv4ToLong(ip)!,
        mac,
        startMs,
        endMs: startMs + ttlSeconds * 1000,
        ttlSeconds,
      });
    }
  });

  if (filled === 0 && errors.length === 0) {
    errors.push('没有可审计的观测行（每行格式：ISO 时间, IPv4, MAC, 有效秒数）');
  }
  return { observations, errors };
}

// ---- 子网归属 ----

interface AllocationBlock {
  alloc: Allocation;
  cidr: Cidr;
}

function blocksContaining(blocks: AllocationBlock[], ipLong: number): AllocationBlock | null {
  let best: AllocationBlock | null = null;
  for (const b of blocks) {
    if (b.cidr.base <= ipLong && ipLong <= lastAddr(b.cidr)) {
      if (!best || b.cidr.prefix > best.cidr.prefix) best = b;
    }
  }
  return best;
}

// ---- 扫描线核心 ----

interface ScanEvent {
  t: number;
  start: boolean; // true=区间开始，false=区间结束（半开右端点）
  mac: string;
  lineNo: number;
}

interface ActiveMac {
  count: number;
  lines: Set<number>;
}

interface RawSegment {
  startMs: number;
  endMs: number;
  macs: string[];
  lines: number[];
}

/**
 * 对单个 IP 的观测做半开区间扫描。
 * 同一时刻的事件先处理结束、再处理开始：端点相接（旧区间 t 结束、新区间 t 开始）
 * 在 t 处不重叠，属正常换机；仅当不同 MAC 的有效时段真正相交才产生冲突。
 * 相邻且参与 MAC 集合相同的冲突段合并。
 */
function scanIpConflicts(obs: AddressObservation[]): RawSegment[] {
  const groups = new Map<number, { ends: ScanEvent[]; starts: ScanEvent[] }>();
  for (const o of obs) {
    for (const start of [true, false]) {
      const t = start ? o.startMs : o.endMs;
      let g = groups.get(t);
      if (!g) {
        g = { ends: [], starts: [] };
        groups.set(t, g);
      }
      (start ? g.starts : g.ends).push({ t, start, mac: o.mac, lineNo: o.lineNo });
    }
  }
  const times = [...groups.keys()].sort((a, b) => a - b);
  const active = new Map<string, ActiveMac>();

  const snapshot = (): { key: string; macs: string[]; lines: number[] } | null => {
    if (active.size < 2) return null;
    const macs = [...active.keys()].sort();
    const lines = new Set<number>();
    for (const m of macs) for (const l of active.get(m)!.lines) lines.add(l);
    return { key: macs.join(','), macs, lines: [...lines].sort((a, b) => a - b) };
  };

  const segments: RawSegment[] = [];
  let seg: (RawSegment & { key: string }) | null = null;
  const closeSeg = (endMs: number) => {
    if (seg) segments.push({ startMs: seg.startMs, endMs, macs: seg.macs, lines: seg.lines });
    seg = null;
  };

  let prevT: number | null = null;
  for (const t of times) {
    // [prevT, t) 内有效集合不变，判定该时段是否为冲突
    if (prevT !== null && prevT < t) {
      const cur = snapshot();
      if (cur) {
        if (seg === null) {
          seg = { startMs: prevT, endMs: 0, macs: cur.macs, lines: cur.lines, key: cur.key };
        } else if (seg.key !== cur.key) {
          closeSeg(prevT);
          seg = { startMs: prevT, endMs: 0, macs: cur.macs, lines: cur.lines, key: cur.key };
        } else {
          // seg.key === cur.key：端点相接且参与方集合相同，合并为一段（保留原起点）；
          // 参与方各自的观测可能恰好在边界处续约，行号取并集。
          const merged = new Set([...seg.lines, ...cur.lines]);
          seg.lines = [...merged].sort((a, b) => a - b);
        }
      } else {
        closeSeg(prevT);
      }
    }
    const g = groups.get(t)!;
    // 半开区间：t 时刻先让到期区间失效，再生效新开始的区间
    for (const e of g.ends) {
      const am = active.get(e.mac);
      if (!am) continue;
      am.count -= 1;
      am.lines.delete(e.lineNo);
      if (am.count <= 0) active.delete(e.mac);
    }
    for (const e of g.starts) {
      const am = active.get(e.mac) ?? { count: 0, lines: new Set<number>() };
      am.count += 1;
      am.lines.add(e.lineNo);
      active.set(e.mac, am);
    }
    prevT = t;
  }
  closeSeg(prevT ?? 0);
  return segments;
}

/**
 * 执行完整审计：先由 parseObservations 完成严格解析，再按 IP 扫描冲突
 * 并附加当前子网分配归属。规划仅被读取。
 */
export function auditObservations(
  observations: AddressObservation[],
  plan: Plan,
): AuditResult {
  const blocks: AllocationBlock[] = plan.allocations
    .map((alloc) => ({ alloc, cidr: parseCidr(alloc.cidr) }))
    .filter((b): b is AllocationBlock => b.cidr !== null);
  const roots: { root: RootBlock; cidr: Cidr }[] = plan.roots
    .map((root) => ({ root, cidr: parseCidr(root.cidr) }))
    .filter((r): r is { root: RootBlock; cidr: Cidr } => r.cidr !== null);

  const byIp = new Map<string, AddressObservation[]>();
  for (const o of observations) {
    const list = byIp.get(o.ip) ?? [];
    list.push(o);
    byIp.set(o.ip, list);
  }

  const conflicts: AuditConflict[] = [];
  for (const [ip, list] of byIp) {
    const ipLong = list[0].ipLong;
    const hit = blocksContaining(blocks, ipLong);
    let rootName: string | null = null;
    for (const r of roots) {
      if (contains(r.cidr, { base: ipLong, prefix: 32 })) {
        rootName = r.root.name;
        break;
      }
    }
    for (const seg of scanIpConflicts(list)) {
      conflicts.push({
        ip,
        ipLong,
        startMs: seg.startMs,
        endMs: seg.endMs,
        macs: seg.macs,
        lines: seg.lines,
        subnet: hit
          ? { name: hit.alloc.name, cidr: hit.alloc.cidr, kind: hit.alloc.kind }
          : null,
        rootName,
      });
    }
  }
  conflicts.sort((a, b) => a.ipLong - b.ipLong || a.startMs - b.startMs);

  return { observations, conflicts, ipCount: byIp.size };
}

/** 解析 + 审计一体入口：任一行非法时返回 errors 且 result 为 undefined（不生成结果）。 */
export function runAddressAudit(
  text: string,
  plan: Plan,
): { result: AuditResult; errors?: undefined } | { result?: undefined; errors: string[] } {
  const { observations, errors } = parseObservations(text);
  if (errors.length > 0) return { errors };
  return { result: auditObservations(observations, plan) };
}

// ---- 文本报告 ----

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function formatReportTime(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(
    d.getHours(),
  )}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/** 毫秒时间戳 → ISO 8601 UTC（带毫秒与 Z），与输入口径无关。 */
export function isoUtc(ms: number): string {
  return new Date(ms).toISOString();
}

const KIND_LABEL: Record<Allocation['kind'], string> = {
  subnet: '子网',
  reserved: '保留段',
};

/** 生成可复制的纯文本审计报告（顺序与结果表格一致）。 */
export function formatAuditReport(result: AuditResult, generatedAt = new Date()): string {
  const lines: string[] = [
    '地址观测冲突审计报告',
    `生成时间：${formatReportTime(generatedAt)}`,
    `观测行：${result.observations.length} · 涉及 IP：${result.ipCount} · 冲突区间：${result.conflicts.length}`,
    '----------------------------------------',
  ];
  if (result.conflicts.length === 0) {
    lines.push('未发现同一 IP 上不同 MAC 的有效区间重叠（非重叠换机不计为冲突）。');
    return lines.join('\n');
  }

  let currentIp: string | null = null;
  let index = 0;
  for (const c of result.conflicts) {
    if (c.ip !== currentIp) {
      currentIp = c.ip;
      index = 0;
      const where = c.subnet
        ? `${c.subnet.name} ${c.subnet.cidr}（${KIND_LABEL[c.subnet.kind]}）`
        : '未落在任何已分配网段内';
      const rootPart = c.rootName ? `，根网段：${c.rootName}` : '';
      lines.push(`IP ${c.ip}｜当前子网分配：${where}${rootPart}`);
    }
    index += 1;
    const seconds = Math.round((c.endMs - c.startMs) / 1000);
    lines.push(
      `  冲突 ${index}：${isoUtc(c.startMs)} → ${isoUtc(c.endMs)}（${seconds} 秒，区间左闭右开）`,
    );
    lines.push(`    参与 MAC（${c.macs.length}）：${c.macs.join('、')}`);
    lines.push(`    输入行：${c.lines.join('、')}`);
  }
  return lines.join('\n');
}
