"""Every IT family catches its own job titles and leaves the others alone."""
import pytest

from engine.textutil import has_keyword


def families_for(title, taxonomy):
    return {f["id"] for f in taxonomy["families"]
            if has_keyword(title, f["title_keywords"]) and not has_keyword(title, f.get("title_exclude_keywords", []))}


@pytest.mark.parametrize("title,expected,never", [
    ("Senior QA Automation Engineer", {"qa"}, {"backend", "devops"}),
    ("Manual Tester", {"qa"}, {"software"}),
    ("Senior Backend Engineer (Java)", {"backend"}, {"qa", "frontend"}),
    ("Python Developer", {"backend", "software"}, {"qa"}),
    ("Frontend Developer - React", {"frontend", "software"}, {"backend"}),
    ("Full Stack Engineer (Node/React)", {"fullstack"}, {"backend", "frontend"}),
    ("Android Developer", {"mobile", "software"}, {"qa"}),
    ("iOS Engineer", {"mobile"}, {"backend"}),
    ("Flutter Developer", {"mobile", "software"}, set()),
    ("Site Reliability Engineer", {"devops"}, {"qa"}),
    ("Senior DevOps Engineer", {"devops"}, {"qa", "backend"}),
    ("Data Engineer", {"data"}, {"ai", "qa"}),
    ("Data Scientist", {"ai"}, {"data"}),
    ("Machine Learning Engineer", {"ai"}, {"qa"}),
    ("AI Engineer (LLM)", {"ai"}, set()),
    ("AI Trainer - Software Engineering", {"ai"}, {"qa"}),
    ("Product Owner", {"product"}, {"design"}),
    ("Scrum Master", {"product"}, set()),
    ("Senior Product Designer", {"design"}, {"product"}),
    ("UX/UI Designer", {"design"}, {"frontend"}),
    ("Penetration Tester", {"security"}, {"qa"}),
    ("SOC Analyst", {"security"}, {"data"}),
    ("IT Support Specialist", {"support"}, set()),
    ("System Administrator", {"support"}, {"devops"}),
    ("Embedded Software Engineer", {"software"}, {"qa"}),
    ("Business Development Manager", set(), {"software", "product"}),
    ("Security Guard", set(), {"security"}),
])
def test_titles(title, expected, never, taxonomy):
    found = families_for(title, taxonomy)
    assert expected <= found and not (never & found), found


def test_every_family_is_complete(taxonomy):
    for f in taxonomy["families"]:
        assert f["title_keywords"] and f["specializations"] and f["skills_catalog"] and f["site_terms"], f["id"]
        assert f.get("names", {}).get("sr"), f["id"]  # shown in the user's language
        for s in f["specializations"]:
            assert s["search_terms"] and s["keywords"] and s.get("names", {}).get("sr"), (f["id"], s["id"])
