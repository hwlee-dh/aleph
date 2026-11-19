"""올린 파일에서 글을 뽑고, 원고를 파일로 내보낸다.

에이전트는 문서 도구밖에 없어서 docx나 pdf를 스스로 열지 못한다. 그래서 올릴 때
여기서 글을 뽑아 통짜 문서로 넣는다. 나누고 정리하는 것은 그다음에 에이전트가 한다.
"""

from __future__ import annotations

import base64
import html
import io
import mimetypes
import re
import zipfile
from pathlib import PurePosixPath
from urllib.parse import unquote
from xml.etree import ElementTree

from .workspace.documents import IMAGE_SUFFIXES, DocError, DocWorkspace, normalize_path, zone_of

MAX_UPLOAD = 40 * 1024 * 1024
TEXT_UPLOADS = (".txt", ".md", ".markdown", ".docx", ".hwpx", ".pdf")


class ExtractError(ValueError):
    """사용자에게 그대로 보여줄 수 있는 이유. no_text면 파일은 멀쩡한데 글이 그림으로만 들어 있는 경우다."""

    def __init__(self, message: str, *, no_text: bool = False):
        super().__init__(message)
        self.no_text = no_text


def decode_text(data: bytes) -> str:
    """글 파일의 글자 인코딩을 맞춘다. 옛 메모장·한글에서 저장한 파일(UTF-16, 완성형)도 읽는다."""
    if data.startswith(b"\xef\xbb\xbf"):
        text = data[3:].decode("utf-8", errors="replace")
    elif data.startswith((b"\xff\xfe", b"\xfe\xff")):
        text = data.decode("utf-16", errors="replace")
    else:
        try:
            text = data.decode("utf-8")
        except UnicodeDecodeError:
            text = data.decode("cp949", errors="replace")
    return text.replace("\r\n", "\n").replace("\r", "\n")


def _local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _docx_text(data: bytes) -> str:
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            root = ElementTree.fromstring(z.read("word/document.xml"))
    except (zipfile.BadZipFile, KeyError, ElementTree.ParseError) as e:
        raise ExtractError("Word 문서를 열지 못했습니다. 파일이 손상됐거나 docx 형식이 아닙니다.") from e
    paragraphs: list[str] = []
    for p in root.iter():
        if _local(p.tag) != "p":
            continue
        parts: list[str] = []
        for node in p.iter():
            name = _local(node.tag)
            if name == "t" and node.text:
                parts.append(node.text)
            elif name == "tab":
                parts.append("\t")
            elif name in ("br", "cr"):
                parts.append("\n")
        paragraphs.append("".join(parts))
    return "\n\n".join(paragraphs)


def _hwpx_text(data: bytes) -> str:
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            names = sorted(n for n in z.namelist() if re.fullmatch(r"Contents/section\d+\.xml", n))
            if not names:
                raise ExtractError("한글 문서에서 본문을 찾지 못했습니다.")
            sections = [ElementTree.fromstring(z.read(n)) for n in names]
    except (zipfile.BadZipFile, ElementTree.ParseError) as e:
        raise ExtractError("한글 문서를 열지 못했습니다. 파일이 손상됐거나 hwpx 형식이 아닙니다.") from e
    paragraphs: list[str] = []
    for root in sections:
        for p in root.iter():
            if _local(p.tag) != "p":
                continue
            # 표나 글상자 안의 문단은 바깥 문단의 자손으로 또 나온다. 자기 줄(run)의 글만 모은다.
            parts: list[str] = []
            for run in p:
                if _local(run.tag) != "run":
                    continue
                for node in run:
                    name = _local(node.tag)
                    if name == "t":
                        parts.append("".join(node.itertext()))
                    elif name == "lineBreak":
                        parts.append("\n")
            paragraphs.append("".join(parts))
    return "\n\n".join(paragraphs)


def _pdf_text(data: bytes) -> str:
    try:
        from pypdf import PdfReader
    except ImportError as e:
        raise ExtractError("PDF를 읽는 기능이 설치되지 않았습니다. install.bat을 다시 실행해야 합니다.") from e
    try:
        reader = PdfReader(io.BytesIO(data))
        if reader.is_encrypted:
            raise ExtractError("암호가 걸린 PDF는 읽을 수 없습니다.")
        pages = [(page.extract_text() or "").strip() for page in reader.pages]
    except ExtractError:
        raise
    except Exception as e:
        raise ExtractError("PDF를 열지 못했습니다. 파일이 손상됐거나 PDF 형식이 아닙니다.") from e
    return "\n\n".join(p for p in pages if p)


def extract_text(name: str, data: bytes) -> str:
    """올린 파일에서 글을 뽑는다. 못 뽑으면 이유와 함께 ExtractError."""
    suffix = PurePosixPath(name.lower()).suffix
    if suffix in (".txt", ".md", ".markdown"):
        text = decode_text(data)
    elif suffix == ".docx":
        text = _docx_text(data)
    elif suffix == ".hwpx":
        text = _hwpx_text(data)
    elif suffix == ".pdf":
        text = _pdf_text(data)
    elif suffix == ".hwp":
        raise ExtractError("옛 한글 형식(.hwp)은 아직 읽지 못합니다. 한글에서 hwpx나 docx로 다시 저장해 올려야 합니다.")
    elif suffix == ".doc":
        raise ExtractError("옛 Word 형식(.doc)은 읽지 못합니다. docx로 다시 저장해 올려야 합니다.")
    else:
        raise ExtractError(f"'{suffix or name}' 형식은 올릴 수 없습니다. 글은 txt·md·docx·hwpx·pdf, 이미지는 png·jpg·webp·gif를 받습니다.")
    text = re.sub(r"\n{3,}", "\n\n", text.replace(" ", " ")).strip()
    if len(re.sub(r"\s", "", text)) < 2:
        why = "스캔한 문서처럼 글이 그림으로만 들어 있을 수 있습니다." if suffix == ".pdf" else "문서가 비어 있습니다."
        raise ExtractError(f"이 파일에서 글을 뽑지 못했습니다. {why}", no_text=suffix == ".pdf")
    return text


def is_image(name: str) -> bool:
    return name.lower().endswith(IMAGE_SUFFIXES)


def is_text_upload(name: str) -> bool:
    return name.lower().endswith(TEXT_UPLOADS)


# ---------------------------------------------------------------------- 내보내기

_IMAGE = re.compile(r"!\[([^\]]*)\]\(([^)\n]+)\)")   # 경로에 띄어쓰기가 있어도 된다 (자료/삽화/등대 그림.png)


def image_bytes(docs: DocWorkspace, path: str) -> tuple[str, bytes] | None:
    """원고에 적힌 이미지 경로의 파일. `%20`처럼 적혀 있어도 찾는다. (실제 경로, 내용)"""
    for candidate in dict.fromkeys([path.strip(), unquote(path.strip())]):
        try:
            target = normalize_path(candidate)
        except DocError:
            continue
        if zone_of(target) == "material":
            data = docs.get_bytes(target)
            if data is not None:
                return target, data
    return None


def manuscript_markdown(docs: DocWorkspace, title: str, chapter_numbers: bool = True) -> str:
    """원고를 마크다운 한 편으로. 장이 둘 이상이면 장마다 번호('1장')를 단다 (chapter_numbers가 꺼져 있으면 안 단다).

    장과 장면에 제목은 없다. 본문에 글로 적은 제목은 본문이므로 그대로 나간다.
    """
    overview = docs.manuscript.overview()
    chapters = overview["chapters"]
    show_heads = chapter_numbers and len(chapters) > 1
    out = [f"# {title}", ""]
    for c in chapters:
        if show_heads:
            out += [f"## {c['number']}장", ""]
        for s in c["scenes"]:
            body = (docs.get(f"{s['path']}.md") or "").strip()
            if body:
                out += [body, ""]
    return "\n".join(out).rstrip() + "\n"


def _images_in(text: str) -> list[str]:
    return list(dict.fromkeys(m.group(2).strip() for m in _IMAGE.finditer(text)))


# 원고는 글 그대로 저장한다. 굵게(**…**)와 기울임(*…*)은 마크다운의 표시로 적혀 있다.
# 표시 바로 안쪽이 빈칸이면 서식으로 보지 않는다 (`2 * 3 * 4`, 줄 전체가 `***`인 구분선).
_BOLD = re.compile(r"\*\*(?=\S)(.+?)(?<=\S)\*\*")
_ITALIC = re.compile(r"(?<![*\w])\*(?=[^\s*])([^*\n]+?)(?<=[^\s*])\*(?![*\w])")
_RULE = re.compile(r"[ \t]*([*\-_])(?:[ \t]*\1){2,}[ \t]*")   # ***, * * *, ---


def _emphasis(text: str, bold: str, italic: str) -> str:
    """굵게와 기울임의 표시를 바꾼다. bold와 italic은 `\\1`이 든 바꿀 꼴."""
    return _ITALIC.sub(italic, _BOLD.sub(bold, text))


def export_txt(docs: DocWorkspace, title: str, chapter_numbers: bool = True) -> bytes:
    """글만. 그림은 자리 표시로, 제목 줄의 `#`과 굵게·기울임의 표시는 뗀다."""
    markdown = manuscript_markdown(docs, title, chapter_numbers)
    text = _IMAGE.sub(lambda m: f"[그림: {m.group(1) or PurePosixPath(m.group(2).strip()).name}]", markdown)
    text = re.sub(r"^#{1,6} ", "", text, flags=re.MULTILINE)
    lines = [line if _RULE.fullmatch(line) else _emphasis(line, r"\1", r"\1") for line in text.split("\n")]
    return "\n".join(lines).encode("utf-8-sig")


def export_md(docs: DocWorkspace, title: str, chapter_numbers: bool = True) -> bytes:
    return manuscript_markdown(docs, title, chapter_numbers).encode("utf-8")


def export_zip(docs: DocWorkspace, title: str, chapter_numbers: bool = True) -> bytes:
    """마크다운과, 거기 쓰인 이미지들."""
    text = manuscript_markdown(docs, title, chapter_numbers)
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr(f"{title}.md", text)
        for path in _images_in(text):
            found = image_bytes(docs, path) if not path.startswith(("http://", "https://", "data:")) else None
            if found is not None:
                z.writestr(path, found[1])   # 원고에 적힌 경로 그대로 넣어야 마크다운에서 그림이 이어진다
    return buffer.getvalue()


def _inline(text: str, docs: DocWorkspace) -> str:
    def image(m: re.Match) -> str:
        alt, path = m.group(1), m.group(2).strip()
        src = path
        if not path.startswith(("http://", "https://", "data:")):
            found = image_bytes(docs, path)
            if found is None:
                return f"<em>[그림 없음: {html.escape(path)}]</em>"
            mime = mimetypes.guess_type(found[0])[0] or "image/png"
            src = f"data:{mime};base64,{base64.b64encode(found[1]).decode('ascii')}"
        return f'<img src="{src}" alt="{html.escape(alt)}">'

    def words(piece: str) -> str:
        return _emphasis(html.escape(piece), r"<strong>\1</strong>", r"<em>\1</em>")

    out: list[str] = []
    last = 0
    for m in _IMAGE.finditer(text):
        out.append(words(text[last:m.start()]))
        out.append(image(m))
        last = m.end()
    out.append(words(text[last:]))
    return "".join(out).replace("\n", "<br>\n")


def export_html(docs: DocWorkspace, title: str, chapter_numbers: bool = True) -> bytes:
    """이미지를 안에 품은 HTML 한 파일. 어디서나 열리고 PDF로 인쇄할 수 있다."""
    body: list[str] = []
    for block in re.split(r"\n\s*\n", manuscript_markdown(docs, title, chapter_numbers).strip()):
        block = block.strip()
        if not block:
            continue
        head = re.fullmatch(r"(#{1,6}) (.+)", block)
        if head:
            level = len(head.group(1))
            body.append(f"<h{level}>{html.escape(head.group(2))}</h{level}>")
        elif _IMAGE.fullmatch(block):
            body.append(f"<figure>{_inline(block, docs)}</figure>")
        elif _RULE.fullmatch(block):
            body.append("<hr>")
        else:
            body.append(f"<p>{_inline(block, docs)}</p>")
    page = f"""<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{html.escape(title)}</title>
<style>
  body {{ max-width: 42em; margin: 3em auto; padding: 0 1.2em; font-family: "Noto Serif KR", "Nanum Myeongjo", Batang, serif;
         font-size: 17px; line-height: 1.9; color: #1a1a1a; word-break: keep-all; }}
  h1 {{ font-size: 1.7em; margin: 0 0 2em; }}
  h2 {{ font-size: 1.2em; margin: 3em 0 1.2em; }}
  p {{ margin: 0 0 1.1em; }}
  figure {{ margin: 2em 0; text-align: center; }}
  img {{ max-width: 100%; height: auto; }}
  @media print {{ body {{ margin: 0 auto; }} h2 {{ break-before: page; }} }}
</style>
</head>
<body>
{chr(10).join(body)}
</body>
</html>
"""
    return page.encode("utf-8")
