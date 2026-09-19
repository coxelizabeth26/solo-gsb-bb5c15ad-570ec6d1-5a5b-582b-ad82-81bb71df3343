/**
 * 规划差异报告（只读）。
 *
 * 导入由「导出 JSON」生成的基线文件（复用 Plan 完整校验），按分配 id 对比
 * 基线与当前规划：
 *  - 逐项分类：新增、删除、重命名、类型变化、迁移（落位网络地址变化）、
 *    容量变化（前缀变化）；同一项可同时携带多个变化标签；
 *  - 地址差集：分别取两版全部分配的地址并集做区间差集（当前−基线 = 新增占用，
 *    基线−当前 = 释放地址），以伙伴块合并精确压缩为最少 CIDR。
 *
 * 纯本地计算，不修改规划、不产生撤销/重做历史。
 */
import { Allocation, Plan, parsePlanJson } from './model';
import {
  Cidr,
  blockSize,
  cidrToString,
  compareCidr,
  mergeBuddies,
  parseCidr,
  subtractCidr,
} from './ip';

export type ChangeTag = 'renamed' | 'kind-changed' | 'moved' | 'capacity-changed';

export type DiffStatus = 'added' | 'removed' | 'changed';

export interface DiffItem {
  id: string;
  status: DiffStatus;
  /** status 为 changed 时携带的变化标签（可多个）；added/removed 为空 */
  changes: ChangeTag[];
  /** removed/changed 时的基线侧分配 */
  baseline?: Allocation;
  /** added/changed 时的当前侧分配 */
  current?: Allocation;
}

export interface PlanDiffResult {
  /** 有变化的逐项明细（按落位地址升序、同地址按名称排序） */
  items: DiffItem[];
  unchangedCount: number;
  addedCount: number;
  removedCount: number;
  changedCount: number;
  renamedCount: number;
  kindChangedCount: number;
  movedCount: number;
  capacityChangedCount: number;
  /** 新增占用：当前并集 − 基线并集，最少 CIDR 精确覆盖（按地址升序） */
  addedCidrs: Cidr[];
  /** 释放地址：基线并集 − 当前并集，最少 CIDR 精确覆盖（按地址升序） */
  releasedCidrs: Cidr[];
  addedAddressCount: number;
  releasedAddressCount: number;
}

export const CHANGE_LABEL: Record<ChangeTag, string> = {
  renamed: '重命名',
  'kind-changed': '类型变化',
  moved: '迁移',
  'capacity-changed': '容量变化',
};

export const STATUS_LABEL: Record<DiffStatus, string> = {
  added: '新增',
  removed: '删除',
  changed: '变更',
};

export const KIND_LABEL: Record<Allocation['kind'], string> = {
  subnet: '子网',
  reserved: '保留段',
};

/**
 * 解析并完整校验基线文件（与「导入 JSON」共用一个入口）。
 * 校验未通过时把错误信息拆成逐条列表，不生成结果。
 */
export function parseBaseline(
  text: string,
): { plan: Plan; errors?: undefined } | { plan?: undefined; errors: string[] } {
  try {
    return { plan: parsePlanJson(text) };
  } catch (e) {
    const errors = (e as Error).message
      .split('\n')
      .map((line) => line.replace(/^·\s*/, '').trim())
      .filter((line) => line.length > 0);
    return { errors: errors.length > 0 ? errors : ['基线文件校验未通过'] };
  }
}

/** 一侧规划全部分配的地址并集：已校验规划中各块互不相交，伙伴合并后即为规范形。 */
function unionBlocks(cidrs: Cidr[]): Cidr[] {
  return mergeBuddies([...cidrs].sort(compareCidr));
}

/** blocks − removals 的区间差集，伙伴合并压缩为最少 CIDR（按地址升序）。 */
function subtractAll(blocks: Cidr[], removals: Cidr[]): Cidr[] {
  const out: Cidr[] = [];
  for (const b of blocks) {
    let rest: Cidr[] = [b];
    for (const r of removals) {
      const next: Cidr[] = [];
      for (const f of rest) next.push(...subtractCidr(f, r));
      rest = next;
      if (rest.length === 0) break;
    }
    out.push(...rest);
  }
  return mergeBuddies(out.sort(compareCidr));
}

function totalAddresses(cidrs: Cidr[]): number {
  return cidrs.reduce((sum, c) => sum + blockSize(c.prefix), 0);
}

/** 逐项对比 + 地址差集主入口。两侧规划均须已通过完整校验。 */
export function diffPlans(baseline: Plan, current: Plan): PlanDiffResult {
  const baseById = new Map(baseline.allocations.map((a) => [a.id, a]));
  const curById = new Map(current.allocations.map((a) => [a.id, a]));

  const items: DiffItem[] = [];
  let unchangedCount = 0;

  for (const cur of current.allocations) {
    const base = baseById.get(cur.id);
    if (!base) {
      items.push({ id: cur.id, status: 'added', changes: [], current: cur });
      continue;
    }
    const changes: ChangeTag[] = [];
    if (cur.name !== base.name) changes.push('renamed');
    if (cur.kind !== base.kind) changes.push('kind-changed');
    // 两侧均通过完整校验，cidr 必然可解析
    const baseCidr = parseCidr(base.cidr)!;
    const curCidr = parseCidr(cur.cidr)!;
    if (curCidr.base !== baseCidr.base) changes.push('moved');
    if (cur.prefix !== base.prefix) changes.push('capacity-changed');
    if (changes.length === 0) {
      unchangedCount += 1;
    } else {
      items.push({ id: cur.id, status: 'changed', changes, baseline: base, current: cur });
    }
  }
  for (const base of baseline.allocations) {
    if (!curById.has(base.id)) {
      items.push({ id: base.id, status: 'removed', changes: [], baseline: base });
    }
  }

  const addrOf = (it: DiffItem): Cidr => parseCidr((it.current ?? it.baseline)!.cidr)!;
  const nameOf = (it: DiffItem): string => (it.current ?? it.baseline)!.name;
  items.sort(
    (a, b) => compareCidr(addrOf(a), addrOf(b)) || nameOf(a).localeCompare(nameOf(b)),
  );

  const count = (tag: ChangeTag): number =>
    items.filter((it) => it.changes.includes(tag)).length;

  const baseUnion = unionBlocks(baseline.allocations.map((a) => parseCidr(a.cidr)!));
  const curUnion = unionBlocks(current.allocations.map((a) => parseCidr(a.cidr)!));
  const addedCidrs = subtractAll(curUnion, baseUnion);
  const releasedCidrs = subtractAll(baseUnion, curUnion);

  return {
    items,
    unchangedCount,
    addedCount: items.filter((it) => it.status === 'added').length,
    removedCount: items.filter((it) => it.status === 'removed').length,
    changedCount: items.filter((it) => it.status === 'changed').length,
    renamedCount: count('renamed'),
    kindChangedCount: count('kind-changed'),
    movedCount: count('moved'),
    capacityChangedCount: count('capacity-changed'),
    addedCidrs,
    releasedCidrs,
    addedAddressCount: totalAddresses(addedCidrs),
    releasedAddressCount: totalAddresses(releasedCidrs),
  };
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

function allocBrief(a: Allocation): string {
  return `${KIND_LABEL[a.kind]}｜${a.cidr}（容量 /${a.prefix}）`;
}

function itemLine(it: DiffItem, seq: number): string {
  if (it.status === 'added') {
    return `${seq}. [新增] ${it.current!.name}｜${allocBrief(it.current!)}`;
  }
  if (it.status === 'removed') {
    return `${seq}. [删除] ${it.baseline!.name}｜${allocBrief(it.baseline!)}`;
  }
  const tags = it.changes.map((t) => CHANGE_LABEL[t]).join('+');
  const base = it.baseline!;
  const cur = it.current!;
  const namePart = base.name !== cur.name ? `「${base.name}」→「${cur.name}」` : cur.name;
  const kindPart = base.kind !== cur.kind ? `${KIND_LABEL[base.kind]}→${KIND_LABEL[cur.kind]}` : KIND_LABEL[cur.kind];
  const cidrPart = base.cidr !== cur.cidr ? `${base.cidr} → ${cur.cidr}` : cur.cidr;
  const capPart =
    base.prefix !== cur.prefix ? `（容量 /${base.prefix} → /${cur.prefix}）` : `（容量 /${cur.prefix}）`;
  return `${seq}. [${tags}] ${namePart}｜${kindPart}｜${cidrPart}${capPart}`;
}

/** 生成可复制的纯文本差异报告（顺序与结果表格一致）。 */
export function formatDiffReport(result: PlanDiffResult, generatedAt = new Date()): string {
  const lines: string[] = [
    '规划差异报告',
    `生成时间：${formatReportTime(generatedAt)}`,
    `新增 ${result.addedCount} · 删除 ${result.removedCount} · 变更 ${result.changedCount}` +
      `（重命名 ${result.renamedCount} · 类型变化 ${result.kindChangedCount} · 迁移 ${result.movedCount} · 容量变化 ${result.capacityChangedCount}）· 未变化 ${result.unchangedCount}`,
    `新增占用 ${result.addedAddressCount} 个地址（${result.addedCidrs.length} 条 CIDR）· 释放地址 ${result.releasedAddressCount} 个（${result.releasedCidrs.length} 条 CIDR）`,
    '----------------------------------------',
  ];
  if (result.items.length === 0) {
    lines.push('两版规划的分配完全一致。');
  } else {
    result.items.forEach((it, i) => lines.push(itemLine(it, i + 1)));
  }
  lines.push('----------------------------------------', '新增占用（当前有、基线无）：');
  if (result.addedCidrs.length === 0) {
    lines.push('  （无）');
  } else {
    result.addedCidrs.forEach((c, i) =>
      lines.push(`  ${i + 1}. ${cidrToString(c)}（${blockSize(c.prefix)} 个地址）`),
    );
  }
  lines.push('释放地址（基线有、当前无）：');
  if (result.releasedCidrs.length === 0) {
    lines.push('  （无）');
  } else {
    result.releasedCidrs.forEach((c, i) =>
      lines.push(`  ${i + 1}. ${cidrToString(c)}（${blockSize(c.prefix)} 个地址）`),
    );
  }
  return lines.join('\n');
}
