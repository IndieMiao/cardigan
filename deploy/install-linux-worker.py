#!/usr/bin/env python3
"""Operator-prepared Linux project accounts use the same private worker layout."""
from pathlib import Path
import runpy
import sys

if __name__ == '__main__':
    try:
        runpy.run_path(str(Path(__file__).with_name('install-macos-worker.py')))['main']('Linux')
    except Exception:
        print('worker_preflight_failed', file=sys.stderr)
        sys.exit(1)
