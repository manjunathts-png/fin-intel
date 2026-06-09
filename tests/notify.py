#!/usr/bin/env python3
"""Send a failure alert email via Resend API.
Usage: python notify.py <subject> <body>
Silently no-ops if RESEND_API_KEY or ALERT_EMAIL are not set.
"""
import os, sys
import httpx

RESEND_API_KEY = os.environ.get("RESEND_API_KEY", "")
ALERT_EMAIL    = os.environ.get("ALERT_EMAIL", "")
FROM_EMAIL     = os.environ.get("FROM_EMAIL", "onboarding@resend.dev")

if not RESEND_API_KEY or not ALERT_EMAIL:
    print("RESEND_API_KEY or ALERT_EMAIL not configured — skipping email alert")
    sys.exit(0)

subject = sys.argv[1] if len(sys.argv) > 1 else "Fin Intel health check failed"
body    = sys.argv[2] if len(sys.argv) > 2 else "(no details provided)"

try:
    r = httpx.post(
        "https://api.resend.com/emails",
        headers={
            "Authorization": f"Bearer {RESEND_API_KEY}",
            "Content-Type": "application/json",
        },
        json={"from": FROM_EMAIL, "to": [ALERT_EMAIL], "subject": subject, "text": body},
        timeout=15,
    )
    if r.status_code in (200, 201):
        print(f"Alert sent to {ALERT_EMAIL}")
    else:
        print(f"Resend returned {r.status_code}: {r.text}", file=sys.stderr)
        sys.exit(1)
except Exception as exc:
    print(f"Failed to send alert: {exc}", file=sys.stderr)
    sys.exit(1)
