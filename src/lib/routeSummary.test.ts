import { describe, expect, it } from 'vitest';
import { Allocation, Plan, RootBlock } from './model';
import { cidrToString, parseCidr } from './ip';
import {
  formatSummaryReport,
  planRouteSummary,
  selectableSubnets,
  validateMaxEntries,
} from './routeSummary';

const root = (name: string, cidr: string): RootBlock => ({ id: `r_${name}`, name, cidr });
const subnet = (name: string, cidr: string): Allocation => ({
  id: `a_${name}`,
  name,
  kind: 'subnet',
  prefix: parseCidr(cidr)!.prefix,
  cidr,
});
const reserved = (name: string, cidr: string): Allocation => ({
  id: `a_${name}`,
  name,
  kind: 'reserved',
  prefix: parseCidr(cidr)!.prefix,
  cidr,
});

const plan = (roots: RootBlock[], allocations: Allocation[]): Plan => ({
  version: 1,
  roots,
  allocations,
});

const entryStrings = (r: ReturnType<typeof planRouteSummary>) =>
  r.entries.map((e) => cidrToString(e.cidr));

describe('基础合并', () => {
  const p = plan(
    [root('骨干', '10.0.0.0/8')],
    [subnet('a', '10.0.0.0/24'), subnet('b', '10.0.1.0/24')],
  );

  it('相邻可完全合并的子网汇总为单条 /23，空闲代价 0', () => {
    const r = planRouteSummary(p, ['a_a', 'a_b'], 4);
    expect(r.feasible).toBe(true);
    expect(entryStrings(r)).toEqual(['10.0.0.0/23']);
    expect(r.totalEntries).toBe(1);
    expect(r.totalExtraFree).toBe(0);
    expect(r.minimumEntries).toBe(1);
    expect(r.entries[0].covered.map((t) => t.alloc.name)).toEqual(['a', 'b']);
  });

  it('代价相同时优先更少条目', () => {
    // /23 完整覆盖两个 /24，无空闲代价，1 条优于 2 条
    const r = planRouteSummary(p, ['a_a', 'a_b'], 4);
    expect(r.totalEntries).toBe(1);
  });
});

describe('空闲代价优先于条目数', () => {
  // 两个 /24 之间隔着一个空闲 /24（10.0.1.0/24）
  const p = plan([root('骨干', '10.0.0.0/8')], [
    subnet('a', '10.0.0.0/24'),
    subnet('c', '10.0.2.0/24'),
  ]);

  it('上限允许时宁愿用 2 条也不覆盖空闲地址', () => {
    const r = planRouteSummary(p, ['a_a', 'a_c'], 4);
    expect(r.feasible).toBe(true);
    expect(entryStrings(r)).toEqual(['10.0.0.0/24', '10.0.2.0/24']);
    expect(r.totalEntries).toBe(2);
    expect(r.totalExtraFree).toBe(0);
  });

  it('只允许 1 条时放大到 /22，额外覆盖 512 个空闲地址', () => {
    const r = planRouteSummary(p, ['a_a', 'a_c'], 1);
    expect(r.feasible).toBe(true);
    expect(entryStrings(r)).toEqual(['10.0.0.0/22']);
    expect(r.totalEntries).toBe(1);
    expect(r.totalExtraFree).toBe(512); // /22 的 1024 − 两个 /24 共 512
    expect(r.entries[0].extraFreeAddresses).toBe(512);
  });

  it('上限 1 强制合并时取最小代价：/23 额外覆盖 256 个空闲地址，优于 /22 的 768', () => {
    // 10.0.0.0/25 与 10.0.1.128/25：
    //   /23 覆盖 512 个地址、已用 256 → 空闲 256
    //   /22 覆盖 1024 个地址、已用 256 → 空闲 768
    const p2 = plan([root('骨干', '10.0.0.0/8')], [
      subnet('lo', '10.0.0.0/25'),
      subnet('hi', '10.0.1.128/25'),
    ]);
    const forced = planRouteSummary(p2, ['a_lo', 'a_hi'], 1);
    expect(entryStrings(forced)).toEqual(['10.0.0.0/23']);
    expect(forced.totalExtraFree).toBe(256);

    // 上限充足时，每段子网各自成路由，空闲代价恒为 0（合并不强制）
    const free = planRouteSummary(p2, ['a_lo', 'a_hi'], 4);
    expect(entryStrings(free)).toEqual(['10.0.0.0/25', '10.0.1.128/25']);
    expect(free.totalExtraFree).toBe(0);
  });
});

describe('不得覆盖未选分配', () => {
  const p = plan([root('骨干', '10.0.0.0/8')], [
    subnet('a', '10.0.0.0/24'),
    reserved('保留', '10.0.1.0/24'),
    subnet('c', '10.0.2.0/24'),
    subnet('d', '10.0.3.0/24'),
  ]);

  it('命名保留段阻断放大：c+d 可合并 /23，但跨越保留段的 /22 非法', () => {
    const r = planRouteSummary(p, ['a_a', 'a_c', 'a_d'], 4);
    expect(r.feasible).toBe(true);
    expect(entryStrings(r)).toEqual(['10.0.0.0/24', '10.0.2.0/23']);
    expect(r.totalExtraFree).toBe(0);
    expect(r.minimumEntries).toBe(2);
  });

  it('未勾选的子网同样阻断（只选 a、c 时保留段与 d 都是障碍）', () => {
    const r = planRouteSummary(p, ['a_a', 'a_c'], 4);
    // /22 与保留段重叠非法；10.0.2.0/23 与 d(10.0.3.0/24) 重叠也非法 → 只能各自 /24
    expect(r.feasible).toBe(true);
    expect(entryStrings(r)).toEqual(['10.0.0.0/24', '10.0.2.0/24']);
    expect(r.minimumEntries).toBe(2);
  });

  it('条数上限低于最少所需时不可行并给出最少条数', () => {
    const r = planRouteSummary(p, ['a_a', 'a_c', 'a_d'], 1);
    expect(r.feasible).toBe(false);
    expect(r.entries).toEqual([]);
    expect(r.minimumEntries).toBe(2);
  });
});

describe('不得跨根网段', () => {
  const p = plan(
    [root('生产', '10.0.0.0/8'), root('办公', '192.168.0.0/16')],
    [subnet('a', '10.0.0.0/24'), subnet('b', '192.168.0.0/24')],
  );

  it('不同根网段即使可在全局地址空间合并也必须分条', () => {
    const r = planRouteSummary(p, ['a_a', 'a_b'], 4);
    expect(r.feasible).toBe(true);
    expect(entryStrings(r)).toEqual(['10.0.0.0/24', '192.168.0.0/24']);
    expect(r.minimumEntries).toBe(2);
    expect(r.groups).toHaveLength(2);
    expect(r.groups[0].root.name).toBe('生产');
  });

  it('上限 1 条无法覆盖两个根网段：不可行，最少 2 条', () => {
    const r = planRouteSummary(p, ['a_a', 'a_b'], 1);
    expect(r.feasible).toBe(false);
    expect(r.minimumEntries).toBe(2);
    expect(r.groups.map((g) => g.minimumEntries)).toEqual([1, 1]);
  });
});

describe('全局条数预算在根网段间分配', () => {
  // 根 A：两个相邻 /24（合并不浪费）；根 B：两个 /24 间隔一个空闲 /24
  const p = plan(
    [root('A', '10.0.0.0/8'), root('B', '172.16.0.0/12')],
    [
      subnet('a1', '10.0.0.0/24'),
      subnet('a2', '10.0.1.0/24'),
      subnet('b1', '172.16.0.0/24'),
      subnet('b2', '172.16.2.0/24'),
    ],
  );

  it('上限 2：A 用 1 条 /23（代价 0），B 用 1 条 /22（代价 512）是唯一可行结构', () => {
    const r = planRouteSummary(p, ['a_a1', 'a_a2', 'a_b1', 'a_b2'], 2);
    expect(r.feasible).toBe(true);
    expect(r.totalEntries).toBe(2);
    expect(entryStrings(r)).toEqual(['10.0.0.0/23', '172.16.0.0/22']);
    expect(r.totalExtraFree).toBe(512);
  });

  it('上限 3：A 维持 1 条（代价 0 时更少条目优先），B 拆 2 条消除空闲代价', () => {
    const r = planRouteSummary(p, ['a_a1', 'a_a2', 'a_b1', 'a_b2'], 3);
    expect(r.feasible).toBe(true);
    expect(entryStrings(r)).toEqual([
      '10.0.0.0/23',
      '172.16.0.0/24',
      '172.16.2.0/24',
    ]);
    expect(r.totalEntries).toBe(3);
    expect(r.totalExtraFree).toBe(0);
  });
});

describe('同代价同条目数按网络地址排序', () => {
  it('结果条目始终按网络地址升序输出', () => {
    const p = plan(
      [root('A', '10.0.0.0/8'), root('B', '172.16.0.0/12')],
      [
        subnet('b1', '172.16.0.0/24'),
        subnet('a1', '10.0.0.0/24'),
      ],
    );
    const r = planRouteSummary(p, ['a_b1', 'a_a1'], 4);
    expect(entryStrings(r)).toEqual(['10.0.0.0/24', '172.16.0.0/24']);
  });

  it('空闲代价优先于条目数：上限收紧时逐级接受更大的空闲覆盖', () => {
    // 四个互不重叠的 /25：
    //   S0=10.0.0.0/25、S1=10.0.0.128/25（/24@0 恰好占满）
    //   S2=10.0.1.128/25（/24@1 下半，上半空闲）、S3=10.0.2.0/25
    const p = plan([root('骨干', '10.0.0.0/8')], [
      subnet('s0', '10.0.0.0/25'),
      subnet('s1', '10.0.0.128/25'),
      subnet('s2', '10.0.1.128/25'),
      subnet('s3', '10.0.2.0/25'),
    ]);
    // 上限 ≥3：0 空闲代价（/24@0 恰好合并 S0+S1，S2、S3 各成一条），3 条
    const r3 = planRouteSummary(p, ['a_s0', 'a_s1', 'a_s2', 'a_s3'], 3);
    expect(entryStrings(r3)).toEqual(['10.0.0.0/24', '10.0.1.128/25', '10.0.2.0/25']);
    expect(r3.totalEntries).toBe(3);
    expect(r3.totalExtraFree).toBe(0);
    // 上限 2：/23@0 合并 S0+S1+S2（顺带 /24@1 上半 128 空闲），S3 独立
    const r2 = planRouteSummary(p, ['a_s0', 'a_s1', 'a_s2', 'a_s3'], 2);
    expect(r2.feasible).toBe(true);
    expect(entryStrings(r2)).toEqual(['10.0.0.0/23', '10.0.2.0/25']);
    expect(r2.totalExtraFree).toBe(128);
    // 上限 1：/22@0 覆盖全部 4 个子网，额外 512 空闲
    const r1 = planRouteSummary(p, ['a_s0', 'a_s1', 'a_s2', 'a_s3'], 1);
    expect(entryStrings(r1)).toEqual(['10.0.0.0/22']);
    expect(r1.totalExtraFree).toBe(512);
  });

  it('同代价、同网络地址序列时，同基 CIDR 取更具体前缀', () => {
    // 单子网 /24：所有更大前缀都有空闲代价，/24 自身代价 0，天然最优。
    const p = plan([root('骨干', '10.0.0.0/8')], [subnet('s', '10.0.0.0/24')]);
    const r = planRouteSummary(p, ['a_s'], 4);
    expect(entryStrings(r)).toEqual(['10.0.0.0/24']);
    expect(r.totalExtraFree).toBe(0);
  });
});

describe('根网段不对齐覆盖边界', () => {
  it('汇总块必须完整落在根网段内（根为 /22 时不允许放大到包含外部地址的 /21）', () => {
    const p = plan([root('小根', '10.0.2.0/23')], [
      subnet('lo', '10.0.2.0/24'),
      subnet('hi', '10.0.3.0/24'),
    ]);
    const r = planRouteSummary(p, ['a_lo', 'a_hi'], 4);
    // /23 恰好是根网段本身，合法；再大的 /22 跨根网段
    expect(entryStrings(r)).toEqual(['10.0.2.0/23']);
  });

  it('根网段起始未对齐放大块时，放大到越界即停止', () => {
    // 10.0.1.0/24 所在 /23 为 10.0.0.0/23，根 10.0.1.0/24 仅含自身 → 只能 /24
    const p = plan([root('单/24', '10.0.1.0/24')], [subnet('s', '10.0.1.0/25')]);
    const r = planRouteSummary(p, ['a_s'], 4);
    expect(entryStrings(r)).toEqual(['10.0.1.0/25']);
    expect(r.totalExtraFree).toBe(0);
  });
});

describe('可选子网清单', () => {
  it('命名保留段不出现在可选清单', () => {
    const p = plan([root('r', '10.0.0.0/8')], [
      subnet('s1', '10.0.0.0/24'),
      reserved('rv', '10.0.1.0/24'),
    ]);
    const list = selectableSubnets(p);
    expect(list.map((x) => x.target.alloc.kind)).toEqual(['subnet']);
    expect(list[0].root.name).toBe('r');
  });
});

describe('条数上限输入校验', () => {
  it('接受 1-256 的整数', () => {
    expect(validateMaxEntries('1')).toBe(1);
    expect(validateMaxEntries(' 12 ')).toBe(12);
    expect(validateMaxEntries('256')).toBe(256);
  });
  it('拒绝空、非数字、0 与超过 256', () => {
    expect(typeof validateMaxEntries('')).toBe('string');
    expect(typeof validateMaxEntries('abc')).toBe('string');
    expect(typeof validateMaxEntries('0')).toBe('string');
    expect(typeof validateMaxEntries('257')).toBe('string');
    expect(typeof validateMaxEntries('1.5')).toBe('string');
  });
});

describe('文本报告', () => {
  it('可行方案包含统计、每条 CIDR、覆盖子网与空闲地址数', () => {
    const p = plan([root('骨干', '10.0.0.0/8')], [
      subnet('a', '10.0.0.0/24'),
      subnet('c', '10.0.2.0/24'),
    ]);
    const r = planRouteSummary(p, ['a_a', 'a_c'], 1);
    const text = formatSummaryReport(r, new Date('2026-09-19T10:00:00'));
    expect(text).toContain('路由汇总报告');
    expect(text).toContain('2026-09-19 10:00:00');
    expect(text).toContain('已选子网：2 个 · 路由条数上限：1 条');
    expect(text).toContain('方案 1 条');
    expect(text).toContain('1. 10.0.0.0/22');
    expect(text).toContain('a(10.0.0.0/24)');
    expect(text).toContain('c(10.0.2.0/24)');
    expect(text).toContain('额外覆盖空闲地址 512 个');
  });

  it('不可行方案说明全局与各根网段最少所需条数', () => {
    const p = plan(
      [root('A', '10.0.0.0/8'), root('B', '192.168.0.0/16')],
      [subnet('a', '10.0.0.0/24'), subnet('b', '192.168.0.0/24')],
    );
    const r = planRouteSummary(p, ['a_a', 'a_b'], 1);
    const text = formatSummaryReport(r);
    expect(text).toContain('无法在 1 条内完成汇总，最少需要 2 条');
    expect(text).toContain('根网段「A」10.0.0.0/8：已选 1 个，最少 1 条');
    expect(text).toContain('根网段「B」192.168.0.0/16：已选 1 个，最少 1 条');
  });
});
