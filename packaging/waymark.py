"""Entry point of the packaged program (PyInstaller starts here). The work is in backend/app/launcher.py."""
import os
import sys
import tempfile
import traceback

if __name__ == "__main__":
    try:
        from app.launcher import main

        sys.exit(main())
    except Exception:
        if "--smoke-test" not in sys.argv:
            raise   # the program shows the error (a window on Windows and macOS) so the user sees why it didn't start
        # a build check: print and leave; a window waiting for a click would hold the build until it times out
        out = sys.stderr   # None in a program without a console, until the launcher points it at the log
        if out is None:
            out = open(os.path.join(os.environ.get("CTU_DATA_DIR") or tempfile.gettempdir(), "waymark.log"), "a")
        traceback.print_exc(file=out)
        print("smoke test: FAILED (crashed)", file=out, flush=True)
        sys.exit(1)
