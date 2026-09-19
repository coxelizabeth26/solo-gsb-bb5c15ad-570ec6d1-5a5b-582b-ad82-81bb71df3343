/**
 * 路由汇总：以 CIDR 树对勾选的子网做全局最优汇总。
 *
 * 硬约束：
 *  - 方案必须覆盖全部已选子网；
 *  - 任何汇总 CIDR 必须完整位于某一个根网段内（不得跨根网段）；
 *  - 任何汇总 CIDR 不得覆盖未勾选的分配（含其他子网与命名保留段）。
 *
 * 优化目标（在路由条数上限内）：
 *  1. 额外覆盖的空闲地址总数最少；
 *  2. 代价相同时使用更少的汇总条目；
 *  3. 仍相同时按汇总 CIDR 网络地址升序（同地址时更具体前缀在前）确定唯一方案。
 *
 * 无法在条数上限内完成时，给出每个根网段（及全局）最少所需条目数。
 * 纯本地只读计算，不修改规划、不产生修订历史。
 */
import { Allocation, Plan, RootBlock } from './model';
import {
  Cidr,
  blockSize,
  cidrToString,
  compareCidr,
  contains,
  overlaps,
  parseCidr,
} from './ip';

export interface SummaryTarget {
  alloc: Allocation;
  cidr: Cidr;
}

export interface SummaryEntry {
  cidr: Cidr;
  root: RootBlock;
  /** 该条目覆盖的已选子网（按网络地址升序） */
  covered: SummaryTarget[];
  /** 除已选子网地址外额外覆盖的空闲地址数（不含任何未选分配） */
  extraFreeAddresses: number;
}

export interface SummaryGroup {
  root: RootBlock;
  rootCidr: Cidr;
  /** 该根网段内被勾选的子网（按网络地址升序） */
  selected: SummaryTarget[];
  /** 不考虑条数上限时该根网段最少需要的汇总条目数 */
  minimumEntries: number;
  /** 最终方案落在该根网段的条目（不可行时为空） */
  entries: SummaryEntry[];
}

export interface SummaryResult {
  groups: SummaryGroup[];
  selectedCount: number;
  maxEntries: number;
  /** 忽略上限时全局最少需要的条目数（各根网段之和） */
  minimumEntries: number;
  feasible: boolean;
  /** feasible 时的最终条目（按网络地址升序，互不相交） */
  entries: SummaryEntry[];
  /** 最终条目数 / 额外空闲地址合计（不可行时为 0） */
  totalEntries: number;
  totalExtraFree: number;
}

interface Candidate {
  cidr: Cidr;
  /** 覆盖的已选子网在组内下标区间 [i, j]（地址连续，必含生成点 i） */
  j: number;
  /** 额外覆盖的空闲地址数 = 块容量 − 覆盖到的已选子网容量合计 */
  waste: number;
}

interface StateValue {
  waste: number;
  cidrs: Cidr[];
}

/** 方案决胜：先比网络地址序列字典序，再比前缀序列（同基更具体在前）。 */
function compareState(a: StateValue, b: StateValue): number {
  const len = Math.min(a.cidrs.length, b.cidrs.length);
  for (let k = 0; k < len; k++) {
    if (a.cidrs[k].base !== b.cidrs[k].base) {
      return a.cidrs[k].base < b.cidrs[k].base ? -1 : 1;
    }
  }
  for (let k = 0; k < len; k++) {
    if (a.cidrs[k].prefix !== b.cidrs[k].prefix) {
      return a.cidrs[k].prefix > b.cidrs[k].prefix ? -1 : 1; // 更具体（前缀更大）在前
    }
  }
  return a.cidrs.length - b.cidrs.length;
}

function betterState(a: StateValue, b: StateValue): StateValue {
  if (a.waste !== b.waste) return a.waste < b.waste ? a : b;
  return compareState(a, b) <= 0 ? a : b;
}

/** 取当前规划中全部子网分配（命名保留段不可勾选），并附上所属根网段。 */
export function selectableSubnets(
  plan: Plan,
): { target: SummaryTarget; root: RootBlock }[] {
  const out: { target: SummaryTarget; root: RootBlock }[] = [];
  for (const alloc of plan.allocations) {
    if (alloc.kind !== 'subnet') continue;
    const cidr = parseCidr(alloc.cidr);
    if (!cidr) continue;
    const root = plan.roots.find((r) => {
      const rc = parseCidr(r.cidr);
      return rc !== null && contains(rc, cidr);
    });
    if (!root) continue;
    out.push({ target: { alloc, cidr }, root });
  }
  return out.sort(
    (a, b) =>
      compareCidr(a.target.cidr, b.target.cidr) ||
      a.target.alloc.name.localeCompare(b.target.alloc.name),
  );
}

/**
 * 枚举出从第 i 个已选子网出发、可作为有序方案该位置条目的全部合法汇总 CIDR：
 * 沿 CIDR 树逐级放大（前缀递减），要求完整位于根网段内、不覆盖任何未选分配，
 * 且不得回卷覆盖 i 之前的已选子网（保证方案条目互不相交、可做区间 DP）。
 */
function candidatesFrom(
  i: number,
  selected: SummaryTarget[],
  rootCidr: Cidr,
  blockers: Cidr[],
): Candidate[] {
  const first = selected[i].cidr;
  const out: Candidate[] = [];
  for (let prefix = first.prefix; prefix >= rootCidr.prefix; prefix--) {
    const size = blockSize(prefix);
    const base = first.base - (first.base % size);
    const cand: Cidr = { base, prefix };
    // 不得跨根网段
    if (!contains(rootCidr, cand)) continue;
    // 不得覆盖任何未选分配（对齐块相交即包含关系）
    if (blockers.some((b) => overlaps(b, cand))) continue;
    // 回卷到更早的已选子网：该候选只能从更早位置发起，此处不可用。
    // 对齐块连续且已选子网按地址升序，只需检查前一个。
    if (i > 0 && contains(cand, selected[i - 1].cidr)) continue;
    // 窗口内的已选子网（对齐 CIDR 包含即覆盖）。已选子网按地址升序：
    // 一旦越过块末尾即可停止；i 之前的子网由上面的回卷检查保证不被包含。
    let j = i;
    let coveredSize = 0;
    const candEnd = cand.base + size;
    for (let t = i; t < selected.length; t++) {
      const tc = selected[t].cidr;
      if (tc.base >= candEnd) break;
      if (contains(cand, tc)) {
        j = t;
        coveredSize += blockSize(tc.prefix);
      }
    }
    out.push({ cidr: cand, j, waste: size - coveredSize });
  }
  return out;
}

interface SolvedGroup {
  root: RootBlock;
  rootCidr: Cidr;
  selected: SummaryTarget[];
  minimumEntries: number;
  /** 条目数 → 最优方案（各条目按地址升序）；仅保留 ≤ cap 的条目数 */
  byCount: Map<number, StateValue>;
}

/**
 * 对单个根网段求解：
 *  - 最少条目数：经典区间覆盖贪心——每步选择覆盖第 i 个已选子网且向右延伸最远的合法 CIDR；
 *  - 各条目数下的最优（空闲代价最少、地址序列决胜）：自后向前区间 DP，
 *    dp[i] 为「覆盖第 i..n-1 个已选子网」时 条目数 → 最优 StateValue。
 */
function solveGroup(
  root: RootBlock,
  rootCidr: Cidr,
  selected: SummaryTarget[],
  blockers: Cidr[],
  cap: number,
): SolvedGroup {
  const n = selected.length;
  const allCandidates: Candidate[][] = selected.map((_, i) =>
    candidatesFrom(i, selected, rootCidr, blockers),
  );

  // 最少条目数（忽略空闲代价）
  let minimumEntries = 0;
  let cursor = 0;
  while (cursor < n) {
    let farthest = cursor;
    for (const cand of allCandidates[cursor]) {
      if (cand.j > farthest) farthest = cand.j;
    }
    minimumEntries += 1;
    cursor = farthest + 1;
  }

  // 区间 DP
  const dp: Map<number, StateValue>[] = new Array(n + 1);
  dp[n] = new Map([[0, { waste: 0, cidrs: [] }]]);
  for (let i = n - 1; i >= 0; i--) {
    const cur = new Map<number, StateValue>();
    for (const cand of allCandidates[i]) {
      const rest = dp[cand.j + 1];
      for (const [restCount, restVal] of rest) {
        const count = 1 + restCount;
        if (count > cap) continue; // 超过全局上限的条目数永不会被采用
        const value: StateValue = {
          waste: cand.waste + restVal.waste,
          cidrs: [cand.cidr, ...restVal.cidrs],
        };
        const prev = cur.get(count);
        cur.set(count, prev ? betterState(prev, value) : value);
      }
    }
    dp[i] = cur;
  }

  return { root, rootCidr, selected, minimumEntries, byCount: dp[0] };
}

/** 校验条数上限输入：1-256 的整数（超出无意义：最多 2^32 条 /32，UI 取保守上限）。 */
export function validateMaxEntries(input: string): number | string {
  const text = input.trim();
  if (!/^\d+$/.test(text)) return '最多路由条数必须为不小于 1 的整数';
  const value = Number(text);
  if (value < 1) return '最多路由条数必须为不小于 1 的整数';
  if (value > 256) return '最多路由条数不能超过 256';
  return value;
}

/**
 * 路由汇总主入口（纯只读）。
 * @param plan       当前规划
 * @param selectedId 勾选的子网分配 id（须均为 kind=subnet）
 * @param maxEntries 最多路由条数（正整数）
 */
export function planRouteSummary(
  plan: Plan,
  selectedId: readonly string[],
  maxEntries: number,
): SummaryResult {
  const wanted = new Set(selectedId);
  const pick = selectableSubnets(plan).filter(({ target }) =>
    wanted.has(target.alloc.id),
  );

  // 根网段按地址升序，组内子网已按地址升序
  const rootOrder = plan.roots
    .map((r) => ({ root: r, cidr: parseCidr(r.cidr) }))
    .filter((x): x is { root: RootBlock; cidr: Cidr } => x.cidr !== null)
    .sort((a, b) => a.cidr.base - b.cidr.base);

  const solved: SolvedGroup[] = [];
  for (const { root, cidr: rootCidr } of rootOrder) {
    const selected = pick
      .filter((x) => x.root.id === root.id)
      .map((x) => x.target);
    if (selected.length === 0) continue;
    const selectedSet = new Set(selected.map((t) => t.alloc.id));
    // 未选分配（子网与命名保留段同等对待）均为禁止覆盖对象
    const blockers = plan.allocations
      .map((a) => ({ alloc: a, cidr: parseCidr(a.cidr) }))
      .filter(
        (x): x is { alloc: Allocation; cidr: Cidr } =>
          x.cidr !== null &&
          contains(rootCidr, x.cidr) &&
          !selectedSet.has(x.alloc.id),
      )
      .map((x) => x.cidr);
    solved.push(solveGroup(root, rootCidr, selected, blockers, maxEntries));
  }

  const minimumEntries = solved.reduce((sum, g) => sum + g.minimumEntries, 0);
  const selectedCount = pick.length;

  const bareGroups = (entriesOf?: (gi: number) => SummaryEntry[]): SummaryGroup[] =>
    solved.map((g, gi) => ({
      root: g.root,
      rootCidr: g.rootCidr,
      selected: g.selected,
      minimumEntries: g.minimumEntries,
      entries: entriesOf ? entriesOf(gi) : [],
    }));

  if (minimumEntries > maxEntries) {
    return {
      groups: bareGroups(),
      selectedCount,
      maxEntries,
      minimumEntries,
      feasible: false,
      entries: [],
      totalEntries: 0,
      totalExtraFree: 0,
    };
  }

  // 跨根网段分配条数预算：逐组卷积 总条目数 → 最优（空闲代价、全局地址序列）
  interface GlobalValue {
    waste: number;
    /** 每组选中的条目 CIDR 列表（组顺序即根网段地址升序） */
    perGroup: Cidr[][];
  }
  const globalKey = (gv: GlobalValue): number[] =>
    gv.perGroup.flatMap((list) => list.map((c) => c.base));
  let globalMap = new Map<number, GlobalValue>([
    [0, { waste: 0, perGroup: [] }],
  ]);
  for (const g of solved) {
    const next = new Map<number, GlobalValue>();
    for (const [used, gv] of globalMap) {
      for (const [cnt, val] of g.byCount) {
        const total = used + cnt;
        if (total > maxEntries) continue;
        const candidate: GlobalValue = {
          waste: gv.waste + val.waste,
          perGroup: [...gv.perGroup, val.cidrs],
        };
        const prev = next.get(total);
        if (!prev || candidate.waste < prev.waste) {
          next.set(total, candidate);
        } else if (candidate.waste === prev.waste && lexCompare(globalKey(candidate), globalKey(prev)) < 0) {
          next.set(total, candidate);
        }
      }
    }
    globalMap = next;
  }

  // 上限内优先级：空闲代价最少 → 条目更少 → 全局网络地址序列
  let bestTotal = 0;
  let bestValue: GlobalValue | null = null;
  for (const [total, gv] of globalMap) {
    if (bestValue === null) {
      bestTotal = total;
      bestValue = gv;
      continue;
    }
    if (gv.waste < bestValue.waste) {
      bestTotal = total;
      bestValue = gv;
    } else if (gv.waste === bestValue.waste) {
      if (total < bestTotal) {
        bestTotal = total;
        bestValue = gv;
      } else if (total === bestTotal && lexCompare(globalKey(gv), globalKey(bestValue)) < 0) {
        bestValue = gv;
      }
    }
  }

  const groups = bareGroups((gi) => {
    const cidrs = bestValue ? bestValue.perGroup[gi] : [];
    const g = solved[gi];
    return cidrs.map((cidr): SummaryEntry => {
      const covered = g.selected.filter((t) => contains(cidr, t.cidr));
      const used = covered.reduce((sum, t) => sum + blockSize(t.cidr.prefix), 0);
      return {
        cidr,
        root: g.root,
        covered,
        extraFreeAddresses: blockSize(cidr.prefix) - used,
      };
    });
  });

  const entries = groups.flatMap((g) => g.entries);
  return {
    groups,
    selectedCount,
    maxEntries,
    minimumEntries,
    feasible: true,
    entries,
    totalEntries: entries.length,
    totalExtraFree: entries.reduce((sum, e) => sum + e.extraFreeAddresses, 0),
  };
}

function lexCompare(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function formatTime(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(
    d.getHours(),
  )}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/** 生成可复制的纯文本汇总报告（顺序与结果表格一致）。 */
export function formatSummaryReport(result: SummaryResult, generatedAt = new Date()): string {
  const lines: string[] = [
    '路由汇总报告',
    `生成时间：${formatTime(generatedAt)}`,
    `已选子网：${result.selectedCount} 个 · 路由条数上限：${result.maxEntries} 条`,
  ];
  if (!result.feasible) {
    lines.push(
      `结论：无法在 ${result.maxEntries} 条内完成汇总，最少需要 ${result.minimumEntries} 条`,
      '----------------------------------------',
    );
    for (const g of result.groups) {
      lines.push(
        `根网段「${g.root.name}」${g.root.cidr}：已选 ${g.selected.length} 个，最少 ${g.minimumEntries} 条`,
      );
    }
    return lines.join('\n');
  }
  lines.push(
    `结论：方案 ${result.totalEntries} 条 · 覆盖已选子网 ${result.selectedCount} 个 · 额外覆盖空闲地址 ${result.totalExtraFree} 个`,
    '----------------------------------------',
  );
  let seq = 1;
  for (const g of result.groups) {
    lines.push(`[根网段] ${g.root.name}  ${g.root.cidr}（本根网段最少 ${g.minimumEntries} 条）`);
    for (const e of g.entries) {
      const names = e.covered
        .map((t) => `${t.alloc.name}(${cidrToString(t.cidr)})`)
        .join('、');
      lines.push(
        `${seq}. ${cidrToString(e.cidr)}  覆盖子网 ${e.covered.length} 个：${names}；额外覆盖空闲地址 ${e.extraFreeAddresses} 个`,
      );
      seq += 1;
    }
  }
  return lines.join('\n');
}
