"""Shared signal for requests that arrive while the timeline index is still being prepared."""

class ArchiveWarming(RuntimeError):pass
