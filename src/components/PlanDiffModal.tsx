import { useRef, useState } from 'react';
import { Plan } from '../lib/model';
import { blockSize, cidrToString } from '../lib/ip';
import {
  CHANGE_LABEL,
  ChangeTag,
  DiffItem,
  KIND_LABEL,
  PlanDiffResult,
  diffPlans,
  formatDiffReport,
  parseBaseline,
} from '../lib/planDiff';

interface Props {
  plan: Plan;
  onClose: () => void;
}

const TAG_BADGE_CLASS: Record<ChangeTag, string> = {
  renamed: 'diff-renamed',
  'kind-changed': 'diff-kind',
  moved: 'diff-moved',
  'capacity-changed': 'diff-capacity',
};

/**
 * 规划差异报告弹窗：导入由「导出 JSON」生成的基线文件（复用 Plan 完整校验，
 * 基线非法时逐条列出错误且不生成结果），按分配 id 对比基线与当前规划——
 * 分类新增、删除、重命名、类型变化、迁移与容量变化（同一项可带多个标签），
 * 并对两版全部分配的地址并集做区间差集，精确压缩为最少 CIDR 分别列出
 * 新增占用与释放地址。结果含汇总计数与逐项明细，可一键复制文本报告。
 * 纯本地只读计算：不修改规划、不写入修订历史，冲突锁定期间仍可使用。
 */
export default function PlanDiffModal({ plan, onClose }: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [baselineText, setBaselineText] = useState<string | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [result, setResult] = useState<PlanDiffResult | null>(null);
  const [copied, setCopied] = useState(false);

  const run = (text: string) => {
    setCopied(false);
    const out = parseBaseline(text);
    if (out.errors) {
      setErrors(out.errors);
      setResult(null);
      return;
    }
    setErrors([]);
    setResult(diffPlans(out.plan, plan));
  };

  const handleFile = async (file: File | undefined) => {
    if (!file) return;
    const text = await file.text();
    setFileName(file.name);
    setBaselineText(text);
    run(text);
    if (fileRef.current) fileRef.current.value = '';
  };

  const report = result ? formatDiffReport(result) : '';

  const copyReport = async () => {
    try {
      await navigator.clipboard.writeText(report);
    } catch {
      // 剪贴板 API 不可用（如非安全上下文）时回退
      const ta = document.createElement('textarea');
      ta.value = report;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    setCopied(true);
  };

  return (
    <div className="modal-backdrop readonly-backdrop" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <h3>规划差异报告</h3>
        <p className="muted">
          选择由「导出 JSON」生成的<strong>基线文件</strong>，与当前规划对比。基线复用 Plan
          完整校验，非法时逐条列出错误且不生成结果。按<strong>分配 id</strong> 分类
          新增、删除、重命名、类型变化、迁移与容量变化（同一项可带多个标签）；并对两版全部分配的
          地址并集做区间差集，<strong>精确压缩为最少 CIDR</strong> 分别列出新增占用与释放地址。
          纯本地只读计算，不修改规划与历史，冲突锁定期间仍可使用。
        </p>

        <div className="diff-file-row">
          <button className="btn" onClick={() => fileRef.current?.click()}>
            选择基线文件…
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={(e) => void handleFile(e.target.files?.[0])}
          />
          {fileName ? (
            <span className="muted">
              已选：<code>{fileName}</code>
            </span>
          ) : (
            <span className="muted">尚未选择基线文件</span>
          )}
        </div>

        {errors.length > 0 && (
          <ul className="errors">
            {errors.map((er, i) => (
              <li key={i}>{er}</li>
            ))}
          </ul>
        )}

        {result && (
          <div className="dhcp-result">
            <div className="dhcp-result-head">
              <span>
                新增 {result.addedCount} · 删除 {result.removedCount} · 变更 {result.changedCount}
                （重命名 {result.renamedCount} · 类型变化 {result.kindChangedCount} · 迁移{' '}
                {result.movedCount} · 容量变化 {result.capacityChangedCount}）· 未变化{' '}
                {result.unchangedCount}
              </span>
              <button className="btn small" onClick={copyReport}>
                {copied ? '已复制 ✓' : '复制文本报告'}
              </button>
            </div>

            {result.items.length === 0 ? (
              <p className="muted">两版规划的分配完全一致。</p>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>变化</th>
                      <th>分配</th>
                      <th>基线</th>
                      <th>当前</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.items.map((it, i) => (
                      <DiffRow key={it.id} item={it} seq={i + 1} />
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <div className="diff-addr-grid">
              <div>
                <div className="diff-addr-head">
                  新增占用（当前有、基线无）：{result.addedAddressCount} 个地址 ·{' '}
                  {result.addedCidrs.length} 条 CIDR
                </div>
                {result.addedCidrs.length === 0 ? (
                  <span className="muted">（无）</span>
                ) : (
                  <div className="diff-cidr-list">
                    {result.addedCidrs.map((c) => (
                      <code key={`a-${c.base}-${c.prefix}`} title={`${blockSize(c.prefix)} 个地址`}>
                        {cidrToString(c)}
                      </code>
                    ))}
                  </div>
                )}
              </div>
              <div>
                <div className="diff-addr-head">
                  释放地址（基线有、当前无）：{result.releasedAddressCount} 个地址 ·{' '}
                  {result.releasedCidrs.length} 条 CIDR
                </div>
                {result.releasedCidrs.length === 0 ? (
                  <span className="muted">（无）</span>
                ) : (
                  <div className="diff-cidr-list">
                    {result.releasedCidrs.map((c) => (
                      <code key={`r-${c.base}-${c.prefix}`} title={`${blockSize(c.prefix)} 个地址`}>
                        {cidrToString(c)}
                      </code>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        <div className="modal-actions">
          <button className="btn" onClick={onClose}>
            关闭
          </button>
          <button
            className="btn primary"
            onClick={() => baselineText && run(baselineText)}
            disabled={!baselineText}
          >
            生成差异报告
          </button>
        </div>
      </div>
    </div>
  );
}

function DiffRow({ item, seq }: { item: DiffItem; seq: number }) {
  const base = item.baseline;
  const cur = item.current;
  const name =
    base && cur && base.name !== cur.name ? (
      <>
        <span className="muted">{base.name}</span> → <strong>{cur.name}</strong>
      </>
    ) : (
      <strong>{(cur ?? base)!.name}</strong>
    );
  return (
    <tr>
      <td className="muted">{seq}</td>
      <td>
        {item.status === 'changed' ? (
          item.changes.map((t) => (
            <span key={t} className={`badge ${TAG_BADGE_CLASS[t]}`}>
              {CHANGE_LABEL[t]}
            </span>
          ))
        ) : (
          <span className={`badge ${item.status === 'added' ? 'diff-added' : 'diff-removed'}`}>
            {item.status === 'added' ? '新增' : '删除'}
          </span>
        )}
      </td>
      <td>{name}</td>
      <td>
        {base ? (
          <>
            <span className={`badge ${base.kind === 'reserved' ? 'reserved' : 'subnet'}`}>
              {KIND_LABEL[base.kind]}
            </span>{' '}
            <code>{base.cidr}</code>
          </>
        ) : (
          <span className="muted">—</span>
        )}
      </td>
      <td>
        {cur ? (
          <>
            <span className={`badge ${cur.kind === 'reserved' ? 'reserved' : 'subnet'}`}>
              {KIND_LABEL[cur.kind]}
            </span>{' '}
            <code>{cur.cidr}</code>
          </>
        ) : (
          <span className="muted">—</span>
        )}
      </td>
    </tr>
  );
}
