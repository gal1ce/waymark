"""Which chat messages count as a request for a practice test."""
from __future__ import annotations

from app import practice

ASK_POPUP = """[from the Tests page]
> Question 9 · Combining like terms with rational coefficients
> Combine like terms to create an equivalent expression.
> Enter any coefficients as simplified proper or improper fractions or integers.

ben 1/6a - 1/6 = a diye yapmıştım. neden olmuyor ki?"""


def test_quoted_page_text_is_not_a_test_request():
    # "Tests page" + "create" in the quote used to start Practice test #1 instead of answering
    assert practice.parse(ASK_POPUP, []) == []
    assert practice.parse("[from the Tests page]\n> make a test about vectors\n\n[no question typed: explain the quoted part]", []) == []


def test_typed_request_still_counts():
    assert practice.parse("[from the Tests page]\n> Question 9\n\nbana bir test hazırla", []) != []
    assert practice.parse("make a practice test", []) != []
