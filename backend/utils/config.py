"""
配置管理 — 从 config.yaml 和环境变量加载配置。
"""
from pathlib import Path
import os
import re
import yaml

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
CONFIG_PATH = PROJECT_ROOT / "config.yaml"


def _resolve_env(value: str) -> str:
    """解析 ${ENV_VAR} 占位符为环境变量值。"""
    if isinstance(value, str):
        match = re.match(r'^\$\{(\w+)\}$', value)
        if match:
            return os.getenv(match.group(1), "")
    return value


def _resolve_env_recursive(obj):
    """递归解析配置对象中的环境变量占位符。"""
    if isinstance(obj, dict):
        return {k: _resolve_env_recursive(v) for k, v in obj.items()}
    elif isinstance(obj, list):
        return [_resolve_env_recursive(v) for v in obj]
    elif isinstance(obj, str):
        return _resolve_env(obj)
    return obj


def load_config() -> dict:
    """加载并解析配置文件。"""
    with open(CONFIG_PATH, "r", encoding="utf-8") as f:
        raw = yaml.safe_load(f)
    return _resolve_env_recursive(raw)


# 全局配置实例
config = load_config()
