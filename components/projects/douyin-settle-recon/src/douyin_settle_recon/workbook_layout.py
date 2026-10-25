"""Keep template/source presentation while streaming newly calculated workbook data.

Only styles and sparse reference cells are read from inputs. Accounting formulas and
caches are generated separately; cached totals in an input never become calculations.
"""
from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass, field
from pathlib import Path
import posixpath
import re
import xml.etree.ElementTree as ET
import zipfile

MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
NS = {'m': MAIN, 'r': REL}
SHEET_ORDER = ['sheetPr','dimension','sheetViews','sheetFormatPr','cols','sheetData',
               'sheetCalcPr','sheetProtection','protectedRanges','scenarios','autoFilter',
               'sortState','dataConsolidate','customSheetViews','mergeCells','phoneticPr',
               'conditionalFormatting','dataValidations','hyperlinks','printOptions',
               'pageMargins','pageSetup','headerFooter','rowBreaks','colBreaks',
               'customProperties','cellWatches','ignoredErrors','smartTags','drawing',
               'legacyDrawing','legacyDrawingHF','picture','oleObjects','controls',
               'webPublishItems','tableParts','extLst']
SHEET_ALIASES = {'余额账单': '余额截图'}
ET.register_namespace('', MAIN)
ET.register_namespace('r', REL)


def sheet_name(name):
    return SHEET_ALIASES.get(name, name)


def formula_names(formula):
    # References, including quoted worksheet names, follow the canonical template.
    for old, new in SHEET_ALIASES.items():
        formula = formula.replace(f"'{old}'!", f"'{new}'!").replace(old+'!', new+'!')
    return formula


def workbook_sheets(z):
    rels = {r.attrib['Id']: r.attrib['Target'] for r in ET.fromstring(z.read('xl/_rels/workbook.xml.rels'))}
    return {s.attrib['name']: (rels[s.attrib['{'+REL+'}id']].lstrip('/') if rels[s.attrib['{'+REL+'}id']].startswith('/')
                             else posixpath.normpath('xl/'+rels[s.attrib['{'+REL+'}id']]))
            for s in ET.fromstring(z.read('xl/workbook.xml')).find('m:sheets', NS)}


@dataclass
class SheetLayout:
    source: Path
    name: str
    elements: dict = field(default_factory=dict)
    header_styles: dict = field(default_factory=dict)
    body_styles: dict = field(default_factory=dict)
    cell_styles: dict = field(default_factory=dict)
    cells: dict = field(default_factory=dict)
    row_attributes: dict = field(default_factory=dict)


def read_layout(z, path, name, member, strings):
    layout = SheetLayout(path, name)
    sparse = name in ['核对汇总', '账单字段对照表', '管家账户', '余额截图']
    with z.open(member) as stream:
        for event, node in ET.iterparse(stream, events=('end',)):
            tag = node.tag.rsplit('}', 1)[-1]
            if tag == 'row':
                rn = int(node.attrib['r'])
                attrs = {k: v for k, v in node.attrib.items() if k not in ['r', 'spans']}
                if attrs:
                    layout.row_attributes[rn] = attrs
                for cell in node:
                    coord = cell.attrib['r']; col = re.sub(r'\d+', '', coord)
                    style = cell.get('s', '0')
                    if rn == 1: layout.header_styles[col] = style
                    if rn == 2: layout.body_styles[col] = style
                    if rn > 2 and not sparse:
                        baseline = layout.body_styles.setdefault(col, style)
                        if style != baseline: layout.cell_styles[coord] = style
                    if sparse:
                        layout.cell_styles[coord] = style
                        v = cell.find('m:v', NS); f = cell.find('m:f', NS)
                        value = v.text if v is not None else None
                        if cell.get('t') == 's' and value is not None: value = strings[int(value)]
                        elif cell.get('t') == 'inlineStr':
                            inline=cell.find('m:is', NS)
                            value=''.join(inline.itertext()) if inline is not None else None
                        elif value is not None and cell.get('t') not in ['str', 'e']:
                            value = float(value) if any(c in value for c in '.Ee') else int(value)
                        if f is not None and f.text:
                            layout.cells[coord] = (formula_names('='+f.text), value)
                        elif value is not None:
                            layout.cells[coord] = value
                node.clear()
            elif tag in ['sheetPr', 'sheetViews', 'sheetFormatPr', 'cols', 'mergeCells', 'pageMargins', 'pageSetup', 'printOptions', 'headerFooter']:
                layout.elements[tag] = deepcopy(node)
                node.clear()
    return layout


class ReportLayout:
    def __init__(self, template, artifacts):
        self.sheets = {}
        self.sources = {}
        self.sheetnames = []
        self.theme = None
        claimed = set()
        paths = [Path(template), *(Path(a['path']) for a in artifacts if Path(a['path']).suffix.lower() in ['.xlsx', '.xlsm'])]
        for index, path in enumerate(dict.fromkeys(paths)):
            with zipfile.ZipFile(path) as z:
                members = workbook_sheets(z)
                if index == 0:
                    self.sheetnames = list(members)
                    if 'xl/theme/theme1.xml' in z.namelist(): self.theme = z.read('xl/theme/theme1.xml')
                strings = []
                if 'xl/sharedStrings.xml' in z.namelist():
                    strings = [''.join(c.itertext()) for c in ET.fromstring(z.read('xl/sharedStrings.xml'))]
                self.sources[path] = z.read('xl/styles.xml')
                for original, member in members.items():
                    name = sheet_name(original)
                    if name not in self.sheetnames: continue
                    # A source mapping table is never an approved accounting rule.
                    if index and name == '账单字段对照表': continue
                    layout = read_layout(z, path, name, member, strings)
                    if index == 0 or name not in claimed:
                        if index and name == '核对汇总':
                            # Older source reports do not contain the new account.
                            # Keep template additions while accepting source openings.
                            layout.cells = {**self.sheets[name].cells, **layout.cells}
                        self.sheets[name] = layout
                        if index: claimed.add(name)
        required = {'结算账单', '资金账单', '管家账户', '保证金账户', '余额截图', '资金账单 (核对)', '核对汇总', '账单字段对照表'}
        if not required <= set(self.sheetnames) or set(self.sheetnames)-required-{'千川账户','涉税账单'}:
            from .model import DataError
            raise DataError('unsupported monthly template worksheets')

    def cells(self, name):
        return self.sheets[name].cells

    def finish(self, path, images):
        """Merge style registries and exact sheet geometry without loading data cells."""
        target = Path(str(path)+'.layout')
        with zipfile.ZipFile(path) as src, zipfile.ZipFile(target, 'w', zipfile.ZIP_DEFLATED) as dst:
            styles = ET.fromstring(src.read('xl/styles.xml'))
            style_maps = {p: _merge_styles(styles, ET.fromstring(raw)) for p, raw in self.sources.items()}
            # Small layout elements can be replaced directly. Stream cell tag
            # replacements rather than constructing millions of Element objects.
            members = workbook_sheets(src)
            by_member = {member: self.sheets[name] for name, member in members.items()}
            for info in src.infolist():
                raw = src.read(info.filename)
                if info.filename == 'xl/theme/theme1.xml' and self.theme is not None:
                    raw = self.theme
                elif info.filename == 'xl/styles.xml':
                    raw = ET.tostring(styles, encoding='utf-8', xml_declaration=True)
                elif info.filename in by_member:
                    layout = by_member[info.filename]; mapping = style_maps[layout.source]
                    text = raw.decode('utf-8')
                    def cell_style(match):
                        attrs = match.group(1)
                        coord = re.search(r'\br="([A-Z]+)(\d+)"', attrs)
                        if not coord: return match.group(0)
                        col, row = coord.groups()
                        style = layout.cell_styles.get(col+row, (layout.header_styles if row == '1' else layout.body_styles).get(col))
                        if style is None: return match.group(0)
                        attrs = re.sub(r'\s+s="[^"]*"', '', attrs)
                        return '<c'+attrs+' s="'+str(mapping[int(style)])+'"'+match.group(2)+'>'
                    text = re.sub(r'<c(\s[^>]*?)(/?)>', cell_style, text)
                    for tag, element in layout.elements.items():
                        el = deepcopy(element)
                        for col in el.iter('{'+MAIN+'}col'):
                            if 'style' in col.attrib: col.set('style', str(mapping[int(col.get('style'))]))
                        if tag == 'pageSetup': el.attrib.pop('{'+REL+'}id', None)
                        replacement = ET.tostring(el, encoding='unicode')
                        pattern = rf'<{tag}\b[^>]*(?:/>|>.*?</{tag}>)'
                        if re.search(pattern, text, flags=re.S):
                            text = re.sub(pattern, lambda _: replacement, text, count=1, flags=re.S)
                        else:
                            # Worksheet children have a schema-defined order.
                            later = SHEET_ORDER[SHEET_ORDER.index(tag)+1:]
                            following = re.search(r'<(?:'+'|'.join(later)+r')\b', text)
                            at = following.start() if following else text.index('</worksheet>')
                            text = text[:at]+replacement+text[at:]
                    if layout.row_attributes:
                        def row_style(match):
                            attrs = match.group(1); row = re.search(r'\br="(\d+)"', attrs)
                            updates = layout.row_attributes.get(int(row.group(1)), {}) if row else {}
                            for key, value in updates.items():
                                if key == 's': value = str(mapping[int(value)])
                                attrs = re.sub(rf'\s+{key}="[^"]*"', '', attrs)
                                attrs += f' {key}="{value}"'
                            return '<row'+attrs+'>'
                        text = re.sub(r'<row(\s[^>]*?)>', row_style, text)
                    # Input filters/panes are presentation too; don't invent new filters.
                    text = re.sub(r'<autoFilter\b[^>]*(?:/>|>.*?</autoFilter>)', '', text, flags=re.S)
                    raw = text.encode('utf-8')
                elif re.fullmatch(r'xl/drawings/drawing\d+\.xml', info.filename):
                    raw = _restore_image_anchors(raw, images)
                dst.writestr(info, raw)
        target.replace(path)


def _merge_styles(target, source):
    offsets = {}
    numfmts = target.find('m:numFmts', NS)
    if numfmts is None:
        numfmts = ET.Element('{'+MAIN+'}numFmts', count='0'); target.insert(0, numfmts)
    known = {n.get('formatCode'): int(n.get('numFmtId')) for n in numfmts}
    next_id = max([163, *known.values()])+1
    num_map = {}
    for num in source.findall('m:numFmts/m:numFmt', NS):
        code = num.get('formatCode')
        if code not in known:
            new = deepcopy(num); new.set('numFmtId', str(next_id)); numfmts.append(new)
            known[code] = next_id; next_id += 1
        num_map[int(num.get('numFmtId'))] = known[code]
    numfmts.set('count', str(len(numfmts)))
    for tag in ['fonts', 'fills', 'borders', 'cellStyleXfs', 'cellXfs']:
        dest = target.find('m:'+tag, NS); original = source.find('m:'+tag, NS)
        offsets[tag] = len(dest)
        for node in original:
            new = deepcopy(node)
            if tag in ['cellStyleXfs', 'cellXfs']:
                for attr, section in [('fontId', 'fonts'), ('fillId', 'fills'), ('borderId', 'borders'), ('xfId', 'cellStyleXfs')]:
                    if attr in new.attrib: new.set(attr, str(int(new.get(attr))+offsets[section]))
                if 'numFmtId' in new.attrib:
                    value = int(new.get('numFmtId')); new.set('numFmtId', str(num_map.get(value, value)))
            dest.append(new)
        dest.set('count', str(len(dest)))
    return {i: offsets['cellXfs']+i for i in range(len(source.find('m:cellXfs', NS)))}


def _restore_image_anchors(raw, images):
    ns = {'xdr': 'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing',
          'a': 'http://schemas.openxmlformats.org/drawingml/2006/main'}
    root = ET.fromstring(raw)
    for anchor in list(root):
        desc = anchor.find('.//xdr:cNvPr', ns)
        ident = desc.get('descr') if desc is not None else None
        image = next((im for im in images if im.get('layout_id') == ident), None)
        if image and image.get('anchor_xml'):
            original = ET.fromstring(image['anchor_xml'])
            # Keep the generated package relationship and unique picture ID.
            old_blip = original.find('.//a:blip', ns); new_blip = anchor.find('.//a:blip', ns)
            old_blip.attrib.clear(); old_blip.attrib.update(new_blip.attrib)
            old_desc = original.find('.//xdr:cNvPr', ns)
            old_desc.set('id', desc.get('id'))
            root.insert(list(root).index(anchor), original); root.remove(anchor)
    return ET.tostring(root, encoding='utf-8', xml_declaration=True)
