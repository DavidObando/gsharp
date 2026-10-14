// <copyright file="Issue3888ExpandedParamsElementNullabilityTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import System
import System.Collections.Generic
import System.Linq
import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import GSharp.Tests
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import Xunit
import GSharp.Core.CodeAnalysis

/// Issue #3888: nullable evidence in an expanded `params T[]` argument
/// belongs to the emitted `...T` element position, not to the array carrier.
open class Issue3888ExpandedParamsElementNullabilityTests {
    @Fact
    func ExpandedEvidence_IsAssociatedWithItsParameterAndRuns() {
        let printed = TranslateOblivious(`namespace Demo
{
    public static class Fixture
    {
        public static int LiteralCount(params string[] values) => values.Length;
        public static int ExpressionCount(params string[] values) => values.Length;
        public static int StrictCount(params string[] values) => values.Length;
        public static int Ordinary(string value) => 1;
    }

    public static class Caller
    {
        public static int Literal() => Fixture.LiteralCount(null, "tail");

        public static int Expression(bool useNull)
        {
            string maybe = useNull ? null : "x";
            return Fixture.ExpressionCount("head", maybe);
        }

        public static int Zero() => Fixture.StrictCount();
        public static int Multiple() => Fixture.StrictCount("a", "b");
        public static int OrdinaryNull() => Fixture.Ordinary(null);
    }
}`)
        Assert.Contains("func LiteralCount(values ...string?)", printed, StringComparison.Ordinal)
        Assert.Contains("func ExpressionCount(values ...string?)", printed, StringComparison.Ordinal)
        Assert.Contains("func StrictCount(values ...string)", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("func StrictCount(values ...string?)", printed, StringComparison.Ordinal)
        Assert.Contains("func Ordinary(value string?)", printed, StringComparison.Ordinal)
        Assert.Contains("LiteralCount(nil, \"tail\")", printed, StringComparison.Ordinal)
        Assert.Contains("ExpressionCount(\"head\", maybe)", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("nil!!", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("maybe!!", printed, StringComparison.Ordinal)
        AssertEvaluates(printed, "Caller.Literal()", 2)
        AssertEvaluates(printed, "Caller.Expression(true)", 2)
        AssertEvaluates(printed, "Caller.Zero()", 0)
        AssertEvaluates(printed, "Caller.Multiple()", 2)
        AssertEvaluates(printed, "Caller.OrdinaryNull()", 1)
    }

    @Fact
    func NormalFormNullableArray_DoesNotWidenElementOrCarrierAndRuns() {
        let printed = TranslateOblivious(`namespace Demo
{
    public static class Fixture
    {
        public static int Count(params string[] values)
        {
            if (values is null)
            {
                return -1;
            }

            return values.Length;
        }
    }

    public static class Caller
    {
        public static int Go(bool present)
        {
            string[] values = present ? new[] { "x" } : null;
            return Fixture.Count(values);
        }
    }
}`)
        Assert.Contains("func Count(values ...string)", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("func Count(values ...string?)", printed, StringComparison.Ordinal)
        Assert.Contains("Fixture.Count(values!!)", printed, StringComparison.Ordinal)
        AssertEvaluates(printed, "Caller.Go(true)", 1)
    }

    @Fact
    func GenericReferenceParams_PromotesExpandedElementAndRuns() {
        let printed = TranslateOblivious(`namespace Demo
{
    public static class Fixture
    {
        public static int Count<T>(params T[] values)
            where T : class => values.Length;
    }

    public static class Caller
    {
        public static int Go() => Fixture.Count<string>(null, "x");
    }
}`)
        Assert.Contains("values ...T?", printed, StringComparison.Ordinal)
        Assert.Contains("Count[string](nil, \"x\")", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("nil!!", printed, StringComparison.Ordinal)
        AssertEvaluates(printed, "Caller.Go()", 2)
    }

    @Fact
    func CarrierShapedArrayElement_PromotesNestedElementAndRuns() {
        let printed = TranslateOblivious(`namespace Demo
{
    public static class Fixture
    {
        public static int Count(params string[][] values) => values.Length;
    }

    public static class Caller
    {
        public static int Go() => Fixture.Count(null, new[] { "x" });
    }
}`)
        Assert.Contains("func Count(values ...[][]?string)", printed, StringComparison.Ordinal)
        Assert.Contains("Fixture.Count(nil, []string{\"x\"})", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("nil!!", printed, StringComparison.Ordinal)
        AssertEvaluates(printed, "Caller.Go()", 2)
    }

    @Fact
    func AnnotatedNullableParamsElement_RemainsNullableAndRuns() {
        let printed = TranslateOblivious(`#nullable enable

namespace Demo
{
    public static class Fixture
    {
        public static int Count(params string?[] values) => values.Length;
    }

    public static class Caller
    {
        public static int Go() => Fixture.Count(null, "x");
    }
}`)
        Assert.Contains("func Count(values ...string?)", printed, StringComparison.Ordinal)
        Assert.Contains("Fixture.Count(nil, \"x\")", printed, StringComparison.Ordinal)
        AssertEvaluates(printed, "Caller.Go()", 2)
    }

    @Fact
    func CrossProjectSameArityOverloads_KeepEvidenceOnSelectedParamsPosition() {
        const libSource = `namespace Lib
{
    public static class Fixture
    {
        public static int Count(params string[] values) => values.Length;
        public static int Count(params object[] values) => values.Length;
    }
}`
        const appSource = `using Lib;

namespace App
{
    public static class Caller
    {
        public static int Go()
        {
            string maybe = null;
            return Fixture.Count(maybe, "x");
        }
    }
}`
        let library = LoadOblivious(libSource, "Lib")
        let app = LoadOblivious(appSource, "App", []CompilationReference{library.Compilation.ToMetadataReference()})
        let siblings = []CSharpCompilation{library.Compilation, app.Compilation}
        let printedLibrary = TranslateProject(library, siblings)
        let printedApp = TranslateProject(app, siblings)
        TranslationTestValidation.AssertBinds(printedLibrary, printedApp)
        Assert.Contains("func Count(values ...string?)", printedLibrary, StringComparison.Ordinal)
        Assert.Contains("func Count(values ...object)", printedLibrary, StringComparison.Ordinal)
        Assert.DoesNotContain("func Count(values ...object?)", printedLibrary, StringComparison.Ordinal)
        Assert.DoesNotContain("maybe!!", printedApp, StringComparison.Ordinal)
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

        private func LoadOblivious(
            source string,
            assemblyName string,
            extraReferences IReadOnlyList[MetadataReference]? = nil
        ) LoadedCSharpProject {
            let references = if extraReferences == nil {
                CSharpProjectLoader.RuntimeReferences()
            } else {
                cast[IReadOnlyList[MetadataReference]](
                    CSharpProjectLoader.RuntimeReferences().Concat(extraReferences).ToList()
                )
            }
            let project = CSharpProjectLoader.LoadInMemory(
                [](string, source string){(assemblyName + ".cs", source)},
                references,
                assemblyName
            )
            Assert.True(
                project.BoundWithoutErrors,
                "$assemblyName should bind with no C# errors: " + string.Join(
                    Environment.NewLine,
                    project.ErrorDiagnostics
                )
            )
            Assert.Equal(NullableContextOptions.Disable, project.Compilation.Options.NullableContextOptions)
            return project
        }

        private func TranslateProject(
            project LoadedCSharpProject,
            siblingCompilations IReadOnlyList[CSharpCompilation]
        ) string {
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(
                project.Compilation,
                document.SemanticModel,
                document.FilePath,
                siblingCompilations,
                repositoryCompilations: siblingCompilations
            )
            return GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        }
    }
}
