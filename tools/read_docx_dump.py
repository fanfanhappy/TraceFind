# -*- coding: utf-8 -*-
"""Dump a DOCX to readable plain text, preserving structure."""
import sys
from docx import Document
from docx.table import Table
from docx.text.paragraph import Paragraph
from docx.oxml.ns import qn


def iter_block_items(parent):
    body = parent.element.body
    for child in body.iterchildren():
        if child.tag == qn('w:p'):
            yield Paragraph(child, parent)
        elif child.tag == qn('w:tbl'):
            yield Table(child, parent)


def dump(path, out_path):
    doc = Document(path)
    lines = []
    for block in iter_block_items(doc):
        if isinstance(block, Paragraph):
            text = block.text.strip()
            style = block.style.name if block.style is not None else ''
            has_img = bool(block._p.findall('.//' + qn('a:blip')))
            if has_img:
                lines.append(f'[[IMAGE]] (style={style}) {text}')
            if not text:
                continue
            prefix = ''
            if style.startswith('Heading') or style == 'Title':
                prefix = f'[{style}] '
            elif style not in ('Normal', 'Body Text', ''):
                prefix = f'[{style}] '
            lines.append(prefix + text)
        else:
            lines.append('--- TABLE ---')
            for row in block.rows:
                cells = []
                for cell in row.cells:
                    cells.append(' '.join(p.text.strip() for p in cell.paragraphs if p.text.strip()))
                lines.append(' | '.join(cells))
            lines.append('--- END TABLE ---')
    with open(out_path, 'w', encoding='utf-8') as f:
        f.write('\n'.join(lines))
    print(f'paragraphs_blocks={len(lines)} chars={sum(len(l) for l in lines)}')
    print(f'images_inline={len(doc.inline_shapes)}')


if __name__ == '__main__':
    dump(sys.argv[1], sys.argv[2])
