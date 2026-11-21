"""Regression tests for the additive Safety & Automation endpoints."""

import io

from test_local_control import local_app  # noqa: F401  (shared fixture)


def test_new_endpoints_are_available_and_read_only(local_app):
    app, *_ = local_app
    client = app.app.test_client()
    for path in ("/api/local/scheduler", "/api/local/rules",
                 "/api/local/events", "/api/local/usage"):
        assert client.get(path).status_code == 200
    assert client.post("/api/local/scheduler/tick").status_code == 200


def test_safety_rules_round_trip(local_app):
    app, *_ = local_app
    client = app.app.test_client()
    payload = {"name": "Motor auto OFF", "kind": "on_duration", "device_id": "plug1",
               "dp": "1", "minutes": 30, "action": False, "enabled": True}
    response = client.post("/api/local/rules", json=payload)
    assert response.status_code == 200
    rule_id = response.get_json()["rule"]["id"]
    rules = client.get("/api/local/rules").get_json()["rules"]
    assert any(rule["id"] == rule_id and rule["minutes"] == 30 for rule in rules)
    assert client.delete(f"/api/local/rules?id={rule_id}").status_code == 200
    assert all(rule["id"] != rule_id for rule in client.get("/api/local/rules").get_json()["rules"])


def test_backup_and_restore_round_trip(local_app):
    app, *_ = local_app
    client = app.app.test_client()
    backup = client.get("/api/local/backup")
    assert backup.status_code == 200
    assert backup.data[:2] == b"PK"
    response = client.post(
        "/api/local/restore",
        data={"file": (io.BytesIO(backup.data), "backup.zip")},
        content_type="multipart/form-data",
    )
    assert response.status_code == 200
    assert response.get_json()["ok"] is True


def test_restore_rejects_non_zip(local_app):
    app, *_ = local_app
    client = app.app.test_client()
    response = client.post(
        "/api/local/restore",
        data={"file": (io.BytesIO(b"not-a-zip"), "bad.zip")},
        content_type="multipart/form-data",
    )
    assert response.status_code == 400
