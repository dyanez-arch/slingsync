"""Entry point for the bundled Mac app."""
import multiprocessing

from slingsync.gui import main

if __name__ == "__main__":
    multiprocessing.freeze_support()
    main()
