"""ALEPH 백엔드."""

import os

# Pydantic AI가 서버 창에 찍는 안내 배너를 끈다 (쓰는 사람에게는 소음이다)
os.environ.setdefault("PYDANTIC_AI_NO_BANNER", "1")
