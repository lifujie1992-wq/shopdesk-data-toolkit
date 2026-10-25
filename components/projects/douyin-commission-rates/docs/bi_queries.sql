-- On the BI connection: attach the published commission dataset.
ATTACH DATABASE '/var/lib/xdr-sync/data/jst-commission-rates.sqlite' AS cr;

-- Current released public settings, including partial results. Always include ERP shop_id and platform.
-- batch_complete=0 means full-scope/manual acceptance remains pending.
SELECT f.order_item_id, f.shop_id, f.platform_link_id, f.channel,
       c.commission_enabled, c.commission_rate, c.link_status, c.rate_captured_at,
       c.batch_complete, c.batch_status,
       CASE WHEN f.channel='normal' THEN 0
            WHEN f.channel='creator' AND c.commission_enabled=1
              THEN CAST(f.item_paid_amount AS REAL)*c.commission_rate
            WHEN f.channel='creator' AND c.commission_enabled=0 THEN NULL
            ELSE NULL END AS estimated_creator_commission,
       c.ad_commission_rate, c.extra_rate
FROM order_profit_facts f
LEFT JOIN cr.commission_rates_available_latest c
 ON c.shop_id=f.shop_id AND c.platform=f.platform AND c.platform_link_id=f.platform_link_id;
-- creator + disabled is an anomaly, not a proved zero. unknown channel stays unknown.
-- This is an estimate using latest observed settings, not a backdated settlement fact.
-- Directional and ad-period settings require the creator/ad attribution on the order.
-- Do NOT add extra_rate for every order. commission_overrides contains creator-scoped rates.

-- History for one link. Bind :shop_id and :link_id as text, never as floats.
SELECT r.batch_id,b.complete,b.status,r.captured_at,r.rate_captured_at,
       r.commission_rate,r.commission_enabled,r.extra_rate,r.ad_commission_rate,
       r.link_status,r.carried_from_batch
FROM cr.commission_rates r JOIN cr.batch_runs b USING(batch_id)
WHERE r.shop_id=:shop_id AND r.platform='抖音' AND r.platform_link_id=:link_id
ORDER BY b.started_at,b.batch_id;

-- Coverage for a specific frozen target universe, including uncollected shops.
SELECT t.shop_id,count(*) AS target_links,count(r.platform_link_id) AS found,
       1.0*count(r.platform_link_id)/count(*) AS coverage
FROM cr.batch_targets t LEFT JOIN cr.commission_rates r
 USING(batch_id,shop_id,platform,platform_link_id)
WHERE t.batch_id=:batch_id
GROUP BY t.shop_id;
