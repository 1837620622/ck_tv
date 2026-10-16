// 栏目口令和签名密钥。
//
// 这个仓库是公开的，所以这里的口令任何人都能看到。写在这里，是为了部署时不用配置任何环境变量。
// - 换口令：改 GATE_PASSWORD，提交并重新部署。已经通过的 cookie 在 7 天内仍然有效。
// - 换签名密钥：改 GATE_SIGNING_KEY，提交并重新部署。所有人都要重新输入口令。
// 签名密钥只用来签 cookie，至少 32 个字符，不要和口令相同。

export const GATE_PASSWORD = 'cknb666';

export const GATE_SIGNING_KEY =
  '978ac099b3e77bae1e8293c853e5b3ceed7f60fa65c3b0791a821962bd897636';
