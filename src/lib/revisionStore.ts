/**
 * 本机多标签页协同：基于修订图（revision graph）的持久化与广播同步。
 *
 * - 每次改变 Plan 的操作生成一个 Revision（crypto.randomUUID），
 *   记录 parentRevisionIds / clientId / 完整 Plan；
 * - 修订全集与 head 指针收敛为单个持久化状态（state/v2），一次 setItem 原子替换，
 *   杜绝双键各写一半留下的半提交状态；启动时兼容读取并迁移旧版双键数据；
 * - 只有完整状态写入成功后才切换内存 head、更新界面历史并广播；
 *   写入失败（容量耗尽、权限限制等）时保留提交前状态、不产生幽灵修订、
 *   其他标签页也不会收到失败修订；
 * - 同步判定只看修订图的祖先关系，禁止按时间戳覆盖：
 *   - 当前 head 是收到修订的祖先 → 快进；
 *   - 收到修订是当前 head 的祖先 → 忽略；
 *   - 互不为祖先（或祖先链缺失无法证明）→ 分叉冲突，保留两份；
 * - 冲突由用户显式选择后生成同时引用两个父版本的合并修订。
 */
import { Plan, emptyPlan, validatePlan } from './model';

export interface Revision {
  id: string;
  parentRevisionIds: string[];
  clientId: string;
  plan: Plan;
}

/** 持久化在 localStorage 中的完整状态：修订全集 + head 指针，单键原子替换。 */
interface StateDoc {
  version: 2;
  headId: string;
  revisions: Revision[];
}

/** 旧版双键格式（v1）：仅用于读取迁移与兼容接收旧标签页的 storage 事件。 */
interface RevisionDoc {
  version: 1;
  revisions: Revision[];
}

interface ParsedState {
  doc: StateDoc;
  badCount: number;
}

interface ParsedDoc {
  doc: RevisionDoc;
  badCount: number;
}

/** 单键原子持久化状态：修订全集与 head 指针随一次 setItem 整体替换。 */
export const STATE_STORAGE_KEY = 'ipv4-subnet-planner/state/v2';
/** 旧版双键（v1）：不再写入，仅用于启动迁移与接收旧版标签页的 storage 事件。 */
export const REVISIONS_STORAGE_KEY = 'ipv4-subnet-planner/revisions/v1';
export const HEAD_STORAGE_KEY = 'ipv4-subnet-planner/head/v1';
export const CHANNEL_NAME = 'ipv4-subnet-planner/revisions/v1';

/** 修订全集上限，超出后从最早的修订开始裁剪（head 与冲突分支最后裁剪）。 */
const MAX_REVISIONS = 400;

/** 所有客户端共享的空规划创世修订 id（内容恒定，无需随机）。 */
export const GENESIS_REVISION_ID = 'genesis:empty-plan:v1';

export type RevisionRelation = 'same' | 'fast-forward' | 'stale' | 'diverged';

/**
 * 提交结果：只有完整状态成功写入本地存储才为 ok；
 * 失败时内存 head、修订图与广播均未发生任何变化，调用方必须保持提交前规划并提示用户。
 */
export type CommitResult = { ok: true; revision: Revision } | { ok: false; error: string };

type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

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

/** 解析修订列表：跳过损坏与重复条目并计数。 */
function parseRevisionList(items: unknown[]): { revisions: Revision[]; badCount: number } {
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

/** 解析新版单键持久化状态（修订全集 + head 指针）。 */
function parseStateDoc(raw: string): ParseResult<ParsedState> {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, error: '本地持久化状态不是合法 JSON' };
  }
  if (!isRecord(json) || !Array.isArray(json.revisions) || typeof json.headId !== 'string') {
    return { ok: false, error: '本地持久化状态结构损坏' };
  }
  const { revisions, badCount } = parseRevisionList(json.revisions as unknown[]);
  return {
    ok: true,
    value: { doc: { version: 2, headId: json.headId, revisions }, badCount },
  };
}

/** 解析旧版双键中的修订文档（仅迁移与兼容接收路径使用）。 */
function parseRevisionDoc(raw: string): ParseResult<ParsedDoc> {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, error: '本地修订文档不是合法 JSON' };
  }
  if (!isRecord(json) || !Array.isArray(json.revisions)) {
    return { ok: false, error: '本地修订文档结构损坏' };
  }
  const { revisions, badCount } = parseRevisionList(json.revisions as unknown[]);
  return { ok: true, value: { doc: { version: 1, revisions }, badCount } };
}

/** 超出上限时按文档顺序从最早修订开始裁剪；keep 中的 id（head、冲突分支）最后被丢弃。 */
function pruneOrder(
  order: string[],
  revisions: Map<string, Revision>,
  keep: ReadonlySet<string>,
): void {
  while (order.length > MAX_REVISIONS) {
    const idx = order.findIndex((id) => !keep.has(id));
    if (idx < 0) break;
    const [removed] = order.splice(idx, 1);
    revisions.delete(removed);
  }
}

export interface SyncHandlers {
  /** 当前 head 是该修订祖先：已自动快进（应用需作为一次可撤销变更处理）。 */
  onFastForward: (revision: Revision) => void;
  /** 修订图分叉：已保留两份，等待用户选择合并方式，期间应禁用编辑。 */
  onConflict: (revision: Revision) => void;
  /** 损坏快照被忽略、接收侧落盘失败等需要提示用户的情况。 */
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
      if (loaded.migrated) {
        // 旧版双键数据：立即收敛写入单键状态并清理旧键；
        // 迁移写入失败不致命（旧键仍在），下次成功写入时重试。
        try {
          this.writeState(this.headId, this.order, this.revisions);
          this.removeLegacyKeys();
          warnings.push('已将旧版双键存储迁移为单键原子状态');
        } catch (e) {
          warnings.push(
            `旧版数据迁移写入失败（${(e as Error).message}），本次从旧数据恢复，将在下次成功写入时重试迁移`,
          );
        }
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
      this.persistBestEffort();
      this.post(root);
    }
  }

  static open(handlers: SyncHandlers, deps: SyncDeps = {}): RevisionSync {
    const warnings: string[] = [];
    const sync = new RevisionSync(handlers, deps, warnings);
    if (typeof window !== 'undefined' && sync.storage) {
      const listener = (e: StorageEvent) => {
        if (!e.newValue) return;
        if (e.key === STATE_STORAGE_KEY) {
          const doc = parseStateDoc(e.newValue);
          if (!doc.ok) {
            handlers.onWarning('收到损坏的持久化状态，已忽略');
            return;
          }
          if (doc.value.badCount > 0) {
            handlers.onWarning(`收到的修订中有 ${doc.value.badCount} 个损坏快照，已忽略`);
          }
          for (const rev of doc.value.doc.revisions) sync.ingest(rev);
          return;
        }
        if (e.key === REVISIONS_STORAGE_KEY) {
          // 旧版双键标签页的兼容接收：只取修订全集，head 由修订图判定。
          const doc = parseRevisionDoc(e.newValue);
          if (!doc.ok) {
            handlers.onWarning('收到损坏的修订文档，已忽略');
            return;
          }
          if (doc.value.badCount > 0) {
            handlers.onWarning(`收到的修订中有 ${doc.value.badCount} 个损坏快照，已忽略`);
          }
          for (const rev of doc.value.doc.revisions) sync.ingest(rev);
        }
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
   * 发布一个普通修订（撤销、重做、导入、清空、普通编辑都走这里）。冲突锁定时拒绝发布。
   * 完整状态写入成功后才切换内存 head 并广播；失败时不留任何痕迹（无幽灵修订）。
   */
  commit(plan: Plan): CommitResult {
    // 冲突期间禁止规划编辑：调用方应已锁定入口，这里做最后一道防线。
    if (this.conflictId !== null) {
      return { ok: false, error: '存在未解决的标签页分叉冲突，请先选择合并方式' };
    }
    const rev: Revision = {
      id: this.uuid(),
      parentRevisionIds: [this.headId],
      clientId: this.clientId,
      plan,
    };
    const advanced = this.tryAdvance(rev, false);
    if (!advanced.ok) return advanced;
    this.post(rev);
    return { ok: true, revision: rev };
  }

  /**
   * 解决冲突：生成同时引用当前 head 与外部修订的合并修订并继续广播。
   * 写入失败时冲突锁定保持不解除，可修正存储问题后重试。
   * 调用方随后应调用 resume() 以重新判定冲突期间挂起的其他修订。
   */
  mergeAndHead(plan: Plan, remoteRevisionId: string): CommitResult {
    const parents = [...new Set([this.headId, remoteRevisionId])];
    const rev: Revision = {
      id: this.uuid(),
      parentRevisionIds: parents,
      clientId: this.clientId,
      plan,
    };
    const advanced = this.tryAdvance(rev, true);
    if (!advanced.ok) return advanced;
    this.post(rev);
    return { ok: true, revision: rev };
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
   * 提交/合并共用：先在候选状态上完成裁剪与单键整体落盘，
   * 写入成功后才切换内存 head（与冲突锁）；失败时内存状态原封不动。
   */
  private tryAdvance(rev: Revision, clearConflict: boolean): CommitResult {
    const revisions = new Map(this.revisions);
    revisions.set(rev.id, rev);
    const order = [...this.order, rev.id];
    const keep = new Set<string>([rev.id]);
    if (!clearConflict && this.conflictId) keep.add(this.conflictId);
    pruneOrder(order, revisions, keep);
    try {
      this.writeState(rev.id, order, revisions);
    } catch (e) {
      return {
        ok: false,
        error:
          `本地存储写入失败（${(e as Error).message}）：本次修改未保存，刷新后将丢失，` +
          '也未同步到其他标签页。请清理浏览器存储空间或解除权限限制后重试；' +
          '可先用「导出 JSON」备份当前规划。',
      };
    }
    this.revisions = revisions;
    this.order = order;
    this.headId = rev.id;
    if (clearConflict) this.conflictId = null;
    this.removeLegacyKeys();
    return { ok: true, revision: rev };
  }

  /** 接收一个外部修订：先落库保留，再按修订图判定。 */
  private ingest(rev: Revision): void {
    if (this.destroyed) return;
    const isNew = !this.revisions.has(rev.id);
    if (!isNew) {
      // 重复投递（storage 事件与频道消息可能各来一次）：无需再判定。
      return;
    }
    this.revisions.set(rev.id, rev);
    this.order.push(rev.id);
    this.persistBestEffort();
    if (this.conflictId !== null) {
      const conflictId = this.conflictId;
      const relHead = relationOf(this.headId, rev.id, this.revisions);
      if (
        relHead === 'fast-forward' &&
        isAncestor(conflictId, rev.id, this.revisions)
      ) {
        // 对方（或某个标签页）已生成同时覆盖本页 head 与冲突版本的合并修订：
        // 冲突自动消解，直接快进，再逐条重新判定挂起队列。
        this.headId = rev.id;
        this.conflictId = null;
        this.persistBestEffort();
        this.handlers.onFastForward(rev);
        const pending = this.pendingIds;
        this.pendingIds = [];
        for (const id of pending) {
          const queued = this.revisions.get(id);
          if (queued && queued.id !== rev.id) this.classify(queued);
        }
        return;
      }
      if (!this.pendingIds.includes(rev.id)) this.pendingIds.push(rev.id);
      return;
    }
    this.classify(rev);
  }

  private classify(rev: Revision): void {
    const relation = relationOf(this.headId, rev.id, this.revisions);
    if (relation === 'same' || relation === 'stale') return;
    if (relation === 'fast-forward') {
      this.headId = rev.id;
      this.persistBestEffort();
      this.handlers.onFastForward(rev);
      return;
    }
    // 分叉（含祖先链缺失无法证明先后的情况）：保留两份，等待人工合并。
    this.conflictId = rev.id;
    if (!this.pendingIds.includes(rev.id)) this.pendingIds.push(rev.id);
    this.handlers.onConflict(rev);
  }

  private post(rev: Revision): void {
    if (!this.channel) return;
    try {
      this.channel.postMessage({ type: 'revision', revision: rev });
    } catch {
      this.handlers.onWarning('修订广播失败，其他标签页可能无法即时同步');
    }
  }

  private load(): { headId: string | null; migrated: boolean; warnings: string[] } {
    const warnings: string[] = [];
    const none = { headId: null, migrated: false, warnings };
    if (!this.storage) return none;

    // 1) 新版单键状态优先：修订全集与 head 出自同一次原子写入，天然一致。
    const rawState = this.storage.getItem(STATE_STORAGE_KEY);
    if (rawState !== null) {
      const parsed = parseStateDoc(rawState);
      if (parsed.ok) {
        this.loadRevisions(parsed.value.doc.revisions);
        if (parsed.value.badCount > 0) {
          warnings.push(`检测到 ${parsed.value.badCount} 个损坏的修订快照，已忽略`);
        }
        if (this.revisions.has(parsed.value.doc.headId)) {
          return { headId: parsed.value.doc.headId, migrated: false, warnings };
        }
        // head 指向损坏修订：从可用修订中恢复一个叶子（无其他可用后裔）。
        const recovered = this.recoverHead();
        if (recovered) {
          warnings.push('本地 head 指针损坏，已自动恢复到最近的完整修订');
          return { headId: recovered, migrated: false, warnings };
        }
        warnings.push('本地修订快照均已损坏，已忽略并从空规划开始');
        this.revisions.clear();
        this.order = [];
        return none;
      }
      warnings.push(`本地持久化状态已损坏（${parsed.error}），尝试从旧版双键数据恢复`);
    }

    // 2) 旧版双键：读取可用数据并标记迁移（构造阶段收敛写入单键状态）。
    const rawLegacy = this.storage.getItem(REVISIONS_STORAGE_KEY);
    if (rawLegacy === null) return none;
    const doc = parseRevisionDoc(rawLegacy);
    if (!doc.ok) {
      warnings.push(`本地修订快照已损坏（${doc.error}），已忽略并从空规划开始`);
      return none;
    }
    this.loadRevisions(doc.value.doc.revisions);
    if (doc.value.badCount > 0) {
      warnings.push(`检测到 ${doc.value.badCount} 个损坏的修订快照，已忽略`);
    }
    const storedHead = this.storage.getItem(HEAD_STORAGE_KEY);
    if (storedHead && this.revisions.has(storedHead)) {
      return { headId: storedHead, migrated: true, warnings };
    }
    const recovered = this.recoverHead();
    if (recovered) {
      warnings.push('本地 head 指针损坏，已自动恢复到最近的完整修订');
      return { headId: recovered, migrated: true, warnings };
    }
    warnings.push('本地修订快照均已损坏，已忽略并从空规划开始');
    this.revisions.clear();
    this.order = [];
    return none;
  }

  private loadRevisions(revisions: Revision[]): void {
    for (const rev of revisions) {
      this.revisions.set(rev.id, rev);
      this.order.push(rev.id);
    }
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
   * 完整状态（修订全集 + head 指针）序列化后单键原子写入；
   * 失败抛出，由调用方决定回滚还是提示。
   */
  private writeState(
    headId: string,
    order: string[],
    revisions: ReadonlyMap<string, Revision>,
  ): void {
    if (!this.storage) return;
    const doc: StateDoc = {
      version: 2,
      headId,
      revisions: order.map((id) => revisions.get(id)!),
    };
    this.storage.setItem(STATE_STORAGE_KEY, JSON.stringify(doc));
  }

  /**
   * 接收外部修订后的落盘：修订已由产生它的标签页先行持久化（先写盘后广播），
   * 这里只是合并重写，失败仅提示、不回滚内存状态。
   */
  private persistBestEffort(): void {
    if (!this.storage) return;
    const keep = new Set<string>([this.headId]);
    if (this.conflictId) keep.add(this.conflictId);
    pruneOrder(this.order, this.revisions, keep);
    try {
      this.writeState(this.headId, this.order, this.revisions);
    } catch (e) {
      this.handlers.onWarning(`修订无法写入本地存储：${(e as Error).message}`);
      return;
    }
    this.removeLegacyKeys();
  }

  /** 旧版双键清理：尽力而为，残留无害（加载时新键优先）。 */
  private removeLegacyKeys(): void {
    if (!this.storage) return;
    try {
      this.storage.removeItem(REVISIONS_STORAGE_KEY);
      this.storage.removeItem(HEAD_STORAGE_KEY);
    } catch {
      // 旧键残留不影响正确性：加载时新键优先，下次成功写入时再清理。
    }
  }
}
