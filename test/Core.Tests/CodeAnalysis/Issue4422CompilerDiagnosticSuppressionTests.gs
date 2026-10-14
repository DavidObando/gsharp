// <copyright file="Issue4422CompilerDiagnosticSuppressionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import System
import System.IO
import System.Linq
import Xunit

/// ADR-0175 amendment (issue #4422): `@SuppressDiagnostic` scopes now
/// filter the compiler's own warnings, not only analyzer diagnostics, so a
/// migrated `ref x!` can carry its C# suppression of GS0612. The filter
/// sits in `Compilation`, where every `EmitResult` is produced, so gsc,
/// the emitted-program host and the language server agree. Errors are never
/// suppressed, as with C#'s `#pragma warning`.
open class Issue4422CompilerDiagnosticSuppressionTests {
    @Fact
    func BlockForm_SuppressesOnlyInsideTheBlock() {
        let result = EmittedOracle.Evaluate(Callee + `
var a string? = nil
@SuppressDiagnostic("GS0612") {
    R(&a)
}
R(&a)
Console.WriteLine(a)
`)
        let warning = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0612")
        let text = Assert.IsType[SourceText](warning.Location.Text)
        Assert.Equal(text.ToString().LastIndexOf("R(&a)", StringComparison.Ordinal) + 2, warning.Location.Span.Start)
        Assert.Equal("r", result.Output.Trim())
    }

    @Fact
    func DeclarationForms_SuppressTheirOwnSpan() {
        let result = EmittedOracle.Evaluate(Callee + `
@SuppressDiagnostic("GS0612")
func Whole() string {
    var a string? = nil
    R(&a)
    return a!!
}

func Local() int32 {
    var a string? = nil
    @SuppressDiagnostic("GS0612") let n = Count(&a)
    return n
}

func Count(ref s string) int32 -> s.Length

Console.WriteLine(Whole())
`)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0612")
        Assert.Equal("r", result.Output.Trim())
    }

    @Fact
    func AnUnrelatedIdentifier_DoesNotSuppress() {
        let result = EmittedOracle.Evaluate(Callee + `
var a string? = nil
@SuppressDiagnostic("GS0536") {
    R(&a)
}
`)
        Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0612")
    }

    @Fact
    func Errors_AreNeverSuppressed() {
        let result = EmittedOracle.Evaluate(Callee + `
var n int32 = 1
@SuppressDiagnostic("GS0154") {
    R(&n)
}
`)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0154" && d.IsError)
    }

    @Fact
    func Compilation_ExposesTheSameFilterToOtherHosts() {
        let tree = SyntaxTree.Parse(SourceText.From(Callee + `
var a string? = nil
@SuppressDiagnostic("GS0612") {
    R(&a)
}
`))
        let compilation = Compilation(tree)
        let raw = compilation.GlobalScope.Diagnostics.AddRange(compilation.BoundProgram.Diagnostics)
        Assert.Contains(raw, (d Diagnostic) -> d.Id == "GS0612")
        Assert.DoesNotContain(compilation.ApplySourceSuppressions(raw), (d Diagnostic) -> d.Id == "GS0612")
        using let stream = MemoryStream()
        let emit = compilation.Emit(stream)
        Assert.True(emit.Success)
        Assert.DoesNotContain(emit.Diagnostics, (d Diagnostic) -> d.Id == "GS0612")
    }

    shared {
        private const Callee string = "func R(ref s string) { s = \"r\" }\n"
    }
}
