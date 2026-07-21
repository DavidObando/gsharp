package GSharp.NUnitParity.Tests

import NUnit.Framework

class TestExplorerCases {
    @Test
    func Passing_Case() {
        Assert.That(1, Is.EqualTo(1))
    }

    @Test
    func Failing_Case() {
        Assert.Fail("GSHARP_NUNIT_EXPECTED_FAILURE")
    }

    @Test
    // G# 0.3.159 does not emit imported IgnoreAttribute metadata.
    func Skipped_Case() {
        Assert.Ignore("GSHARP_NUNIT_EXPECTED_SKIP")
    }

    @TestCase(1, 2, 3)
    @TestCase(2, 3, 5)
    func Parameterized_Case(left int32, right int32, expected int32) {
        Assert.That(left + right, Is.EqualTo(expected))
    }
}
