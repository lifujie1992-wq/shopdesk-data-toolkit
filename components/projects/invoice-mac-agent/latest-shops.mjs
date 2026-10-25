// User policy: resolve execution against the current Shopdesk login list.
// A workbench UUID identifies a local login entry, not a permanent platform shop.
export class ShopResolutionError extends Error {
  constructor(message, retryable = true) { super(message); this.retryable = retryable; }
}
const nameOf = value => String(value || '').trim();
export function resolveLatestShop(shops, payload) {
  if (!Array.isArray(shops)) throw new ShopResolutionError('shopdesk最新店铺列表格式无效');
  const byId = shops.filter(s => s.id === payload.shopId);
  if (byId.length > 1) throw new ShopResolutionError('shopdesk店铺ID重复，无法唯一定位');
  const name = nameOf(payload.shopName);
  const byName = name ? shops.filter(s => s.platform === '抖店' && nameOf(s.name) === name) : [];
  if (byId.length) {
    const shop = byId[0];
    if (shop.platform !== '抖店') throw new ShopResolutionError(`任务店铺不是抖店: ${shop.name || payload.shopId}`, false);
    if (name && nameOf(shop.name) !== name && byName.length) throw new ShopResolutionError('任务ID与店名在shopdesk最新清单中指向不同店铺，拒绝自动选店', false);
    return {shop, matchedBy: 'current_id'};
  }
  if (byName.length > 1) throw new ShopResolutionError(`shopdesk存在多个同名登录，无法唯一定位: ${name}`);
  if (byName.length === 1 && typeof byName[0].id === 'string' && byName[0].id) return {shop: byName[0], matchedBy: 'unique_current_name'};
  throw new ShopResolutionError(`shopdesk最新清单暂未找到任务店铺: ${name || payload.shopId}`);
}
