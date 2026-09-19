import { describe, expect, it } from 'vitest';
import { Allocation, Plan, RootBlock, serializePlan } from './model';
import { Cidr, cidrToString, parseCidr } from './ip';
import { diffPlans, formatDiffReport, parseBaseline } from './planDiff';

const root = (name: string, cidr: string): RootBlock => ({ id: `r_${name}`, name, cidr });

const alloc = (
  id: string,
  name: string,
  cidr: string,
  kind: Allocation['kind'] = 'subnet',
): Allocation => ({
  id,
  name,
  kind,
  prefix: parseCidr(cidr)!.prefix,
  cidr,
});

const plan = (roots: RootBlock[], allocations: Allocation[]): Plan => ({
  version: 1,
  roots,
  allocations,
});

const cidrStrings = (cidrs: Cidr[]): string[] => cidrs.map((c) => cidrToString(c));

describe('parseBaseline', () => {
  it('接受「导出 JSON」生成的文件并复用完整校验', () => {
    const p = plan(
      [root('生产', '10.0.0.0/8')],
      [alloc('a1', '子网甲', '10.0.0.0/24')],
    );
    const out = parseBaseline(serializePlan(p));
    expect(out.errors).toBeUndefined();
    expect(out.plan).toEqual(p);
  });

  it('非法 JSON 报错且不生成结果', () => {
    const out = parseBaseline('{not json');
    expect(out.plan).toBeUndefined();
    expect(out.errors).toEqual(['JSON 解析失败：文件不是合法 JSON']);
  });

  it('结构缺失报错', () => {
    const out = parseBaseline('{"roots": []}');
    expect(out.plan).toBeUndefined();
    expect(out.errors![0]).toContain('缺少 roots / allocations 数组');
  });

  it('完整校验失败时逐条列出全部错误', () => {
    const bad = {
      version: 1,
      roots: [root('生产', '10.0.0.0/8')],
      allocations: [
        alloc('a1', '甲', '10.0.0.0/24'),
        alloc('a2', '乙', '10.0.0.128/25'), // 与甲重叠
        alloc('a3', '', '10.1.0.0/24'), // 缺名称
      ],
    };
    const out = parseBaseline(JSON.stringify(bad));
    expect(out.plan).toBeUndefined();
    expect(out.errors!.length).toBeGreaterThanOrEqual(3);
    expect(out.errors![0]).toContain('规划文件校验未通过');
    expect(out.errors!.some((e) => e.includes('重叠'))).toBe(true);
    expect(out.errors!.some((e) => e.includes('缺少名称'))).toBe(true);
  });
});

describe('diffPlans 逐项分类', () => {
  const roots = [root('生产', '10.0.0.0/8')];

  it('新增与删除', () => {
    const baseline = plan(roots, [alloc('a1', '保留项', '10.0.0.0/24'), alloc('a2', '删除项', '10.0.1.0/24')]);
    const current = plan(roots, [alloc('a1', '保留项', '10.0.0.0/24'), alloc('a3', '新增项', '10.0.2.0/24')]);
    const r = diffPlans(baseline, current);
    expect(r.addedCount).toBe(1);
    expect(r.removedCount).toBe(1);
    expect(r.changedCount).toBe(0);
    expect(r.unchangedCount).toBe(1);
    const added = r.items.find((i) => i.status === 'added')!;
    const removed = r.items.find((i) => i.status === 'removed')!;
    expect(added.current!.name).toBe('新增项');
    expect(removed.baseline!.name).toBe('删除项');
    expect(added.changes).toEqual([]);
  });

  it('重命名 / 类型变化 / 迁移 / 容量变化各自独立判定', () => {
    const baseline = plan(roots, [
      alloc('a1', '旧名', '10.0.0.0/24'),
      alloc('a2', '类型项', '10.0.1.0/24'),
      alloc('a3', '迁移项', '10.0.2.0/24'),
      alloc('a4', '容量项', '10.0.4.0/24'),
    ]);
    const current = plan(roots, [
      alloc('a1', '新名', '10.0.0.0/24'),
      alloc('a2', '类型项', '10.0.1.0/24', 'reserved'),
      alloc('a3', '迁移项', '10.0.9.0/24'),
      alloc('a4', '容量项', '10.0.4.0/23'), // 同基址扩容量
    ]);
    const r = diffPlans(baseline, current);
    const byId = new Map(r.items.map((i) => [i.id, i]));
    expect(byId.get('a1')!.changes).toEqual(['renamed']);
    expect(byId.get('a2')!.changes).toEqual(['kind-changed']);
    expect(byId.get('a3')!.changes).toEqual(['moved']);
    expect(byId.get('a4')!.changes).toEqual(['capacity-changed']);
    expect(r.renamedCount).toBe(1);
    expect(r.kindChangedCount).toBe(1);
    expect(r.movedCount).toBe(1);
    expect(r.capacityChangedCount).toBe(1);
  });

  it('同一项可携带多个变化标签', () => {
    const baseline = plan(roots, [alloc('a1', '旧名', '10.0.0.0/24')]);
    const current = plan(roots, [
      { id: 'a1', name: '新名', kind: 'reserved', prefix: 23, cidr: '10.0.2.0/23' },
    ]);
    const r = diffPlans(baseline, current);
    expect(r.items).toHaveLength(1);
    expect(r.items[0].status).toBe('changed');
    expect(r.items[0].changes).toEqual(['renamed', 'kind-changed', 'moved', 'capacity-changed']);
  });

  it('完全一致的规划没有任何差异项', () => {
    const p = plan(roots, [alloc('a1', '甲', '10.0.0.0/24'), alloc('a2', '乙', '10.0.1.0/24', 'reserved')]);
    const r = diffPlans(p, p);
    expect(r.items).toEqual([]);
    expect(r.unchangedCount).toBe(2);
    expect(r.addedCidrs).toEqual([]);
    expect(r.releasedCidrs).toEqual([]);
    expect(r.addedAddressCount).toBe(0);
    expect(r.releasedAddressCount).toBe(0);
  });

  it('明细按落位地址升序排列', () => {
    const baseline = plan(roots, [alloc('a1', '删除项', '10.0.9.0/24')]);
    const current = plan(roots, [
      alloc('a2', '新增乙', '10.0.5.0/24'),
      alloc('a3', '新增甲', '10.0.1.0/24'),
    ]);
    const r = diffPlans(baseline, current);
    expect(r.items.map((i) => (i.current ?? i.baseline)!.name)).toEqual([
      '新增甲',
      '新增乙',
      '删除项',
    ]);
  });
});

describe('diffPlans 地址差集', () => {
  const roots = [root('生产', '10.0.0.0/8')];

  it('新增占用 = 当前 − 基线，释放地址 = 基线 − 当前', () => {
    const baseline = plan(roots, [alloc('a1', '甲', '10.0.0.0/24')]);
    const current = plan(roots, [alloc('a1', '甲', '10.0.0.0/24'), alloc('a2', '乙', '10.0.1.0/24')]);
    const r = diffPlans(baseline, current);
    expect(cidrStrings(r.addedCidrs)).toEqual(['10.0.1.0/24']);
    expect(cidrStrings(r.releasedCidrs)).toEqual([]);
    expect(r.addedAddressCount).toBe(256);
    expect(r.releasedAddressCount).toBe(0);
  });

  it('迁移：原位置释放、新位置占用', () => {
    const baseline = plan(roots, [alloc('a1', '甲', '10.0.0.0/24')]);
    const current = plan(roots, [alloc('a1', '甲', '10.0.1.0/24')]);
    const r = diffPlans(baseline, current);
    expect(cidrStrings(r.addedCidrs)).toEqual(['10.0.1.0/24']);
    expect(cidrStrings(r.releasedCidrs)).toEqual(['10.0.0.0/24']);
  });

  it('扩容只计增量、缩容只计释放', () => {
    const baseline = plan(roots, [alloc('a1', '甲', '10.0.0.0/24')]);
    const grown = plan(roots, [alloc('a1', '甲', '10.0.0.0/23')]);
    const r1 = diffPlans(baseline, grown);
    expect(cidrStrings(r1.addedCidrs)).toEqual(['10.0.1.0/24']);
    expect(cidrStrings(r1.releasedCidrs)).toEqual([]);
    const r2 = diffPlans(grown, baseline);
    expect(cidrStrings(r2.addedCidrs)).toEqual([]);
    expect(cidrStrings(r2.releasedCidrs)).toEqual(['10.0.1.0/24']);
  });

  it('部分重叠精确扣除：释放侧只算不再占用的部分', () => {
    const baseline = plan(roots, [alloc('a1', '甲', '10.0.0.0/24')]);
    const current = plan(roots, [alloc('a1', '甲', '10.0.0.128/25')]);
    const r = diffPlans(baseline, current);
    expect(cidrStrings(r.addedCidrs)).toEqual([]);
    expect(cidrStrings(r.releasedCidrs)).toEqual(['10.0.0.0/25']);
    expect(r.releasedAddressCount).toBe(128);
  });

  it('相邻新增块伙伴合并为最少 CIDR', () => {
    const baseline = plan(roots, []);
    const current = plan(roots, [
      alloc('a1', '甲', '10.0.0.0/25'),
      alloc('a2', '乙', '10.0.0.128/25'),
      alloc('a3', '丙', '10.0.1.0/25'),
    ]);
    const r = diffPlans(baseline, current);
    expect(cidrStrings(r.addedCidrs)).toEqual(['10.0.0.0/24', '10.0.1.0/25']);
  });

  it('差集结果跨块再合并仍为最少 CIDR', () => {
    // 基线占 10.0.0.0/24，当前占 10.0.0.0/25 与 10.0.1.0/25：
    // 新增 = 10.0.1.0/25，释放 = 10.0.0.128/25
    const baseline = plan(roots, [alloc('a1', '甲', '10.0.0.0/24')]);
    const current = plan(roots, [
      alloc('a1', '甲', '10.0.0.0/25'),
      alloc('a2', '乙', '10.0.1.0/25'),
    ]);
    const r = diffPlans(baseline, current);
    expect(cidrStrings(r.addedCidrs)).toEqual(['10.0.1.0/25']);
    expect(cidrStrings(r.releasedCidrs)).toEqual(['10.0.0.128/25']);
  });

  it('两版并集内部相邻块先合并再求差', () => {
    // 基线两个相邻 /25（并集为 /24），当前一个 /24：差集应为空
    const baseline = plan(roots, [
      alloc('a1', '甲', '10.0.0.0/25'),
      alloc('a2', '乙', '10.0.0.128/25'),
    ]);
    const current = plan(roots, [alloc('a3', '丙', '10.0.0.0/24')]);
    const r = diffPlans(baseline, current);
    expect(cidrStrings(r.addedCidrs)).toEqual([]);
    expect(cidrStrings(r.releasedCidrs)).toEqual([]);
  });
});

describe('formatDiffReport', () => {
  it('报告包含汇总计数、逐项明细与地址差集', () => {
    const roots = [root('生产', '10.0.0.0/8')];
    const baseline = plan(roots, [
      alloc('a1', '旧名', '10.0.0.0/24'),
      alloc('a2', '删除项', '10.0.1.0/24'),
    ]);
    const current = plan(roots, [
      alloc('a1', '新名', '10.0.0.0/24'),
      alloc('a3', '新增项', '10.0.2.0/24'),
    ]);
    const text = formatDiffReport(diffPlans(baseline, current), new Date(2026, 8, 19, 12, 0, 0));
    expect(text).toContain('规划差异报告');
    expect(text).toContain('生成时间：2026-09-19 12:00:00');
    expect(text).toContain('新增 1 · 删除 1 · 变更 1（重命名 1 · 类型变化 0 · 迁移 0 · 容量变化 0）· 未变化 0');
    expect(text).toContain('[重命名] 「旧名」→「新名」');
    expect(text).toContain('[删除] 删除项');
    expect(text).toContain('[新增] 新增项');
    expect(text).toContain('新增占用 256 个地址（1 条 CIDR）· 释放地址 256 个（1 条 CIDR）');
    expect(text).toContain('10.0.2.0/24（256 个地址）');
    expect(text).toContain('10.0.1.0/24（256 个地址）');
  });

  it('完全一致时明确说明且无差集', () => {
    const p = plan([root('生产', '10.0.0.0/8')], [alloc('a1', '甲', '10.0.0.0/24')]);
    const text = formatDiffReport(diffPlans(p, p));
    expect(text).toContain('两版规划的分配完全一致。');
    expect(text).toContain('（无）');
  });
});
