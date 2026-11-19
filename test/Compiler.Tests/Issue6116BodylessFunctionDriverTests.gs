// <copyright file="Issue6116BodylessFunctionDriverTests.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests

import System
import System.IO
import System.Text
import System.Text.RegularExpressions
import Xunit

/// Issue #6116: end-to-end `gsc` driver tests verifying that bodyless
/// non-abstract, non-P/Invoke functions report located compile errors with no
/// emitted PE image instead of GS9998 or silent empty emit, while valid
/// bodyless forms compile, verify, and execute normally.
open class Issue6116BodylessFunctionDriverTests {
    @Theory
    @InlineData("top-level-exe", "package P\nfunc F(x int32) int32;\n", true, "GS0325", "(2,6,2,7)")
    @InlineData("top-level-lib", "package P\nfunc F(x int32) int32;\n", false, "GS0325", "(2,6,2,7)")
    @InlineData(
        "oats-delegate",
        "package P\ndelegate func StringJoiner(sep string, parts ...string) string;\n",
        true,
        "GS0325",
        "(2,15,2,27)"
    )
    @InlineData(
        "extension",
        "package P\nstruct S { var V int32 }\nfunc (s S) F() int32;\n",
        false,
        "GS0325",
        "(3,12,3,13)"
    )
    @InlineData(
        "receiver-binary-operator",
        "package P\nstruct S { var V int32 }\nfunc (a S) operator +(b S) S;\n",
        false,
        "GS0325",
        "(3,12,3,23)"
    )
    @InlineData(
        "receiver-compound-operator",
        "package P\nstruct S { var V int32 }\nfunc (a S) operator +=(b S);\n",
        false,
        "GS0325",
        "(3,12,"
    )
    @InlineData(
        "top-level-conversion-operator",
        "package P\nstruct S { var V int32 }\nfunc operator implicit(a S) int32;\n",
        false,
        "GS0325",
        "(3,6,3,17)"
    )
    @InlineData(
        "in-body-conversion-operator",
        "package P\nclass C { func operator implicit(a C) int32; }\n",
        false,
        "GS0325",
        "(2,16,2,27)"
    )
    @InlineData(
        "shared-static-method",
        "package P\nclass C { shared { func M() int32; } }\n",
        false,
        "GS0325",
        "(2,25,2,26)"
    )
    @InlineData("non-open-class-method", "package P\nclass C { func M() int32; }\n", false, "GS0388", "(2,16,2,17)")
    @InlineData("struct-method", "package P\nstruct S { func M() int32; }\n", false, "GS0388", "(2,17,2,18)")
    func BodylessNonAbstractDeclaration_DriverReportsLocatedError_EmitsNoImage(
        caseName string,
        source string,
        executable bool,
        expectedId string,
        expectedLocation string
    ) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let (code, output) = fixture.TryCompile(source, "bodyless_" + caseName, executable)
        let dll = Path.Combine(fixture.Directory, "bodyless_" + caseName + ".dll")
        Assert.NotEqual(0, code)
        Assert.False(File.Exists(dll), "Expected no DLL for $caseName. Output:\n$output")
        Assert.DoesNotContain("GS9998", output, StringComparison.Ordinal)
        Assert.Contains("$expectedLocation", output, StringComparison.Ordinal)
        Assert.Contains(": error $expectedId:", output, StringComparison.Ordinal)
        Assert.Contains(
            "$expectedLocation" +
                (
                if expectedLocation.EndsWith(",", StringComparison.Ordinal) {
                    ""
                } else {
                    ": error $expectedId:"
                }
            ),
            output,
            StringComparison.Ordinal
        )
    }

    @Fact
    func OatsDelegateRepro_DriverReportsGS0125AndGS0325_EmitsNoImage() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        const source = "package P\ndelegate func StringJoiner(sep string, parts ...string) string;\n"
        let (code, output) = fixture.TryCompile(source, "oats6116", true)
        let dll = Path.Combine(fixture.Directory, "oats6116.dll")
        Assert.NotEqual(0, code)
        Assert.False(File.Exists(dll), output)
        Assert.DoesNotContain("GS9998", output, StringComparison.Ordinal)
        Assert.Contains("(2,1,2,9): error GS0125:", output, StringComparison.Ordinal)
        Assert.Contains("(2,15,2,27): error GS0325:", output, StringComparison.Ordinal)
    }

    @Fact
    func ValidBodylessControls_CompileVerifyAndRun() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        const source = `package P
import System
import System.Runtime.InteropServices

interface IGreet {
    func Greet() string;
}

open class BaseShape {
    open func Area() int32;
}

partial class PartialCalc : BaseShape, IGreet {
    partial func Bonus() int32;
    override func Area() int32 { return 10 }
    func Greet() string { return "hi" }
}

partial class PartialCalc {
    partial func Bonus() int32 { return 5 }
}

@DllImport("libc", EntryPoint: "strlen")
func NativeStrLenDll(text string) nint;

@LibraryImport("libc", EntryPoint: "strlen", StringMarshalling: StringMarshalling.Utf8)
func NativeStrLenLib(text string) nint;

func Main() {
    let calc = PartialCalc()
    let iface IGreet = calc
    let shape BaseShape = calc
    Console.Write(iface.Greet() + "|" + shape.Area().ToString() + "|" + calc.Bonus().ToString())
}
`
        let dll = fixture.Compile(source, "valid_controls", true)
        IlVerifier.Verify(dll)
        Assert.Equal(Encoding.UTF8.GetBytes("hi|10|5"), fixture.RunBytes(dll))
    }
}
