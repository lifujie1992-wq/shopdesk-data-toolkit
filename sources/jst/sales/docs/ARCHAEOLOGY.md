# Sales Performance Archaeology

- Page: 聚水潭 ERP `salesPerformanceReport`
- Verified: 2026-09-06 through OpenBridge `browser_evaluate`
- Endpoint: `POST https://api.erp321.com/jst-data-report/getData/transportData?apiCode=sales_performance_channel_list`
- API code: `sales_performance_channel_list`
- Domain/page: `merchantBusinessAnalysis` / `SALES_PERFORMANCE`
- Shop table code: `sales_performance_report_overview_shop_v_2_table`
- Pagination: `pageNum`, `pageSize`; 500 rows per page verified
- Authentication: `u_sso_token`, `u_id`, and `u_co_id` cookies
- Verified response: HTTP 200, `code=0`, `success=true`, 78 shop rows for 2026-09-05
- Safety: read-only report endpoint; no order or shop mutation calls

The CLI uses the saved Keychain session after archaeology, so normal reads do not require Chrome or OpenBridge.
