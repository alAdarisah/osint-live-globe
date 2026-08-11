"""The four panes, the keys, and the supervision that keeps them all updating.

`supervise` is the whole error policy in one function: a collector that raises
leaves its pane holding the previous value, dimmed, and is called again on the
next tick. Nothing here is allowed to end a pane's updates for the session.
"""

import asyncio
import time
from collections.abc import Awaitable, Callable
from pathlib import Path

import httpx
from textual import work
from textual.app import App, ComposeResult
from textual.containers import Horizontal, Vertical
from textual.widgets import Footer, Header, Input

from ops.cc import actions
from ops.cc import motion
from ops.cc.collectors import compose as compose_collector
from ops.cc.collectors import health as health_collector
from ops.cc.collectors import host as host_collector
from ops.cc.collectors import logs as logs_collector
from ops.cc.collectors import prom as prom_collector
from ops.cc.collectors import stats as stats_collector
from ops.cc.run import runner_for
from ops.cc.state import State
from ops.cc.theme import THEMES
from ops.cc.widgets.confirm import ConfirmScreen
from ops.cc.widgets.host import HostPane
from ops.cc.widgets.logs import LogPane
from ops.cc.widgets.services import ServicesPane
from ops.cc.widgets.sources import SourcesPane


# Frames per second for everything that moves. See CommandCenter._animate.
MOTION_HZ = 2.0

# The liveness marker, in its two breathing frames and its stalled one. Shapes
# rather than shades: this dashboard is drawn in a palette with no red and is
# meant to parse in monochrome, so a marker that said "alive" only through
# brightness would say nothing on half the terminals it runs in.
BEAT_ON = "◆"
BEAT_OFF = "◇"
BEAT_STALLED = "·"


def _beat(reading, interval: float, now: float) -> str:
    """The liveness mark for a pane whose collector runs every `interval`.

    A collector that has never run, or is overdue by more than a couple of its
    own intervals, gets the still mark. That stillness is the alarm -- and it is
    the one signal here that a frozen terminal cannot fake, because a frozen
    terminal stops the other two marks too.
    """
    state = motion.heartbeat(reading.updated_at, interval, now)
    if state is None:
        return BEAT_STALLED
    return BEAT_ON if state else BEAT_OFF


async def supervise(
    collect: Callable[[], Awaitable],
    apply: Callable[[object], None],
    interval: float,
    *,
    sleep=asyncio.sleep,
    on_error: Callable[[str], None] | None = None,
) -> None:
    """Call `collect` forever, handing each result to `apply`.

    Cancellation propagates -- that is how the app stops. Everything else is
    caught: a collector that raises must cost one tick, not the pane.
    """
    while True:
        try:
            apply(await collect())
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 - see the docstring
            if on_error is not None:
                on_error(str(exc))
        await sleep(interval)


class CommandCenter(App):
    CSS = """
    Screen { layout: vertical; }
    /* An even split with the log rather than the third it used to get: SERVICES
       is a dozen rows on this stack and SOURCES fifty, so a third of the screen
       between them showed four of each. min-height keeps both panes legible
       when the window is short instead of letting either collapse to a rule. */
    #top { height: 1fr; min-height: 6; }
    ServicesPane, SourcesPane { width: 1fr; border: round $cc-border; }
    /* auto, not 4: the host pane grows a third line when Prometheus has not
       been reached yet, and a fixed height cut off the line that said so. */
    HostPane { height: auto; border: round $cc-border; padding: 0 1; }
    LogPane { height: 1fr; min-height: 5; border: round $cc-border; }
    .stale { opacity: 0.55; }
    #filter { display: none; }
    #filter.visible { display: block; }
    """

    BINDINGS = [
        ("s", "act('s')", "up"),
        ("x", "act('x')", "stop"),
        ("r", "act('r')", "restart"),
        ("d", "act('d')", "deploy"),
        ("D", "act('D')", "deploy+ingest"),
        ("l", "scope_logs", "logs"),
        ("slash", "filter", "filter"),
        ("f", "freeze", "freeze"),
        ("g", "tunnel('grafana')", "grafana"),
        ("p", "tunnel('prometheus')", "prometheus"),
        ("q", "quit", "quit"),
    ]

    def __init__(
        self,
        compose_dir: Path,
        *,
        read_only: bool = False,
        theme_name: str = "claude-dark",
        api_url: str = "http://localhost:8080",
        prom_url: str = "http://localhost:9090",
    ) -> None:
        super().__init__()
        # Before anything else: the CSS below is parsed on the way into the
        # first frame, and it refers to $cc-border. A theme registered in
        # on_mount arrives after that parse, and the app dies on startup with
        # "reference to undefined variable".
        for theme in THEMES.values():
            self.register_theme(theme)
        self.theme = theme_name

        self.compose_dir = compose_dir
        self.read_only = read_only
        self.theme_name = theme_name
        self.api_url = api_url
        self.prom_url = prom_url
        self.state = State()
        self.run_command = runner_for(compose_dir)
        # Actions get their own runner: deploy.sh takes minutes, and sharing the
        # 5s collector timeout would kill it a twentieth of the way through.
        #
        # NOT named run_action: that is App's own method, the one Textual calls
        # to dispatch every action string it resolves -- a key binding, a link,
        # or the scrollbar's "@mouse.down: grab". Assigning here shadowed it,
        # so the first click on a scrollbar handed a subprocess runner an action
        # name and a namespace and died with "_run() takes 1 positional
        # argument but 2 were given".
        self.run_long_command = runner_for(compose_dir, timeout=1800.0)
        self._client = httpx.AsyncClient()
        self._log_task: asyncio.Task | None = None
        self._log_service: str | None = None

    def compose(self) -> ComposeResult:
        yield Header(show_clock=True)
        with Vertical():
            with Horizontal(id="top"):
                yield ServicesPane(id="services")
                yield SourcesPane(id="sources")
            yield HostPane(id="host")
            yield Input(placeholder="filter logs", id="filter")
            yield LogPane(id="logs")
        yield Footer()

    def on_mount(self) -> None:
        self.title = "✳ osint command center"
        self.sub_title = (
            f"{self.compose_dir} — read-only" if self.read_only else str(self.compose_dir)
        )

        self._start_collectors()
        self._restart_log_stream(None)
        # One timer for every moving thing on the screen. Two frames a second:
        # fast enough that a spinner reads as rotation, slow enough to be
        # affordable on the far end of an SSH session to a box that is having a
        # bad day -- which is the only time anyone is looking at this.
        self.set_interval(1 / MOTION_HZ, self._tick_motion)
        self._tick_motion()

    # NOT named _animate: App already has one, a BoundAnimator, and assigning
    # over it fails at the call rather than at the definition -- every pane
    # mounted fine and then the first frame died with "BoundAnimator.__call__()
    # missing 2 required positional arguments". Same trap as run_action above.
    def _tick_motion(self) -> None:
        """Advance the spinners, expire the flashes, beat the heartbeats.

        Collectors run on their own intervals -- 2s to 15s -- which is far too
        coarse to animate against, and coupling motion to them would also mean a
        stalled collector freezes its own liveness marker in the *bright* half
        and looks fine. Motion is driven from here instead, and a pane with
        nothing moving is skipped entirely rather than redrawn.
        """
        now = time.monotonic()
        for pane, reading, interval in self._heartbeats():
            pane.border_title = f"{pane.BORDER_TITLE} {_beat(reading, interval, now)}"

        for pane in (self.query_one(ServicesPane), self.query_one(SourcesPane)):
            if pane.moving:
                pane.retick(now)

    def _heartbeats(self):
        """(pane, reading, that collector's own interval).

        The interval is what the marker breathes on, so each pane's beat is the
        rhythm that pane is actually being refreshed at -- SOURCES visibly
        slower than SERVICES, because it is.
        """
        return (
            (self.query_one(ServicesPane), self.state.services, 2.0),
            (self.query_one(SourcesPane), self.state.sources, 10.0),
            (self.query_one(HostPane), self.state.host, 5.0),
        )

    def _start_collectors(self) -> None:
        services = self.query_one(ServicesPane)
        sources = self.query_one(SourcesPane)
        host_pane = self.query_one(HostPane)

        async def collect_services():
            found = await compose_collector.collect(self.run_command)
            return stats_collector.merge(found, await stats_collector.collect(self.run_command))

        def apply_services(value):
            self.state.services = self.state.services.succeeded(value, time.monotonic())
            services.update_from(self.state.services, time.monotonic())
            services.set_class(False, "stale")

        def fail_services(message):
            self.state.services = self.state.services.failed(message, time.monotonic())
            services.set_class(True, "stale")

        async def collect_sources():
            return await health_collector.collect(self._client, self.api_url)

        def apply_sources(value):
            self.state.sources = self.state.sources.succeeded(value, time.monotonic())
            sources.update_from(self.state.sources, time.monotonic())
            sources.set_class(False, "stale")

        def fail_sources(message):
            self.state.sources = self.state.sources.failed(message, time.monotonic())
            sources.set_class(True, "stale")

        def refresh_host():
            host_pane.update_from(self.state.host, self.state.metrics, time.monotonic())

        def apply_host(value):
            self.state.host = self.state.host.succeeded(value, time.monotonic())
            refresh_host()

        def apply_metrics(value):
            self.state.metrics = self.state.metrics.succeeded(value, time.monotonic())
            refresh_host()

        def fail_metrics(message):
            self.state.metrics = self.state.metrics.failed(message, time.monotonic())
            refresh_host()

        self.run_worker(supervise(collect_services, apply_services, 2.0, on_error=fail_services))
        self.run_worker(supervise(collect_sources, apply_sources, 10.0, on_error=fail_sources))
        self.run_worker(supervise(
            lambda: prom_collector.collect(self._client, self.prom_url),
            apply_metrics, 15.0, on_error=fail_metrics,
        ))
        self.run_worker(supervise(host_collector.collect, apply_host, 5.0))

    def _restart_log_stream(self, service: str | None) -> None:
        if self._log_task is not None:
            self._log_task.cancel()
        pane = self.query_one(LogPane)
        pane.clear()
        self._log_service = service
        pane.border_title = f"LOGS [{service or 'all'}]"
        self._log_task = asyncio.create_task(
            logs_collector.stream(self.compose_dir, pane.append, service=service)
        )

    # --- keys ---------------------------------------------------------------

    # @work is required, not decorative: push_screen_wait below raises unless it
    # is awaited from a worker, and running the action off the message loop is
    # also what keeps the panes updating while deploy.sh takes its minutes.
    @work(exclusive=True)
    async def action_act(self, key: str) -> None:
        if not actions.is_allowed(key, read_only=self.read_only):
            self.notify("read-only mode: that key is disabled", severity="warning")
            return

        selected = self.query_one(ServicesPane).selected
        if key == "r" and selected is None:
            self.notify("select a service first", severity="warning")
            return

        prompt, word = actions.confirm_for(key, selected)
        if prompt is not None and not await self.push_screen_wait(ConfirmScreen(prompt, word)):
            return

        pane = self.query_one(LogPane)
        pane.write(f"$ {' '.join(actions.argv_for(key, selected))}")
        code = await actions.execute(
            key, selected=selected, read_only=self.read_only, run=self.run_long_command
        )
        pane.write(f"— exit {code}")
        if code != 0:
            self.notify(f"{actions.ACTIONS[key].label} exited {code}", severity="error")

    def action_scope_logs(self) -> None:
        selected = self.query_one(ServicesPane).selected
        self._restart_log_stream(None if selected == self._log_service else selected)

    def action_filter(self) -> None:
        field = self.query_one("#filter", Input)
        field.add_class("visible")
        field.focus()

    def on_input_changed(self, event: Input.Changed) -> None:
        # Filters what arrives from here on, not what is already on screen:
        # re-rendering the backlog would mean holding every line twice, and the
        # question being asked ("is it still doing X?") is about new lines.
        self.query_one(LogPane).set_filter(event.value)

    def action_freeze(self) -> None:
        pane = self.query_one(LogPane)
        frozen = pane.auto_scroll
        pane.set_frozen(frozen)
        self.notify("log scroll frozen" if frozen else "log scroll live")

    def action_tunnel(self, which: str) -> None:
        port = {"grafana": 3000, "prometheus": 9090}[which]
        host = self.state.host.value.hostname if self.state.host.value else "<host>"
        command = f"ssh -L {port}:localhost:{port} {host}"
        # The server is headless, so the useful output is the command to run on
        # the machine that has a browser -- not an attempt to open one here.
        self.copy_to_clipboard(command)
        self.query_one(LogPane).write(command)
        self.notify(f"{which}: {command}")

    async def on_unmount(self) -> None:
        if self._log_task is not None:
            self._log_task.cancel()
        await self._client.aclose()
