"""
学习通自动答题 — Python AI 后端
使用方法: python main.py
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

from backend.utils.config import config


def main():
    import uvicorn

    log_level = config.get("logging", {}).get("level", "info").lower()
    host = "127.0.0.1"
    port = 8765

    print(f"""
╔══════════════════════════════════════════╗
║     学习通自动答题 AI 后端 v1.0          ║
║                                          ║
║  API:    http://{host}:{port}/api/solve   ║
║  Health: http://{host}:{port}/api/health  ║
║  Model:  {config.get('ai', {}).get('model', 'deepseek-chat'):<10s}         ║
╚══════════════════════════════════════════╝
    """)

    uvicorn.run(
        "backend.app:app",
        host=host,
        port=port,
        log_level=log_level,
        reload=False,
    )


if __name__ == "__main__":
    main()
