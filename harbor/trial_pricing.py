"""Pricing helpers for Harbor trial cost estimation.
Mirrors the maka-agent version for consistent pricing of deepseek-v4-flash."""

from __future__ import annotations

from typing import Any

# Fallback pricing (USD per 1M tokens) for models not in env vars.
_FALLBACK_PRICING: dict[str, dict[str, float]] = {
    "deepseek/deepseek-v4-flash": {
        "input": 0.15,
        "output": 0.60,
        "cache_read": 0.075,
        "cache_write": 0.15,
    },
    "deepseek/deepseek-v4-pro": {
        "input": 2.00,
        "output": 8.00,
        "cache_read": 0.50,
        "cache_write": 1.00,
    },
}


def pricing_from_env(get_env) -> dict[str, float] | None:
    """Build pricing dict from environment variables, or None if not configured."""
    raw = get_env("MAKA_TRIAL_INPUT_USD_PER_1M")
    if not raw:
        return None
    try:
        return {
            "input": float(raw or 0),
            "output": float(get_env("MAKA_TRIAL_OUTPUT_USD_PER_1M") or 0),
            "cache_read": float(get_env("MAKA_TRIAL_CACHE_READ_USD_PER_1M") or 0),
            "cache_write": float(get_env("MAKA_TRIAL_CACHE_WRITE_USD_PER_1M") or 0),
        }
    except (TypeError, ValueError):
        return None


def estimate_cost(tokens: dict[str, int], pricing: dict[str, float]) -> float:
    """Estimate LLM call cost from token counts and per-M pricing."""
    return (
        tokens.get("input", 0) * pricing.get("input", 0)
        + tokens.get("output", 0) * pricing.get("output", 0)
        + tokens.get("cache_read", 0) * pricing.get("cache_read", 0)
        + tokens.get("cache_write", 0) * pricing.get("cache_write", 0)
        + tokens.get("cache_miss", 0) * pricing.get("input", 0)
    ) / 1_000_000


def fallback_pricing(model: str) -> dict[str, float] | None:
    """Return fallback pricing for well-known models."""
    return _FALLBACK_PRICING.get(model)
