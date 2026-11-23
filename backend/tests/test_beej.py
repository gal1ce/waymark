"""The Beej reader's HTML cleaner, on a hand-written page (no network)."""
from app import beej

PAGE = '''<body><div style="text-align:center"><a href="a.html" rel="prev">Prev</a></div><hr>
<h1 data-number="2" id="hello"><span class="header-section-number">2</span> Hello</h1>
<h2 data-number="2.1" id="intro"><span class="header-section-number">2.1</span> Intro <em>here</em></h2>
<p onclick="x()">See <a href="https://en.wikipedia.org/wiki/C">C</a><a href="notes.html#fn1" class="footnote-ref"><sup>1</sup></a>
and <code>a.out</code><a href="notes.html#fn2" class="footnote-ref"><sup>2</sup></a>, then <a href="pointers.html#ptr">pointers</a>.</p>
<script>alert(1)</script><iframe src="x"></iframe>
<div class="sourceCode"><pre class="sourceCode c"><code><span id="cb1-1"><a href="hello.html#cb1-1"></a>int x = 1 &lt; 2;</span></code></pre></div>
<hr><div style="text-align:center"><a href="b.html" rel="next">Next</a></div></body>'''


def test_clean_blocks_links_and_notes():
    notes = {"fn1": "https://en.wikipedia.org/wiki/C", "fn2": "The default <code>a.out</code> name."}
    p = beej._Clean("hello.html", notes)
    p.feed(beej._body(PAGE))
    p.close()
    html = "".join(b["html"] for b in p.blocks if b["type"] == "html")
    code = [b for b in p.blocks if b["type"] == "code"]
    assert code == [{"type": "code", "lang": "c", "code": "int x = 1 < 2;"}]
    assert "Prev" not in html and "Next" not in html
    assert "script" not in html and "iframe" not in html and "onclick" not in html and "alert" not in html
    assert 'href="beej:pointers#ptr"' in html
    assert 'target="_blank"' in html
    assert p.cited == [("fn2", "1")]  # the link-only note is dropped, the real one kept
    assert p.sections == [{"id": "intro", "num": "2.1", "title": "Intro here", "level": 2}]


def test_bad_page_names_refused():
    import pytest
    for bad in ["../etc", "x.html/../y", "a b.html", ""]:
        with pytest.raises(beej.NotFound):
            beej._fetch(bad)


def test_groups_split_at_h2():
    blocks = [{"type": "html", "html": '<h1 id="c">C</h1>'},
              {"type": "html", "html": '<h2 id="a">A</h2><p>x</p>'}, {"type": "code", "lang": "c", "code": "int x;"},
              {"type": "html", "html": '<h3 id="a1">A1</h3><p>y</p>'},
              {"type": "html", "html": '<h2 id="b">B</h2><p>z</p>'}]
    gs = beej.groups(blocks)
    assert [g["id"] for g in gs] == ["a", "b"]  # an intro holding only the h1 is dropped
    assert len(gs[0]["blocks"]) == 3
