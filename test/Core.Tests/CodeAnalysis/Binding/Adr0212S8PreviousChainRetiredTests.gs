// <copyright file="Adr0212S8PreviousChainRetiredTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Immutable
import System.IO
import System.Linq
import System.Text.RegularExpressions
import Xunit

/// ADR-0212 S8: the `previous` chain is retired, `BodyBindingOptions` lives on
/// `BindingServices`, and submission binding lives under `Binding/Submissions/`
/// behind `SubmissionBinding` so `Binder.gs` carries no submission or body-cache
/// plumbing (Gate 3).
///
/// Contract (row, behaviour, mutation witness):
///
/// | Row | Behaviour | Witness (test goes red) |
/// | --- | --- | --- |
/// | R1 | BindGlobalScope with a non-nil `previous` throws ArgumentException("previous") on every overload | drop the check in BindGlobalScopeWithRoot: R1a/R1b |
/// | R2 | the BoundGlobalScope constructors reject a non-nil `previous`, so a chained scope cannot reach BindProgram | drop the check in the main constructor: R2 |
/// | R3 | a nil `previous` is accepted and `Previous` is nil | throw unconditionally: R3 |
/// | R4 | BindProgram.Imports is the scope's own import list, in order (was GetCumulativeImports) | `Imports = ImmutableArray.Empty` in BindProgram: R4 |
/// | R5 | BindProgram binds a body for every function of the scope | skip the function loop in BindProgram: R5 |
/// | R6 | ADR-0212 §11.3 Gate 3: `Binder.gs` has zero matches for `submission|Submission|BoundBodyCache|dirtyTrees|GetCumulativeImports`, and the `Binding/Submissions/` partials and door exist | reintroduce any forbidden token in `Binder.gs`: R6 |
open class Adr0212S8PreviousChainRetiredTests {
    @Fact
    func R1a_BindGlobalScope_TwoArgumentOverload_RejectsPrevious() {
        let first = BindSource("package P\nfunc f() int32 -> 1\n")
        let tree = SyntaxTree.Parse(SourceText.From("package P\nfunc g() int32 -> 2\n"))
        let ex = Assert.Throws[ArgumentException](() -> Binder.BindGlobalScope(first, ImmutableArray.Create(tree)))
        Assert.Equal("previous", ex.ParamName)
    }

    @Fact
    func R1b_BindGlobalScope_FullOverload_RejectsPrevious() {
        let first = BindSource("package P\nfunc f() int32 -> 1\n")
        let tree = SyntaxTree.Parse(SourceText.From("package P\nfunc g() int32 -> 2\n"))
        let ex = Assert.Throws[ArgumentException](
            () -> Binder.BindGlobalScope(
                first,
                ImmutableArray.Create(tree),
                references: nil,
                implicitSystemImport: true,
                preprocessorSymbols: nil,
                isLibrary: false,
                submission: nil
            )
        )
        Assert.Equal("previous", ex.ParamName)
    }

    @Fact
    func R2_BoundGlobalScope_Constructor_RejectsPrevious() {
        let first = BindSource("package P\nfunc f() int32 -> 1\n")
        let ex = Assert.Throws[ArgumentException](
            () -> BoundGlobalScope(
                first,
                first.Package,
                first.Packages,
                first.Diagnostics,
                first.Imports,
                first.Functions,
                first.Variables,
                nil,
                ImmutableArray[BoundStatement].Empty
            )
        )
        Assert.Equal("previous", ex.ParamName)
    }

    @Fact
    func R3_NilPrevious_IsAccepted() {
        let scope_ = BindSource("package P\nfunc f() int32 -> 1\n")
        Assert.Null(scope_.Previous)
        Assert.Single(scope_.Functions)
    }

    @Fact
    func R4_BindProgram_Imports_AreTheScopesOwnImports_InOrder() {
        let scope_ = BindSource("package P\nimport System.Text\nimport System.IO\nfunc f() int32 -> 1\n")
        let program = Binder.BindProgram(scope_)
        Assert.NotEmpty(scope_.Imports)
        Assert.Equal(
            scope_.Imports.Select((i ImportSymbol) -> i.Name).ToArray(),
            program.Imports.Select((i ImportSymbol) -> i.Name).ToArray()
        )
        Assert.Contains(program.Imports, (i ImportSymbol) -> i.Name == "System.IO")
    }

    @Fact
    func R5_BindProgram_BindsABodyForEveryFunction() {
        let scope_ = BindSource(
            "package P\nfunc f() int32 -> 1\nfunc g() int32 -> f() + 1\nfunc h() int32 -> g() + 1\n"
        )
        Assert.Equal(3, scope_.Functions.Length)
        let program = Binder.BindProgram(scope_)
        Assert.Empty(program.Diagnostics)
        for function in scope_.Functions {
            Assert.True(program.Functions.ContainsKey(function), function.Name)
        }
    }

    @Fact
    func R6_BinderSource_ContainsNoSubmissionOrBodyCachePlumbing() {
        let bindingDir = Path.Combine(TestSource.Root, "src", "Core", "CodeAnalysis", "Binding")
        let binderPath = Path.Combine(bindingDir, "Binder.gs")
        Assert.True(File.Exists(binderPath), "Missing Binder.gs at " + binderPath)
        let forbidden = Regex("submission|Submission|BoundBodyCache|dirtyTrees|GetCumulativeImports")
        let lines = File.ReadAllLines(binderPath)
        Assert.NotEmpty(lines)
        let matches = System.Collections.Generic.List[string]()
        for var i = 0; i < lines.Length; i++ {
            if forbidden.IsMatch(lines[i]) {
                matches.Add("${i + 1}: ${lines[i].Trim()}")
            }
        }
        Assert.True(matches.Count == 0, "Binder.gs violates ADR-0212 §11.3 Gate 3:\n" + string.Join("\n", matches))
        let submissionsDir = Path.Combine(bindingDir, "Submissions")
        let expectedFiles = []string{
            "SubmissionBinding.gs",
            "Binder.Submissions.gs",
            "ExpressionBinder.Submissions.gs",
            "OverloadResolver.Submissions.gs",
            "BoundScope.Submissions.gs",
            "SubmissionImports.gs",
            "SubmissionGlobalTypeProjection.gs"
        }
        Assert.NotEmpty(expectedFiles)
        for fileName in expectedFiles {
            let fullPath = Path.Combine(submissionsDir, fileName)
            Assert.True(File.Exists(fullPath), "Missing submission file: " + fullPath)
        }
    }

    shared {
        private func BindSource(source string) BoundGlobalScope {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            return Binder.BindGlobalScope(previous: nil, ImmutableArray.Create(tree))
        }
    }
}
