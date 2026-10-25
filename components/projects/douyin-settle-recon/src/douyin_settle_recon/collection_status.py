"""Explicit Qianchuan access denial permits partial delivery, never fake zero."""


def collection_error(role, error, **details):
    message = str(error)
    denied = role == 'qianchuan' and any(marker in message for marker in (
        '暂无权限', '无访问权限', '权限不足', '没有访问该页面的权限',
    ))
    return {'role': role, 'status': 'permission_denied' if denied else 'error',
            'error': message, **details}


def qianchuan_denied(receipt):
    return receipt.get('role') == 'qianchuan' and receipt.get('status') == 'permission_denied'


def deliverable(receipt):
    return receipt.get('status') in ['downloaded', 'no_activity', 'not_opened'] or qianchuan_denied(receipt)


def partial_qianchuan(context):
    return (context.get('qianchuan_access')=='permission_denied'
            and context.get('qianchuan_result',{}).get('status')=='failed'
            and any(qianchuan_denied(r) for r in context.get('collection',[])))
