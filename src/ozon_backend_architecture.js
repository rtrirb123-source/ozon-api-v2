const MODULES = Object.freeze([
  { key: "products", name: "商品", source: "Ozon Seller API", status: "connected", automation: "商品、库存、内容基础数据已接入", writePolicy: "写入锁定" },
  { key: "pricing", name: "价格和促销", source: "Seller API + Seller后台核验", status: "partial", automation: "后台利润价、买家到手价、竞品价分口径处理；促销仅生成审核建议", writePolicy: "写入锁定" },
  { key: "fbo", name: "FBO", source: "Seller API + Seller后台补充", status: "gap", automation: "需补充集群缺货、无库存天数、建议补货量和本地销售占比", writePolicy: "只读规划" },
  { key: "fbs", name: "FBS", source: "Seller API", status: "partial", automation: "已有订单与库存基础；需补充备货截止时间、逾期风险和仓库维度", writePolicy: "只读预警" },
  { key: "finance", name: "财务", source: "Finance API", status: "connected", automation: "佣金、物流、退货、广告及实际结算费用进入利润模型", writePolicy: "只读" },
  { key: "analytics", name: "分析", source: "Analytics API + Seller后台核验", status: "partial", automation: "需补充曝光→详情→加购→订单→购买漏斗和缺货损失", writePolicy: "只读" },
  { key: "customers", name: "买家", source: "Seller后台", status: "gap", automation: "买家分群与触达尚未接入；不得自动群发", writePolicy: "人工审核" },
  { key: "advertising", name: "推广", source: "Performance API + Seller后台核验", status: "partial", automation: "商品广告、非商品推广工具、外部引流追踪分开统计", writePolicy: "写入锁定" },
  { key: "bank", name: "银行", source: "Seller后台", status: "excluded", automation: "融资、提前付款和银行业务不纳入自动运营", writePolicy: "禁止自动操作" },
]);

const AUDIT = Object.freeze({
  observedAt: "2026-08-04T00:00:00+08:00",
  source: "紫鸟俄罗斯住宅IP只读巡查 Ozon Seller",
  volatile: true,
  facts: [
    "商品67个：销售中54个、准备销售13个、错误0个",
    "FBO在26个集群有库存，过去28天存在20个无库存日，后台给出集群补货建议",
    "FBS当前存在等待备货订单，自动系统需要备货截止时间预警",
    "分析页显示带推广商品占比0%，广告费用份额4.2%；两者不能当作广告活动数量",
    "促销营业额占比100%，促销与广告必须分开评估",
    "后台推广工具包括按点击、按订单、媒体广告、精选商品集、外部推广和平台促销",
  ],
});

function overview() {
  const counts = MODULES.reduce((result, item) => {
    result[item.status] = (result[item.status] || 0) + 1;
    return result;
  }, {});
  return { modules: MODULES, audit: AUDIT, summary: { total: MODULES.length, ...counts } };
}

module.exports = { MODULES, AUDIT, overview };
