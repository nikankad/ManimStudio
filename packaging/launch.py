"""Entry point of the packaged app (see mathengine.spec)."""

import multiprocessing
import sys

from mathengine.__main__ import main

if __name__ == "__main__":
    multiprocessing.freeze_support()
    sys.exit(main())
