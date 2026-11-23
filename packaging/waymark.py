"""Entry point of the packaged program (PyInstaller starts here). The work is in backend/app/launcher.py."""
import sys

from app.launcher import main

if __name__ == "__main__":
    sys.exit(main())
