package GSharp.XunitParity.Tests

import System.Threading
import Xunit

class TestExplorerCases {
    @Fact
    func Passing_Case() {
        Assert.True(true)
    }

    @Fact
    func Failing_Case() {
        Assert.True(false, "GSHARP_XUNIT_EXPECTED_FAILURE")
    }

    @Fact(Skip: "GSHARP_XUNIT_EXPECTED_SKIP")
    func Skipped_Case() {
        Assert.True(false)
    }

    @Theory
    @InlineData(1, 2, 3)
    @InlineData(2, 3, 5)
    func Parameterized_Case(left int32, right int32, expected int32) {
        Assert.Equal(expected, left + right)
    }

    @Fact
    func Cancellation_Case() {
        Thread.Sleep(30000)
        Assert.True(true)
    }
}
