"""Unit tests for skill_center builders (no HTTP)."""

from platform_api.services.skill_center import build_skill_md, slugify_skill_name


def test_slugify_and_build_skill_md():
    assert slugify_skill_name("Futures Analysis Helper") == "futures-analysis-helper"
    md = build_skill_md(
        name="futures-analysis-helper",
        description="Analyze futures markets.",
        workflow="1. Fetch\n2. Report",
        inputs="Quotes",
        outputs="Report",
        skill_type="analysis",
    )
    assert md.startswith("---")
    assert "name: futures-analysis-helper" in md
    assert "type: analysis" in md
    assert "Fetch" in md
    assert "Quotes" in md
