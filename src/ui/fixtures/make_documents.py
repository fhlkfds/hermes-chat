"""Writes the Word and PDF files the preview tests and screenshots open. Run: python3 make_documents.py <out dir>.
scan.pdf needs Pillow built with OpenJPEG."""
import io
import sys
import zipfile
from pathlib import Path

W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'


def para(text, style=None, bold=False):
    props = f'<w:pPr><w:pStyle w:val="{style}"/></w:pPr>' if style else ""
    run_props = "<w:rPr><w:b/></w:rPr>" if bold else ""
    return f"<w:p>{props}<w:r>{run_props}<w:t xml:space=\"preserve\">{text}</w:t></w:r></w:p>"


def cell(text):
    return f"<w:tc>{para(text)}</w:tc>"


def docx(path):
    rows = [("Item", "Owner", "Due"), ("Draft the brief", "Sam", "Mon"), ("Review figures", "Alex", "Wed"), ("Send to print", "Kai", "Fri")]
    table = "<w:tbl>" + "".join("<w:tr>" + "".join(cell(c) for c in r) + "</w:tr>" for r in rows) + "</w:tbl>"
    body = (
        para("Quarterly plan", "Heading1")
        + para("This Word document opens in the Highwing preview.")
        + para("Owners and dates", "Heading2")
        + table
        + para("Bold closing line.", bold=True)
    )
    styles = (
        f'<w:styles {W}>'
        '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style>'
        '<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/></w:style>'
        "</w:styles>"
    )
    parts = {
        "[Content_Types].xml": '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/>'
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
        '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
        "</Types>",
        "_rels/.rels": '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
        "</Relationships>",
        "word/_rels/document.xml.rels": '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
        "</Relationships>",
        "word/document.xml": f"<w:document {W}><w:body>{body}</w:body></w:document>",
        "word/styles.xml": styles,
    }
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        for name, xml in parts.items():
            info = zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
            z.writestr(info, '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' + xml)


def write_pdf(path, objects):
    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for i, body in enumerate(objects, 1):
        offsets.append(len(out))
        out += f"{i} 0 obj\n".encode() + (body if isinstance(body, bytes) else body.encode()) + b"\nendobj\n"
    xref = len(out)
    out += f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode()
    out += "".join(f"{o:010d} 00000 n \n" for o in offsets).encode()
    out += f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    Path(path).write_bytes(out)


def pdf(path):
    pages = [["Field report", "Page one of a PDF the preview draws."], ["Second page", "Each page is its own canvas."]]
    objects = ["<< /Type /Catalog /Pages 2 0 R >>", None, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"]
    kids = []
    for title, line in pages:
        stream = f"BT /F1 28 Tf 72 700 Td ({title}) Tj ET BT /F1 14 Tf 72 660 Td ({line}) Tj ET".encode()
        objects.append(f"<< /Length {len(stream)} >>\nstream\n{stream.decode()}\nendstream")
        content = len(objects)
        objects.append(f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents {content} 0 R /Resources << /Font << /F1 3 0 R >> >> >>")
        kids.append(f"{len(objects)} 0 R")
    objects[1] = f"<< /Type /Pages /Kids [{' '.join(kids)}] /Count {len(kids)} >>"
    write_pdf(path, objects)


def scan(path):
    """One page holding a red JPEG 2000 picture, as a scanner writes it."""
    from PIL import Image

    jpx = io.BytesIO()
    Image.new("RGB", (64, 64), (220, 30, 30)).save(jpx, "JPEG2000")
    data = jpx.getvalue()
    image = f"<< /Type /XObject /Subtype /Image /Width 64 /Height 64 /Filter /JPXDecode /Length {len(data)} >>\nstream\n".encode() + data + b"\nendstream"
    content = b"q 400 0 0 400 106 300 cm /Im1 Do Q"
    objects = [
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /XObject << /Im1 5 0 R >> >> >>",
        f"<< /Length {len(content)} >>\nstream\n".encode() + content + b"\nendstream",
        image,
    ]
    write_pdf(path, objects)


out = Path(sys.argv[1])
docx(out / "plan.docx")
pdf(out / "report.pdf")
scan(out / "scan.pdf")
