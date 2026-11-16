from app.config import load


def test_defaults():
    s = load()
    assert s.app_name == "demo"
    assert s.debug is False
