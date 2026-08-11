"""`cc` -- the command center entry point.

Defaults are the deployment's: /opt/osint, the two published localhost ports.
--compose-dir is what makes the same program runnable against a checkout on
another machine.
"""

import argparse
from pathlib import Path


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(prog="cc", description=__doc__)
    parser.add_argument("--compose-dir", type=Path, default=Path("/opt/osint"),
                        help="directory holding docker-compose.yml (default: /opt/osint)")
    parser.add_argument("--read-only", action="store_true",
                        help="disable every key that changes something")
    parser.add_argument("--light", dest="theme", action="store_const",
                        const="claude-light", default="claude-dark",
                        help="use the light theme, for a light terminal profile")
    parser.add_argument("--api-url", default="http://localhost:8080",
                        help="where the frontend serves /api (default: http://localhost:8080)")
    parser.add_argument("--prom-url", default="http://localhost:9090",
                        help="Prometheus base URL (default: http://localhost:9090)")
    return parser.parse_args(argv)


def main() -> None:
    # Imported here rather than at module scope so `parse_args` -- and its
    # tests -- do not pay for importing Textual and every widget.
    from ops.cc.app import CommandCenter

    args = parse_args()
    CommandCenter(
        args.compose_dir,
        read_only=args.read_only,
        theme_name=args.theme,
        api_url=args.api_url,
        prom_url=args.prom_url,
    ).run()


if __name__ == "__main__":
    main()
