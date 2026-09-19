import { useState } from 'react';
import { Plan } from '../lib/model';
import {
  AuditResult,
  formatAuditReport,
  runAddressAudit,
} from '../lib/addressAudit';

interface Props {
  plan: Plan;
  onClose: () => void;
}

const SAMPLE = `2026-09-18T09:00:00Z, 192.168.0.10, aa:bb:cc:dd:ee:01, 300
2026-09-18T09:02:00Z, 192.168.0.10, aa:bb:cc:dd:ee:99, 300`;

const KIND_LABEL: Record<string, string> = {
  subnet: '子网',
  reserved: '保留段',
};

function formatMs(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function durationLabel(startMs: number, endMs: number): string {
  const seconds = Math.round((endMs - startMs) / 1000);
  if (seconds < 60) return `${seconds} 秒`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s === 0 ? `${m} 分` : `${m} 分 ${s} 秒`;
}

/**
 * 地址观测冲突审计弹窗：粘贴多行「ISO 时间, IPv4, MAC, 有效秒数」观测。
 * 先完整校验并规范化每个字段（任一行非法即带行号报错、不生成结果），
 * 再将每行视为半开有效区间，按 IP 扫描不同 MAC 的区间重叠并合并相邻的
 * 同一参与方冲突段，输出起止、MAC 列表与该 IP 的当前子网分配。
 * 纯只读：不修改规划、不产生撤销/重做历史。
 */
export default function AddressAuditModal({ plan, onClose }: Props) {
  const [text, setText] = useState('');
  const [errors, setErrors] = useState<string[]>([]);
  const [result, setResult] = useState<AuditResult | null>(null);
  const [copied, setCopied] = useState(false);

  const run = () => {
    const out = runAddressAudit(text, plan);
    setCopied(false);
    if (out.errors) {
      setErrors(out.errors);
      setResult(null);
      return;
    }
    setErrors([]);
    setResult(out.result);
  };

  const report = result ? formatAuditReport(result) : '';

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
        <h3>地址观测冲突审计</h3>
        <p className="muted">
          粘贴多行观测，每行 <code>ISO 时间, IPv4, MAC, 有效秒数</code>（逗号分隔）。
          IPv4 须为四段十进制（拒绝 <code>01.2.3.4</code> 类前导零）；MAC 接受
          <code> aa:bb:cc:dd:ee:ff</code>、<code>aa-bb-cc-dd-ee-ff</code>、<code>aaaa.bbbb.cccc</code>
          ，统一规范化为小写冒号形式；ISO 时间形如 <code>2026-09-18T09:00:00Z</code>（可带偏移或小数秒，
          无时区按本机时区）。每行视为左闭右开区间 <code>[观测时刻, +有效秒数)</code>，
          按 IP 找<strong>不同 MAC 的区间重叠</strong>，端点相接的换机不算冲突；相邻且参与 MAC 集合相同的冲突段合并。
          结果含该 IP <strong>当前所属子网分配</strong>（取最具体的分配）。纯本地只读计算，不修改规划与历史。
        </p>
        <label className="field">
          <span>观测记录（每行一条，空行跳过）</span>
          <textarea
            autoFocus
            rows={9}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={SAMPLE}
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
        {result && (
          <div className="dhcp-result">
            <div className="dhcp-result-head">
              <span>
                观测行 {result.observations.length} · 涉及 IP {result.ipCount} · 冲突区间{' '}
                {result.conflicts.length}
              </span>
              <button className="btn small" onClick={copyReport} disabled={!result}>
                {copied ? '已复制 ✓' : '复制文本报告'}
              </button>
            </div>
            {result.conflicts.length === 0 ? (
              <p className="muted">未发现同一 IP 上不同 MAC 的有效区间重叠（非重叠换机不计为冲突）。</p>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>IP</th>
                      <th>冲突起（含）</th>
                      <th>冲突止（不含）</th>
                      <th>时长</th>
                      <th>参与 MAC</th>
                      <th>当前子网分配</th>
                      <th>输入行</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.conflicts.map((c, i) => (
                      <tr key={`${c.ip}-${c.startMs}-${i}`}>
                        <td>
                          <strong>{c.ip}</strong>
                        </td>
                        <td>
                          <code>{formatMs(c.startMs)}</code>
                        </td>
                        <td>
                          <code>{formatMs(c.endMs)}</code>
                        </td>
                        <td className="muted">{durationLabel(c.startMs, c.endMs)}</td>
                        <td>
                          {c.macs.map((m) => (
                            <div key={m}>
                              <code>{m}</code>
                            </div>
                          ))}
                        </td>
                        <td>
                          {c.subnet ? (
                            <>
                              <span className={`badge ${c.subnet.kind === 'reserved' ? 'reserved' : 'subnet'}`}>
                                {KIND_LABEL[c.subnet.kind]}
                              </span>{' '}
                              {c.subnet.name} <code>{c.subnet.cidr}</code>
                              {c.rootName && <div className="muted">根网段：{c.rootName}</div>}
                            </>
                          ) : (
                            <span className="muted">未落在任何已分配网段内</span>
                          )}
                        </td>
                        <td className="muted">{c.lines.join('、')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
        <div className="modal-actions">
          <button className="btn" onClick={onClose}>
            关闭
          </button>
          <button className="btn primary" onClick={run}>
            执行审计
          </button>
        </div>
      </div>
    </div>
  );
}
