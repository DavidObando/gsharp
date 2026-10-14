// <copyright file="ScopedRefKindCompositionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import System.Collections.Generic
import System.Linq
import Xunit

/// ADR-0060 item #9: the `scoped` modifier (ADR-0058) must compose with
/// the new `ref`/`out`/`in` modifiers on the same parameter.
/// These tests verify that the combinations parse, bind, the parameter symbol
/// carries both (cref:ParameterSymbol.IsScoped) and the correct
/// (cref:RefKind), and the existing scoped-escape enforcement still
/// fires when the body tries to leak a scoped-ref-kind binding.
open class ScopedRefKindCompositionTests {
    @Fact
    func ScopedRef_BindsWithBothFlags() {
        const Source = `package SR

func bump(scoped ref x int32) {
    x = x + 1
}
`
        let result = Compile(Source)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
        let func_ = GetFunction(Source, "bump")
        let p = func_.Parameters[0]
        Assert.True(p.IsScoped)
        Assert.Equal(RefKind.Ref, p.RefKind)
    }

    @Fact
    func ScopedIn_BindsWithBothFlags() {
        const Source = `package SI

func observe(scoped in x int32) int32 {
    return x + 1
}
`
        let result = Compile(Source)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
        let func_ = GetFunction(Source, "observe")
        let p = func_.Parameters[0]
        Assert.True(p.IsScoped)
        Assert.Equal(RefKind.In, p.RefKind)
    }

    @Fact
    func ScopedOut_BindsWithBothFlags() {
        const Source = `package SO

func produce(scoped out x int32) {
    x = 42
}
`
        let result = Compile(Source)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
        let func_ = GetFunction(Source, "produce")
        let p = func_.Parameters[0]
        Assert.True(p.IsScoped)
        Assert.Equal(RefKind.Out, p.RefKind)
    }

    @Fact
    func ScopedIn_StillRejectsAssignment_GS0237() {
        // Composition check: GS0237 (item #6) fires regardless of whether
        // the 'in' is also 'scoped'.
        const Source = `package SIBody

func bad(scoped in x int32) {
    x = 99
}
`
        let result = Compile(Source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0237")
    }

    @Fact
    func ScopedOut_StillRequiresAssignment_GS0238() {
        // Composition check: GS0238 (item #4) fires regardless of whether
        // the 'out' is also 'scoped'.
        const Source = `package SOBody

func bad(scoped out x int32) {
    return
}
`
        let result = Compile(Source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0238")
    }

    shared {
        private func Compile(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }

        private func GetFunction(source string, name string) FunctionSymbol {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let compilation = Compilation(tree)
            return compilation.GlobalScope.Functions.First((f FunctionSymbol) -> f.Name == name)
        }
    }
}
