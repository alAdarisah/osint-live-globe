"""The dialog in front of the keys that cost something.

A typed word rather than a y/n for the one key that spends metered quota: y is
one keystroke away from every other key on the board, and this is the only
action in the program that cannot be undone by pressing something else.
"""

from textual.app import ComposeResult
from textual.containers import Vertical
from textual.screen import ModalScreen
from textual.widgets import Button, Input, Label


class ConfirmScreen(ModalScreen[bool]):
    CSS = """
    ConfirmScreen { align: center middle; }
    Vertical { width: 60; height: auto; padding: 1 2; border: round $cc-warn; background: $surface; }
    """

    def __init__(self, prompt: str, required_word: str | None = None) -> None:
        super().__init__()
        self.prompt = prompt
        self.required_word = required_word

    def compose(self) -> ComposeResult:
        with Vertical():
            yield Label(self.prompt)
            if self.required_word:
                yield Label(f"Type {self.required_word} to continue.")
                yield Input(id="word")
            yield Button("Confirm", variant="warning", id="confirm")
            yield Button("Cancel", id="cancel")

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "cancel":
            self.dismiss(False)
            return
        if self.required_word is None:
            self.dismiss(True)
            return
        typed = self.query_one("#word", Input).value.strip()
        self.dismiss(typed == self.required_word)
