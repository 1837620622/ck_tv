// 查询域名解析出的全部地址，供 Docker（Node 运行时）下的出站请求做内网检查。
// 查询走系统解析器，和 fetch 实际连接用的是同一条解析路径。
// 边缘运行时没有 node:dns，所以只在调用方判断 DOCKER_ENV=true 之后才会走到这里。

type DnsPromises = {
  lookup: (
    host: string,
    options: { all: true; verbatim: true }
  ) => Promise<{ address: string }[]>;
};

async function loadDnsPromises(): Promise<DnsPromises> {
  // Node 20.16+、22.3+ 可以直接取内建模块，打包器也不会去解析这个字符串
  const getBuiltinModule = (
    process as { getBuiltinModule?: (id: string) => unknown }
  ).getBuiltinModule;
  if (typeof getBuiltinModule === 'function') {
    const mod = getBuiltinModule('node:dns/promises');
    if (mod) return mod as DnsPromises;
  }
  // 更老的 Node 只能动态 import；用 Function 包一层，让打包器不去解析 node:dns
  const load = new Function('specifier', 'return import(specifier)') as (
    specifier: string
  ) => Promise<DnsPromises>;
  return load('node:dns/promises');
}

export async function nodeResolve(host: string): Promise<string[]> {
  const dns = await loadDnsPromises();
  const records = await dns.lookup(host, { all: true, verbatim: true });
  return records.map((record) => record.address);
}
