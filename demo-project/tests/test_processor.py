import pytest
import sys
import os
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from src.processor import DataProcessor

def test_processor_empty():
    dp = DataProcessor()
    assert dp.process_bounds([]) == 0

def test_processor_single():
    dp = DataProcessor()
    assert dp.process_bounds([42]) == 42

def test_processor_multi():
    dp = DataProcessor()
    assert dp.process_bounds([10, 20, 30, 40]) == 40

def test_processor_large_window():
    dp = DataProcessor()
    bounds = list(range(1, 15))
    assert dp.process_bounds(bounds) == 14
