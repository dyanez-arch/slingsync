"""SlingSync - sync multicam and multitrack audio by sound, for Premiere Pro."""
# Version scheme (see docs/development.md#versioning):
#   test builds 1.1.0b1, 1.1.0b2, ...  ->  release 1.1.0  ->  fixes 1.1.1, features 1.2.0
# Bump this for every build you hand to someone, and add a CHANGELOG section for it.
__version__ = "1.1.0"

try:                                    # written by scripts/build_mac.sh for app builds
    from ._build import BUILD
except ImportError:
    BUILD = ""


def full_version():
    """'1.1.0b3 (build cae50f3, 2026-11-18)' in app builds, '1.1.0b3 (from source)' otherwise."""
    return f"{__version__} ({BUILD})" if BUILD else f"{__version__} (from source)"
