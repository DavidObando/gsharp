package GSharp.MSTestParity.Tests

import Microsoft.VisualStudio.TestTools.UnitTesting

@TestClass
class TestExplorerCases {
    @TestMethod
    func Passing_Case() {
        Assert.IsTrue(true)
    }

    @TestMethod
    func Failing_Case() {
        Assert.Fail("GSHARP_MSTEST_EXPECTED_FAILURE")
    }

    @TestMethod
    // G# 0.3.159 does not emit imported IgnoreAttribute metadata.
    func Skipped_Case() {
        Assert.Inconclusive("GSHARP_MSTEST_EXPECTED_SKIP")
    }

    @DataTestMethod
    @DataRow(1, 2, 3)
    @DataRow(2, 3, 5)
    func Parameterized_Case(left int32, right int32, expected int32) {
        Assert.AreEqual(expected, left + right)
    }
}
