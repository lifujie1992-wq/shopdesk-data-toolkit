from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime
from decimal import Decimal, InvalidOperation
import hashlib
import json
from pathlib import Path
import re


class DataError(ValueError):
    pass


def json_value(value):
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, (datetime, date)):
        return value.isoformat(sep=' ') if isinstance(value, datetime) else value.isoformat()
    raise TypeError(type(value).__name__)


def dump_json(path: Path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2, default=json_value) + '\n')


def sha256(path: Path):
    h = hashlib.sha256()
    with path.open('rb') as source:
        for block in iter(lambda: source.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def safe_name(value):
    text = re.sub(r'[\\/:*?"<>|\x00-\x1f]', '_', str(value)).strip(' .')
    if not text:
        raise DataError('empty filename')
    return text[:150]


def decimal(value, *, blank_zero=True):
    if value is None or value == '':
        if blank_zero:
            return Decimal(0)
        raise DataError('missing amount')
    if isinstance(value, bool):
        raise DataError('boolean is not an amount')
    try:
        # No float accumulation, no implicit currency/unit or sign conversion.
        result = Decimal(str(value).strip())
    except InvalidOperation:
        raise DataError(f'invalid amount: {str(value)[:60]}') from None
    if not result.is_finite():
        raise DataError('amount must be finite')
    return result


def month_bounds(month):
    if not re.fullmatch(r'\d{4}-\d{2}', month):
        raise DataError('month must be YYYY-MM')
    start = datetime.strptime(month, '%Y-%m')
    end = datetime(start.year + (start.month == 12), start.month % 12 + 1, 1)
    return start, end


def parse_time(value):
    if isinstance(value, datetime):
        return value
    if isinstance(value, date):
        return datetime.combine(value, datetime.min.time())
    if isinstance(value, str):
        text = value.strip().lstrip("'").replace('/', '-')
        try:
            return datetime.fromisoformat(text)
        except ValueError:
            pass
    raise DataError(f'invalid transaction date: {str(value)[:60]}')


@dataclass
class Column:
    key: str
    name: str
    type: str = 'string'
    nullable: bool = True


@dataclass
class Row:
    values: dict
    source: dict = field(default_factory=dict)
    row_id: str = ''

    def __post_init__(self):
        if not self.row_id:
            seed = json.dumps(self.source, sort_keys=True, ensure_ascii=False, default=json_value)
            self.row_id = hashlib.sha256(seed.encode()).hexdigest()[:24]


@dataclass
class Table:
    table_id: str
    name: str
    columns: list[Column]
    rows: list[Row] = field(default_factory=list)
    role: str = 'source'
    images: list[dict] = field(default_factory=list)

    @classmethod
    def from_records(cls, table_id, name, records, role='derived', types=None, fields=None):
        keys = list(dict.fromkeys([*(fields or []), *(k for record in records for k in record)]))
        table = cls(table_id, name, [Column(k, k, (types or {}).get(k, 'string')) for k in keys], role=role)
        table.rows = [Row(record, {'table_id': table_id, 'row': index}) for index, record in enumerate(records, 1)]
        return table

    def schema(self):
        return {'table_id': self.table_id, 'sheet_name': self.name, 'role': self.role,
                'row_count': len(self.rows), 'columns': [vars(c) for c in self.columns],
                'images': self.images}


@dataclass
class Dataset:
    context: dict
    tables: list[Table] = field(default_factory=list)
    artifacts: list[dict] = field(default_factory=list)
    issues: list[dict] = field(default_factory=list)
    checks: list[dict] = field(default_factory=list)
    balances: list[dict] = field(default_factory=list)

    def issue(self, code, message, *, severity='blocking', source=None, **extra):
        self.issues.append({'code': code, 'severity': severity, 'message': message,
                            'source': source or {}, **extra})

    def table(self, role):
        return [table for table in self.tables if table.role == role]
