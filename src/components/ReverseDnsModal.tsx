import { useState } from 'react';
import { Allocation } from '../lib/model';
import { blockSize, parseCidr } from '../lib/ip';
import { ReverseDnsResult, generateReverseDns } from '../lib/reverseDns';

interface Props {
  alloc: Allocation;
  onClose: () => void;
}

/** 按前缀说明将使用的委派策略 */
function strategyText(prefix: number): string {
  if (prefix === 32) {
    return '该子网为 /32 单地址：生成单条 PTR 所有者提示，NS 可留空（填写则仅校验、不参与生成）。';
  }
  if (prefix >= 25) {
    return `该子网为 /${prefix}：按 RFC 2317 生成父区 NS 委派、覆盖子网全部 ${blockSize(prefix)} 个地址的 CNAME 与子区名。`;
  }
  const octets = prefix === 0 ? 0 : prefix <= 8 ? 1 : prefix <= 16 ? 2 : 3;
  const count = 2 ** (octets * 8 - prefix);
  if (count === 1) {
    return '该子网对齐八位边界：生成单个 in-addr.arpa 区，并给出其父区 NS 委派记录。';
  }
  return `该子网为 /${prefix}：拆成 /${octets * 8} 八位边界上的 ${count} 个 in-addr.arpa 区（最小区域集合），并给出父区 NS 委派记录。`;
}

function linesOf(text: string): number {
  return text === '' ? 0 : text.split('\n').length;
}

/**
 * 反向 DNS 委派片段弹窗：基于子网 CIDR 生成可复制的 BIND 委派片段。
 * 逐行填写权威 NS（带末尾点的绝对域名；/32 可留空），任一非法则不生成。
 * 纯本地计算，不修改规划与历史。
 */
export default function ReverseDnsModal({ alloc, onClose }: Props) {
  const subnet = parseCidr(alloc.cidr)!;
  const [text, setText] = useState('');
  const [errors, setErrors] = useState<string[]>([]);
  const [result, setResult] = useState<ReverseDnsResult | null>(null);
  const [copied, setCopied] = useState(false);

  const generate = () => {
    const { errors: errs, result: r } = generateReverseDns(subnet, text);
    setErrors(errs);
    setCopied(false);
    setResult(r);
  };

  const snippet = result?.snippet ?? null;
  const fullText = snippet?.fullText ?? '';

  const copySnippet = async () => {
    try {
      await navigator.clipboard.writeText(fullText);
    } catch {
      // 剪贴板 API 不可用（如非安全上下文）时回退
      const ta = document.createElement('textarea');
      ta.value = fullText;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    setCopied(true);
  };

  const summary = result
    ? result.plan.kind === 'ptr'
      ? `PTR 所有者：${result.plan.ptrOwner}`
      : `父区记录 ${result.plan.parentRecords.length} 条 · 需创建子区 ${result.plan.childZones.length} 个`
    : '';

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <h3>反向 DNS 委派：{alloc.name}</h3>
        <p className="muted">
          子网 <code>{alloc.cidr}</code>。{strategyText(subnet.prefix)}
          每行填写一个权威 NS，必须是带末尾点的绝对域名（如 <code>ns1.example.com.</code>）；
          任一非法则不生成。纯本地计算，不修改规划与历史。
        </p>
        <label className="field">
          <span>
            权威 NS（每行一个，带末尾点{subnet.prefix === 32 ? '；/32 可留空' : ''}）
          </span>
          <textarea
            autoFocus
            rows={3}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={'例如：\nns1.example.com.\nns2.example.com.'}
            spellCheck={false}
          />
        </label>
        {errors.length > 0 && (
          <ul className="errors">
            {errors.map((er, i) => (
              <li key={i}>{er}</li>
            ))}
          </ul>
        )}
        {result && snippet && (
          <div className="dhcp-result">
            <div className="dhcp-result-head">
              <span>{summary}</span>
              <button className="btn small" onClick={copySnippet}>
                {copied ? '已复制 ✓' : '复制片段'}
              </button>
            </div>
            {result.plan.kind === 'ptr' ? (
              <label className="field">
                <span>PTR 所有者提示</span>
                <textarea readOnly rows={4} value={snippet.ptrText} />
              </label>
            ) : (
              <>
                <label className="field">
                  <span>父区记录（加入 {result.plan.parentZone}）</span>
                  <textarea
                    readOnly
                    rows={Math.min(Math.max(linesOf(snippet.parentText), 2), 14)}
                    value={snippet.parentText}
                  />
                </label>
                <label className="field">
                  <span>需创建的子区（{result.plan.childZones.length} 个）</span>
                  <textarea
                    readOnly
                    rows={Math.min(Math.max(linesOf(snippet.childText), 2), 12)}
                    value={snippet.childText}
                  />
                </label>
              </>
            )}
          </div>
        )}
        <div className="modal-actions">
          <button className="btn" onClick={onClose}>
            关闭
          </button>
          <button className="btn primary" onClick={generate}>
            生成片段
          </button>
        </div>
      </div>
    </div>
  );
}
