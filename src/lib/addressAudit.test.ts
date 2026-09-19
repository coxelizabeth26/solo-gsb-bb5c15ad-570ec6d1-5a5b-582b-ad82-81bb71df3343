import { describe, expect, it } from 'vitest';
import { Allocation, Plan, RootBlock } from './model';
import { parseCidr } from './ip';
import {
  AddressObservation,
  auditObservations,
  formatAuditReport,
  isoUtc,
  normalizeIpv4,
  normalizeMac,
  parseIsoTime,
  parseObservations,
  parseTtlSeconds,
  runAddressAudit,
} from './addressAudit';

const T0 = Date.UTC(2026, 8, 18, 0, 0, 0); // 2026-09-18T00:00:00Z
const MAC_A = 'aa:00:00:00:00:01';
const MAC_B = 'bb:00:00:00:00:02';
const MAC_C = 'cc:00:00:00:00:03';

function obs(
  lineNo: number,
  ip: string,
  mac: string,
  startOffsetSec: number,
  ttl: number,
): AddressObservation {
  const startMs = T0 + startOffsetSec * 1000;
  return {
    lineNo,
    ip,
    ipLong: 0,
    mac,
    startMs,
    endMs: startMs + ttl * 1000,
    ttlSeconds: ttl,
  };
}

/** 构造观测时补齐 ipLong（auditObservations 前的规范化数据） */
function withIp(list: AddressObservation[], ip: string): AddressObservation[] {
  const c = parseCidr(`${ip}/32`)!;
  return list.map((o) => ({ ...o, ip, ipLong: c.base }));
}

const alloc = (name: string, cidr: string, kind: Allocation['kind'] = 'subnet'): Allocation => ({
  id: name,
  name,
  kind,
  prefix: parseCidr(cidr)!.prefix,
  cidr,
});

function planWith(allocs: Allocation[], roots: RootBlock[] = []): Plan {
  return {
    version: 1,
    roots:
      roots.length > 0
        ? roots
        : ([{ id: 'r1', name: '办公网', cidr: '192.168.0.0/16' }] satisfies RootBlock[]),
    allocations: allocs,
  };
}

describe('IPv4 规范化', () => {
  it('接受标准四段并去除两侧空白', () => {
    expect(normalizeIpv4('10.0.0.1')).toBe('10.0.0.1');
    expect(normalizeIpv4('  192.168.1.1  ')).toBe('192.168.1.1');
    expect(normalizeIpv4('0.0.0.0')).toBe('0.0.0.0');
    expect(normalizeIpv4('255.255.255.255')).toBe('255.255.255.255');
  });

  it('拒绝前导零与歧义写法', () => {
    expect(normalizeIpv4('01.2.3.4')).toBeNull();
    expect(normalizeIpv4('1.2.3.0x1')).toBeNull();
    expect(normalizeIpv4('1.2.3.00')).toBeNull();
  });

  it('拒绝越界、缺段与多余内容', () => {
    expect(normalizeIpv4('256.0.0.1')).toBeNull();
    expect(normalizeIpv4('1.2.3')).toBeNull();
    expect(normalizeIpv4('1.2.3.4.5')).toBeNull();
    expect(normalizeIpv4('a.b.c.d')).toBeNull();
    expect(normalizeIpv4('1. 2.3.4')).toBeNull();
  });
});

describe('MAC 规范化', () => {
  it('接受冒号、连字符与点分写法并统一为小写冒号形式', () => {
    expect(normalizeMac('aa:bb:cc:dd:ee:ff')).toBe('aa:bb:cc:dd:ee:ff');
    expect(normalizeMac('AA:BB:CC:DD:EE:FF')).toBe('aa:bb:cc:dd:ee:ff');
    expect(normalizeMac('aa-bb-cc-dd-ee-ff')).toBe('aa:bb:cc:dd:ee:ff');
    expect(normalizeMac('aAbB.cCdD.eEfF')).toBe('aa:bb:cc:dd:ee:ff');
  });

  it('拒绝混用分隔符、位数不足与非法字符', () => {
    expect(normalizeMac('aa:bb-cc:dd:ee:ff')).toBeNull();
    expect(normalizeMac('aaaa.bbbb.cc')).toBeNull();
    expect(normalizeMac('aa-bb-cc-dd-ee')).toBeNull();
    expect(normalizeMac('zz:00:00:00:00:00')).toBeNull();
  });
});

describe('ISO 时间与有效秒数', () => {
  it('解析带 Z、偏移、空格分隔与小数秒', () => {
    expect(parseIsoTime('2026-09-18T00:00:00Z')).toBe(T0);
    expect(parseIsoTime('2026-09-18 00:00:00Z')).toBe(T0);
    expect(parseIsoTime('2026-09-18T08:00:00+08:00')).toBe(T0);
    expect(parseIsoTime('2026-09-17T19:00:00-05:00')).toBe(T0);
    expect(parseIsoTime('2026-09-18T00:00:00.500Z')).toBe(T0 + 500);
    expect(parseIsoTime('2026-09-18T00:00:00.5Z')).toBe(T0 + 500);
  });

  it('拒绝不存在的日期与非法时分秒', () => {
    expect(parseIsoTime('2026-02-30T00:00:00Z')).toBeNull(); // Date 会静默回卷到 3 月，需显式拒绝
    expect(parseIsoTime('2026-13-01T00:00:00Z')).toBeNull();
    expect(parseIsoTime('2026-09-18T24:00:00Z')).toBeNull();
    expect(parseIsoTime('2026-09-18T00:60:00Z')).toBeNull();
    expect(parseIsoTime('2026-09-18T00:00:60Z')).toBeNull(); // 不接受闰秒
    expect(parseIsoTime('2026/09/18 00:00:00')).toBeNull();
    expect(parseIsoTime('not-a-time')).toBeNull();
  });

  it('有效秒数须为不小于 1 的整数', () => {
    expect(parseTtlSeconds('1')).toBe(1);
    expect(parseTtlSeconds('3600')).toBe(3600);
    expect(parseTtlSeconds('0')).toBeNull();
    expect(parseTtlSeconds('-5')).toBeNull();
    expect(parseTtlSeconds('1.5')).toBeNull();
    expect(parseTtlSeconds('abc')).toBeNull();
  });
});

describe('逐行解析', () => {
  const sample = [
    '2026-09-18T00:00:00Z, 192.168.0.10, AA:00:00:00:00:01, 100',
    '2026-09-18T00:01:00Z,192.168.0.10,bb-00-00-00-00-02,200',
  ].join('\n');

  it('规范化全部字段并给出半开区间', () => {
    const { observations, errors } = parseObservations(sample);
    expect(errors).toEqual([]);
    expect(observations).toHaveLength(2);
    expect(observations[0]).toMatchObject({
      lineNo: 1,
      ip: '192.168.0.10',
      mac: 'aa:00:00:00:00:01',
      ttlSeconds: 100,
      startMs: T0,
      endMs: T0 + 100_000,
    });
    expect(observations[1].mac).toBe('bb:00:00:00:00:02');
  });

  it('空行跳过且物理行号保留', () => {
    const text = '\n  \n' + sample;
    const { observations, errors } = parseObservations(text);
    expect(errors).toEqual([]);
    expect(observations.map((o) => o.lineNo)).toEqual([3, 4]);
  });

  it('空文本报错', () => {
    expect(parseObservations('').errors).toHaveLength(1);
    expect(parseObservations('  \n\n').errors).toHaveLength(1);
  });

  it('非法行带行号并一次收集全部错误', () => {
    const text = [
      '2026-09-18T00:00:00Z, 192.168.0.10, aa:00:00:00:00:01, 100',
      'bad-time, 192.168.0.10, aa:00:00:00:00:01, 100',
      '2026-09-18T00:00:00Z, 256.0.0.1, aa:00:00:00:00:01, 100',
      '2026-09-18T00:00:00Z, 10.0.0.1, zz:00:00:00:00:01, 0',
      'only,three',
    ].join('\n');
    const { errors } = parseObservations(text);
    // 第 4 行同时有非法 MAC 与非法秒数，报两条；逐字段问题全部带行号
    expect(errors).toHaveLength(5);
    const joined = errors.join('\n');
    expect(errors[0]).toContain('第 2 行');
    expect(errors[0]).toContain('ISO 时间非法');
    expect(errors[1]).toContain('第 3 行');
    expect(errors[1]).toContain('IPv4 地址非法');
    expect(joined).toContain('第 4 行');
    expect(joined).toContain('MAC 地址非法');
    expect(joined).toContain('有效秒数');
    expect(errors[4]).toContain('第 5 行');
    // 有任一行非法时一体入口阻止生成结果
    const out = runAddressAudit(text, planWith([]));
    expect('errors' in out).toBe(true);
    expect('result' in out).toBe(false);
  });
});

describe('冲突扫描', () => {
  const plan = planWith([alloc('办公有线', '192.168.0.0/24'), alloc('核心区', '10.0.0.0/16')]);

  it('非重叠的历史换机不误报（半开区间端点相接）', () => {
    const list = withIp(
      [obs(1, '192.168.0.10', MAC_A, 0, 100), obs(2, '192.168.0.10', MAC_B, 100, 200)],
      '192.168.0.10',
    );
    const result = auditObservations(list, plan);
    expect(result.conflicts).toEqual([]);
    expect(result.ipCount).toBe(1);
  });

  it('不同 MAC 区间重叠产生单段冲突，行号取并集', () => {
    const list = withIp(
      [obs(1, '192.168.0.10', MAC_A, 0, 100), obs(2, '192.168.0.10', MAC_B, 50, 100)],
      '192.168.0.10',
    );
    const result = auditObservations(list, plan);
    expect(result.conflicts).toHaveLength(1);
    const c = result.conflicts[0];
    expect(c.startMs).toBe(T0 + 50_000);
    expect(c.endMs).toBe(T0 + 100_000);
    expect(c.macs).toEqual([MAC_A, MAC_B]);
    expect(c.lines).toEqual([1, 2]);
  });

  it('同一 MAC 的区间重叠不构成冲突', () => {
    const list = withIp(
      [
        obs(1, '192.168.0.10', MAC_A, 0, 100),
        obs(2, '192.168.0.10', MAC_A, 50, 100),
        obs(3, '192.168.0.10', MAC_A, 90, 10),
      ],
      '192.168.0.10',
    );
    expect(auditObservations(list, plan).conflicts).toEqual([]);
  });

  it('参与方集合相同且端点相接的相邻冲突段合并，续约不产生缝隙', () => {
    const list = withIp(
      [
        obs(1, '192.168.0.10', MAC_A, 0, 200),
        obs(2, '192.168.0.10', MAC_B, 50, 50), // [50,100)
        obs(3, '192.168.0.10', MAC_B, 100, 50), // [100,150)，与上一段半开相接
      ],
      '192.168.0.10',
    );
    const { conflicts } = auditObservations(list, plan);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].startMs).toBe(T0 + 50_000);
    expect(conflicts[0].endMs).toBe(T0 + 150_000);
    expect(conflicts[0].macs).toEqual([MAC_A, MAC_B]);
    expect(conflicts[0].lines).toEqual([1, 2, 3]);
  });

  it('冲突参与方集合在边界变化时拆为不同段', () => {
    const list = withIp(
      [
        obs(1, '192.168.0.10', MAC_A, 0, 100),
        obs(2, '192.168.0.10', MAC_B, 50, 100), // 冲突 [50,150)
        obs(3, '192.168.0.10', MAC_C, 100, 100), // t=100 起 A 退出、C 加入
      ],
      '192.168.0.10',
    );
    const { conflicts } = auditObservations(list, plan);
    expect(conflicts).toHaveLength(2);
    expect(conflicts[0]).toMatchObject({ startMs: T0 + 50_000, endMs: T0 + 100_000 });
    expect(conflicts[0].macs).toEqual([MAC_A, MAC_B]);
    expect(conflicts[1]).toMatchObject({ startMs: T0 + 100_000, endMs: T0 + 150_000 });
    expect(conflicts[1].macs).toEqual([MAC_B, MAC_C]);
  });

  it('存在无冲突空隙时相同参与方也不合并', () => {
    const list = withIp(
      [
        obs(1, '192.168.0.10', MAC_A, 0, 50),
        obs(2, '192.168.0.10', MAC_B, 25, 25), // 冲突 [25,50)
        // [50,100) 无任何观测
        obs(3, '192.168.0.10', MAC_A, 100, 50),
        obs(4, '192.168.0.10', MAC_B, 125, 25), // 冲突 [125,150)
      ],
      '192.168.0.10',
    );
    const { conflicts } = auditObservations(list, plan);
    expect(conflicts).toHaveLength(2);
    expect(conflicts[0].startMs).toBe(T0 + 25_000);
    expect(conflicts[1].startMs).toBe(T0 + 125_000);
  });

  it('三个 MAC 同时有效时参与方为三者', () => {
    const list = withIp(
      [obs(1, '192.168.0.10', MAC_A, 0, 100), obs(2, '192.168.0.10', MAC_B, 0, 100), obs(3, '192.168.0.10', MAC_C, 0, 100)],
      '192.168.0.10',
    );
    const { conflicts } = auditObservations(list, plan);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].macs).toEqual([MAC_A, MAC_B, MAC_C]);
  });

  it('不同 IP 的区间互不算冲突，并按 IP 与时间排序输出', () => {
    const list = [
      ...withIp([obs(1, '192.168.0.10', MAC_A, 0, 100), obs(2, '192.168.0.10', MAC_B, 0, 100)], '192.168.0.10'),
      ...withIp([obs(3, '10.0.0.9', MAC_A, 0, 100), obs(4, '10.0.0.9', MAC_B, 0, 100)], '10.0.0.9'),
    ];
    const { conflicts } = auditObservations(list, plan);
    expect(conflicts).toHaveLength(2);
    expect(conflicts.map((c) => c.ip)).toEqual(['10.0.0.9', '192.168.0.10']);
  });
});

describe('子网归属', () => {
  const plan = planWith([
    alloc('办公有线', '192.168.0.0/22'),
    alloc('办公有线-一楼', '192.168.0.0/24'),
    alloc('预留核心', '10.0.0.0/16', 'reserved'),
  ]);

  it('取包含该 IP 的最具体分配（含保留段）', () => {
    const list = withIp(
      [obs(1, '192.168.0.10', MAC_A, 0, 100), obs(2, '192.168.0.10', MAC_B, 0, 100)],
      '192.168.0.10',
    );
    const c = auditObservations(list, plan).conflicts[0];
    expect(c.subnet).toEqual({ name: '办公有线-一楼', cidr: '192.168.0.0/24', kind: 'subnet' });
    expect(c.rootName).toBe('办公网');

    const reserved = withIp(
      [obs(3, '10.0.0.5', MAC_A, 0, 100), obs(4, '10.0.0.5', MAC_B, 0, 100)],
      '10.0.0.5',
    );
    const c2 = auditObservations(reserved, plan).conflicts[0];
    expect(c2.subnet?.kind).toBe('reserved');
    expect(c2.subnet?.name).toBe('预留核心');
    expect(c2.rootName).toBeNull();
  });

  it('不落在任何分配内时 subnet 为 null', () => {
    const plan2 = planWith([]);
    const list = withIp(
      [obs(1, '172.16.0.1', MAC_A, 0, 100), obs(2, '172.16.0.1', MAC_B, 0, 100)],
      '172.16.0.1',
    );
    const c = auditObservations(list, plan2).conflicts[0];
    expect(c.subnet).toBeNull();
    expect(c.rootName).toBeNull();
  });
});

describe('一体入口与文本报告', () => {
  const plan = planWith([alloc('办公有线', '192.168.0.0/24')]);

  it('runAddressAudit：存在非法行时阻止生成', () => {
    const out = runAddressAudit(
      '2026-09-18T00:00:00Z, 192.168.0.10, aa:00:00:00:00:01, 100\nnope',
      plan,
    );
    expect('errors' in out).toBe(true);
    expect((out as { errors: string[] }).errors).toHaveLength(1);
    expect((out as { errors: string[] }).errors[0]).toContain('第 2 行');
  });

  it('报告含统计、起止、MAC 列表与子网分配，且可重复复制', () => {
    const text = [
      '2026-09-18T00:00:00Z, 192.168.0.10, aa:00:00:00:00:01, 100',
      '2026-09-18T00:00:30Z, 192.168.0.10, bb:00:00:00:00:02, 100',
    ].join('\n');
    const out = runAddressAudit(text, plan);
    expect(out.result).toBeDefined();
    const report = formatAuditReport(out.result!, new Date('2026-09-18T08:30:00'));
    expect(report).toContain('地址观测冲突审计报告');
    expect(report).toContain('2026-09-18 08:30:00');
    expect(report).toContain('观测行：2 · 涉及 IP：1 · 冲突区间：1');
    expect(report).toContain('IP 192.168.0.10');
    expect(report).toContain('办公有线 192.168.0.0/24（子网）');
    expect(report).toContain(isoUtc(T0 + 30_000));
    expect(isoUtc(T0 + 30_000)).toBe('2026-09-18T00:00:30.000Z');
    expect(report).toContain('aa:00:00:00:00:01');
    expect(report).toContain('bb:00:00:00:00:02');
    expect(report).toContain('输入行：1、2');
  });

  it('无冲突时给出明确结论', () => {
    const text = [
      '2026-09-18T00:00:00Z, 192.168.0.10, aa:00:00:00:00:01, 100',
      '2026-09-18T00:01:40Z, 192.168.0.10, bb:00:00:00:00:02, 100',
    ].join('\n');
    const out = runAddressAudit(text, plan);
    expect(out.result!.conflicts).toEqual([]);
    expect(formatAuditReport(out.result!)).toContain('未发现');
  });
});
