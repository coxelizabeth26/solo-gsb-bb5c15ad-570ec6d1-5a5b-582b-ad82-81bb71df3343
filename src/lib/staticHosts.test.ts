import { describe, expect, it } from 'vitest';
import { formatHostsText, isValidHostname, planStaticHosts } from './staticHosts';
import { longToIpv4, parseCidr } from './ip';

const cidr = (s: string) => parseCidr(s)!;

/** 行号 → 结果地址字符串（ok 行），nospace/invalid 行为 null */
const addrByRow = (text: string, subnet = '10.0.0.0/24') => {
  const plan = planStaticHosts(cidr(subnet), text);
  return new Map(plan.lines.map((l) => [l.row, l.addr === null ? null : longToIpv4(l.addr)]));
};

describe('主机名校验', () => {
  it('接受合法 LDH 主机名', () => {
    expect(isValidHostname('web')).toBe(true);
    expect(isValidHostname('web-01')).toBe(true);
    expect(isValidHostname('web01.example.com')).toBe(true);
    expect(isValidHostname('a')).toBe(true);
    expect(isValidHostname('WEB-01')).toBe(true);
  });

  it('拒绝非法主机名', () => {
    expect(isValidHostname('')).toBe(false);
    expect(isValidHostname('-web')).toBe(false);
    expect(isValidHostname('web-')).toBe(false);
    expect(isValidHostname('web_01')).toBe(false);
    expect(isValidHostname('web..example.com')).toBe(false);
    expect(isValidHostname('a'.repeat(64))).toBe(false); // 单标签超 63
    expect(isValidHostname(`${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(62)}`)).toBe(false); // 全长超 253
  });
});

describe('逐行解析', () => {
  it('空行忽略，合法行全部通过', () => {
    const plan = planStaticHosts(cidr('10.0.0.0/24'), 'web 10.0.0.10\n\n  \ndb auto\n');
    expect(plan.lines).toHaveLength(2);
    expect(plan.ok).toBe(true);
  });

  it('格式非法：列数不对、主机名非法、地址非法', () => {
    const plan = planStaticHosts(
      cidr('10.0.0.0/24'),
      'onlyname\nweb 10.0.0.1 extra\nbad_host 10.0.0.2\nweb 10.0.0.300\nweb 10.0.0.0/24',
    );
    expect(plan.ok).toBe(false);
    expect(plan.lines).toHaveLength(5);
    for (const l of plan.lines) expect(l.status).toBe('invalid');
    expect(plan.lines[3].reason).toContain('IPv4');
    expect(plan.lines[4].reason).toContain('IPv4');
  });

  it('auto 关键字大小写不敏感', () => {
    const plan = planStaticHosts(cidr('10.0.0.0/24'), 'a AUTO\nb Auto\n');
    expect(plan.ok).toBe(true);
    expect(plan.lines.every((l) => l.mode === 'auto')).toBe(true);
  });

  it('行号按物理行计入（含空行）', () => {
    const plan = planStaticHosts(cidr('10.0.0.0/24'), '\n\nbad line here');
    expect(plan.lines).toHaveLength(1);
    expect(plan.lines[0].row).toBe(3);
  });
});

describe('指定地址校验', () => {
  it('指定地址越界记为非法', () => {
    const plan = planStaticHosts(cidr('10.0.0.0/24'), 'web 10.0.1.5\nweb2 9.9.9.9');
    expect(plan.lines.every((l) => l.status === 'invalid')).toBe(true);
    expect(plan.lines[0].reason).toContain('不在子网内');
  });

  it('/0～/30 排除网络地址与广播地址', () => {
    const plan = planStaticHosts(cidr('10.0.0.0/24'), 'a 10.0.0.0\nb 10.0.0.255\nc 10.0.0.1');
    expect(plan.lines[0].status).toBe('invalid');
    expect(plan.lines[0].reason).toContain('网络地址');
    expect(plan.lines[1].status).toBe('invalid');
    expect(plan.lines[1].reason).toContain('广播地址');
    expect(plan.lines[2].status).toBe('ok');
  });

  it('/31、/32 沿用可用主机规则，不额外排除', () => {
    const p31 = planStaticHosts(cidr('10.0.0.0/31'), 'a 10.0.0.0\nb 10.0.0.1');
    expect(p31.ok).toBe(true);
    const p32 = planStaticHosts(cidr('10.0.0.7/32'), 'a 10.0.0.7');
    expect(p32.ok).toBe(true);
    const p32bad = planStaticHosts(cidr('10.0.0.7/32'), 'a 10.0.0.8');
    expect(p32bad.lines[0].status).toBe('invalid');
  });

  it('指定地址重复占用：首次保留，后续记为非法', () => {
    const plan = planStaticHosts(cidr('10.0.0.0/24'), 'a 10.0.0.5\nb 10.0.0.5\nc 10.0.0.5');
    expect(plan.lines[0].status).toBe('ok');
    expect(plan.lines[1].status).toBe('invalid');
    expect(plan.lines[1].reason).toContain('第 1 行');
    expect(plan.lines[2].status).toBe('invalid');
  });

  it('主机名重复（大小写不敏感）记为非法', () => {
    const plan = planStaticHosts(cidr('10.0.0.0/24'), 'Web 10.0.0.5\nweb auto\nWEB 10.0.0.9');
    expect(plan.lines[0].status).toBe('ok');
    expect(plan.lines[1].status).toBe('invalid');
    expect(plan.lines[1].reason).toContain('主机名');
    expect(plan.lines[2].status).toBe('invalid');
  });
});

describe('auto 安置', () => {
  it('安置到最低可用主机地址，避开网络/广播地址', () => {
    const plan = planStaticHosts(cidr('10.0.0.0/29'), 'a auto\nb auto\nc auto');
    expect(plan.ok).toBe(true);
    const got = plan.lines.map((l) => l.addr! & 255);
    expect(got).toEqual([1, 2, 3]);
  });

  it('先整体预留指定地址：前序 auto 不抢占后续指定地址', () => {
    // /30 可用 .1 .2；若按行序直接安置，a 会抢走 .1 使 b 冲突
    const plan = planStaticHosts(cidr('10.0.0.0/30'), 'a auto\nb 10.0.0.1');
    expect(plan.ok).toBe(true);
    expect(plan.lines[0].addr! & 255).toBe(2);
    expect(plan.lines[1].addr! & 255).toBe(1);
  });

  it('auto 按输入顺序取最低可用地址并跳过指定占用', () => {
    const plan = planStaticHosts(
      cidr('10.0.0.0/29'),
      'c auto\nb auto\na 10.0.0.2\nd auto',
    );
    expect(plan.ok).toBe(true);
    const byName = new Map(plan.lines.map((l) => [l.hostname, l.addr! & 255]));
    expect(byName.get('c')).toBe(1);
    expect(byName.get('a')).toBe(2);
    expect(byName.get('b')).toBe(3);
    expect(byName.get('d')).toBe(4);
  });

  it('可用地址耗尽记为空间不足', () => {
    const plan = planStaticHosts(cidr('10.0.0.0/30'), 'a auto\nb auto\nc auto');
    expect(plan.ok).toBe(false);
    expect(plan.lines[2].status).toBe('nospace');
    expect(plan.lines[2].reason).toContain('空间不足');

    const full = planStaticHosts(cidr('10.0.0.0/30'), 'a 10.0.0.1\nb 10.0.0.2\nc auto');
    expect(full.lines[2].status).toBe('nospace');
  });

  it('/31 恰可容纳两台，/32 恰可容纳一台', () => {
    expect(planStaticHosts(cidr('10.0.0.0/31'), 'a auto\nb auto').ok).toBe(true);
    expect(planStaticHosts(cidr('10.0.0.0/31'), 'a auto\nb auto\nc auto').lines[2].status).toBe('nospace');
    expect(planStaticHosts(cidr('10.0.0.9/32'), 'a auto').lines[0].addr! & 255).toBe(9);
    expect(planStaticHosts(cidr('10.0.0.9/32'), 'a auto\nb auto').lines[1].status).toBe('nospace');
  });

  it('非法行不参与占用，但整体不可导出', () => {
    const plan = planStaticHosts(cidr('10.0.0.0/30'), 'bad line\na auto\nb auto');
    expect(plan.ok).toBe(false);
    expect(plan.lines[1].status).toBe('ok');
    expect(plan.lines[2].status).toBe('ok');
  });
});

describe('整体判定与 hosts 文本', () => {
  it('空输入不可导出', () => {
    expect(planStaticHosts(cidr('10.0.0.0/24'), '').ok).toBe(false);
    expect(planStaticHosts(cidr('10.0.0.0/24'), '\n  \n').ok).toBe(false);
  });

  it('任一非法或空间不足行均不可导出', () => {
    expect(planStaticHosts(cidr('10.0.0.0/24'), 'a bad_ip').ok).toBe(false);
    expect(planStaticHosts(cidr('10.0.0.9/32'), 'a auto\nb auto').ok).toBe(false);
  });

  it('hosts 文本按地址升序，每行「IPv4 主机名」', () => {
    const plan = planStaticHosts(
      cidr('10.0.0.0/24'),
      'zeta 10.0.0.200\nalpha auto\nmid 10.0.0.50\nbeta auto',
    );
    expect(plan.ok).toBe(true);
    expect(formatHostsText(plan)).toBe(
      '10.0.0.1 alpha\n10.0.0.2 beta\n10.0.0.50 mid\n10.0.0.200 zeta',
    );
  });

  it('addrByRow 辅助：端到端地址核对', () => {
    const got = addrByRow('a auto\nb 10.0.0.1\nc auto', '10.0.0.0/30');
    expect(got.get(1)).toBe('10.0.0.2');
    expect(got.get(2)).toBe('10.0.0.1');
    expect(got.get(3)).toBeNull(); // nospace
  });
});
