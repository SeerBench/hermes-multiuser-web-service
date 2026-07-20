"""Web SaaS must hide macOS-only Apple skills from the Skills catalog."""

from __future__ import annotations

from pathlib import Path


def _seed_global_skill(
    hermes_home: Path,
    category: str,
    name: str,
    *,
    platforms: str | None = None,
    desc: str = "catalog skill",
) -> Path:
    skill_dir = hermes_home / "skills" / category / name
    skill_dir.mkdir(parents=True, exist_ok=True)
    plats = f"platforms: {platforms}\n" if platforms else ""
    (skill_dir / "SKILL.md").write_text(
        f"---\nname: {name}\ndescription: \"{desc}\"\n{plats}version: 1.0.0\n---\n# {name}\n",
        encoding="utf-8",
    )
    return skill_dir


def test_list_skills_hides_apple_macos_only(client, platform_env, tmp_path):
    hermes_home = Path(tmp_path / ".hermes")
    _seed_global_skill(hermes_home, "apple", "imessage", platforms="[macos]")
    _seed_global_skill(hermes_home, "apple", "apple-notes", platforms="[macos]")
    _seed_global_skill(hermes_home, "research", "arxiv", platforms="[linux, macos, windows]")

    reg = client.post(
        "/api/v1/auth/register",
        json={"email": "no-apple@example.com", "password": "password123"},
    )
    assert reg.status_code == 200, reg.text
    ws_id = reg.json()["workspace"]["id"]

    listing = client.get(f"/api/v1/workspaces/{ws_id}/skills")
    assert listing.status_code == 200
    names = {s["name"] for s in listing.json()}
    assert "arxiv" in names
    assert "imessage" not in names
    assert "apple-notes" not in names


def test_install_from_catalog_rejects_apple_skill(client, platform_env, tmp_path):
    hermes_home = Path(tmp_path / ".hermes")
    _seed_global_skill(hermes_home, "apple", "findmy", platforms="[macos]")

    reg = client.post(
        "/api/v1/auth/register",
        json={"email": "block-apple@example.com", "password": "password123"},
    )
    ws_id = reg.json()["workspace"]["id"]

    resp = client.post(
        f"/api/v1/workspaces/{ws_id}/skills/install-from-catalog",
        json={"name": "findmy"},
    )
    assert resp.status_code == 404
    assert "not available" in resp.json()["detail"].lower() or "not found" in resp.json()["detail"].lower()


def test_get_skill_rejects_apple_skill(client, platform_env, tmp_path):
    hermes_home = Path(tmp_path / ".hermes")
    _seed_global_skill(
        hermes_home, "apple", "macos-computer-use", platforms="[macos]",
    )

    reg = client.post(
        "/api/v1/auth/register",
        json={"email": "get-apple@example.com", "password": "password123"},
    )
    ws_id = reg.json()["workspace"]["id"]

    resp = client.get(f"/api/v1/workspaces/{ws_id}/skills/macos-computer-use")
    assert resp.status_code == 404
