import { useState } from 'react';

interface Props {
  mode: 'export' | 'import';
  /** 备份文件名（仅导入模式展示） */
  fileName?: string;
  /** 返回 null 表示成功（父组件随后关闭弹窗），否则为展示给用户的错误信息 */
  onSubmit: (password: string) => Promise<string | null>;
  onClose: () => void;
}

/**
 * 加密备份口令弹窗。导出需输入并确认口令；导入只需口令。
 * 口令仅保存在本组件的临时状态中，随弹窗关闭即销毁，绝不写入持久化存储。
 */
export default function CryptoBackupModal({ mode, fileName, onSubmit, onClose }: Props) {
  const isExport = mode === 'export';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const errs: string[] = [];
    if (!password) errs.push('口令不能为空');
    if (isExport && password !== confirm) errs.push('两次输入的口令不一致');
    if (errs.length > 0) {
      setErrors(errs);
      return;
    }
    setBusy(true);
    setErrors([]);
    try {
      const err = await onSubmit(password);
      if (err) setErrors([err]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop readonly-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{isExport ? '导出加密备份' : '导入加密备份'}</h3>
        <p className="muted">
          {isExport
            ? '使用口令加密当前规划：随机 16 字节 salt 与 12 字节 iv，PBKDF2-SHA-256 迭代 200000 次派生 AES-GCM-256 密钥。口令不会被保存，遗忘后无法恢复备份内容。'
            : `仅接受本应用导出的加密备份信封（${fileName ?? '所选文件'}）。输入导出时使用的口令，解密内容通过规划完整校验后作为一次可撤销修订替换当前规划。`}
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <label className="field">
            <span>口令</span>
            <input
              autoFocus
              type="password"
              autoComplete="off"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={isExport ? '设置备份口令' : '输入备份口令'}
            />
          </label>
          {isExport && (
            <label className="field">
              <span>确认口令</span>
              <input
                type="password"
                autoComplete="off"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                placeholder="再次输入相同口令"
              />
            </label>
          )}
          {errors.length > 0 && (
            <ul className="errors">
              {errors.map((er, i) => (
                <li key={i}>{er}</li>
              ))}
            </ul>
          )}
          <div className="modal-actions">
            <button type="button" className="btn" onClick={onClose} disabled={busy}>
              取消
            </button>
            <button type="submit" className="btn primary" disabled={busy}>
              {busy ? '派生密钥中…' : isExport ? '加密并下载' : '解密并导入'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
