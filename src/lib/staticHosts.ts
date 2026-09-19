/**
 * 静态主机地址编排：在单个子网内把「主机名 + 指定 IPv4 / auto」编排为 hosts 文本。
 *
 * 规则：
 *  - 逐行解析「主机名 地址」，空行忽略；主机名须为合法 LDH 主机名（可含点分标签）；
 *  - 地址为合法 IPv4 或关键字 auto（大小写不敏感）；
 *  - 指定地址必须落在子网可用主机范围内：/0～/30 排除网络地址与广播地址，
 *    /31、/32 沿用可用主机规则（不额外排除）；
 *  - 先整体预留所有合法指定地址，再按输入顺序把 auto 安置到最低可用主机地址，
 *    因此前序 auto 不会抢占后续行指定的地址；
 *  - 主机名（大小写不敏感）与指定地址均不允许重复占用。
 *
 * 纯本地计算，不修改规划、不产生历史记录。
 */
import { Cidr, ipv4ToLong, lastAddr, longToIpv4 } from './ip';
import { usableRangeOf } from './dhcp';

export type HostAddrMode = 'specified' | 'auto';

export type HostLineStatus = 'ok' | 'invalid' | 'nospace';

export interface HostLinePlan {
  /** 物理行号（从 1 开始，空行也计入） */
  row: number;
  /** 解析出的主机名；解析失败时为空串 */
  hostname: string;
  /** 地址模式；解析失败时为 null */
  mode: HostAddrMode | null;
  /** 地址列原文（specified 为 IPv4 文本，auto 为原样关键字，解析失败为整行文本） */
  input: string;
  status: HostLineStatus;
  /** 安置成功的 IPv4（uint32） */
  addr: number | null;
  /** 失败原因（status !== 'ok' 时） */
  reason: string | null;
}

export interface StaticHostPlan {
  /** 非空行的逐行结果，按行号升序 */
  lines: HostLinePlan[];
  /** 至少一行且全部非空行均安置成功 */
  ok: boolean;
}

/** LDH 主机名：标签 1-63 字符，字母/数字/连字符，不以连字符开头结尾，可点分，全长 ≤ 253 */
const HOSTNAME_RE =
  /^(?=.{1,253}$)[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;

export function isValidHostname(name: string): boolean {
  return HOSTNAME_RE.test(name);
}

interface ParsedLine {
  row: number;
  hostname: string;
  mode: HostAddrMode;
  input: string;
  /** mode === 'specified' 时的地址值 */
  addr: number | null;
}

/** 解析单行（不含行号前缀）。空行返回 null；非法时 error 为错误说明。 */
function parseHostLine(
  row: number,
  raw: string,
): { parsed: ParsedLine } | { error: string } | null {
  const text = raw.trim();
  if (!text) return null;
  const tokens = text.split(/\s+/);
  if (tokens.length !== 2) {
    return { error: '格式应为「主机名 IPv4地址|auto」，每行一台主机' };
  }
  const [hostname, addrToken] = tokens;
  if (!isValidHostname(hostname)) {
    return { error: `主机名非法：${hostname}（仅允许字母、数字、连字符与点分标签）` };
  }
  if (/^auto$/i.test(addrToken)) {
    return { parsed: { row, hostname, mode: 'auto', input: addrToken, addr: null } };
  }
  const addr = ipv4ToLong(addrToken);
  if (addr === null) {
    return { error: `地址非法，须为 IPv4 地址或 auto：${addrToken}` };
  }
  return { parsed: { row, hostname, mode: 'specified', input: addrToken, addr } };
}

const okLine = (p: ParsedLine, addr: number): HostLinePlan => ({
  row: p.row,
  hostname: p.hostname,
  mode: p.mode,
  input: p.input,
  status: 'ok',
  addr,
  reason: null,
});

const invalidLine = (p: ParsedLine, reason: string): HostLinePlan => ({
  row: p.row,
  hostname: p.hostname,
  mode: p.mode,
  input: p.input,
  status: 'invalid',
  addr: null,
  reason,
});

const nospaceLine = (p: ParsedLine, reason: string): HostLinePlan => ({
  ...invalidLine(p, reason),
  status: 'nospace',
});

/**
 * 编排静态主机：
 *  1. 逐行解析，非法行直接记录；
 *  2. 主机名去重（大小写不敏感，首次出现保留）；
 *  3. 校验并整体预留全部合法指定地址（子网内、可用主机地址、不重复）；
 *  4. 按输入顺序把 auto 安置到最低可用主机地址（游标单调前进，跳过已预留/已占用）。
 */
export function planStaticHosts(subnet: Cidr, text: string): StaticHostPlan {
  const results = new Map<number, HostLinePlan>();
  const parsed: ParsedLine[] = [];
  text.split('\n').forEach((raw, i) => {
    const row = i + 1;
    const r = parseHostLine(row, raw);
    if (r === null) return;
    if ('error' in r) {
      results.set(row, {
        row,
        hostname: '',
        mode: null,
        input: raw.trim(),
        status: 'invalid',
        addr: null,
        reason: r.error,
      });
    } else {
      parsed.push(r.parsed);
    }
  });

  // 主机名去重：后续重复行记为非法
  const seenNames = new Map<string, number>();
  const alive: ParsedLine[] = [];
  for (const p of parsed) {
    const key = p.hostname.toLowerCase();
    const first = seenNames.get(key);
    if (first !== undefined) {
      results.set(p.row, invalidLine(p, `主机名与第 ${first} 行重复：${p.hostname}`));
    } else {
      seenNames.set(key, p.row);
      alive.push(p);
    }
  }

  // 指定地址校验并整体预留
  const usable = usableRangeOf(subnet);
  const subnetEnd = lastAddr(subnet);
  const reserved = new Set<number>();
  const specifiedAt = new Map<number, number>(); // addr → 首次出现的行号
  const autos: ParsedLine[] = [];
  for (const p of alive) {
    if (p.mode === 'auto') {
      autos.push(p);
      continue;
    }
    const addr = p.addr!;
    if (addr < subnet.base || addr > subnetEnd) {
      results.set(
        p.row,
        invalidLine(
          p,
          `指定地址 ${longToIpv4(addr)} 不在子网内（${longToIpv4(subnet.base)} - ${longToIpv4(subnetEnd)}）`,
        ),
      );
      continue;
    }
    if (addr < usable.start || addr > usable.end) {
      const which = addr === subnet.base ? '网络地址' : '广播地址';
      results.set(
        p.row,
        invalidLine(p, `指定地址 ${longToIpv4(addr)} 是子网的${which}，不可分配给主机`),
      );
      continue;
    }
    const firstRow = specifiedAt.get(addr);
    if (firstRow !== undefined) {
      results.set(
        p.row,
        invalidLine(p, `指定地址 ${longToIpv4(addr)} 与第 ${firstRow} 行重复占用`),
      );
      continue;
    }
    specifiedAt.set(addr, p.row);
    reserved.add(addr);
    results.set(p.row, okLine(p, addr));
  }

  // 按输入顺序安置 auto：游标从可用范围起点单调前进，逐台取最低可用地址
  let cursor = usable.start;
  for (const p of autos) {
    while (reserved.has(cursor)) cursor += 1;
    if (cursor > usable.end) {
      results.set(p.row, nospaceLine(p, '空间不足：子网可用主机地址已耗尽'));
      continue;
    }
    reserved.add(cursor);
    results.set(p.row, okLine(p, cursor));
    cursor += 1;
  }

  const lines = [...results.values()].sort((a, b) => a.row - b.row);
  const ok = lines.length > 0 && lines.every((l) => l.status === 'ok');
  return { lines, ok };
}

/** 生成 hosts 文本：成功行按地址升序，每行「IPv4 主机名」。仅在 plan.ok 时用于导出。 */
export function formatHostsText(plan: StaticHostPlan): string {
  const okLines = plan.lines
    .filter((l): l is HostLinePlan & { addr: number } => l.status === 'ok' && l.addr !== null)
    .sort((a, b) => a.addr - b.addr);
  return okLines.map((l) => `${longToIpv4(l.addr)} ${l.hostname}`).join('\n');
}
