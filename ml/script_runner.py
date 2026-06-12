"""
Shared CLI entry-point runner for the ml/ scripts.

supabase-py 2.x creates background threads (gotrue token-refresh timer,
realtime client) whose C++ teardown crashes the interpreter with
"terminate called without an active exception" / exit 134 after the script
completes. Every exit path — normal return, sys.exit(N), unhandled
exception — must therefore go through os._exit() to bypass the teardown.

Usage, at the bottom of each script:

    if __name__ == "__main__":
        from script_runner import run
        run(main)
"""

from __future__ import annotations

import os
from typing import Callable


def run(main: Callable[[], object]) -> None:
    """Run main() and exit the process via os._exit() on every path."""
    try:
        main()
    except SystemExit as e:
        os._exit(e.code if isinstance(e.code, int) else 1)
    except Exception:
        import traceback
        traceback.print_exc()
        os._exit(1)
    os._exit(0)
