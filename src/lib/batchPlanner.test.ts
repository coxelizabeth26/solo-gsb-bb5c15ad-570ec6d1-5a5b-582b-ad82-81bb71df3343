import { describe, expect, it } from 'vitest';
import { parseCidr } from './ip';
import { Allocation, Plan, RootBlock, validatePlan } from './model';
import { allocationsFromBatchPlan, planBatchSubnets, BatchSubnetRequest } from './planner';

const root = (id: string, name: string, cidr: string): RootBlock => ({ id, name, cidr });
const alloc = (name: string, cidr: string): Allocation => ({
  id: `a_${name}`,
  name,
  kind: 'subnet',
  prefix: parseCidr(cidr)!.prefix,
  cidr,
});
const req = (
  row: number,
  name: string,
  hosts: number,
  rootId: string = 'auto',
  note?: string,
): BatchSubnetRequest => ({ row, name, hosts, rootId, note });

const plan = (roots: RootBlock[], allocs: Allocation[] = []): Plan => ({
  version: 1,
  roots,
  allocations: allocs,
});

describe('planBatchSubnets 批量申请预演', () => {
  it('按输入顺序逐行安置到最低可用地址并返回最小前缀与容量', () => {
    const p = plan([root('r1', 'A', '10.0.0.0/24')]);
    const batch = planBatchSubnets(p, [req(1, 'X', 100), req(2, 'Y', 100)]);
    expect(batch.ok).toBe(true);
    // 100 台主机 → /25（126 可用），两行依次 .0/25、.128/25
    expect(batch.lines.map((l) => l.cidr)).toEqual(['10.0.0.0/25', '10.0.0.128/25']);
    expect(batch.lines.every((l) => l.prefix === 25)).toBe(true);
    expect(batch.lines.every((l) => l.capacity === 126)).toBe(true);
    expect(batch.lines.map((l) => l.rootName)).toEqual(['A', 'A']);
  });

  it('前序行计入占用，后序行被推向更高地址（输入顺序影响落位）', () => {
    const p = plan([root('r1', 'A', '10.0.0.0/24')]);
    const smallFirst = planBatchSubnets(p, [req(1, 'S', 50), req(2, 'B', 100)]);
    expect(smallFirst.ok).toBe(true);
    // 50 台 → /26 落 .0/26；/25 最低对齐位置为 .128
    expect(smallFirst.lines.map((l) => l.cidr)).toEqual(['10.0.0.0/26', '10.0.0.128/25']);

    const bigFirst = planBatchSubnets(p, [req(1, 'B', 100), req(2, 'S', 50)]);
    expect(bigFirst.ok).toBe(true);
    // /25 先占 .0/25；/26 落 .128/26
    expect(bigFirst.lines.map((l) => l.cidr)).toEqual(['10.0.0.0/25', '10.0.0.128/26']);
  });

  it('既存分配同样被避开', () => {
    const p = plan([root('r1', 'A', '10.0.0.0/24')], [alloc('old', '10.0.0.0/25')]);
    const batch = planBatchSubnets(p, [req(1, 'X', 100)]);
    expect(batch.ok).toBe(true);
    expect(batch.lines[0].cidr).toBe('10.0.0.128/25');
  });

  it('rootId=auto 时跨根网段按地址升序选择最低地址', () => {
    const p = plan([
      root('r2', 'B', '192.168.0.0/24'),
      root('r1', 'A', '10.0.0.0/24'),
    ]);
    const batch = planBatchSubnets(p, [req(1, 'X', 1)]);
    expect(batch.ok).toBe(true);
    expect(batch.lines[0].cidr).toBe('10.0.0.0/32');
    expect(batch.lines[0].rootName).toBe('A');
  });

  it('指定根网段时只在该根网段内寻找', () => {
    const p = plan([
      root('r1', 'A', '10.0.0.0/24'),
      root('r2', 'B', '192.168.0.0/24'),
    ]);
    const batch = planBatchSubnets(p, [req(1, 'X', 1, 'r2')]);
    expect(batch.ok).toBe(true);
    expect(batch.lines[0].cidr).toBe('192.168.0.0/32');
    expect(batch.lines[0].rootName).toBe('B');
  });

  it('/31 与 /32 容量按特殊规则计算', () => {
    const p = plan([root('r1', 'A', '10.0.0.0/30')]);
    const batch = planBatchSubnets(p, [req(1, 'P2P', 2), req(2, 'host', 1)]);
    expect(batch.ok).toBe(true);
    expect(batch.lines[0]).toMatchObject({ prefix: 31, capacity: 2, cidr: '10.0.0.0/31' });
    expect(batch.lines[1]).toMatchObject({ prefix: 32, capacity: 1, cidr: '10.0.0.2/32' });
  });

  it('指定根网段已满但其他根网段有空间时仍判失败且不挪用', () => {
    const p = plan(
      [root('r1', 'A', '10.0.0.0/30'), root('r2', 'B', '192.168.0.0/24')],
      [alloc('full', '10.0.0.0/30')],
    );
    const batch = planBatchSubnets(p, [req(1, 'X', 1, 'r1')]);
    expect(batch.ok).toBe(false);
    expect(batch.lines[0].status).toBe('nospace');
    expect(batch.lines[0].cidr).toBeNull();
    expect(batch.lines[0].reason).toContain('空间不足');
    expect(batch.lines[0].reason).toContain('A');
  });

  it('auto 时所有根网段均无空间判失败', () => {
    const p = plan([root('r1', 'A', '10.0.0.0/30')], [alloc('full', '10.0.0.0/30')]);
    const batch = planBatchSubnets(p, [req(1, 'X', 1)]);
    expect(batch.ok).toBe(false);
    expect(batch.lines[0].status).toBe('nospace');
    expect(batch.lines[0].prefix).toBe(32);
  });

  it('后续行空间不足时失败，且失败行不占用任何地址', () => {
    const p = plan([root('r1', 'A', '10.0.0.0/26')]);
    const batch = planBatchSubnets(p, [req(1, 'X', 50), req(2, 'Y', 50), req(3, 'Z', 50)]);
    expect(batch.ok).toBe(false);
    expect(batch.lines[0].cidr).toBe('10.0.0.0/26');
    expect(batch.lines[1].status).toBe('nospace');
    expect(batch.lines[2].status).toBe('nospace');
    // 第三行即使按第二行未占用来算也放不下 /26（/26 只有一个），换一个可区分的场景：
    const p2 = plan([root('r1', 'A', '10.0.0.0/25')]);
    const b2 = planBatchSubnets(p2, [
      req(1, 'B', 100), // /25 占满
      req(2, 'S', 50), // 无空间，失败且不落位
    ]);
    expect(b2.lines.map((l) => l.status)).toEqual(['ok', 'nospace']);
  });

  it('名称为空、主机数非法、根网段不存在分别报非法，且不进行安置', () => {
    const p = plan([root('r1', 'A', '10.0.0.0/24')]);
    const batch = planBatchSubnets(p, [
      req(1, '   ', 10),
      req(2, 'B', 0),
      req(3, 'C', 1.5),
      req(4, 'D', 10, 'missing-root'),
    ]);
    expect(batch.ok).toBe(false);
    expect(batch.lines.map((l) => l.status)).toEqual(['invalid', 'invalid', 'invalid', 'invalid']);
    expect(batch.lines[0].reason).toContain('名称');
    expect(batch.lines[1].reason).toContain('主机数');
    expect(batch.lines[2].reason).toContain('主机数');
    expect(batch.lines[3].reason).toContain('根网段');
    expect(batch.lines.every((l) => l.cidr === null)).toBe(true);
  });

  it('非法行不占用空间，其后的合法行仍可正常安置', () => {
    const p = plan([root('r1', 'A', '10.0.0.0/24')]);
    const batch = planBatchSubnets(p, [req(1, '', 100), req(2, 'Y', 100)]);
    expect(batch.ok).toBe(false);
    expect(batch.lines[0].status).toBe('invalid');
    expect(batch.lines[1].status).toBe('ok');
    expect(batch.lines[1].cidr).toBe('10.0.0.0/25');
  });

  it('没有任何根网段时 auto 与指定行都报非法', () => {
    const batch = planBatchSubnets(plan([]), [req(1, 'X', 10)]);
    expect(batch.ok).toBe(false);
    expect(batch.lines[0].status).toBe('invalid');
    expect(batch.lines[0].reason).toContain('根网段');
  });

  it('空请求预演通过但不产生任何行', () => {
    const batch = planBatchSubnets(plan([root('r1', 'A', '10.0.0.0/24')]), []);
    expect(batch.ok).toBe(true);
    expect(batch.lines).toEqual([]);
  });

  it('行号保留原始输入位置（含被调用方过滤的空行场景）', () => {
    const p = plan([root('r1', 'A', '10.0.0.0/24')]);
    const batch = planBatchSubnets(p, [req(3, 'X', 1), req(5, 'Y', 1)]);
    expect(batch.lines.map((l) => l.row)).toEqual([3, 5]);
  });
});

describe('allocationsFromBatchPlan 构造分配', () => {
  it('按输入顺序构造 subnet 分配，名称与备注 trim，无备注为 undefined', () => {
    const p = plan([root('r1', 'A', '10.0.0.0/24')]);
    const batch = planBatchSubnets(p, [req(1, '  X  ', 100, 'auto', '  备注 '), req(2, 'Y', 1)]);
    const allocs = allocationsFromBatchPlan(batch);
    expect(allocs).toHaveLength(2);
    expect(allocs[0]).toMatchObject({
      name: 'X',
      kind: 'subnet',
      prefix: 25,
      cidr: '10.0.0.0/25',
      note: '备注',
    });
    expect(allocs[1].note).toBeUndefined();
    // id 唯一
    expect(new Set(allocs.map((a) => a.id)).size).toBe(2);
  });

  it('整批原子加入后不改变原规划引用，且新规划通过整体校验', () => {
    const p = plan([root('r1', 'A', '10.0.0.0/24')], [alloc('old', '10.0.0.128/25')]);
    const batch = planBatchSubnets(p, [req(1, 'X', 50)]);
    const next: Plan = { ...p, allocations: [...p.allocations, ...allocationsFromBatchPlan(batch)] };
    expect(p.allocations).toHaveLength(1); // 原规划未被修改
    expect(validatePlan(next)).toEqual([]);
    expect(next.allocations.map((a) => a.cidr)).toEqual(['10.0.0.128/25', '10.0.0.0/26']);
  });
});
