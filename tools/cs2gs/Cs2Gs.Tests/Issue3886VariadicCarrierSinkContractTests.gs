// <copyright file="Issue3886VariadicCarrierSinkContractTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import System
import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import GSharp.Tests
import Xunit
import GSharp.Core.CodeAnalysis
import Microsoft.CodeAnalysis

/// Issue #3886: the sink contract used to decide whether an argument needs a
/// `!!` bridge must agree with the signature the DECLARATION side
/// actually emits.
///
/// Carrier evidence (`if (paths is null) throw`) never widens a variadic
/// declaration, so a direct nullable-array argument still needs `!!`.
/// Issue #3888 separately lets expanded-element evidence widen `...T` to
/// `...T?`; that element call then stays bare.
///
/// That is the whole migrated `test/Compiler.Tests` compile wall:
/// `test/Shared/EmittedFixture.cs` declares
/// `LoadTogether(params string[] assemblyPaths)` opening with
/// `if (assemblyPaths is null) throw`, and the one call site in
/// `Issue2525ImportedIndexerHidingEmitTests` passing a promoted
/// `ContractsPath` produced GS0154 plus fifteen cascade
/// "Cannot find function/member" errors on the error-typed result.
open class Issue3886VariadicCarrierSinkContractTests {
    /// Issue #3888 refinement: expanded nullable evidence widens the element
    /// position, while the carrier's null guard remains irrelevant to it.
    @Fact
    func ExpandedArgument_NullGuardedSourceParams_WidensElementAndRuns() {
        let printed = TranslateOblivious(`using System;

namespace Demo
{
    public static class Fixture
    {
        public static string Join(params string[] parts)
        {
            if (parts is null)
            {
                throw new ArgumentNullException(nameof(parts));
            }

            return string.Join("|", parts);
        }
    }

    public sealed class Result
    {
        public Result(string first)
        {
            First = first;
        }

        public string First { get; }
    }

    public static class Caller
    {
        public static string Go(bool emit)
        {
            var first = emit ? "a" : null;
            var result = new Result(first);
            return Fixture.Join(result.First, "b");
        }
    }
}`)
        Assert.Contains("func Join(parts ...string?)", printed, StringComparison.Ordinal)
        Assert.Contains("prop First string?", printed, StringComparison.Ordinal)
        Assert.Contains("Fixture.Join(result.First, \"b\")", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("result.First!!", printed, StringComparison.Ordinal)
        AssertEvaluates(printed, "Caller.Go(true)", "a|b")
        AssertEvaluates(printed, "Caller.Go(false)", "|b")
    }

    /// The same defect through the DIRECT collection form
    /// (`Join(paths)`, binding the params parameter itself rather than
    /// its element): the emitted carrier is non-null, so a promoted
    /// `[]string?` argument needs the bridge too.
    @Fact
    func DirectCollectionArgument_NullGuardedSourceParams_AssertsNonNullAndRuns() {
        let printed = TranslateOblivious(`using System;

namespace Demo
{
    public static class Fixture
    {
        public static string Join(params string[] parts)
        {
            if (parts is null)
            {
                throw new ArgumentNullException(nameof(parts));
            }

            return string.Join("|", parts);
        }
    }

    public sealed class Bundle
    {
        public Bundle(string[] parts)
        {
            Parts = parts;
        }

        public string[] Parts { get; }
    }

    public static class Caller
    {
        public static string Go(bool emit)
        {
            var parts = emit ? new[] { "a", "b" } : null;
            var bundle = new Bundle(parts);
            return Fixture.Join(bundle.Parts);
        }
    }
}`)
        Assert.Contains("func Join(parts ...string)", printed, StringComparison.Ordinal)
        Assert.Contains("Fixture.Join(bundle.Parts!!)", printed, StringComparison.Ordinal)
        AssertEvaluates(printed, "Caller.Go(true)", "a|b")
    }

    /// Precision guard: a genuinely non-null argument to the same null-guarded
    /// variadic carrier gains no assertion. `!!` is a RUNTIME check in G#,
    /// so a gratuitous one is a behaviour change, not a readability wart.
    @Fact
    func ExpandedArgument_NonNullValue_StaysBare() {
        let printed = TranslateOblivious(`using System;

namespace Demo
{
    public static class Fixture
    {
        public static string Join(params string[] parts)
        {
            if (parts is null)
            {
                throw new ArgumentNullException(nameof(parts));
            }

            return string.Join("|", parts);
        }
    }

    public static class Caller
    {
        public static string Go(string first)
        {
            return Fixture.Join(first, "b");
        }
    }
}`)
        Assert.Contains("Fixture.Join(first, \"b\")", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("first!!", printed, StringComparison.Ordinal)
        AssertEvaluates(printed, "Caller.Go(\"a\")", "a|b")
    }

    shared {
        private func AssertEvaluates(printed string, expression string, expected object) {
            let result = EmittedOracle.Evaluate(printed + Environment.NewLine + expression)
            Assert.DoesNotContain(
                result.Diagnostics,
                (diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> diagnostic.IsError
            )
            Assert.Null(result.UnhandledException)
            Assert.Equal(expected, result.Value)
        }

        private func TranslateOblivious(source string) string {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Snippet.cs", source)})
            Assert.True(
                project.BoundWithoutErrors,
                "Snippet should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
            )
            Assert.Equal(NullableContextOptions.Disable, project.Compilation.Options.NullableContextOptions)
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            let printed = GSharpPrinter.Print(unit)
            let result RoundTripResult? = TranslationTestValidation.AssertBinds(printed)
            Assert.True(
                result!!.Success,
                "Translated G# must round-trip. Errors:\n" + string.Join("\n", result!!.Errors) + `

Printed:
` + printed
            )
            return printed
        }
    }
}
