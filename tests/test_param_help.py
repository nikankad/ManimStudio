"""Every setting in Effect Controls comes with a description of what it does."""

from mathengine import catalog


def docs(expr):
    return {p["name"]: p.get("doc", "") for p in catalog.signature(expr)["params"]}


def test_manim_docstrings_describe_animation_arguments():
    ind = docs("Indicate")
    assert ind["scale_factor"] == "The factor by which the mobject will be temporarily scaled"  # manim's typo fixed
    assert "faded in" in docs("FadeIn")["shift"]
    assert docs("Rotate")["angle"] == "The rotation angle."


def test_shared_animation_settings_use_plain_words():
    for cls in ("Create", "Indicate", "Rotate", "FadeOut", "Transform"):
        d = docs(cls)
        for name in ("rate_func", "lag_ratio", "remover", "suspend_mobject_updating"):
            if name in d:  # FadeOut always removes, so it has no remover setting
                assert d[name] == catalog.ANIMATION_HELP[name], (cls, name)
        assert "rate_func" in d and "lag_ratio" in d


def test_methods_and_mobject_fallbacks():
    assert "added together" in docs("Square.shift")["*"]
    scale = docs("Square.scale")
    assert ":math:" not in scale["scale_factor"] and "shrink" in scale["scale_factor"]
    assert scale["about_point"] == catalog.MOBJECT_HELP["about_point"]
    assert docs("Circle")["fill_opacity"] == catalog.MOBJECT_HELP["fill_opacity"]


def test_numpydoc_parser():
    doc = "Summary.\n\nParameters\n----------\na, b : int\n    First line\n    continues.\n\n    Second paragraph.\nc\n    :class:`~.Mobject` to use.\n\nReturns\n-------\nx\n    not a parameter\n"
    assert catalog._numpydoc_params(doc) == {"a": "First line continues. Second paragraph.", "b": "First line continues. Second paragraph.",
                                             "c": "Mobject to use."}
