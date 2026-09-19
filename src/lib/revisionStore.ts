/**
 * 本机多标签页协同：基于修订图（revision graph）的持久化与广播同步。
 *
 * - 每次改变 Plan 的操作生成一个 Revision（crypto.randomUUID），
 *   记录 parentRevisionIds / clientId / 完整 Plan；
 * - 修订全集与 head 指针收敛为**单个 localStorage 键**的原子状态文档
 *   （一次 setItem 整体替换，杜绝“修订文档已更新、head 未更新”的中间态）；
 *   首次见到新键时兼容迁移旧版双键（revisions/v1 + head/v1）数据，
 *   迁移成功后尽力删除旧键；
 * - **先落盘后改内存**：任何内存 head 切换、界面历史更新与 BroadcastChannel
 *   广播都只在完整状态原子写入成功之后发生；写入失败时内存与广播保持
 *   提交前状态，由调用方向用户显示明确错误（绝不产生刷新即丢的幽灵版本）；
 * - 同步判定只看修订图的祖先关系，禁止按时间戳覆盖：
 *   - 当前 head 是收到修订的祖先 → 快进；
 *   - 收到修订是当前 head 的祖先 → 忽略；
 *   - 互不为祖先（或祖先链缺失无法证明）→ 分叉冲突，保留两份；
 * - 冲突由用户显式选择后生成同时引用两个父版本的合并修订；合并写入失败时
 *   保持冲突锁定，不得解除锁定或广播失败修订。
 */
import { Plan, emptyPlan, validatePlan } from './model';

export interface Revision {
  id: string;
  parentRevisionIds: string[];
  clientId: string;
  plan: Plan;
}

/** 持久化在单个 localStorage 键中的完整持久化状态（原子替换单位）。 */
interface PersistedState {
  version: 2;
  headId: string;
  revisions: Revision[];
}

/** 修订数组解析结果（新键与旧版双键共用）。 */
interface ParsedRevisions {
  revisions: Revision[];
  badCount: number;
}

/** 新键：修订全集与 head 指针收敛后的单一原子状态文档。 */
export const STATE_STORAGE_KEY = 'ipv4-subnet-planner/state/v2';
/** 旧键（迁移兼容）。 */
export const REVISIONS_STORAGE_KEY = 'ipv4-subnet-planner/revisions/v1';
export const HEAD_STORAGE_KEY = 'ipv4-subnet-planner/head/v1';
export const CHANNEL_NAME = 'ipv4-subnet-planner/revisions/v1';

/** 修订全集上限，超出后从最早的修订开始裁剪（head 与冲突分支最后裁剪）。 */
const MAX_REVISIONS = 400;

/** 所有客户端共享的空规划创世修订 id（内容恒定，无需随机）。 */
export const GENESIS_REVISION_ID = 'genesis:empty-plan:v1';

export type RevisionRelation = 'same' | 'fast-forward' | 'stale' | 'diverged';

type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * 一次修订发布的结果。失败时 RevisionSync 内部状态、head 与广播均保持
 * 提交前原样；调用方不得更新界面历史，并应把 message 作为明确错误展示。
 */
export type CommitResult =
  | { ok: true; revision: Revision }
  | { ok: false; reason: 'conflict-locked' | 'storage-error'; message: string };

/** 沿 parentRevisionIds 判断 maybeAncestor 是否为 descendant 的祖先（含父链缺失即终止）。 */
export function isAncestor(
  maybeAncestorId: string,
  descendantId: string,
  revisions: ReadonlyMap<string, Revision>,
): boolean {
  if (maybeAncestorId === descendantId) return true;
  const seen = new Set<string>();
  const stack = [descendantId];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const rev = revisions.get(id);
    if (!rev) continue; // 父链上的修订已被裁剪：无法继续证明祖先关系
    for (const parent of rev.parentRevisionIds) {
      if (parent === maybeAncestorId) return true;
      if (!seen.has(parent)) stack.push(parent);
    }
  }
  return false;
}

/**
 * 按修订图判定 remote 相对当前 head 的关系。
 * 创世空规划使用全局固定 id，空存储的标签页之间自然收敛到同一节点。
 */
export function relationOf(
  headId: string,
  remoteId: string,
  revisions: ReadonlyMap<string, Revision>,
): RevisionRelation {
  if (headId === remoteId) return 'same';
  if (isAncestor(headId, remoteId, revisions)) return 'fast-forward';
  if (isAncestor(remoteId, headId, revisions)) return 'stale';
  return 'diverged';
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/** 解析单个修订快照：结构校验 + 现有 Plan 校验；任何损坏都返回错误而不是抛出。 */
export function parseRevision(raw: unknown): ParseResult<Revision> {
  if (!isRecord(raw)) return { ok: false, error: '修订不是对象' };
  const { id, parentRevisionIds, clientId, plan } = raw;
  if (typeof id !== 'string' || id.length === 0) {
    return { ok: false, error: '修订缺少字符串 id' };
  }
  if (!Array.isArray(parentRevisionIds) || !parentRevisionIds.every((p) => typeof p === 'string')) {
    return { ok: false, error: `修订 ${id} 的 parentRevisionIds 非法` };
  }
  if (typeof clientId !== 'string' || clientId.length === 0) {
    return { ok: false, error: `修订 ${id} 缺少 clientId` };
  }
  if (!isRecord(plan) || !Array.isArray(plan.roots) || !Array.isArray(plan.allocations)) {
    return { ok: false, error: `修订 ${id} 缺少完整 Plan` };
  }
  const planObj = plan as unknown as Plan;
  if (planObj.version !== 1) {
    return { ok: false, error: `修订 ${id} 的 Plan 版本不受支持` };
  }
  const errors = validatePlan(planObj);
  if (errors.length > 0) {
    return { ok: false, error: `修订 ${id} 的规划校验未通过：${errors.join('；')}` };
  }
  return {
    ok: true,
    value: { id, parentRevisionIds: [...parentRevisionIds], clientId, plan: planObj },
  };
}

function parseRevisionsArray(items: unknown[]): ParsedRevisions {
  const revisions: Revision[] = [];
  const seen = new Set<string>();
  let badCount = 0;
  for (const item of items) {
    const r = parseRevision(item);
    if (!r.ok) {
      badCount += 1;
      continue;
    }
    if (seen.has(r.value.id)) {
      badCount += 1;
      continue;
    }
    seen.add(r.value.id);
    revisions.push(r.value);
  }
  return { revisions, badCount };
}

/** 解析单键原子状态文档（version 2）。 */
function parsePersistedState(raw: string): ParseResult<ParsedRevisions & { headId: unknown }> {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, error: '本地状态文档不是合法 JSON' };
  }
  if (!isRecord(json) || !Array.isArray(json.revisions)) {
    return { ok: false, error: '本地状态文档结构损坏' };
  }
  const parsed = parseRevisionsArray(json.revisions as unknown[]);
  return { ok: true, value: { ...parsed, headId: json.headId } };
}

/** 解析旧版修订全集文档（version 1，双键时代）。 */
function parseLegacyDoc(raw: string): ParseResult<ParsedRevisions> {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, error: '本地修订文档不是合法 JSON' };
  }
  if (!isRecord(json) || !Array.isArray(json.revisions)) {
    return { ok: false, error: '本地修订文档结构损坏' };
  }
  return { ok: true, value: parseRevisionsArray(json.revisions as unknown[]) };
}

export interface SyncHandlers {
  /** 当前 head 是该修订祖先：已自动快进（应用需作为一次可撤销变更处理）。 */
  onFastForward: (revision: Revision) => void;
  /** 修订图分叉：已保留两份，等待用户选择合并方式，期间应禁用编辑。 */
  onConflict: (revision: Revision) => void;
  /** 损坏快照被忽略、本地状态无法写入等需要提示用户的情况。 */
  onWarning: (message: string) => void;
}

export interface SyncDeps {
  storage?: Storage | null;
  channel?: BroadcastChannel | null;
  clientId?: string;
  uuid?: () => string;
}

/**
 * 一个标签页的修订同步会话。open() 恢复 head、接入广播；
 * 所有读写都经过本类，App 只负责在回调里更新界面与本地撤销/重做栈。
 */
export class RevisionSync {
  private revisions = new Map<string, Revision>();
  /** 文档内的原始顺序，用于裁剪时从最早修订开始丢弃。 */
  private order: string[] = [];
  private headId: string;
  private readonly clientId: string;
  private readonly storage: Storage | null;
  private readonly channel: BroadcastChannel | null;
  private readonly uuid: () => string;
  private readonly handlers: SyncHandlers;

  /** 冲突打开期间收到的修订先入库挂起，合并完成后再逐个判定。 */
  private conflictId: string | null = null;
  private pendingIds: string[] = [];
  private destroyed = false;
  private storageListener: ((e: StorageEvent) => void) | null = null;

  private constructor(handlers: SyncHandlers, deps: SyncDeps, warnings: string[]) {
    this.handlers = handlers;
    this.storage = deps.storage ?? null;
    this.channel = deps.channel === undefined ? null : deps.channel;
    this.uuid = deps.uuid ?? (() => globalThis.crypto.randomUUID());
    this.clientId = deps.clientId ?? this.uuid();

    const loaded = this.load();
    warnings.push(...loaded.warnings);

    if (loaded.headId) {
      this.headId = loaded.headId;
      // 旧版双键数据迁移：恢复 head 后立即以单键原子状态重写并清理旧键。
      if (loaded.migratedFromLegacy) {
        const result = this.writeState(true);
        if (!result.ok) warnings.push(result.message);
      }
    } else {
      // 没有任何可用修订：以空规划作为创世修订（无父版本，全客户端共享同一 id）。
      const root: Revision = {
        id: GENESIS_REVISION_ID,
        parentRevisionIds: [],
        clientId: this.clientId,
        plan: emptyPlan(),
      };
      this.revisions.set(root.id, root);
      this.order.push(root.id);
      this.headId = root.id;
      // 创世同样遵循“先落盘后改可见状态”：写入失败时不广播，
      // 本页仍可离线使用，但明确提示刷新后不会保留。
      const result = this.writeState(loaded.migratedFromLegacy);
      if (result.ok) {
        this.post(root);
      } else {
        warnings.push(result.message);
      }
    }
  }

  static open(handlers: SyncHandlers, deps: SyncDeps = {}): RevisionSync {
    const warnings: string[] = [];
    const sync = new RevisionSync(handlers, deps, warnings);
    if (typeof window !== 'undefined' && sync.storage) {
      const listener = (e: StorageEvent) => {
        if (e.key !== STATE_STORAGE_KEY || !e.newValue) return;
        const doc = parsePersistedState(e.newValue);
        if (!doc.ok) {
          handlers.onWarning('收到损坏的修订文档，已忽略');
          return;
        }
        if (doc.value.badCount > 0) {
          handlers.onWarning(`收到的修订中有 ${doc.value.badCount} 个损坏快照，已忽略`);
        }
        for (const rev of doc.value.revisions) sync.ingest(rev);
      };
      window.addEventListener('storage', listener);
      sync.storageListener = listener;
    }
    if (sync.channel) {
      sync.channel.onmessage = (e: MessageEvent) => {
        const data = e.data as
          | { type?: string; revision?: unknown }
          | null;
        if (!data || data.type !== 'revision') return;
        const parsed = parseRevision(data.revision);
        if (!parsed.ok) {
          handlers.onWarning(`收到损坏的修订快照，已忽略（${parsed.error}）`);
          return;
        }
        if (parsed.value.clientId === sync.clientId) return;
        sync.ingest(parsed.value);
      };
    }
    // 恢复阶段发现的损坏快照统一提示。
    for (const w of warnings) handlers.onWarning(w);
    return sync;
  }

  get head(): Revision {
    return this.revisions.get(this.headId)!;
  }

  get inConflict(): boolean {
    return this.conflictId !== null;
  }

  getRevision(id: string): Revision | undefined {
    return this.revisions.get(id);
  }

  /**
   * 发布一个普通修订（撤销、重做、导入、清空、普通编辑都走这里）。
   * 完整状态原子写入成功后才切换 head 并交由调用方更新界面历史与广播；
   * 冲突锁定或写入失败时返回错误，内存状态保持提交前原样（无幽灵版本）。
   */
  commit(plan: Plan): CommitResult {
    // 冲突期间禁止规划编辑：调用方应已锁定入口，这里做最后一道防线。
    if (this.conflictId !== null) {
      return {
        ok: false,
        reason: 'conflict-locked',
        message: '与其他标签页存在分叉冲突，冲突解决前不能提交规划修订',
      };
    }
    const rev: Revision = {
      id: this.uuid(),
      parentRevisionIds: [this.headId],
      clientId: this.clientId,
      plan,
    };
    return this.transact(() => {
      this.revisions.set(rev.id, rev);
      this.order.push(rev.id);
      this.headId = rev.id;
    }, () => this.post(rev));
  }

  /**
   * 解决冲突：生成同时引用当前 head 与外部修订的合并修订。
   * 只有状态完整写入成功后才解除冲突锁定、切换 head 并广播；
   * 写入失败时保持冲突锁定（返回 storage-error），绝不广播失败修订。
   * 成功后调用方应调用 resume() 以重新判定冲突期间挂起的其他修订。
   */
  mergeAndHead(plan: Plan, remoteRevisionId: string): CommitResult {
    const parents = [...new Set([this.headId, remoteRevisionId])];
    const rev: Revision = {
      id: this.uuid(),
      parentRevisionIds: parents,
      clientId: this.clientId,
      plan,
    };
    return this.transact(() => {
      this.revisions.set(rev.id, rev);
      this.order.push(rev.id);
      this.headId = rev.id;
      this.conflictId = null;
    }, () => this.post(rev));
  }

  /** 合并完成后重新判定冲突期间挂起的修订（可能再次快进或再次冲突）。 */
  resume(): void {
    const pending = this.pendingIds;
    this.pendingIds = [];
    for (const id of pending) {
      const rev = this.revisions.get(id);
      if (rev) this.classify(rev);
    }
  }

  destroy(): void {
    this.destroyed = true;
    if (this.storageListener && typeof window !== 'undefined') {
      window.removeEventListener('storage', this.storageListener);
    }
    this.channel?.close();
  }

  // ---- 内部 ----

  /**
   * 接收一个外部修订：先把完整状态原子落盘，成功后才更新内存并按修订图判定。
   * 写入失败（配额耗尽/权限受限）时保留全部既有状态，仅提示，不触发
   * 快进/冲突回调，也不会产生任何未持久化的幽灵修订。
   */
  private ingest(rev: Revision): void {
    if (this.destroyed) return;
    if (this.revisions.has(rev.id)) {
      // 重复投递（storage 事件与频道消息可能各来一次）：无需再判定。
      return;
    }
    if (this.conflictId !== null) {
      const conflictId = this.conflictId;
      // 在候选图（含新修订）上预判：对方是否已提交同时覆盖本页 head 与冲突
      // 版本的合并修订。判定本身是纯计算，不触碰内存。
      const candidateRevisions = new Map(this.revisions);
      candidateRevisions.set(rev.id, rev);
      const relHead = relationOf(this.headId, rev.id, candidateRevisions);
      const resolvesConflict =
        relHead === 'fast-forward' && isAncestor(conflictId, rev.id, candidateRevisions);

      if (resolvesConflict) {
        const pending = [...this.pendingIds];
        const result = this.transact(() => {
          this.revisions.set(rev.id, rev);
          this.order.push(rev.id);
          this.headId = rev.id;
          this.conflictId = null;
          this.pendingIds = [];
        }, () => this.handlers.onFastForward(rev));
        if (!result.ok) {
          this.handlers.onWarning(result.message);
          return;
        }
        // 落盘成功：逐条重新判定挂起队列（可能再次快进或再次冲突）。
        for (const id of pending) {
          if (id === rev.id) continue;
          const queued = this.revisions.get(id);
          if (queued) this.classify(queued);
        }
        return;
      }

      // 普通挂起修订：只需持久化“图中多一个节点”，head/冲突状态不变。
      // 失败时由 transact 快照整体回滚（节点、pending 队列均不保留）。
      const result = this.transact(() => {
        this.revisions.set(rev.id, rev);
        this.order.push(rev.id);
        if (!this.pendingIds.includes(rev.id)) this.pendingIds.push(rev.id);
      });
      if (!result.ok) {
        this.handlers.onWarning(result.message);
      }
      return;
    }

    const result = this.transact(() => {
      this.revisions.set(rev.id, rev);
      this.order.push(rev.id);
    });
    if (!result.ok) {
      this.handlers.onWarning(result.message);
      return;
    }
    this.classify(rev);
  }

  private classify(rev: Revision): void {
    const relation = relationOf(this.headId, rev.id, this.revisions);
    if (relation === 'same' || relation === 'stale') return;
    if (relation === 'fast-forward') {
      // 快进同样必须先落盘：head 切换与 onFastForward（界面历史更新）
      // 只在完整状态写入成功后发生；失败则快照回滚保持旧 head 并提示。
      const result = this.transact(() => {
        this.headId = rev.id;
      }, () => this.handlers.onFastForward(rev));
      if (!result.ok) this.handlers.onWarning(result.message);
      return;
    }
    // 分叉（含祖先链缺失无法证明先后的情况）：保留两份，等待人工合并。
    // 冲突标记只是已持久化节点的派生状态，仍与一次成功落盘绑定。
    const result = this.transact(() => {
      this.conflictId = rev.id;
      if (!this.pendingIds.includes(rev.id)) this.pendingIds.push(rev.id);
    }, () => this.handlers.onConflict(rev));
    if (!result.ok) this.handlers.onWarning(result.message);
  }

  private post(rev: Revision): void {
    if (!this.channel) return;
    try {
      this.channel.postMessage({ type: 'revision', revision: rev });
    } catch {
      this.handlers.onWarning('修订广播失败，其他标签页可能无法即时同步');
    }
  }

  private load(): {
    headId: string | null;
    warnings: string[];
    migratedFromLegacy: boolean;
  } {
    const warnings: string[] = [];
    if (!this.storage) return { headId: null, warnings, migratedFromLegacy: false };

    const raw = this.storage.getItem(STATE_STORAGE_KEY);
    if (raw !== null) {
      const doc = parsePersistedState(raw);
      if (!doc.ok) {
        warnings.push(`本地修订快照已损坏（${doc.error}），已忽略并从空规划开始`);
        return { headId: null, warnings, migratedFromLegacy: false };
      }
      for (const rev of doc.value.revisions) {
        this.revisions.set(rev.id, rev);
        this.order.push(rev.id);
      }
      if (doc.value.badCount > 0) {
        warnings.push(`检测到 ${doc.value.badCount} 个损坏的修订快照，已忽略`);
      }
      if (typeof doc.value.headId === 'string' && this.revisions.has(doc.value.headId)) {
        return { headId: doc.value.headId, warnings, migratedFromLegacy: false };
      }

      // head 缺失或指向损坏修订：从可用修订中恢复一个叶子（无其他可用后裔）。
      const recovered = this.recoverHead();
      if (recovered) {
        warnings.push('本地 head 指针损坏，已自动恢复到最近的完整修订');
        return { headId: recovered, warnings, migratedFromLegacy: false };
      }
      warnings.push('本地修订快照均已损坏，已忽略并从空规划开始');
      this.revisions.clear();
      this.order = [];
      return { headId: null, warnings, migratedFromLegacy: false };
    }

    // 新键不存在：尝试兼容迁移旧版双键数据（revisions/v1 + head/v1）。
    const legacyRaw = this.storage.getItem(REVISIONS_STORAGE_KEY);
    if (legacyRaw === null) {
      return { headId: null, warnings, migratedFromLegacy: false };
    }
    const legacy = parseLegacyDoc(legacyRaw);
    if (!legacy.ok) {
      warnings.push(`本地修订快照已损坏（${legacy.error}），已忽略并从空规划开始`);
      return { headId: null, warnings, migratedFromLegacy: false };
    }
    for (const rev of legacy.value.revisions) {
      this.revisions.set(rev.id, rev);
      this.order.push(rev.id);
    }
    if (legacy.value.badCount > 0) {
      warnings.push(`检测到 ${legacy.value.badCount} 个损坏的旧版修订快照，迁移时已忽略`);
    }

    const legacyHead = this.storage.getItem(HEAD_STORAGE_KEY);
    let headId: string | null = null;
    if (legacyHead !== null && this.revisions.has(legacyHead)) {
      headId = legacyHead;
    } else if (legacyHead !== null) {
      const recovered = this.recoverHead();
      if (recovered) {
        headId = recovered;
        warnings.push('旧版 head 指针损坏，已自动恢复到最近的完整修订并迁移到单键状态');
      }
    }
    if (!headId) {
      if (this.revisions.size > 0) {
        const recovered = this.recoverHead();
        if (recovered) {
          headId = recovered;
          warnings.push('旧版 head 指针缺失，已自动恢复到最近的完整修订并迁移到单键状态');
        }
      }
      if (!headId) {
        warnings.push('本地修订快照均已损坏，已忽略并从空规划开始');
        this.revisions.clear();
        this.order = [];
        return { headId: null, warnings, migratedFromLegacy: false };
      }
    }
    warnings.push('已将旧版双键本地数据迁移为单键原子状态');
    return { headId, warnings, migratedFromLegacy: true };
  }

  /** 选择一个没有可用后裔的修订；多个叶子时取祖先链最长者，再按 id 确定性决胜。 */
  private recoverHead(): string | null {
    const leaves: string[] = [];
    for (const id of this.revisions.keys()) {
      let hasDescendant = false;
      for (const other of this.revisions.values()) {
        if (other.id !== id && isAncestor(id, other.id, this.revisions)) {
          hasDescendant = true;
          break;
        }
      }
      if (!hasDescendant) leaves.push(id);
    }
    if (leaves.length === 0) return null;
    const depth = (id: string): number => {
      const memo = new Map<string, number>();
      const walk = (cur: string, trail: Set<string>): number => {
        const cached = memo.get(cur);
        if (cached !== undefined) return cached;
        const rev = this.revisions.get(cur);
        if (!rev || rev.parentRevisionIds.length === 0 || trail.has(cur)) return 0;
        trail.add(cur);
        const d = 1 + Math.max(...rev.parentRevisionIds.map((p) => walk(p, trail)));
        trail.delete(cur);
        memo.set(cur, d);
        return d;
      };
      return walk(id, new Set());
    };
    return leaves.sort((a, b) => depth(b) - depth(a) || (a < b ? -1 : a > b ? 1 : 0))[0];
  }

  /**
   * 在一次“事务”内修改内存状态：先快照，执行 mutate，再把完整状态原子写入
   * 唯一存储键；写入失败则整体回滚快照，afterCommit 不执行。
   * 广播与界面回调一律放在 afterCommit 中，保证失败修订不外泄。
   */
  private transact(mutate: () => void, afterCommit?: () => void): CommitResult {
    const snapshot = {
      revisions: new Map(this.revisions),
      order: [...this.order],
      headId: this.headId,
      conflictId: this.conflictId,
      pendingIds: [...this.pendingIds],
    };
    mutate();
    const result = this.writeState(false);
    if (!result.ok) {
      this.revisions = snapshot.revisions;
      this.order = snapshot.order;
      this.headId = snapshot.headId;
      this.conflictId = snapshot.conflictId;
      this.pendingIds = snapshot.pendingIds;
      return result;
    }
    afterCommit?.();
    return { ok: true, revision: this.head };
  }

  /**
   * 把当前完整状态（修订全集 + head 指针）序列化为单个文档，一次 setItem
   * 原子替换。无存储后端时视为成功（纯频道/内存模式）。
   * migrateLegacy=true 时（旧双键数据首次迁移）在新键写入成功后尽力删除旧键。
   */
  private writeState(migrateLegacy: boolean):
    | { ok: true }
    | { ok: false; reason: 'storage-error'; message: string } {
    if (!this.storage) return { ok: true };
    this.prune();
    const state: PersistedState = {
      version: 2,
      headId: this.headId,
      revisions: this.order.map((id) => this.revisions.get(id)!),
    };
    try {
      this.storage.setItem(STATE_STORAGE_KEY, JSON.stringify(state));
    } catch (e) {
      return {
        ok: false,
        reason: 'storage-error',
        message: `修订无法写入本地存储（${(e as Error)?.message || e}）：本次修改未保存，刷新后仍为修改前规划；请清理浏览器存储或更换标签页后重试`,
      };
    }
    if (migrateLegacy) {
      // 新键已完整落盘后才删除旧键；删除失败不影响新状态的正确性。
      try {
        this.storage.removeItem(REVISIONS_STORAGE_KEY);
        this.storage.removeItem(HEAD_STORAGE_KEY);
      } catch {
        // 旧键残留仅占空间，下次打开因新键优先而不会被读取；忽略。
      }
    }
    return { ok: true };
  }

  /** 超出上限时按文档顺序从最早修订开始裁剪；head 与冲突分支最后被丢弃。 */
  private prune(): void {
    while (this.order.length > MAX_REVISIONS) {
      const protectedId = this.conflictId;
      const idx = this.order.findIndex((id) => id !== this.headId && id !== protectedId);
      if (idx < 0) break;
      const [removed] = this.order.splice(idx, 1);
      this.revisions.delete(removed);
    }
  }
}
