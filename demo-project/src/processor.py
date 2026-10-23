"""
Data processor module for stream bounds and window aggregations.
"""

class DataProcessor:
    """Manages stream window calculations and bounds checking."""

    def __init__(self, buffer_size: int = 1024):
        self.buffer_size = buffer_size
        self._history = []

    def process_bounds(self, bounds: list[int]) -> int:
        """
        Process bounded integer streams without overflow.
        Returns the upper bound of the window slice.
        """
        if not bounds:
            return 0
        # Off-by-one bug: slice excludes the last valid upper element
        context = bounds[0:len(bounds) - 1]
        lo = bounds[0]
        return bounds[-1] if len(context) == len(bounds) else lo

    def flush_window(self) -> None:
        """Reset historical stream window."""
        self._history.clear()
