import { describe, expect, it } from 'vitest';
import {
  BACKUP_FORMAT,
  BACKUP_VERSION,
  PBKDF2_ITERATIONS,
  decryptBackup,
  encryptBackup,
  exportPlanBackup,
  importPlanBackup,
} from './cryptoBackup';
import { Plan } from './model';

const PASSWORD = 'correct horse battery staple';

function samplePlan(): Plan {
  return {
    version: 1,
    roots: [{ id: 'root_1', name: '生产骨干', cidr: '10.0.0.0/8' }],
    allocations: [
      { id: 'alloc_1', name: '核心交换区', kind: 'reserved', prefix: 16, cidr: '10.0.0.0/16' },
      { id: 'alloc_2', name: '数据中心-A', kind: 'subnet', prefix: 18, cidr: '10.1.0.0/18' },
    ],
  };
}

/** 导出信封并解析为对象，便于按字段篡改。 */
async function exportEnvelope(plan: Plan, password = PASSWORD) {
  const text = await exportPlanBackup(plan, password);
  return { text, obj: JSON.parse(text) as Record<string, any> };
}

function decodeB64(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

describe('加密备份导出', () => {
  it('生成版本化信封：format/version/kdf/cipher 字段齐全，salt/iv/ciphertext 为合法 Base64', async () => {
    const { obj } = await exportEnvelope(samplePlan());
    expect(obj.format).toBe(BACKUP_FORMAT);
    expect(obj.version).toBe(BACKUP_VERSION);
    expect(obj.kdf.name).toBe('PBKDF2');
    expect(obj.kdf.hash).toBe('SHA-256');
    expect(obj.kdf.iterations).toBe(PBKDF2_ITERATIONS);
    expect(decodeB64(obj.kdf.salt)).toHaveLength(16);
    expect(obj.cipher.name).toBe('AES-GCM');
    expect(decodeB64(obj.cipher.iv)).toHaveLength(12);
    expect(decodeB64(obj.ciphertext).length).toBeGreaterThan(16);
  });

  it('相同规划与口令两次导出的 salt、iv、ciphertext 均不同（随机化）', async () => {
    const a = await exportEnvelope(samplePlan());
    const b = await exportEnvelope(samplePlan());
    expect(a.obj.kdf.salt).not.toBe(b.obj.kdf.salt);
    expect(a.obj.cipher.iv).not.toBe(b.obj.cipher.iv);
    expect(a.obj.ciphertext).not.toBe(b.obj.ciphertext);
  });

  it('信封中不出现口令明文', async () => {
    const { text } = await exportEnvelope(samplePlan(), 's3cret-口令');
    expect(text).not.toContain('s3cret-口令');
  });
});

describe('加密备份导入（往返）', () => {
  it('正确口令可完整还原规划', async () => {
    const plan = samplePlan();
    const { text } = await exportEnvelope(plan);
    const restored = await importPlanBackup(text, PASSWORD);
    expect(restored).toEqual(plan);
  });

  it('拒绝错误口令', async () => {
    const { text } = await exportEnvelope(samplePlan());
    await expect(importPlanBackup(text, 'wrong-password')).rejects.toThrow(
      /口令错误或备份数据已被篡改/,
    );
  });

  it('拒绝被篡改的密文', async () => {
    const { obj } = await exportEnvelope(samplePlan());
    const ct: string = obj.ciphertext;
    const flip = ct[10] === 'A' ? 'B' : 'A';
    obj.ciphertext = ct.slice(0, 10) + flip + ct.slice(11);
    await expect(importPlanBackup(JSON.stringify(obj), PASSWORD)).rejects.toThrow(
      /口令错误或备份数据已被篡改/,
    );
  });

  it('拒绝被篡改的 salt', async () => {
    const { obj } = await exportEnvelope(samplePlan());
    const salt = decodeB64(obj.kdf.salt);
    salt[0] ^= 0xff;
    obj.kdf.salt = btoa(String.fromCharCode(...salt));
    await expect(importPlanBackup(JSON.stringify(obj), PASSWORD)).rejects.toThrow(
      /口令错误或备份数据已被篡改/,
    );
  });

  it('解密内容未通过 Plan 完整校验时拒绝', async () => {
    const invalid = await encryptBackup(
      JSON.stringify({
        version: 1,
        roots: [],
        allocations: [{ id: 'a', name: '越界', kind: 'subnet', prefix: 24, cidr: '10.0.0.0/24' }],
      }),
      PASSWORD,
    );
    await expect(importPlanBackup(invalid, PASSWORD)).rejects.toThrow(/规划文件校验未通过/);
  });

  it('解密内容不是合法 JSON 时拒绝', async () => {
    const garbage = await encryptBackup('这不是 JSON', PASSWORD);
    await expect(importPlanBackup(garbage, PASSWORD)).rejects.toThrow(/JSON 解析失败/);
  });
});

describe('加密备份信封校验', () => {
  it('拒绝非 JSON 文本', async () => {
    await expect(importPlanBackup('not json', PASSWORD)).rejects.toThrow(/不是合法 JSON/);
  });

  it('拒绝 format 不匹配的文件（如明文规划导出）', async () => {
    const plain = JSON.stringify({ version: 1, roots: [], allocations: [] });
    await expect(importPlanBackup(plain, PASSWORD)).rejects.toThrow(/format 字段不匹配/);
  });

  it('拒绝不支持的版本', async () => {
    const { obj } = await exportEnvelope(samplePlan());
    obj.version = 2;
    await expect(importPlanBackup(JSON.stringify(obj), PASSWORD)).rejects.toThrow(
      /不支持的加密备份版本/,
    );
  });

  it('拒绝缺少字段的信封', async () => {
    const { obj } = await exportEnvelope(samplePlan());
    delete obj.kdf.salt;
    await expect(importPlanBackup(JSON.stringify(obj), PASSWORD)).rejects.toThrow(/kdf\.salt/);
    const { obj: obj2 } = await exportEnvelope(samplePlan());
    delete obj2.ciphertext;
    await expect(importPlanBackup(JSON.stringify(obj2), PASSWORD)).rejects.toThrow(/ciphertext/);
  });

  it('拒绝非法 Base64 字段', async () => {
    const { obj } = await exportEnvelope(samplePlan());
    obj.kdf.salt = '!!!not-base64!!!';
    await expect(importPlanBackup(JSON.stringify(obj), PASSWORD)).rejects.toThrow(
      /kdf\.salt 不是合法的 Base64/,
    );
    const { obj: obj2 } = await exportEnvelope(samplePlan());
    obj2.cipher.iv = 'abc'; // 长度不是 4 的倍数
    await expect(importPlanBackup(JSON.stringify(obj2), PASSWORD)).rejects.toThrow(
      /cipher\.iv 不是合法的 Base64/,
    );
  });

  it('拒绝长度不符的 salt / iv', async () => {
    const { obj } = await exportEnvelope(samplePlan());
    obj.kdf.salt = btoa('short'); // 5 字节而非 16
    await expect(importPlanBackup(JSON.stringify(obj), PASSWORD)).rejects.toThrow(/16 字节/);
    const { obj: obj2 } = await exportEnvelope(samplePlan());
    obj2.cipher.iv = btoa('0123456789abcdef'); // 16 字节而非 12
    await expect(importPlanBackup(JSON.stringify(obj2), PASSWORD)).rejects.toThrow(/12 字节/);
  });

  it('拒绝不支持的 kdf / cipher 参数', async () => {
    const { obj } = await exportEnvelope(samplePlan());
    obj.kdf.hash = 'SHA-1';
    await expect(importPlanBackup(JSON.stringify(obj), PASSWORD)).rejects.toThrow(
      /不支持的密钥派生参数/,
    );
    const { obj: obj2 } = await exportEnvelope(samplePlan());
    obj2.cipher.name = 'AES-CBC';
    await expect(importPlanBackup(JSON.stringify(obj2), PASSWORD)).rejects.toThrow(
      /不支持的加密算法/,
    );
  });
});

describe('decryptBackup 明文往返', () => {
  it('任意 UTF-8 明文可往返', async () => {
    const text = '规划备份 ✓ 含中文与 emoji 🎉\n第二行';
    const envelope = await encryptBackup(text, PASSWORD);
    await expect(decryptBackup(envelope, PASSWORD)).resolves.toBe(text);
  });
});
