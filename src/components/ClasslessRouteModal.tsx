import { useMemo, useState } from 'react';
import { Allocation } from '../lib/model';
import { cidrToString, longToIpv4, parseCidr } from '../lib/ip';
import { usableRangeOf } from '../lib/dhcp';
import {
  DecodeResult,
  EncodedRoute,
  bytesToHex,
  decodeClasslessHex,
  encodeClasslessRoutes,
  formatRouteLines,
  parseClasslessRoutes,
} from '../lib/classlessRoute';

interface Props {
  alloc: Allocation;
  onClose: () => void;
}

function ByteBreakdown({ entry }: { entry: EncodedRoute }) {
  const { route, prefixByte, targetBytes, gatewayBytes } = entry;
  const hex = (n: number) => n.toString(16).toUpperCase().padStart(2, '0');
  return (
    <div className="csr-bytes">
      <span className="csr-byte-group csr-byte-prefix" title="前缀长度（1 字节）">
        {hex(prefixByte)}
      </span>
      <span
        className={`csr-byte-group csr-byte-target${targetBytes.length === 0 ? ' csr-byte-empty' : ''}`}
        title={`目标网络有效字节（${targetBytes.length} 字节，ceil(${prefixByte}/8)）`}
      >
        {targetBytes.length > 0 ? targetBytes.map(hex).join(' ') : '（/0 无目标字节）'}
      </span>
      <span className="csr-byte-group csr-byte-gw" title="下一跳（4 字节）">
        {gatewayBytes.map(hex).join(' ')}
      </span>
      <span className="muted csr-byte-route">
        → {cidrToString(route.target)} via {longToIpv4(route.gateway)}
      </span>
    </div>
  );
}

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // 剪贴板 API 不可用（如非安全上下文）时回退
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
  }
}

/**
 * DHCP 类无静态路由（Option 121）弹窗：
 * 逐行输入「目标 CIDR,下一跳 IPv4」，按 RFC 3442 编码为十六进制；
 * 支持粘贴十六进制反向解码并回填表格。纯本地只读，不修改规划与历史。
 */
export default function ClasslessRouteModal({ alloc, onClose }: Props) {
  const subnet = useMemo(() => parseCidr(alloc.cidr)!, [alloc.cidr]);
  const usable = usableRangeOf(subnet);
  const [text, setText] = useState('');
  const [hexInput, setHexInput] = useState('');
  const [decodeError, setDecodeError] = useState<string | null>(null);
  const [decoded, setDecoded] = useState<DecodeResult | null>(null);
  const [copied, setCopied] = useState<'enc' | 'dec' | null>(null);

  const parsed = useMemo(() => parseClasslessRoutes(subnet, text), [subnet, text]);
  const encoded = useMemo(
    () => (parsed.errors.length === 0 && parsed.routes.length > 0
      ? encodeClasslessRoutes(parsed.routes)
      : null),
    [parsed],
  );

  const doDecode = () => {
    const result = decodeClasslessHex(hexInput);
    setCopied(null);
    if ('error' in result) {
      setDecodeError(result.error);
      setDecoded(null);
      return;
    }
    setDecodeError(null);
    setDecoded(result);
  };

  /** 解码成功后回填表格（按目标地址、前缀规范化排序），供再次编辑与编码。 */
  const fillTable = () => {
    if (!decoded) return;
    const sorted = [...decoded.routes].sort(
      (a, b) => a.target.base - b.target.base || a.target.prefix - b.target.prefix,
    );
    setText(formatRouteLines(sorted) + '\n');
    setCopied(null);
  };

  return (
    <div className="modal-backdrop csr-backdrop" onClick={onClose}>
      <div
        className="modal wide csr-modal"
        role="dialog"
        aria-modal="true"
        aria-label={`DHCP 类无静态路由（Option 121）：${alloc.name}`}
        onClick={(e) => e.stopPropagation()}
      >
        <h3>DHCP 类无静态路由（Option 121）：{alloc.name}</h3>
        <p className="muted">
          子网 <code>{alloc.cidr}</code>，下一跳可用范围{' '}
          <code>
            {longToIpv4(usable.start)} - {longToIpv4(usable.end)}
          </code>
          。每行输入 <code>目标 CIDR,下一跳 IPv4</code>（空行忽略）；目标须合法且对齐 CIDR
          边界，下一跳须位于本网段可用主机范围，重复目标按行报错，任一错误时不生成结果。
          按 RFC 3442 编码为「前缀长度 + 目标网络有效字节 + 4 字节下一跳」，结果按目标地址、前缀排序。
          纯本地只读，不修改规划与历史。
        </p>
        <label className="field">
          <span>静态路由（每行一条：目标 CIDR,下一跳 IPv4）</span>
          <textarea
            autoFocus
            rows={6}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setCopied(null);
            }}
            placeholder={'例如：\n0.0.0.0/0,10.0.0.1\n192.168.1.0/24,10.0.0.254'}
            spellCheck={false}
          />
        </label>

        {parsed.errors.length > 0 && (
          <ul className="errors">
            {parsed.errors.map((er, i) => (
              <li key={i}>{er}</li>
            ))}
          </ul>
        )}

        {encoded && (
          <div className="dhcp-result">
            <div className="dhcp-result-head">
              <span>Option 121 · 共 {encoded.entries.length} 条路由 · {encoded.bytes.length} 字节</span>
              <button
                className="btn small"
                onClick={async () => {
                  await copyText(encoded.hex);
                  setCopied('enc');
                }}
              >
                {copied === 'enc' ? '已复制 ✓' : '复制十六进制'}
              </button>
            </div>
            <textarea readOnly rows={2} value={encoded.hex} spellCheck={false} />
            <div className="csr-breakdown-head muted">逐条字节拆解（前缀长度 · 目标有效字节 · 下一跳）：</div>
            <div className="csr-breakdown">
              {encoded.entries.map((e, i) => (
                <ByteBreakdown key={i} entry={e} />
              ))}
            </div>
          </div>
        )}

        <div className="csr-decode">
          <label className="field">
            <span>反向解码：粘贴 Option 121 十六进制（支持空格、冒号分隔与 0x 前缀）</span>
            <textarea
              rows={2}
              value={hexInput}
              onChange={(e) => {
                setHexInput(e.target.value);
                setDecodeError(null);
                setDecoded(null);
                setCopied(null);
              }}
              placeholder="例如：00 0A 00 00 01 18 C0 A8 01 0A 00 00 FE"
              spellCheck={false}
            />
          </label>
          <div className="csr-decode-actions">
            <button className="btn" disabled={!hexInput.trim()} onClick={doDecode}>
              解码
            </button>
            {decoded && (
              <>
                <button
                  className="btn"
                  onClick={async () => {
                    await copyText(decoded.hex);
                    setCopied('dec');
                  }}
                >
                  {copied === 'dec' ? '已复制 ✓' : '复制规范化十六进制'}
                </button>
                <button className="btn primary" onClick={fillTable}>
                  回填到表格（{decoded.routes.length} 条）
                </button>
              </>
            )}
          </div>
          {decodeError && (
            <ul className="errors">
              <li>{decodeError}</li>
            </ul>
          )}
          {decoded && (
            <div className="table-wrap csr-decode-table">
              <table>
                <thead>
                  <tr>
                    <th>#</th>
                    <th>目标 CIDR</th>
                    <th>下一跳</th>
                    <th>字节拆解</th>
                  </tr>
                </thead>
                <tbody>
                  {decoded.routes.map((r, i) => (
                    <tr key={i}>
                      <td className="muted">{i + 1}</td>
                      <td><code>{cidrToString(r.target)}</code></td>
                      <td><code>{longToIpv4(r.gateway)}</code></td>
                      <td className="csr-cell-bytes">
                        <code>{bytesToHex(decoded.entries[i].bytes)}</code>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="modal-actions">
          <button className="btn" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}
