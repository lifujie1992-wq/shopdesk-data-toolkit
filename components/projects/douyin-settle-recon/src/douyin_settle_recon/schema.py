"""Template column names are the canonical fields, independent of column order."""
from .qianchuan import COLUMNS as QIANCHUAN_COLUMNS
FUND_COLUMNS = ['动账时间','动帐流水号','动账方向','动账金额','动账账户','动账场景','计费类型',
'子订单号','订单号','售后编号','下单时间','商品ID','商品名称','达人ID','达人名称','订单类型',
'订单实付应结','运费实付','实际平台补贴_运费','实际平台补贴','其他平台补贴','以旧换新抵扣',
'政府补贴平台垫资','实际达人补贴','实际抖音支付补贴','实际抖音月付营销补贴','银行补贴',
'订单退款','平台服务费','佣金','服务商佣金','渠道分成','招商服务费','站外推广费','其他分成',
'是否免佣','免佣金额','商户主体名称','备注']
ALIASES = {'动账流水号':'动帐流水号','店铺劵':'店铺券','运费':'运费实付',
'实际平台补贴运费':'实际平台补贴_运费','实际抖音月付（原DOU分期）营销补贴':'实际抖音月付营销补贴'}
ID_FIELDS = {'动帐流水号','动账流水号','子订单号','订单号','售后编号','商品ID','达人ID',
'操作单号','关联订单号','关联子订单号','交易单号','流水号','单号'}
DATE_FIELDS = {'动账时间','结算时间','下单时间','操作时间','交易时间','创建时间','完成时间','业务时间'}
AMOUNT_FIELDS = set(FUND_COLUMNS[16:35] + ['动账金额','动账金额(元)','冻结金额(元)','账户余额(元)','冻结总额(元)','免佣金额','结算金额','操作金额','交易金额','金额',
'订单总价','商品总价','运费','店铺券','店铺劵','政府补贴商家垫资','结算前退款金额','平台补贴',
'达人补贴','抖音支付补贴','抖音月付营销补贴','银行补贴','平台补贴运费','用户实付','收入合计',
'达人佣金','支出合计','报送金额','退款失败赔付','技术服务费','支付给平台的佣金/服务费总额'] +
[f'{category}_{amount}' for category in ['销售货物取得的收入','销售服务取得的收入'] for amount in ['收入总额','退款总额','收入净额']])
ROLES = {'fund':'资金账单','settlement':'结算账单','steward':'管家账户',
'base_deposit':'基础保证金账户','experience_deposit':'体验保证金账户','deposit':'保证金账户','tax':'涉税账单','qianchuan':'千川账户'}
ACCOUNTS = {'fund':'货款账户','steward':'管家账户','base_deposit':'基础保证金账户',
'experience_deposit':'体验保证金账户','deposit':'保证金账户（待确认）'}
AMOUNT_FIELDS.update(QIANCHUAN_COLUMNS[1:])


def detect_role(headers, sheet_name=''):
    fields = set(headers)
    if {'日期','非赠款消耗(元)','赠款余额(元)','非赠款余额(元)'} <= fields:
        return 'qianchuan'
    if {'动账时间','动账金额','动账场景'} <= fields:
        return 'fund'
    if {'结算时间','结算金额','订单号'} <= fields:
        return 'settlement'
    if {'动账流水号','动账时间','账户方向','动账金额(元)'} <= fields:
        return 'steward'
    if {'操作时间','操作类型','操作金额'} <= fields:
        if '基础' in sheet_name:
            return 'base_deposit'
        if '体验' in sheet_name:
            return 'experience_deposit'
        return 'deposit'
    if ('管家' in sheet_name or '钱包' in sheet_name) and fields & DATE_FIELDS and fields & AMOUNT_FIELDS:
        return 'steward'
    if ('涉税' in sheet_name or '税务' in sheet_name) and len([x for x in headers if x]) >= 2:
        return 'tax'
    return None
