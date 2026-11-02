// 栏目页（成人、黄果、直播）把搜索词、源站、分类和页码写进地址栏。
// 去播放页再按返回时，浏览器回到的是带这些参数的地址，页面据此恢复原来的列表，
// 而不是默认列表。页面状态仍然放在组件里，地址只是跟着它走一份。
// 值为空的参数不写，所以默认状态下地址还是干净的 /adult。
export function sectionQuery(
  entries: ReadonlyArray<readonly [string, string]>
): string {
  const params = new URLSearchParams();
  for (const [key, value] of entries) {
    if (value) params.set(key, value);
  }
  return params.toString();
}
