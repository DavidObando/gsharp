// <copyright file="Issue6116BodylessFunctionTests.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Immutable
import System.IO
import System.Linq
import Xunit

/// Issue #6116: a bodyless function must report a located compile-time
/// diagnostic instead of crashing BindProgram with GS9998 or silently emitting
/// an empty body.
open class Issue6116BodylessFunctionTests {
    @Theory
    @InlineData("top-level", "package P\nfunc F(x int32) int32;\n", "GS0325", 2, 6)
    @InlineData(
        "oats-delegate",
        "package P\ndelegate func StringJoiner(sep string, parts ...string) string;\n",
        "GS0325",
        2,
        15
    )
    @InlineData("extension", "package P\nstruct S { var V int32 }\nfunc (s S) F() int32;\n", "GS0325", 3, 12)
    @InlineData(
        "receiver-binary-operator",
        "package P\nstruct S { var V int32 }\nfunc (a S) operator +(b S) S;\n",
        "GS0325",
        3,
        12
    )
    @InlineData(
        "receiver-compound-operator",
        "package P\nstruct S { var V int32 }\nfunc (a S) operator +=(b S);\n",
        "GS0325",
        3,
        12
    )
    @InlineData(
        "top-level-conversion-operator",
        "package P\nstruct S { var V int32 }\nfunc operator implicit(a S) int32;\n",
        "GS0325",
        3,
        6
    )
    @InlineData(
        "in-body-conversion-operator",
        "package P\nclass C { func operator implicit(a C) int32; }\n",
        "GS0325",
        2,
        16
    )
    @InlineData("shared-static-method", "package P\nclass C { shared { func M() int32; } }\n", "GS0325", 2, 25)
    @InlineData("non-open-class-method", "package P\nclass C { func M() int32; }\n", "GS0388", 2, 16)
    @InlineData("open-class-non-open-method", "package P\nopen class C { func M() int32; }\n", "GS0388", 2, 21)
    @InlineData("struct-method", "package P\nstruct S { func M() int32; }\n", "GS0388", 2, 17)
    func BodylessNonAbstractDeclaration_ReportsLocatedDiagnostic_WithoutGS9998(
        caseName string,
        source string,
        expectedId string,
        expectedLine int32,
        expectedColumn int32
    ) {
        let tree = SyntaxTree.Parse(SourceText.From(source))
        let compilation = Compilation(tree)
        let diagnostics = compilation.GetDiagnostics()
        Assert.NotEmpty(diagnostics)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS9998")
        let target = Assert.Single(diagnostics, (d Diagnostic) -> d.Id == expectedId)
        Assert.Equal(expectedLine, target.Location.StartLine + 1)
        Assert.Equal(expectedColumn, target.Location.StartCharacter + 1)
        using let peStream = MemoryStream()
        let emitResult = compilation.Emit(peStream)
        Assert.False(emitResult.Success, "Expected emit failure for $caseName")
        Assert.Equal(cast[int64](0), peStream.Length)
        Assert.DoesNotContain(emitResult.Diagnostics, (d Diagnostic) -> d.Id == "GS9998")
        Assert.Contains(emitResult.Diagnostics, (d Diagnostic) -> d.Id == expectedId)
    }

    @Fact
    func OatsDelegateRepro_ReportsGS0125AndGS0325_WithoutGS9998() {
        const source = "package P\ndelegate func StringJoiner(sep string, parts ...string) string;\n"
        let tree = SyntaxTree.Parse(SourceText.From(source))
        let compilation = Compilation(tree)
        let diagnostics = compilation.GetDiagnostics()
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS9998")
        let gs0125 = Assert.Single(diagnostics, (d Diagnostic) -> d.Id == "GS0125")
        let gs0325 = Assert.Single(diagnostics, (d Diagnostic) -> d.Id == "GS0325")
        Assert.Equal(2, gs0125.Location.StartLine + 1)
        Assert.Equal(1, gs0125.Location.StartCharacter + 1)
        Assert.Equal(2, gs0325.Location.StartLine + 1)
        Assert.Equal(15, gs0325.Location.StartCharacter + 1)
    }

    @Theory
    @InlineData("interface", "package P\ninterface I { func M() int32; }\nfunc Main() {}\n")
    @InlineData("abstract", "package P\nopen class C { open func M() int32; }\nfunc Main() {}\n")
    @InlineData(
        "dllimport",
        "package P\nimport System.Runtime.InteropServices\n@DllImport(\"libc\")\nfunc F() int32;\nfunc Main() {}\n"
    )
    @InlineData(
        "libraryimport",
        "package P\nimport System.Runtime.InteropServices\n@LibraryImport(\"libc\")\nfunc F() int32;\nfunc Main() {}\n"
    )
    @InlineData(
        "partial",
        "package P\npartial class C {\n    partial func M() int32;\n    partial func M() int32 { return 1 }\n}\nfunc Main() {}\n"
    )
    func ValidBodylessDeclaration_EmitsCleanly(caseName string, source string) {
        let tree = SyntaxTree.Parse(SourceText.From(source))
        let compilation = Compilation(tree)
        let diagnostics = compilation.GetDiagnostics()
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
        using let peStream = MemoryStream()
        let emitResult = compilation.Emit(peStream)
        Assert.True(emitResult.Success, "Expected emit success for $caseName")
        Assert.True(peStream.Length > 0, "Expected non-empty PE for $caseName")
    }
}
