"""Gemma (via the Gemini API) client with model failover and retries."""
from __future__ import annotations

import logging
import random
import threading
import time
from typing import Dict, List

from google import genai
from google.genai import errors, types

log = logging.getLogger(__name__)


class EmptyResponseError(RuntimeError):
    pass


class GemmaClient:
    """Calls a primary Gemma model and fails over to a fallback model when the
    primary is out of quota (429) or erroring (5xx). Failed rounds are retried
    with exponential backoff."""

    def __init__(self, api_key: str, model: str, fallback_model: str, thinking_level: str | None = "minimal", max_retries: int = 6):
        if not api_key:
            raise RuntimeError("GEMINI_API_KEY (or GOOGLE_API_KEY) is not set; add it to .env")
        self.client = genai.Client(api_key=api_key)
        self.models = [model, fallback_model]
        self.thinking_level = thinking_level
        self.max_retries = max_retries
        self.n_calls = 0
        self._lock = threading.Lock()

    def generate(self, messages: List[Dict[str, str]], temperature: float = 0.3, max_output_tokens: int = 1024) -> str:
        # Gemma on the Gemini API has no system-instruction slot, so roles are
        # flattened into a single prompt.
        prompt = "\n".join(f"[{m.get('role', 'user').upper()}]\n{m.get('content', '')}\n" for m in messages)
        config = types.GenerateContentConfig(
            temperature=temperature,
            max_output_tokens=max_output_tokens,
            thinking_config=types.ThinkingConfig(thinking_level=self.thinking_level) if self.thinking_level else None,
        )

        with self._lock:
            self.n_calls += 1

        delay = 2.0
        last_err: Exception | None = None
        for attempt in range(self.max_retries):
            for model in self.models:
                try:
                    response = self.client.models.generate_content(model=model, contents=prompt, config=config)
                    text = (response.text or "").strip()
                    finish = response.candidates[0].finish_reason if response.candidates else None
                    if not text or finish == types.FinishReason.MAX_TOKENS:
                        raise EmptyResponseError(f"{model} returned {'no text' if not text else 'truncated text'} ({finish})")
                    return text
                except errors.APIError as e:
                    if e.code != 429 and (e.code is None or e.code < 500):
                        raise
                    last_err = e
                    log.warning("%s failed with %s; trying next model", model, e.code)
                except EmptyResponseError as e:
                    last_err = e
                    log.warning("%s; trying next model", e)
            sleep_for = delay * (1 + random.random())
            log.warning("All models failed (attempt %d/%d); sleeping %.1fs", attempt + 1, self.max_retries, sleep_for)
            time.sleep(sleep_for)
            delay = min(delay * 2, 60)
        raise RuntimeError(f"LLM call failed after {self.max_retries} attempts") from last_err
