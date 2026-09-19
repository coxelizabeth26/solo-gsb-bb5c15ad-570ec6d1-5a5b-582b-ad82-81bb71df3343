/**
 * 规划引擎：空闲块查找、最低可用地址分配、迁移预演、地址空间树。
 */
import {
  Cidr,
  alignUp,
  blockSize,
  cidrToString,
  compareCidr,
  contains,
  freeBlocks,
  isAlignedCidr,
  overlaps,
  parseCidr,
  prefixForHosts,
  usableHosts,
} from './ip';
import { Allocation, Plan, RootBlock, newId, rootCidrs } from './model';

/**
 * 在 roots（按地址升序扫描）中寻找可容纳 /prefix 的最低可用地址。
 * occupied 为已占用块。找到即返回对齐后的 CIDR，找不到返回 null。
 */
export function findLowestSlot(
  roots: Cidr[],
  occupied: Cidr[],
  prefix: number,
): Cidr | null {
  const size = blockSize(prefix);
  const sortedRoots = [...roots].sort((a, b) => a.base - b.base);
  for (const root of sortedRoots) {
    for (const free of freeBlocks(root, occupied)) {
      const start = alignUp(free.base, prefix);
      if (start + size <= free.base + blockSize(free.prefix)) {
        return { base: start, prefix };
      }
    }
  }
  return null;
}

/** 单行批量申请输入（调用方需保证 name 已 trim）。 */
export interface BatchSubnetRequest {
  /** 输入行号（1 起，用于失败原因定位） */
  row: number;
  name: string;
  hosts: number;
  /** 'auto' 表示在全部根网段中寻找，否则为指定 RootBlock id */
  rootId: string;
  note?: string;
}

export type BatchLineStatus = 'ok' | 'invalid' | 'nospace';

/** 单行批量申请的预演结果：成功时给出 CIDR，非法/空间不足时给出失败原因。 */
export interface BatchSubnetLine {
  row: number;
  name: string;
  hosts: number;
  rootId: string;
  note?: string;
  status: BatchLineStatus;
  prefix: number | null;
  cidr: string | null;
  /** 成功时的可用主机容量 */
  capacity: number | null;
  /** 安置到的根网段名称（成功时） */
  rootName?: string;
  reason?: string;
}

export interface BatchSubnetPlan {
  lines: BatchSubnetLine[];
  /** 全部行合法且有空间时才允许提交 */
  ok: boolean;
}

/**
 * 批量申请预演（纯函数，不改变规划）：
 *  - 按输入顺序逐行计算容纳 hosts 台主机的最小前缀；
 *  - 每行在指定根网段（rootId 为具体 id）或全部根网段（'auto'）中寻找最低可用地址；
 *  - 已安置的前序行立即计入占用，后序行不能与前序行重叠；
 *  - 任一行非法（名称为空/主机数不合法/根网段不存在）或空间不足时 ok=false。
 */
export function planBatchSubnets(plan: Plan, requests: BatchSubnetRequest[]): BatchSubnetPlan {
  const allRootCidrs = rootCidrs(plan);
  const lines: BatchSubnetLine[] = [];
  const occupied = plan.allocations
    .map((a) => parseCidr(a.cidr))
    .filter((c): c is Cidr => c !== null);

  for (const req of requests) {
    const base = {
      row: req.row,
      name: req.name,
      hosts: req.hosts,
      rootId: req.rootId,
      note: req.note,
    };
    const errors: string[] = [];
    if (!req.name.trim()) errors.push('名称不能为空');
    if (!Number.isInteger(req.hosts) || req.hosts < 1) {
      errors.push('主机数必须为不小于 1 的整数');
    }

    const roots =
      req.rootId === 'auto'
        ? allRootCidrs
        : plan.roots
            .filter((r) => r.id === req.rootId)
            .map((r) => parseCidr(r.cidr))
            .filter((c): c is Cidr => c !== null);
    if (req.rootId !== 'auto' && !plan.roots.some((r) => r.id === req.rootId)) {
      errors.push('指定的根网段不存在');
    } else if (roots.length === 0) {
      errors.push('尚未定义任何根网段');
    }

    if (errors.length > 0) {
      lines.push({ ...base, status: 'invalid', prefix: null, cidr: null, capacity: null, reason: errors.join('；') });
      continue;
    }

    let prefix: number;
    try {
      prefix = prefixForHosts(req.hosts);
    } catch (e) {
      lines.push({ ...base, status: 'invalid', prefix: null, cidr: null, capacity: null, reason: (e as Error).message });
      continue;
    }

    const slot = findLowestSlot(roots, occupied, prefix);
    if (!slot) {
      const target =
        req.rootId === 'auto' ? null : plan.roots.find((r) => r.id === req.rootId) ?? null;
      lines.push({
        ...base,
        status: 'nospace',
        prefix,
        cidr: null,
        capacity: usableHosts(prefix),
        reason: target
          ? `地址空间不足：根网段「${target.name}」(${target.cidr}) 中没有可容纳 ${req.hosts} 台主机（/${prefix}）的空闲块`
          : `地址空间不足：所有根网段中都没有可容纳 ${req.hosts} 台主机（/${prefix}）的空闲块`,
      });
      continue;
    }

    occupied.push(slot);
    occupied.sort(compareCidr);
    const rootName = plan.roots.find((r) => {
      const rc = parseCidr(r.cidr);
      return rc !== null && contains(rc, slot);
    })?.name;
    lines.push({
      ...base,
      status: 'ok',
      prefix,
      cidr: cidrToString(slot),
      capacity: usableHosts(prefix),
      rootName,
    });
  }

  return { lines, ok: lines.every((l) => l.status === 'ok') };
}

/**
 * 从通过校验的批量预演结果构造待加入的分配（顺序与输入一致）。
 * 调用方必须先确认 plan.ok。
 */
export function allocationsFromBatchPlan(
  batch: BatchSubnetPlan,
  idFn: () => string = () => newId('alloc'),
): Allocation[] {
  return batch.lines.map((line) => ({
    id: idFn(),
    name: line.name.trim(),
    kind: 'subnet' as const,
    prefix: line.prefix!,
    cidr: line.cidr!,
    note: line.note?.trim() || undefined,
  }));
}

export type MigrationStatus = 'kept' | 'moved' | 'failed';

export interface MigrationItem {
  allocId: string;
  name: string;
  kind: Allocation['kind'];
  prefix: number;
  /** 原落位 */
  from: string;
  /** 新落位；failed 时为 null */
  to: string | null;
  status: MigrationStatus;
  reason?: string;
}

export interface MigrationPlan {
  items: MigrationItem[];
  /** 全部可安置（无 failed）时才允许确认 */
  ok: boolean;
}

/**
 * 迁移预演（纯函数，不产生副作用）：
 *  - 可保留项：容量未变、落位仍对齐且位于新根网段内、且与其他保留项不重叠 → 原位不动；
 *  - 其余项按网段从大到小（前缀升序）、原地址升序，安置到最低可用地址；
 *  - 任一无法安置 → ok = false（调用方禁止确认）。
 *
 * @param nextRoots 调整后的根网段
 * @param nextAllocs 调整后的分配（prefix 为期望容量，cidr 为当前落位）
 */
export function planMigration(
  nextRoots: RootBlock[],
  nextAllocs: Allocation[],
): MigrationPlan {
  const roots = nextRoots
    .map((r) => parseCidr(r.cidr))
    .filter((c): c is Cidr => c !== null)
    .sort((a, b) => a.base - b.base);

  const items: MigrationItem[] = [];
  const keptCidrs: Cidr[] = [];
  const movers: { alloc: Allocation; cidr: Cidr | null }[] = [];

  for (const alloc of nextAllocs) {
    const cur = parseCidr(alloc.cidr);
    const keepable =
      cur !== null &&
      cur.prefix === alloc.prefix &&
      isAlignedCidr(alloc.cidr) &&
      roots.some((r) => contains(r, cur)) &&
      !keptCidrs.some((k) => overlaps(k, cur));
    if (keepable && cur) {
      keptCidrs.push(cur);
      items.push({
        allocId: alloc.id,
        name: alloc.name,
        kind: alloc.kind,
        prefix: alloc.prefix,
        from: alloc.cidr,
        to: alloc.cidr,
        status: 'kept',
      });
    } else {
      movers.push({ alloc, cidr: cur });
    }
  }

  // 网段从大到小（前缀小者优先），同容量按原地址升序，再按名称保证稳定
  movers.sort((a, b) => {
    if (a.alloc.prefix !== b.alloc.prefix) return a.alloc.prefix - b.alloc.prefix;
    const ab = a.cidr ? a.cidr.base : Number.MAX_SAFE_INTEGER;
    const bb = b.cidr ? b.cidr.base : Number.MAX_SAFE_INTEGER;
    if (ab !== bb) return ab - bb;
    return a.alloc.name.localeCompare(b.alloc.name);
  });

  const occupied = [...keptCidrs];
  const movedItems: MigrationItem[] = [];
  for (const { alloc, cidr } of movers) {
    const slot = findLowestSlot(roots, occupied, alloc.prefix);
    if (slot) {
      occupied.push(slot);
      occupied.sort(compareCidr);
      movedItems.push({
        allocId: alloc.id,
        name: alloc.name,
        kind: alloc.kind,
        prefix: alloc.prefix,
        from: alloc.cidr,
        to: cidrToString(slot),
        status: 'moved',
      });
    } else {
      movedItems.push({
        allocId: alloc.id,
        name: alloc.name,
        kind: alloc.kind,
        prefix: alloc.prefix,
        from: alloc.cidr,
        to: null,
        status: 'failed',
        reason: cidr
          ? '地址空间不足：没有可容纳该网段的空闲块'
          : `原落位 ${alloc.cidr} 非法，且地址空间不足`,
      });
    }
  }

  // 输出顺序：保留项按原地址升序，迁移/失败项按安置顺序
  const all = [...items, ...movedItems];
  return { items: all, ok: movedItems.every((i) => i.status !== 'failed') };
}

/** 应用迁移结果，返回更新后的分配数组（整批原子替换由调用方提交）。 */
export function applyMigration(
  allocs: Allocation[],
  plan: MigrationPlan,
): Allocation[] {
  const byId = new Map(plan.items.map((i) => [i.allocId, i]));
  return allocs.map((a) => {
    const item = byId.get(a.id);
    if (!item || item.to === null) return a;
    return { ...a, cidr: item.to };
  });
}

/** 地址空间树节点 */
export interface TreeNode {
  cidr: Cidr;
  key: string;
  depth: number;
  status: 'free' | 'allocated' | 'partial';
  alloc?: Allocation;
  children?: [TreeNode, TreeNode];
}

/** 构建某个根网段的地址空间树：空闲伙伴块天然合并为叶子，含分配的子树继续二分。 */
export function buildTree(
  root: Cidr,
  allocs: { alloc: Allocation; cidr: Cidr }[],
  depth = 0,
): TreeNode {
  const key = cidrToString(root);
  const inside = allocs.filter(({ cidr }) => contains(root, cidr));
  const exact = inside.find(({ cidr }) => cidr.base === root.base && cidr.prefix === root.prefix);
  if (exact) {
    return { cidr: root, key, depth, status: 'allocated', alloc: exact.alloc };
  }
  if (inside.length === 0) {
    return { cidr: root, key, depth, status: 'free' };
  }
  if (root.prefix >= 32) {
    // 理论不可达：/32 若有分配必然 exact
    return { cidr: root, key, depth, status: 'free' };
  }
  const childPrefix = root.prefix + 1;
  const half = blockSize(childPrefix);
  const low = buildTree({ base: root.base, prefix: childPrefix }, inside, depth + 1);
  const high = buildTree({ base: root.base + half, prefix: childPrefix }, inside, depth + 1);
  return { cidr: root, key, depth, status: 'partial', children: [low, high] };
}
