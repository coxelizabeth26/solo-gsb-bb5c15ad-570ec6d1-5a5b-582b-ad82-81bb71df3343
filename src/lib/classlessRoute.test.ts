import { describe, expect, it } from 'vitest';
import { ipv4ToLong, parseCidr } from './ip';
import {
  byteToHex,
  decodeClasslessHex,
  encodeClasslessRoutes,
  encodeRoute,
  formatRouteLines,
  parseClasslessRoutes,
  significantOctets,
} from './classlessRoute';

const cidr = (s: string) => parseCidr(s)!;
const subnet = cidr('10.0.0.0/24');

describe('RFC 3442 有效字节数', () => {
  it('ceil(前缀/8)，/0 为 0', () => {
    expect([0, 1, 7, 8, 9, 16, 17, 24, 25, 32].map(significantOctets)).toEqual([
      0, 1, 1, 1, 2, 2, 3, 3, 4, 4,
    ]);
  });
});

describe('路由行解析', () => {
  it('合法行全部通过，空行忽略', () => {
    const { routes, errors } = parseClasslessRoutes(
      subnet,
      '192.168.1.0/24,10.0.0.1\n\n  \n0.0.0.0/0,10.0.0.254\n',
    );
    expect(errors).toEqual([]);
    expect(routes).toHaveLength(2);
    expect(routes[0].target.base).toBe(cidr('192.168.1.0/24').base);
    expect(routes[1].target.prefix).toBe(0);
  });

  it('格式错误：缺字段、多字段、空字段', () => {
    const { errors } = parseClasslessRoutes(
      subnet,
      '192.168.1.0/24\n192.168.1.0/24,10.0.0.1,10.0.0.2\n192.168.1.0/24,\n,10.0.0.1',
    );
    expect(errors).toHaveLength(4);
    expect(errors.every((e) => e.includes('格式应为'))).toBe(true);
  });

  it('目标必须合法且对齐', () => {
    const { errors, routes } = parseClasslessRoutes(
      subnet,
      '192.168.1.10/24,10.0.0.1\n300.1.0.0/24,10.0.0.1\nabc/24,10.0.0.1',
    );
    expect(routes).toEqual([]);
    expect(errors).toHaveLength(3);
    expect(errors[0]).toContain('未对齐');
    expect(errors[0]).toContain('应为 192.168.1.0/24');
    expect(errors[1]).toContain('目标 CIDR 非法');
    expect(errors[2]).toContain('目标 CIDR 非法');
  });

  it('下一跳必须为合法 IPv4 且在子网可用主机范围内', () => {
    const { errors } = parseClasslessRoutes(
      subnet,
      ['10.1.0.0/16,10.0.0.0', '10.1.0.0/16,10.0.0.255', '10.1.0.0/16,10.0.1.1', '10.1.0.0/16,abc'].join(
        '\n',
      ),
    );
    expect(errors).toHaveLength(4);
    expect(errors[0]).toContain('不在'); // 网络地址（/24 可用范围 .1-.254）
    expect(errors[1]).toContain('不在'); // 广播地址
    expect(errors[2]).toContain('不在'); // 出网
    expect(errors[3]).toContain('不是合法 IPv4');
  });

  it('/31 与 /32 的下一跳范围沿用可用主机规则', () => {
    expect(parseClasslessRoutes(cidr('10.0.0.0/31'), '0.0.0.0/0,10.0.0.0').errors).toEqual([]);
    expect(parseClasslessRoutes(cidr('10.0.0.7/32'), '0.0.0.0/0,10.0.0.7').errors).toEqual([]);
    expect(parseClasslessRoutes(cidr('10.0.0.0/31'), '0.0.0.0/0,10.0.0.2').errors[0]).toContain(
      '不在',
    );
  });

  it('重复目标按行报错', () => {
    const { errors, routes } = parseClasslessRoutes(
      subnet,
      '10.1.0.0/16,10.0.0.1\n10.1.0.0/16,10.0.0.2',
    );
    expect(routes).toHaveLength(1);
    expect(errors).toEqual(['第 2 行：目标 10.1.0.0/16 重复（同一目标只能出现一次）']);
  });

  it('目标可与子网相同，不同下一跳不视为重复', () => {
    const { errors, routes } = parseClasslessRoutes(
      subnet,
      '10.0.0.0/24,10.0.0.1\n10.0.0.0/25,10.0.0.2',
    );
    expect(errors).toEqual([]);
    expect(routes).toHaveLength(2);
  });
});

describe('RFC 3442 编码', () => {
  it('单条路由：前缀长度 + 有效目标字节 + 4 字节下一跳', () => {
    const { routes } = parseClasslessRoutes(subnet, '10.0.0.0/8,10.0.0.1');
    const enc = encodeRoute(routes[0]);
    expect(enc.prefixByte).toBe(8);
    expect(enc.targetBytes).toEqual([10]);
    expect(enc.gatewayBytes).toEqual([10, 0, 0, 1]);
    expect(enc.bytes).toEqual([8, 10, 10, 0, 0, 1]);
    expect(byteToHex(8)).toBe('08');
  });

  it('/0 默认路由不输出任何目标字节', () => {
    const { routes } = parseClasslessRoutes(subnet, '0.0.0.0/0,10.0.0.1');
    expect(encodeRoute(routes[0]).bytes).toEqual([0, 10, 0, 0, 1]);
  });

  it('前缀跨字节边界时只取有效高位字节', () => {
    const { routes } = parseClasslessRoutes(subnet, '192.168.1.128/25,10.0.0.254');
    const enc = encodeRoute(routes[0]);
    expect(enc.bytes).toEqual([25, 192, 168, 1, 128, 10, 0, 0, 254]);
  });

  it('按目标地址、前缀排序后输出', () => {
    const { routes } = parseClasslessRoutes(subnet, [
      '192.168.1.0/24,10.0.0.1',
      '0.0.0.0/0,10.0.0.2',
      '10.0.0.0/8,10.0.0.3',
      '10.0.0.0/16,10.0.0.4',
      '10.0.0.0/24,10.0.0.5',
    ].join('\n'));
    const result = encodeClasslessRoutes(routes);
    expect(result.entries.map((e) => `${e.route.target.base}/${e.route.target.prefix}`)).toEqual([
      '0/0',
      '167772160/8',
      '167772160/16',
      '167772160/24',
      '3232235776/24',
    ]);
    // /0(5B) + /8(6B) + /16(7B) + /24(8B) + 另一个 /24(8B) = 34B = 68 hex
    expect(result.hex).toBe(
      '000A000002' +
        '080A0A000003' +
        '100A000A000004' +
        '180A00000A000005' +
        '18C0A8010A000001',
    );
    expect(result.bytes).toHaveLength(34);
  });
});

describe('十六进制反向解码', () => {
  const encode = (text: string) => {
    const r = parseClasslessRoutes(subnet, text);
    return encodeClasslessRoutes(r.routes).hex;
  };

  it('合法串往返：解码出同样的路由', () => {
    const hex = encode('192.168.1.128/25,10.0.0.254\n0.0.0.0/0,10.0.0.1');
    const dec = decodeClasslessHex(hex);
    if ('error' in dec) throw new Error(dec.error);
    expect(dec.routes).toHaveLength(2);
    // 编码后已按地址排序，/0 在前
    expect(dec.routes[0].target).toEqual({ base: 0, prefix: 0 });
    expect(dec.routes[0].gateway).toBe(ipv4ToLong('10.0.0.1')!);
    expect(dec.routes[1].target).toEqual({ base: parseCidr('192.168.1.128/25')!.base, prefix: 25 });
    expect(formatRouteLines(dec.routes)).toBe('0.0.0.0/0,10.0.0.1\n192.168.1.128/25,10.0.0.254');
  });

  it('接受冒号/空格分隔与 0x 前缀及小写', () => {
    const hex = '00:0a:00:00:01';
    const dec = decodeClasslessHex(hex);
    if ('error' in dec) throw new Error(dec.error);
    expect(dec.routes[0]).toEqual({ target: { base: 0, prefix: 0 }, gateway: ipv4ToLong('10.0.0.1')! });
    expect(decodeClasslessHex('0x00 0a 00 00 01')).not.toHaveProperty('error');
    expect(decodeClasslessHex('000a000001')).not.toHaveProperty('error');
  });

  it('拒绝奇数位、非十六进制字符与空输入', () => {
    expect((decodeClasslessHex('00a') as { error: string }).error).toContain('奇数');
    expect((decodeClasslessHex('zz00') as { error: string }).error).toContain('非十六进制');
    expect(decodeClasslessHex('   ')).toHaveProperty('error');
  });

  it('拒绝前缀长度 > 32', () => {
    expect((decodeClasslessHex('210000000000000000') as { error: string }).error).toContain(
      '不能超过 32',
    );
  });

  it('拒绝截断：目标有效字节不足、下一跳不足、结尾多余字节', () => {
    // /16 需要 2 个目标字节，前缀后仅 1 字节
    expect((decodeClasslessHex('10C0') as { error: string }).error).toContain('截断');
    // 目标完整但下一跳只有 1 字节
    expect((decodeClasslessHex('10C0A80000') as { error: string }).error).toContain('截断');
    // 下一跳只有 3 字节
    expect((decodeClasslessHex('000A0000') as { error: string }).error).toContain('截断');
    // 完整 /0 路由后多 1 字节（被当作第二条路由的前缀长度 255）
    expect((decodeClasslessHex('000A000001FF') as { error: string }).error).toMatch(
      /截断|不能超过 32/,
    );
  });

  it('拒绝冗余目标字节：目标网络写满 4 字节的非规范编码', () => {
    // 两条「1 前缀 + 4 目标 + 4 下一跳」= 18 字节
    const legacy =
      '180A000000' + '0A000001' +
      '18C0A80100' + '0A000002';
    const dec = decodeClasslessHex(legacy);
    expect(dec).toHaveProperty('error');
    expect((dec as { error: string }).error).toContain('冗余字节');
  });

  it('/32 写 4 个目标字节是 RFC 合法编码，不误报', () => {
    // /32 有效字节数本就是 4
    const hex = '200A0000010A0000FE';
    const dec = decodeClasslessHex(hex);
    if ('error' in dec) throw new Error(dec.error);
    expect(dec.routes[0].target).toEqual({ base: ipv4ToLong('10.0.0.1')!, prefix: 32 });
  });

  it('拒绝非规范网络位（主机位非零）', () => {
    // /12 有效字节 2：0A 01 中低 4 位非零（10.1.0.0/12 非规范，应为 10.0.0.0/12）
    const dec = decodeClasslessHex('0C0A010A000001');
    expect(dec).toHaveProperty('error');
    expect((dec as { error: string }).error).toContain('非规范网络位');
    expect((dec as { error: string }).error).toContain('10.0.0.0/12');
  });

  it('解码后的拆解字节与重新编码一致', () => {
    const hex = encode('172.16.10.0/24,10.0.0.5\n172.16.0.0/16,10.0.0.6');
    const dec = decodeClasslessHex(hex);
    if ('error' in dec) throw new Error(dec.error);
    const re = encodeClasslessRoutes(dec.routes);
    expect(re.hex).toBe(hex);
    expect(dec.entries.map((e) => e.bytes)).toEqual(re.entries.map((e) => e.bytes));
  });
});
