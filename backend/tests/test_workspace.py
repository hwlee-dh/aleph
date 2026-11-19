"""작업 공간 — 입력·출력·자료의 문서, 수정 방지와 노트, @include, 버전 기록, 원고의 순서와 나누기."""

from __future__ import annotations

import pytest

from aleph.workspace.documents import (
    INPUT,
    OUTPUT,
    READ_LIMIT,
    Change,
    DocError,
    DocWorkspace,
    kind_of,
    normalize_path,
    zone_of,
)
from aleph.workspace.manuscript import cut_text, find_cuts


def put(docs: DocWorkspace, path: str, content: str, by: str = "user") -> None:
    docs.apply(docs.plan_write(path, content), by=by)


# ------------------------------------------------------------------ 문서

def test_paths_and_zones(tmp_path):
    assert normalize_path(" 자료/인물/서윤 ") == "자료/인물/서윤.md"
    assert normalize_path("자료/1. 등탑") == "자료/1. 등탑.md"          # 이름 속의 점은 확장자가 아니다
    assert normalize_path("자료/삽화/등대.PNG") == "자료/삽화/등대.PNG" and kind_of("자료/삽화/등대.PNG") == "image"
    for bad in ["", "../밖", "a//b", ".숨김", "C:\\x", "a/..", "물음?표"]:
        with pytest.raises(DocError):
            normalize_path(bad)
    assert [zone_of(p) for p in ["입력", "출력.md", "자료/a.md", "자료", "원고/s1.md", "원고", "딴 곳/a.md"]] == [
        "input", "output", "material", "material", "manuscript", "manuscript", None,
    ]

    docs = DocWorkspace(tmp_path)
    put(docs, "자료/인물/서윤", "등대지기의 딸")
    put(docs, "자료/10장 메모", "열")
    put(docs, "자료/2장 메모", "둘")
    assert docs.paths("자료") == ["자료/2장 메모.md", "자료/10장 메모.md", "자료/인물/서윤.md"]   # 2가 10 앞
    assert docs.read("자료/인물/서윤") == "등대지기의 딸" and "자료/인물/서윤 (7자)" in docs.read("자료/인물")
    assert "비슷한 문서: 자료/인물/서윤" in docs.read("자료/서윤")
    assert docs.read("입력") == "(비어 있음)" and docs.text(INPUT) == ""
    assert docs.search("등대") == "자료/인물/서윤:1: 등대지기의 딸"

    with pytest.raises(DocError, match="문서를 둘 수 없습니다"):
        docs.plan_write("딴 곳/메모", "x")                              # 자리 밖
    with pytest.raises(DocError, match="원고에 '새 장면'이라는 장이나 장면이 없습니다"):
        docs.plan_write("원고/새 장면", "x")                            # 장면은 경로로 만들지 않는다
    with pytest.raises(DocError, match="일치하는 글"):
        docs.plan_edit("자료/인물/서윤", "없는 말", "x")


def test_input_output_and_moves(tmp_path):
    docs = DocWorkspace(tmp_path)
    put(docs, "입력", "서윤이 등대에 오른다.", by="agent")
    put(docs, "출력", "바람이 불었다.", by="tool:compose")
    assert docs.slot(INPUT) == {**docs.slot(INPUT), "chars": 12, "by": "agent", "tool": ""}
    assert docs.slot(OUTPUT)["tool"] == "compose"
    assert "입력: 12자 (에이전트가 씀)" in docs.overview() and "출력: 8자 (도구 'compose'가 씀)" in docs.overview()

    # 출력을 자료로 옮기면 출력은 비워진다. 버전 기록은 이어진다
    docs.apply(docs.plan_move("출력", "자료/초고/첫 장면"), by="agent")
    assert docs.text(OUTPUT) == "" and docs.get("자료/초고/첫 장면.md") == "바람이 불었다."
    assert [(e["action"], e["by"]) for e in docs.history("자료/초고/첫 장면")] == [("write", "tool:compose"), ("move", "agent")]
    for src, dst in [("입력", "자료/x"), ("자료/초고/첫 장면", "원고/x"), ("자료/초고/첫 장면", "딴 곳/x")]:
        with pytest.raises(DocError):
            docs.plan_move(src, dst)

    # 폴더째 옮기고 지운다. 지운 문서는 버전으로 되살릴 수 있다
    assert docs.move_folder("자료/초고", "자료/보관/초고", by="user") == ["자료/보관/초고/첫 장면.md"]
    assert docs.delete_folder("자료/보관", by="user") == ["자료/보관/초고/첫 장면.md"]
    last = docs.history("자료/보관/초고/첫 장면")[-1]
    assert last["action"] == "delete" and docs.version(last["prev_hash"]) == "바람이 불었다."

    docs.clear(INPUT, by="user")
    assert docs.text(INPUT) == "" and docs.read("입력") == "(비어 있음)"


def test_locked_and_note_are_inherited(tmp_path):
    docs = DocWorkspace(tmp_path)
    for path in ["자료/인물/서윤", "자료/인물/아버지", "자료/계획"]:
        put(docs, path, "글")
    docs.set_flag("자료/인물", "locked", True)
    docs.set_flag("자료/계획", "note", True)
    assert docs.locked("자료/인물/서윤.md") and docs.locked("자료/인물/아버지.md") and not docs.locked("자료/계획.md")
    assert docs.noted("자료/계획.md") and not docs.noted("자료/인물/서윤.md")

    docs.set_flag("자료/인물/서윤", "locked", False)                    # 더 안쪽에 건 설정이 우선한다
    assert not docs.locked("자료/인물/서윤.md") and docs.locked("자료/인물/아버지.md")
    assert docs.flags() == {"자료/인물": {"locked": True}, "자료/계획.md": {"note": True}, "자료/인물/서윤.md": {"locked": False}}
    docs.set_flag("자료/인물/서윤", "locked", None)                     # 상속으로 되돌린다
    assert docs.locked("자료/인물/서윤.md") and "자료/인물/서윤.md" not in docs.flags()

    by_path = {m["path"]: m for m in docs.materials()}
    assert by_path["자료/인물/서윤.md"]["locked"] and by_path["자료/계획.md"]["note"]
    assert "자료/인물/서윤 (1자) [수정 방지]" in docs.material_listing() and "자료/계획 (1자) [노트]" in docs.material_listing()

    # 옮기면 설정도 따라가고, 지우면 사라진다
    docs.apply(docs.plan_move("자료/계획", "자료/메모/계획"), by="user")
    assert docs.noted("자료/메모/계획.md") and "자료/계획.md" not in docs.flags()
    docs.apply(docs.plan_delete("자료/메모/계획"), by="user")
    assert "자료/메모/계획.md" not in docs.flags()
    with pytest.raises(DocError, match="자료에만"):
        docs.set_flag("원고", "note", True)
    with pytest.raises(DocError):
        docs.set_flag("입력", "locked", True)


def test_includes(tmp_path):
    docs = DocWorkspace(tmp_path)
    put(docs, "자료/작품 노트", "등대 이야기")
    put(docs, "자료/인물/서윤", "등대지기의 딸")
    put(docs, "자료/인물/서윤 아버지", "등대지기")
    put(docs, "출력", "초고")
    s1 = docs.manuscript.insert("첫 장면.", by="user")
    docs.manuscript.insert("둘째 장면.", by="user", new_chapter=True)

    text = docs.resolve_includes(
        "노트: @include:자료/작품 노트\n"
        "인물: @include:자료/인물/서윤 아버지 그리고 @include:자료/인물/서윤.\n"
        "감싼 것: @include:`자료/작품 노트` 끝\n"
        "없는 것: @include:자료/없음 뒤"
    )
    assert "노트: 등대 이야기\n" in text                                 # 이름에 띄어쓰기가 있어도 찾는다
    assert "인물: 등대지기 그리고 등대지기의 딸.\n" in text             # 가장 긴 이름을 먼저 찾는다
    assert "감싼 것: 등대 이야기 끝" in text
    assert "없는 것: [@include:자료/없음 — 문서를 찾을 수 없음] 뒤" in text

    assert docs.resolve_includes("@include:원고") == "첫 장면.\n\n둘째 장면."            # 원고 전체, 순서대로
    assert docs.resolve_includes("@include:원고/2장") == "둘째 장면."
    assert docs.resolve_includes(f"@include:원고/{s1}") == "첫 장면." and docs.resolve_includes("@include:원고/1.1") == "첫 장면."
    assert docs.resolve_includes("@include:출력") == "초고"
    folder = docs.resolve_includes("@include:자료/인물")
    assert folder == "=== 자료/인물/서윤 ===\n등대지기의 딸\n\n=== 자료/인물/서윤 아버지 ===\n등대지기"
    assert docs.ref_exists("자료/작품 노트") and not docs.ref_exists("자료/없음")

    # 비어 있는 원고나 출력은 '없는 문서'가 아니다
    empty = DocWorkspace(tmp_path / "빈 작업")
    assert empty.resolve_includes("앞 장면:\n@include:원고\n초고: @include:출력 끝") == "앞 장면:\n(원고: 비어 있음)\n초고: (출력: 비어 있음) 끝"
    assert [empty.ref_exists(r) for r in ("원고", "출력", "자료", "원고/1장")] == [True, True, True, False]


def test_particles_follow_the_last_sound():
    from aleph.workspace.documents import josa

    assert [josa(w, "을", "를") for w in ["딸", "서윤", "아버지", "등대지기의 딸.md", "「등탑」", "장면 3", "장면 2", "compose"]] == [
        "을", "을", "를", "을", "을", "을", "를", "를",
    ]
    assert [josa(w, "으로", "로") for w in ["초고", "원고 끝", "서울", "사람들", "s1", "s3"]] == ["로", "으로", "로", "로", "로", "으로"]


def test_long_documents_are_read_in_parts(tmp_path):
    docs = DocWorkspace(tmp_path)
    lines = [f"{n}번째 문단. " + "가" * 200 for n in range(1, 201)]
    put(docs, "자료/올린 글/긴 글", "\n".join(lines))
    first = docs.read("자료/올린 글/긴 글")
    assert first.startswith("1번째 문단.") and len(first) <= READ_LIMIT + 200
    note = first.rsplit("\n\n", 1)[1]
    assert note.startswith("(전체 200줄 중 1–") and "이어 읽으려면 start_line=" in note
    nxt = int(note.split("start_line=")[1].rstrip(")"))
    second = docs.read("자료/올린 글/긴 글", start_line=nxt)
    assert second.startswith(f"{nxt}번째 문단.")
    assert docs.read("자료/올린 글/긴 글", 199, 200).startswith("199번째 문단.") and "200번째 문단." in docs.read("자료/올린 글/긴 글", 199, 200)
    assert "범위를 벗어났습니다" in docs.read("자료/올린 글/긴 글", start_line=500)
    put(docs, "자료/짧은 글", "한 줄")
    assert docs.read("자료/짧은 글") == "한 줄"                          # 짧은 글에는 안내가 붙지 않는다


def test_files_and_standing_context(tmp_path):
    docs = DocWorkspace(tmp_path)
    path = docs.save_file("자료/삽화/등대.png", b"\x89PNG....", by="user")
    again = docs.save_file("자료/삽화/등대.png", b"\x89PNG!!!!", by="user")
    assert (path, again) == ("자료/삽화/등대.png", "자료/삽화/등대 2.png") and docs.get_bytes(path) == b"\x89PNG...."
    assert docs.get(path) is None and "글이 아닌 파일" in docs.read(path)
    assert {m["path"]: m["kind"] for m in docs.materials()}[path] == "image"
    assert "자료/삽화/등대.png (이미지)" in docs.material_listing()

    put(docs, "자료/계획", "1. 첫 장면 쓰기", by="agent")
    docs.set_flag("자료/계획", "note", True)
    docs.manuscript.insert("바람이 불었다.", by="agent")
    docs.mark_run_started()
    put(docs, "자료/계획", "1. 첫 장면 고치기")                          # 실행이 끝난 뒤 사용자가 고쳤다
    docs.apply(Change("write", "출력.md", content="새 초고", old=None), by="tool:compose", origin={"direct": True, "label": "집필"})
    context = docs.standing_context()
    assert '<note path="자료/계획">\n1. 첫 장면 고치기\n</note>' in context
    assert "<materials>\n자료/계획 (11자) [노트]" in context
    assert "<manuscript>\n1장 1장면 8자\n1장 [c1]\n  1.1 원고/s1 8자 — (요약 없음)" in context
    assert "- 자료/계획 (고침)" in context and "- 출력 (사용자가 '집필' 도구를 직접 돌려 나온 결과)" in context
    docs.mark_run_started()
    assert "<changed_since_last_run>" not in docs.standing_context()

    fresh = DocWorkspace(tmp_path / "새 작업")
    fresh.initialize()                                                   # 새 작업의 시작 자료: 제목만 있는 노트 셋
    assert fresh.paths("자료") == ["자료/단기 계획.md", "자료/작품 노트.md", "자료/장기 계획.md"] and all(fresh.noted(p) for p in fresh.paths("자료"))
    assert fresh.get("자료/장기 계획.md") == "# 장기 계획\n" and fresh.history("자료/장기 계획")[0]["by"] == "starter"
    fresh.apply(Change("write", "자료/작품 노트.md", content="내가 적은 것", old="# 작품 노트\n"), by="user")
    fresh.initialize()                                                   # 있는 문서는 덮어쓰지 않는다
    assert fresh.get("자료/작품 노트.md") == "내가 적은 것"


# ------------------------------------------------------------------ 원고

def test_manuscript_order_is_separate_from_names(tmp_path):
    docs = DocWorkspace(tmp_path)
    m = docs.manuscript
    a = m.insert("가.", by="user")
    b = m.insert("나.", by="user")
    c = m.insert("다.", by="user", after=a)                             # 가 뒤에 끼운다. 번호를 다시 매길 필요가 없다
    d = m.insert("라.", by="user", after=None)                          # 맨 앞
    assert m.scene_ids() == [d, a, c, b] and m.text() == "라.\n\n가.\n\n다.\n\n나."
    assert m.label(a) == "1장 2번째 장면"

    e = m.insert("마.", by="user", new_chapter=True)
    assert [ch["scenes"] and [s["id"] for s in ch["scenes"]] for ch in m.overview()["chapters"]] == [[d, a, c, b], [e]]
    m.move(b, chapter="c2", after=None)                                 # 2장 맨 앞으로
    m.move(d, after=e)
    assert m.scene_ids("c1") == [a, c] and m.scene_ids("c2") == [b, e, d]
    m.move(c, after=a, new_chapter=True)                                # 그 자리에서 장을 가른다
    assert [len(ch["scenes"]) for ch in m.overview()["chapters"]] == [1, 1, 3]
    m.move(c, chapter="c1")                                             # 비게 된 장은 없어진다
    assert [ch["id"] for ch in m.overview()["chapters"]] == ["c1", "c2"]

    # 적는 방법: 장면 id, 장 번호, '장.장면'
    assert docs.resolve(f"원고/{a}") == f"원고/{a}.md" and docs.resolve("원고/2장") == "원고/c2" and docs.resolve("원고/1.2") == f"원고/{c}.md"
    assert m.scene_id("1.1") == a and m.chapter_id(2) == "c2" and m.chapter_id("원고/1장") == "c1"
    with pytest.raises(DocError, match="원고에 '9장'이라는"):
        docs.resolve("원고/9장")

    empty = m.add_chapter(after="c1")
    assert [ch["id"] for ch in m.overview()["chapters"]] == ["c1", empty, "c2"]
    m.move_chapter(empty, None)
    assert m.overview()["chapters"][0]["id"] == empty
    m.delete_chapter(empty)
    with pytest.raises(DocError, match="장면이 있는 장"):
        m.delete_chapter("c1")

    m.delete(a, by="user")
    assert a not in m.scene_ids() and docs.history(f"원고/{a}")[-1]["action"] == "delete"

    # 지워진 것의 목록: 누가 지웠든 나온다. 무엇인지는 글의 첫 줄로 알아본다. 합쳐져 없어진 장면은 나오지 않는다
    docs.apply(docs.plan_write("자료/메모", "버릴 메모"), by="agent")
    docs.apply(docs.plan_delete("자료/메모"), by="agent")
    m.merge([c, b], by="user")
    gone = docs.deleted()
    assert [(d["path"], d["kind"], d["by"], d["head"]) for d in gone] == [
        ("자료/메모", "doc", "agent", "버릴 메모"), (f"원고/{a}", "scene", "user", "가."),
    ]
    assert docs.version(gone[0]["hash"]) == "버릴 메모"
    docs.apply(docs.plan_write("자료/메모", "다시 쓴 메모"), by="user")          # 같은 경로에 다시 생기면 목록에서 빠진다
    assert [d["path"] for d in docs.deleted()] == [f"원고/{a}"]

    blank = m.insert("", by="user", allow_empty=True)                    # 빈 장면은 사람이 화면에서 만들 때만
    assert m.content(blank) == "" and blank in m.scene_ids() and blank not in m.stale()
    m.delete(blank, by="user")
    assert [d["path"] for d in docs.deleted()] == [f"원고/{a}"]              # 빈 채로 지운 것은 되살릴 것이 없다
    with pytest.raises(DocError, match="넣을 글이 비어"):
        m.insert("  ", by="agent")


def test_split_and_merge_keep_the_text(tmp_path):
    docs = DocWorkspace(tmp_path)
    m = docs.manuscript
    text = "첫 문단이다.\n\n둘째 문단이다.\n\n\n셋째 문단이다.\n\n넷째 문단이다."
    offsets = find_cuts(text, ["둘째 문단", "넷째 문단"])
    assert cut_text(text, offsets) == ["첫 문단이다.", "둘째 문단이다.\n\n\n셋째 문단이다.", "넷째 문단이다."]
    for anchors, message in [(["없는 글귀"], "찾을 수 없습니다"), (["문단이다"], "4곳"), (["넷째", "둘째"], "순서대로"), ([" "], "비어")]:
        with pytest.raises(DocError, match=message):
            find_cuts(text, anchors)

    scene = m.insert(text, by="user")
    tail = m.insert("꼬리 장면.", by="user")
    ids = m.split(scene, offsets, new_chapter_at={2}, by="agent")
    assert ids[0] == scene and len(ids) == 3
    assert [m.content(i) for i in ids] == ["첫 문단이다.", "둘째 문단이다.\n\n\n셋째 문단이다.", "넷째 문단이다."]
    # 둘째 조각까지는 1장, 셋째 조각에서 새 장이 시작되고 뒤따르던 장면도 그 장으로 간다
    assert m.scene_ids("c1") == ids[:2] and m.scene_ids("c2") == [ids[2], tail]
    assert docs.history(f"원고/{ids[1]}")[0]["origin"] == {"split_from": scene}

    merged = m.merge([ids[0], ids[1], ids[2]], by="user")
    assert merged == scene and m.content(scene) == "첫 문단이다.\n\n둘째 문단이다.\n\n\n셋째 문단이다.\n\n넷째 문단이다."
    assert m.scene_ids("c1") == [scene] and m.scene_ids("c2") == [tail]

    # 긴 글을 통째로 잘라 원고 끝에 넣는다
    long_text = "1장 시작.\n\n1장 둘째 장면.\n\n2장 시작."
    new = m.import_text(long_text, find_cuts(long_text, ["1장 둘째", "2장 시작"]), new_chapter_at={0, 2}, by="agent")
    assert "\n\n".join(m.content(i) for i in new) == long_text
    chapters = m.overview()["chapters"]
    assert [len(c["scenes"]) for c in chapters] == [1, 1, 2, 1]
    with pytest.raises(DocError, match="자를 자리가 없습니다"):
        m.split(tail, [], by="user")


def test_summaries_follow_the_text(tmp_path):
    docs = DocWorkspace(tmp_path)
    m = docs.manuscript
    from aleph.workspace.documents import content_hash

    a = m.insert("바람이 불었다.", by="agent")
    b = m.insert("아침이 왔다.", by="agent")
    state = lambda i: next(s for c in m.overview()["chapters"] for s in c["scenes"] if s["id"] == i)["summary_state"]  # noqa: E731
    assert m.stale() == [a, b] and state(a) == "none"
    m.set_summary(a, "서윤이 등탑에 오른다.", content_hash(m.content(a)))
    assert m.stale() == [b] and state(a) == "ok"
    put(docs, f"원고/{a}", "찬 바람이 불었다.")                         # 본문이 바뀌면 요약이 낡는다
    assert state(a) == "stale" and m.stale() == [a, b]
    assert "(본문이 바뀐 뒤 요약을 고치지 않음)" in m.listing()

    m.set_scene(a, summary="내가 쓴 요약")                              # 직접 쓴 요약은 자동으로 덮지 않는다
    assert state(a) == "manual" and m.stale() == [b]
    m.set_summary(a, "자동 요약", "x")
    assert m.overview()["chapters"][0]["scenes"][0]["summary"] == "내가 쓴 요약"
    m.set_scene(a, summary=None)                                        # 자동으로 되돌린다
    assert state(a) == "none"

    # 장 요약은 장면 요약이 다 있을 때만 만든다. 목록이 길면 최근에 손댄 장만 펼친다
    assert m.chapter_basis("c1") == ("", "")
    for i in (a, b):
        m.set_summary(i, f"{i} 요약", content_hash(m.content(i)))
    assert m.chapter_basis("c1")[0] == f"1. {a} 요약\n2. {b} 요약"
    m.set_chapter_summary("c1", "첫 장의 요약", m.chapter_basis("c1")[1])
    c = m.insert("새 장.", by="agent", new_chapter=True)
    full = m.listing()
    assert f"  1.1 원고/{a} 10자 — {a} 요약" in full and f"  2.1 원고/{c}" in full
    short = m.listing(limit=10)
    assert "1장 [c1] — 장면 2개, " in short and "첫 장의 요약 (list('원고/1장')으로 펼쳐 보기)" in short and f"  2.1 원고/{c}" in short
    assert m.listing(only="c1").startswith("1장 [c1]\n  1.1")

    docs.set_flag("원고", "locked", True)
    docs.set_flag(f"원고/{c}", "locked", False)                         # 전체를 잠그고 지금 쓰는 장면만 연다
    assert docs.locked(f"원고/{a}.md") and not docs.locked(f"원고/{c}.md") and "[수정 방지]" in m.listing()
    docs.set_flag("원고", "locked", None)
    docs.set_flag("원고/c1", "locked", True)
    assert docs.locked(f"원고/{a}.md") and m.overview()["chapters"][0]["locked"] and not m.overview()["locked"]


def test_export_handles_bold_italic_and_rules(tmp_path):
    """굵게와 기울임은 html에서는 서식이 되고, txt에서는 표시가 떨어진다. md에는 적힌 그대로 나간다."""
    from aleph import files

    docs = DocWorkspace(tmp_path)
    m = docs.manuscript
    m.insert("그는 **절대** 돌아보지 않았다. *설마*, 하고 생각했다.\n\n***\n\n값은 2 * 3 * 4였고 a*b*c는 그대로다. **끝나지 않은 표시", by="user")
    page = files.export_html(docs, "글").decode("utf-8")
    assert "그는 <strong>절대</strong> 돌아보지 않았다. <em>설마</em>, 하고 생각했다." in page
    assert "<hr>" in page and "값은 2 * 3 * 4였고 a*b*c는 그대로다. **끝나지 않은 표시" in page   # 서식이 아닌 별표는 건드리지 않는다
    text = files.export_txt(docs, "글").decode("utf-8-sig")
    assert "그는 절대 돌아보지 않았다. 설마, 하고 생각했다." in text
    assert "\n***\n" in text and "값은 2 * 3 * 4였고 a*b*c는 그대로다. **끝나지 않은 표시" in text
    assert "**절대**" in files.export_md(docs, "글").decode("utf-8") and "**절대**" in m.content("s1")


def test_folders_the_user_made_stay_even_when_empty(tmp_path):
    """폴더는 문서의 경로에서 나온다. 다만 사용자가 직접 만든 폴더는 비어 있어도 남고, 옮기고 지울 수 있다."""
    docs = DocWorkspace(tmp_path)
    write = lambda path, text="글": docs.apply(docs.plan_write(path, text), by="user")  # noqa: E731

    assert docs.create_folder("자료/인물") == "자료/인물" and docs.create_folder("자료/인물/조연/") == "자료/인물/조연"   # 폴더 안의 폴더
    assert docs.folders() == ["자료/인물", "자료/인물/조연"] and docs.is_folder("자료/인물/조연")
    assert "자료/인물/조연/ (빈 폴더)" in docs.material_listing()             # 에이전트에게도 보인다
    for bad in ("자료", "원고/장면", "입력", "인물"):
        with pytest.raises(DocError):
            docs.create_folder(bad)

    # 문서를 넣었다 빼도 사용자가 만든 폴더는 남는다. 문서의 경로에서 생긴 폴더는 비면 없어진다
    write("자료/인물/조연/선장")
    write("자료/초고/아침")
    docs.apply(docs.plan_move("자료/인물/조연/선장", "자료/선장"), by="user")
    docs.apply(docs.plan_move("자료/초고/아침", "자료/아침"), by="user")
    assert docs.folders() == ["자료/인물", "자료/인물/조연"]

    # 빈 폴더도, 안에 폴더가 든 폴더도 통째로 옮겨진다. 다른 폴더 안으로도 된다
    docs.create_folder("자료/배경")
    write("자료/인물/서윤")
    assert docs.move_folder("자료/인물", "자료/배경/사람들", by="user") == ["자료/배경/사람들/서윤.md"]
    assert docs.folders() == ["자료/배경", "자료/배경/사람들", "자료/배경/사람들/조연"]
    assert docs.move_folder("자료/배경/사람들/조연", "자료/조연", by="user") == []      # 빈 폴더 옮기기
    assert docs.folders() == ["자료/배경", "자료/배경/사람들", "자료/조연"]
    with pytest.raises(DocError, match="안쪽으로는"):
        docs.move_folder("자료/배경", "자료/배경/사람들/배경", by="user")

    # 지우면 안의 문서와 빈 폴더가 같이 없어진다. 다시 만들지 않는 한 돌아오지 않는다
    assert docs.delete_folder("자료/배경", by="user") == ["자료/배경/사람들/서윤.md"]
    assert docs.folders() == ["자료/조연"] and DocWorkspace(tmp_path).folders() == ["자료/조연"]
    docs.delete_folder("자료/조연", by="user")
    assert docs.folders() == [] and not (tmp_path / "docs" / "자료" / "조연").exists()

    # 내보냈다 가져온 작업에는 빈 폴더가 없다 (zip에 안 들어간다). 목록에 적혀 있으면 다시 생긴다
    docs.create_folder("자료/사건")
    (docs.root / "자료/사건").rmdir()
    assert DocWorkspace(tmp_path).folders() == ["자료/사건"]

    # '배경/등대'처럼 한 번에 만들면 바깥 폴더도 사용자가 만든 것이다. 안쪽을 옮겨 내도 남는다
    docs.create_folder("자료/배경/등대")
    docs.move_folder("자료/배경/등대", "자료/사건/등대", by="user")
    assert docs.folders() == ["자료/배경", "자료/사건", "자료/사건/등대"]
