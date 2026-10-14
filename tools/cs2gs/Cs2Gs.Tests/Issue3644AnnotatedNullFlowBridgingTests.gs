// <copyright file="Issue3644AnnotatedNullFlowBridgingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import Microsoft.CodeAnalysis
import System
import Xunit

/// Translator-fidelity tests for issue #3644: an OBLIVIOUS compilation binding
/// an annotated `T?` value (declared `string?` in BCL metadata, e.g.
/// `Path.GetDirectoryName`) into a slot the C# source compiled as
/// non-null `T`. Two shapes slipped through the established #1072/#2113
/// bridging and produced GS0154/GS0155 walls in migrated
/// `Cs2Gs.Pipeline`:
/// 1. an expression-bodied runtime lambda forwarding a flat declared-annotated member read as its
/// result (the `PrepareTemporaryBuildProps` `Select(path => Path.GetDirectoryName(...))` shape) — the
/// lambda result seam bailed on ANY `IsNullableInitializer` value, so gsc inferred the lambda result
/// `string?` and the divergence cascaded into every downstream sink;
/// 2. an argument in the EXPANDED tail of a classic `params T[]` call (the `FindNupkgForVersion`
/// `Path.Combine(RepoRoot, "out", ...)` shape) — Roslyn wraps the tail in one synthesized
/// array-creation argument, so the per-argument `IArgumentOperation`-driven bridge never saw a bound
/// parameter.
open class Issue3644AnnotatedNullFlowBridgingTests {
    /// The migrated Cs2Gs.Pipeline `PrepareTemporaryBuildProps` wall
    /// (GS0154 at SdkCompileRunner.gs): a runtime lambda whose body is a flat
    /// annotated-BCL invocation (`string?`) targeting an oblivious
    /// `Func<string, string>` return contract must assert `!!` so the
    /// `Select(...)` element type — and the foreach variable inferred from it
    /// — stays non-null for the downstream non-null parameter.
    @Fact
    func RuntimeLambdaResult_FlatAnnotatedBclValue_AssertsNonNull() {
        let printed = TranslateOblivious(`
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;

namespace Demo
{
    public static class Props
    {
        public static void Prepare(IEnumerable<string> generatedProjectPaths)
        {
            foreach (string projectDirectory in generatedProjectPaths
                .Select(path => Path.GetDirectoryName(Path.GetFullPath(path)))
                .Distinct(StringComparer.OrdinalIgnoreCase))
            {
                Consume(projectDirectory);
            }
        }

        private static void Consume(string directory)
        {
            Console.WriteLine(directory);
        }
    }
}`)
        Assert.Contains("Path.GetDirectoryName(Path.GetFullPath(path))!!", printed)
    }

    /// The migrated Cs2Gs.Pipeline `FindNupkgForVersion` wall (GS0155 at
    /// GsharpTestProjectRunner.gs:118): a promoted-nullable property
    /// (`string?` on the G# side) flowing into the expanded tail of
    /// `Path.Combine(params string[])` must assert `!!` against the non-null
    /// params ELEMENT contract.
    @Fact
    func ExpandedParamsArgument_PromotedProperty_AssertsNonNull() {
        let printed = TranslateOblivious(`
using System.IO;

namespace Demo
{
    public class Runner
    {
        public Runner(string repoRoot)
        {
            RepoRoot = repoRoot ?? FindRepoRoot();
        }

        public string RepoRoot { get; }

        public string Candidate(string version)
        {
            return Path.Combine(RepoRoot, "out", "bin", "nupkgs", version + ".nupkg");
        }

        private static string FindRepoRoot()
        {
            return null;
        }
    }
}`)
        Assert.Contains("prop RepoRoot string?", printed)
        Assert.Contains("RepoRoot!!", printed.Substring(printed.IndexOf("Path.Combine", StringComparison.Ordinal)))
    }

    /// Precision guard: a SYNTACTICALLY nullable lambda result (`x?.Member`)
    /// keeps its deliberate nullability — no `!!` is forced onto the
    /// conditional access.
    @Fact
    func RuntimeLambdaResult_ConditionalAccessShape_StaysBare() {
        let printed = TranslateOblivious(`
using System.Collections.Generic;
using System.Linq;

namespace Demo
{
    public static class Trimmer
    {
        public static List<string> TrimAll(IEnumerable<string> values)
        {
            return values.Select(value => value?.Trim()).ToList();
        }
    }
}`)
        Assert.DoesNotContain("Trim()!!", printed)
    }

    /// Issue #4046: an inferred LINQ result that ultimately flows into a
    /// promoted nullable sink must keep nullable elements alive long enough for
    /// a later operator to inspect them. Asserting the selector result throws
    /// before `FirstOrDefault(candidate => candidate != null)` can filter
    /// the null.
    @Fact
    func RuntimeLambdaResult_FlowingToPromotedNullableSink_StaysBare() {
        let printed = TranslateOblivious(`
using System.Collections.Generic;
using System.IO;
using System.Linq;

namespace Demo
{
    public static class Paths
    {
        public static void Find(IEnumerable<string> values, out string result)
        {
            result = (values
                .Select(value => Path.GetDirectoryName(value)))
                .FirstOrDefault(candidate => candidate != null);
        }
    }
}`)
        Assert.Contains("out result string?", printed)
        Assert.DoesNotContain("GetDirectoryName(value)!!", printed)
    }

    /// Precision guard: a fixed delegate return contract remains non-null even
    /// when the invocation result later flows into a promoted nullable sink.
    /// Only generic selector-result positions receive issue #4046's exemption.
    @Fact
    func RuntimeLambdaResult_FixedDelegateContract_StillAssertsNonNull() {
        let printed = TranslateOblivious(`
using System;
using System.IO;

namespace Demo
{
    public static class Paths
    {
        public static string Apply(Func<string, string> selector) => selector("");

        public static string Find()
        {
            return Apply(value => Path.GetDirectoryName(value));
        }
    }
}`)
        Assert.Contains("GetDirectoryName(value)!!", printed)
    }

    /// Precision guard: a non-nullable value in the expanded params tail grows
    /// no assertion.
    @Fact
    func ExpandedParamsArgument_NonNullableValue_StaysBare() {
        let printed = TranslateOblivious(`
using System.IO;

namespace Demo
{
    public static class Combiner
    {
        public static string Build(string root)
        {
            return Path.Combine(root, "a", "b", "c", "d");
        }
    }
}`)
        Assert.DoesNotContain("root!!", printed)
    }

    @Fact
    func ExpandedParamsCollectionNullableElementStaysBare() {
        let printed = TranslateOblivious(`
#nullable enable
using System.Collections.Generic;

namespace Demo
{
    public static class Values
    {
        public static bool HasNil(params IEnumerable<string?> values) => true;

        public static bool Run()
        {
            string? value = null;
            return HasNil(value);
        }
    }
}`)
        Assert.Contains("HasNil(value)", printed)
        Assert.DoesNotContain("HasNil(value!!)", printed)
    }

    /// Regression guard for the already-working sibling shape: a LOCAL
    /// initialized from an annotated-BCL `string?` value renders the promoted
    /// `string?` declaration with `!!` at the non-null use site, and the whole
    /// document still binds.
    @Fact
    func AnnotatedBclLocalInitializer_PromotesAndAssertsAtUse() {
        let printed = TranslateOblivious(`
using System.IO;

namespace Demo
{
    public static class Dirs
    {
        public static void Ensure(string generatedProjectPath)
        {
            string projectDirectory = Path.GetDirectoryName(Path.GetFullPath(generatedProjectPath));
            Directory.CreateDirectory(projectDirectory);
        }
    }
}`)
        Assert.Contains("projectDirectory string?", printed)
        Assert.Contains("projectDirectory!!", printed)
    }

    shared {
        private func TranslateOblivious(source string) string {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Snippet.cs", source)})
            Assert.True(
                project.BoundWithoutErrors,
                "Snippet should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
            )
            Assert.Equal(NullableContextOptions.Disable, project.Compilation.Options.NullableContextOptions)
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            return PrintAndValidate(CSharpToGSharpTranslator().TranslateDocument(document, context))
        }

        private func PrintAndValidate(unit CompilationUnit) string {
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
