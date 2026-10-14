// <copyright file="Issue3501RedundantNullAssertionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import System.IO
import System.Linq
import Xunit

/// Issue #3501 (!! reduction): GS0536 warns when a user-written `!!`
/// asserts a value whose bound type — smart-cast narrowing included — is
/// already non-nullable, making the assertion a no-op. cs2gs's polish pass
/// strips exactly these spans, so the warning is the single source of truth
/// for redundancy.
open class Issue3501RedundantNullAssertionTests {
    @Fact
    func AssertionOnStaticallyNonNullable_Warns() {
        let source = `
func F(s string) string {
    return s!!
}

F("x")
`
        let result = EmittedOracle.Evaluate(source)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0536")
        Assert.Equal("x", result.Value)
    }

    @Fact
    func AssertionOnNarrowedNullable_Warns() {
        let source = `
func F(s string?) string {
    if s != nil {
        return s!!
    }
    return "nil"
}

F("x")
`
        let result = EmittedOracle.Evaluate(source)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0536")
        Assert.Equal("x", result.Value)
    }

    @Fact
    func NecessaryAssertion_DoesNotWarn() {
        let source = `
func F(s string?) string {
    return s!!
}

F("x")
`
        let result = EmittedOracle.Evaluate(source)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0536")
        Assert.Equal("x", result.Value)
    }

    @Fact
    func ReceiverPositionAssertion_OnNonNullable_Warns() {
        let source = `
class Box {
    var Value int32 = 42
}

func F(b Box) int32 {
    return b!!.Value
}

F(Box())
`
        let result = EmittedOracle.Evaluate(source)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0536")
        Assert.Equal(42, result.Value)
    }

    @Fact
    func NullConditionalThenAssertion_DoesNotWarn() {
        // `x?.Y` produces a nullable; the trailing assertion does real work.
        let source = `
class Box {
    var Value int32 = 42
}

func F(b Box?) int32 {
    return b?.Value!!
}

F(Box())
`
        let result = EmittedOracle.Evaluate(source)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0536")
        Assert.Equal(42, result.Value)
    }

    @Fact
    func GeneratedTree_RedundantAssertion_DoesNotWarn() {
        // Generated files are rewritten on every build; nobody can act on a
        // polish warning there (and warnings-as-errors builds would wedge).
        let source = `
func F(s string) string {
    return s!!
}

F("x")
`
        let generated = SyntaxTree.Parse(SourceText.From(source, "Probe.generated.g.gs"))
        let compilation = Compilation(generated)
        using let peStream = MemoryStream()
        let emit = compilation.Emit(peStream)
        Assert.True(emit.Success, string.Join("; ", emit.Diagnostics.Select((d Diagnostic) -> d.Message)))
        Assert.DoesNotContain(emit.Diagnostics, (d Diagnostic) -> d.Id == "GS0536")
    }

    @Fact
    func ValueTypeNullable_NecessaryAssertion_DoesNotWarn() {
        let source = `
func F(v int32?) int32 {
    return v!!
}

F(7)
`
        let result = EmittedOracle.Evaluate(source)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0536")
        Assert.Equal(7, result.Value)
    }
}
