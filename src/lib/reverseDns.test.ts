import { describe, expect, it } from 'vitest';
import { parseCidr } from './ip';
import {
  formatReverseDns,
  generateReverseDns,
  isAbsoluteDomain,
  parseNsLines,
  planReverseDns,
} from './reverseDns';

const cidr = (s: string) => parseCidr(s)!;
const NS = ['ns1.example.com.', 'ns2.example.com.'];
const NS_TEXT = NS.join('\n');

describe('权威 NS 校验', () => {
  it('接受带末尾点的绝对域名', () => {
    expect(isAbsoluteDomain('ns1.example.com.')).toBe(true);
    expect(isAbsoluteDomain('a.')).toBe(true); // 单标签也是合法绝对域名
    expect(isAbsoluteDomain('ns-1.x-y.example.')).toBe(true);
    expect(isAbsoluteDomain('NS1.EXAMPLE.COM.')).toBe(true); // 大小写不敏感
    expect(isAbsoluteDomain(`${'a'.repeat(63)}.`)).toBe(true); // 标签长度上限 63
  });

  it('拒绝缺少末尾点、非法字符与非法标签', () => {
    expect(isAbsoluteDomain('ns1.example.com')).toBe(false); // 无末尾点
    expect(isAbsoluteDomain('')).toBe(false);
    expect(isAbsoluteDomain('.')).toBe(false);
    expect(isAbsoluteDomain('..')).toBe(false);
    expect(isAbsoluteDomain('ns1..example.')).toBe(false); // 空标签
    expect(isAbsoluteDomain('-ns1.example.')).toBe(false); // 连字符开头
    expect(isAbsoluteDomain('ns1-.example.')).toBe(false); // 连字符结尾
    expect(isAbsoluteDomain('ns_1.example.')).toBe(false); // 下划线
    expect(isAbsoluteDomain('*.example.')).toBe(false); // 通配符
    expect(isAbsoluteDomain('ns1.example.com/path.')).toBe(false);
    expect(isAbsoluteDomain('ns1 .example.')).toBe(false); // 含空格
    expect(isAbsoluteDomain(`${'a'.repeat(64)}.`)).toBe(false); // 标签超 63
    expect(isAbsoluteDomain(`${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(62)}.`)).toBe(false); // 全长超 253
  });

  it('逐行解析：空行跳过，非法行带行号报错', () => {
    const { ns, errors } = parseNsLines('\nns1.example.com.\n  \nns2.example.com.\n');
    expect(errors).toEqual([]);
    expect(ns).toEqual(NS);

    const bad = parseNsLines('ns1.example.com.\nno-trailing-dot\nns2.example.com.\n bad_name.\n');
    expect(bad.ns).toEqual(NS);
    expect(bad.errors).toHaveLength(2);
    expect(bad.errors[0]).toContain('第 2 行');
    expect(bad.errors[0]).toContain('no-trailing-dot');
    expect(bad.errors[1]).toContain('第 4 行');
  });
});

describe('单区：/0、/8、/16、/24', () => {
  it('/0 生成 in-addr.arpa 单区，父区为 arpa.', () => {
    const plan = planReverseDns(cidr('0.0.0.0/0'), NS);
    expect(plan.kind).toBe('zones');
    expect(plan.childZones.map((z) => z.name)).toEqual(['in-addr.arpa.']);
    expect(plan.childZones[0].firstAddr).toBe(0);
    expect(plan.childZones[0].lastAddr).toBe(0xffffffff);
    expect(plan.parentZone).toBe('arpa.');
    expect(plan.parentRecords).toEqual([
      'in-addr.arpa. 3600 IN NS ns1.example.com.',
      'in-addr.arpa. 3600 IN NS ns2.example.com.',
    ]);
  });

  it('/8 生成单个 /8 区，父区为 in-addr.arpa.', () => {
    const plan = planReverseDns(cidr('10.0.0.0/8'), NS);
    expect(plan.childZones.map((z) => z.name)).toEqual(['10.in-addr.arpa.']);
    expect(plan.parentZone).toBe('in-addr.arpa.');
    expect(plan.parentRecords).toHaveLength(2);
    expect(plan.parentRecords[0]).toBe('10.in-addr.arpa. 3600 IN NS ns1.example.com.');
  });

  it('/16 生成单个 /16 区', () => {
    const plan = planReverseDns(cidr('10.1.0.0/16'), NS);
    expect(plan.childZones.map((z) => z.name)).toEqual(['1.10.in-addr.arpa.']);
    expect(plan.parentZone).toBe('10.in-addr.arpa.');
  });

  it('/24 生成单个 /24 区', () => {
    const plan = planReverseDns(cidr('192.0.2.0/24'), NS);
    expect(plan.childZones.map((z) => z.name)).toEqual(['2.0.192.in-addr.arpa.']);
    expect(plan.parentZone).toBe('0.192.in-addr.arpa.');
    expect(plan.parentRecords).toEqual([
      '2.0.192.in-addr.arpa. 3600 IN NS ns1.example.com.',
      '2.0.192.in-addr.arpa. 3600 IN NS ns2.example.com.',
    ]);
  });
});

describe('拆分：其余 /1～/23 拆成下一个八位边界的最小区域集合', () => {
  it('/1～/7 拆到 /8 边界', () => {
    const p7 = planReverseDns(cidr('10.0.0.0/7'), NS);
    expect(p7.childZones.map((z) => z.name)).toEqual(['10.in-addr.arpa.', '11.in-addr.arpa.']);
    expect(p7.parentZone).toBe('in-addr.arpa.');
    expect(p7.parentRecords).toHaveLength(4); // 2 区 × 2 NS

    const p1 = planReverseDns(cidr('0.0.0.0/1'), NS);
    expect(p1.childZones).toHaveLength(128);
    expect(p1.childZones[0].name).toBe('0.in-addr.arpa.');
    expect(p1.childZones[127].name).toBe('127.in-addr.arpa.');
  });

  it('/9～/15 拆到 /16 边界', () => {
    const p12 = planReverseDns(cidr('10.16.0.0/12'), NS);
    expect(p12.childZones).toHaveLength(16);
    expect(p12.childZones[0].name).toBe('16.10.in-addr.arpa.');
    expect(p12.childZones[15].name).toBe('31.10.in-addr.arpa.');
    expect(p12.parentZone).toBe('10.in-addr.arpa.');

    const p9 = planReverseDns(cidr('10.0.0.0/9'), NS);
    expect(p9.childZones).toHaveLength(128);
    expect(p9.childZones[0].name).toBe('0.10.in-addr.arpa.');
    expect(p9.childZones[127].name).toBe('127.10.in-addr.arpa.');
  });

  it('/17～/23 拆到 /24 边界', () => {
    const p20 = planReverseDns(cidr('10.1.0.0/20'), NS);
    expect(p20.childZones).toHaveLength(16);
    expect(p20.childZones[0].name).toBe('0.1.10.in-addr.arpa.');
    expect(p20.childZones[15].name).toBe('15.1.10.in-addr.arpa.');
    expect(p20.parentZone).toBe('1.10.in-addr.arpa.');

    const p23 = planReverseDns(cidr('192.0.2.0/23'), NS);
    expect(p23.childZones.map((z) => z.name)).toEqual([
      '2.0.192.in-addr.arpa.',
      '3.0.192.in-addr.arpa.',
    ]);

    const p17 = planReverseDns(cidr('10.0.0.0/17'), NS);
    expect(p17.childZones).toHaveLength(128);
  });

  it('区域集合精确覆盖子网且按数值地址升序', () => {
    const plan = planReverseDns(cidr('10.1.0.0/20'), NS);
    const sorted = [...plan.childZones].sort((a, b) => a.firstAddr - b.firstAddr);
    expect(plan.childZones).toEqual(sorted);
    expect(plan.childZones[0].firstAddr).toBe(cidr('10.1.0.0/20').base);
    // 每区一个 /24，首区首地址 + 16×256 - 1 = 末区末地址
    expect(plan.childZones[15].lastAddr - plan.childZones[0].firstAddr + 1).toBe(16 * 256);
    // 父区记录按区地址升序、每区连续列出全部 NS
    expect(plan.parentRecords).toHaveLength(16 * 2);
    expect(plan.parentRecords[0]).toContain('0.1.10.in-addr.arpa.');
    expect(plan.parentRecords[2]).toContain('1.1.10.in-addr.arpa.');
  });
});

describe('RFC 2317：/25～/31', () => {
  it('/25 生成父区 NS 委派、128 条 CNAME 与子区名', () => {
    const plan = planReverseDns(cidr('192.0.2.0/25'), NS);
    expect(plan.kind).toBe('rfc2317');
    expect(plan.parentZone).toBe('2.0.192.in-addr.arpa.');
    expect(plan.childZones.map((z) => z.name)).toEqual(['0-127.2.0.192.in-addr.arpa.']);
    // 2 条 NS + 128 条 CNAME
    expect(plan.parentRecords).toHaveLength(2 + 128);
    expect(plan.parentRecords[0]).toBe('0-127.2.0.192.in-addr.arpa. 3600 IN NS ns1.example.com.');
    expect(plan.parentRecords[2]).toBe(
      '0.2.0.192.in-addr.arpa. 3600 IN CNAME 0.0-127.2.0.192.in-addr.arpa.',
    );
    expect(plan.parentRecords[129]).toBe(
      '127.2.0.192.in-addr.arpa. 3600 IN CNAME 127.0-127.2.0.192.in-addr.arpa.',
    );
  });

  it('/25 上半段与 /26 使用首末地址命名子区', () => {
    const upper = planReverseDns(cidr('192.0.2.128/25'), NS);
    expect(upper.childZones[0].name).toBe('128-255.2.0.192.in-addr.arpa.');
    expect(upper.parentRecords[2]).toBe(
      '128.2.0.192.in-addr.arpa. 3600 IN CNAME 128.128-255.2.0.192.in-addr.arpa.',
    );

    const p26 = planReverseDns(cidr('192.0.2.64/26'), NS);
    expect(p26.childZones[0].name).toBe('64-127.2.0.192.in-addr.arpa.');
    expect(p26.parentRecords).toHaveLength(2 + 64);
  });

  it('/30、/31 覆盖子网全部地址（含网络与广播地址）', () => {
    const p30 = planReverseDns(cidr('10.0.0.0/30'), NS);
    expect(p30.childZones[0].name).toBe('0-3.0.0.10.in-addr.arpa.');
    expect(p30.parentRecords).toHaveLength(2 + 4);

    const p31 = planReverseDns(cidr('10.0.0.8/31'), NS);
    expect(p31.childZones[0].name).toBe('8-9.0.0.10.in-addr.arpa.');
    expect(p31.parentRecords).toHaveLength(2 + 2);
    expect(p31.parentRecords[2]).toBe(
      '8.0.0.10.in-addr.arpa. 3600 IN CNAME 8.8-9.0.0.10.in-addr.arpa.',
    );
    expect(p31.parentRecords[3]).toBe(
      '9.0.0.10.in-addr.arpa. 3600 IN CNAME 9.8-9.0.0.10.in-addr.arpa.',
    );
  });

  it('CNAME 精确覆盖子网每个地址且按数值升序', () => {
    const c = cidr('192.0.2.96/27');
    const plan = planReverseDns(c, NS);
    const cnames = plan.parentRecords.filter((r) => r.includes(' CNAME '));
    expect(cnames).toHaveLength(32);
    cnames.forEach((line, i) => {
      const d = 96 + i;
      expect(line).toBe(
        `${d}.2.0.192.in-addr.arpa. 3600 IN CNAME ${d}.96-127.2.0.192.in-addr.arpa.`,
      );
    });
  });
});

describe('/32：单条 PTR 所有者提示', () => {
  it('生成 PTR 所有者名与所属 /24 区，无委派记录与子区', () => {
    const plan = planReverseDns(cidr('192.0.2.5/32'), []);
    expect(plan.kind).toBe('ptr');
    expect(plan.ptrOwner).toBe('5.2.0.192.in-addr.arpa.');
    expect(plan.parentZone).toBe('2.0.192.in-addr.arpa.');
    expect(plan.parentRecords).toEqual([]);
    expect(plan.childZones).toEqual([]);
  });

  it('边界地址 0.0.0.0/32 与 255.255.255.255/32', () => {
    expect(planReverseDns(cidr('0.0.0.0/32'), []).ptrOwner).toBe('0.0.0.0.in-addr.arpa.');
    const top = planReverseDns(cidr('255.255.255.255/32'), []);
    expect(top.ptrOwner).toBe('255.255.255.255.in-addr.arpa.');
    expect(top.parentZone).toBe('255.255.255.in-addr.arpa.');
  });
});

describe('生成门槛：NS 非法或缺失时不生成', () => {
  it('任一 NS 非法则不生成结果', () => {
    const { errors, result } = generateReverseDns(
      cidr('10.0.0.0/24'),
      'ns1.example.com.\nno-dot\nns2.example.com.',
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('第 2 行');
    expect(result).toBeNull();
  });

  it('非 /32 未填写 NS 时报错且不生成', () => {
    for (const c of ['0.0.0.0/0', '10.0.0.0/8', '10.1.0.0/20', '192.0.2.0/24', '192.0.2.0/25', '10.0.0.8/31']) {
      const { errors, result } = generateReverseDns(cidr(c), '  \n');
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain('至少填写一个权威 NS');
      expect(result).toBeNull();
    }
  });

  it('/32 可留空 NS；填写非法 NS 仍不生成', () => {
    const ok = generateReverseDns(cidr('192.0.2.5/32'), '');
    expect(ok.errors).toEqual([]);
    expect(ok.result?.plan.ptrOwner).toBe('5.2.0.192.in-addr.arpa.');

    const bad = generateReverseDns(cidr('192.0.2.5/32'), 'no-dot');
    expect(bad.errors).toHaveLength(1);
    expect(bad.result).toBeNull();
  });

  it('NS 合法时正常生成', () => {
    const { errors, result } = generateReverseDns(cidr('192.0.2.0/24'), NS_TEXT);
    expect(errors).toEqual([]);
    expect(result).not.toBeNull();
  });
});

describe('BIND 片段格式化', () => {
  it('区片段：父区 NS 记录 + 子区声明与区文件 NS 注释', () => {
    const plan = planReverseDns(cidr('192.0.2.0/24'), NS);
    const s = formatReverseDns(cidr('192.0.2.0/24'), plan, NS);
    expect(s.parentText).toContain('父区 0.192.in-addr.arpa.');
    expect(s.parentText).toContain('2.0.192.in-addr.arpa. 3600 IN NS ns1.example.com.');
    expect(s.childText).toContain('zone "2.0.192.in-addr.arpa" { type master; file "db.2.0.192.in-addr.arpa"; };');
    expect(s.childText).toContain('; @ 3600 IN NS ns1.example.com.');
    expect(s.childText).toContain('; @ 3600 IN NS ns2.example.com.');
    expect(s.fullText).toBe(`${s.parentText}\n\n${s.childText}`);
    expect(s.ptrText).toBe('');
  });

  it('拆分区片段：子区声明按数值地址升序', () => {
    const plan = planReverseDns(cidr('10.1.0.0/20'), NS);
    const s = formatReverseDns(cidr('10.1.0.0/20'), plan, NS);
    const zoneLines = s.childText.split('\n').filter((l) => l.startsWith('zone '));
    expect(zoneLines).toHaveLength(16);
    expect(zoneLines[0]).toContain('zone "0.1.10.in-addr.arpa"');
    expect(zoneLines[15]).toContain('zone "15.1.10.in-addr.arpa"');
    expect(s.childText).toContain('需创建的子区（16 个）');
  });

  it('RFC 2317 片段：父区记录含 NS 与全部 CNAME，子区为委派子区', () => {
    const plan = planReverseDns(cidr('192.0.2.0/25'), NS);
    const s = formatReverseDns(cidr('192.0.2.0/25'), plan, NS);
    expect(s.parentText).toContain('RFC 2317');
    expect(s.parentText).toContain('覆盖子网全部 128 个地址');
    expect(s.parentText).toContain('0-127.2.0.192.in-addr.arpa. 3600 IN NS ns1.example.com.');
    expect(s.parentText).toContain(
      '0.2.0.192.in-addr.arpa. 3600 IN CNAME 0.0-127.2.0.192.in-addr.arpa.',
    );
    expect(s.childText).toContain('zone "0-127.2.0.192.in-addr.arpa"');
  });

  it('/32 片段：PTR 所有者提示，无父区记录与子区段', () => {
    const plan = planReverseDns(cidr('192.0.2.5/32'), []);
    const s = formatReverseDns(cidr('192.0.2.5/32'), plan, []);
    expect(s.ptrText).toContain('所属区 2.0.192.in-addr.arpa.');
    expect(s.ptrText).toContain('5.2.0.192.in-addr.arpa. 3600 IN PTR <主机名.>');
    expect(s.parentText).toBe('');
    expect(s.childText).toBe('');
    expect(s.fullText).toBe(s.ptrText);
  });
});
