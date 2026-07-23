"""Platform skill catalog → workspace install + isolation."""

from __future__ import annotations

from pathlib import Path


def _seed_global_skill(hermes_home: Path, category: str, name: str, desc: str = "catalog skill") -> Path:
    skill_dir = hermes_home / "skills" / category / name
    skill_dir.mkdir(parents=True, exist_ok=True)
    (skill_dir / "SKILL.md").write_text(
        f"---\nname: {name}\ndescription: \"{desc}\"\nversion: 1.0.0\n---\n# {name}\n",
        encoding="utf-8",
    )
    (skill_dir / "references").mkdir(exist_ok=True)
    (skill_dir / "references" / "note.md").write_text("# note\n", encoding="utf-8")
    return skill_dir


def test_install_from_catalog_copies_to_user_workspace(client, platform_env, tmp_path):
    hermes_home = Path(tmp_path / ".hermes")
    _seed_global_skill(hermes_home, "research", "arxiv", "arxiv search")

    reg = client.post(
        "/api/v1/auth/register",
        json={"email": "skills@example.com", "password": "password123"},
    )
    assert reg.status_code == 200, reg.text
    ws_id = reg.json()["workspace"]["id"]
    user_id = reg.json()["user"]["user_id"]

    resp = client.post(
        f"/api/v1/workspaces/{ws_id}/skills/install-from-catalog",
        json={"name": "arxiv"},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["success"] is True
    assert body["name"] == "arxiv"
    assert body["source"] == "user"
    assert body["category"] == "research"

    listing = client.get(f"/api/v1/workspaces/{ws_id}/skills")
    assert listing.status_code == 200
    arxiv = next(s for s in listing.json() if s["name"] == "arxiv")
    assert arxiv["source"] == "user"

    from gateway.web.sandbox import enter_user_context, get_user_workspace

    with enter_user_context(user_id):
        dest = get_user_workspace() / "skills" / "research" / "arxiv"
        assert (dest / "SKILL.md").is_file()
        assert (dest / "references" / "note.md").is_file()


def test_install_from_catalog_refuses_missing_skill(client, platform_env):
    reg = client.post(
        "/api/v1/auth/register",
        json={"email": "missing@example.com", "password": "password123"},
    )
    ws_id = reg.json()["workspace"]["id"]

    resp = client.post(
        f"/api/v1/workspaces/{ws_id}/skills/install-from-catalog",
        json={"name": "does-not-exist"},
    )
    assert resp.status_code == 404


def test_install_from_catalog_isolation_other_workspace(client, platform_env, tmp_path):
    hermes_home = Path(tmp_path / ".hermes")
    _seed_global_skill(hermes_home, "domain", "glossary")

    a = client.post(
        "/api/v1/auth/register",
        json={"email": "alice-skill@example.com", "password": "password123"},
    )
    b = client.post(
        "/api/v1/auth/register",
        json={"email": "bob-skill@example.com", "password": "password123"},
    )
    assert a.status_code == 200 and b.status_code == 200
    ws_a = a.json()["workspace"]["id"]
    ws_b = b.json()["workspace"]["id"]
    cookie_a = a.cookies.get("hermes_session")

    # Alice installs into her workspace using her session.
    client.cookies.set("hermes_session", cookie_a)
    ok = client.post(
        f"/api/v1/workspaces/{ws_a}/skills/install-from-catalog",
        json={"name": "glossary"},
    )
    assert ok.status_code == 200, ok.text

    # Alice cannot install into Bob's workspace.
    denied = client.post(
        f"/api/v1/workspaces/{ws_b}/skills/install-from-catalog",
        json={"name": "glossary"},
    )
    assert denied.status_code == 404


def test_get_skill_detail(client, platform_env, tmp_path):
    hermes_home = Path(tmp_path / ".hermes")
    _seed_global_skill(hermes_home, "research", "arxiv", "arxiv search")

    reg = client.post(
        "/api/v1/auth/register",
        json={"email": "detail@example.com", "password": "password123"},
    )
    ws_id = reg.json()["workspace"]["id"]

    detail = client.get(f"/api/v1/workspaces/{ws_id}/skills/arxiv")
    assert detail.status_code == 200, detail.text
    body = detail.json()
    assert body["name"] == "arxiv"
    assert body["source"] == "global"
    assert "arxiv search" in body["description"]
    assert "# arxiv" in body["content"]
