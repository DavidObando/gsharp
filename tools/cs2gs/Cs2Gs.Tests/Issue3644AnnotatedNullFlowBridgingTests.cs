// <copyright file="Issue3644AnnotatedNullFlowBridgingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Microsoft.CodeAnalysis;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Translator-fidelity tests for issue #3644: an OBLIVIOUS compilation binding
/// an annotated `T?` value (declared `string?` in BCL metadata, e.g.
/// <c>Path.GetDirectoryName</c>) into a slot the C# source compiled as
/// non-null `T`. Two shapes slipped through the established #1072/#2113
/// bridging and produced GS0154/GS0155 walls in migrated
/// <c>Cs2Gs.Pipeline</c>:
/// <list type="number">
/// <item>an expression-bodied runtime lambda forwarding a flat
/// declared-annotated member read as its result (the
/// <c>PrepareTemporaryBuildProps</c>
/// <c>Select(path =&gt; Path.GetDirectoryName(...))</c> shape) — the lambda
/// result seam bailed on ANY <c>IsNullableInitializer</c> value, so gsc
/// inferred the lambda result `string?` and the divergence cascaded into
/// every downstream sink;</item>
/// <item>an argument in the EXPANDED tail of a classic `params T[]` call
/// (the <c>FindNupkgForVersion</c>
/// <c>Path.Combine(RepoRoot, "out", ...)</c> shape) — Roslyn wraps the tail
/// in one synthesized array-creation argument, so the per-argument
/// <c>IArgumentOperation</c>-driven bridge never saw a bound
/// parameter.</item>
/// </list>
/// </summary>
public class Issue3644AnnotatedNullFlowBridgingTests
{
    /// <summary>
    /// The migrated Cs2Gs.Pipeline <c>PrepareTemporaryBuildProps</c> wall
    /// (GS0154 at SdkCompileRunner.gs): a runtime lambda whose body is a flat
    /// annotated-BCL invocation (`string?`) targeting an oblivious
    /// `Func&lt;string, string&gt;` return contract must assert `!!` so the
    /// `Select(...)` element type — and the foreach variable inferred from it
    /// — stays non-null for the downstream non-null parameter.
    /// </summary>
    [Fact]
    public void RuntimeLambdaResult_FlatAnnotatedBclValue_AssertsNonNull()
    {
        string printed = TranslateOblivious(@"
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
}");

        Assert.Contains("Path.GetDirectoryName(Path.GetFullPath(path))!!", printed);
    }

    /// <summary>
    /// The migrated Cs2Gs.Pipeline <c>FindNupkgForVersion</c> wall (GS0155 at
    /// GsharpTestProjectRunner.gs:118): a promoted-nullable property
    /// (`string?` on the G# side) flowing into the expanded tail of
    /// `Path.Combine(params string[])` must assert `!!` against the non-null
    /// params ELEMENT contract.
    /// </summary>
    [Fact]
    public void ExpandedParamsArgument_PromotedProperty_AssertsNonNull()
    {
        string printed = TranslateOblivious(@"
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
            return Path.Combine(RepoRoot, ""out"", ""bin"", ""nupkgs"", version + "".nupkg"");
        }

        private static string FindRepoRoot()
        {
            return null;
        }
    }
}");

        Assert.Contains("prop RepoRoot string?", printed);
        Assert.Contains("RepoRoot!!", printed.Substring(printed.IndexOf("Path.Combine", StringComparison.Ordinal)));
    }

    /// <summary>
    /// Precision guard: a SYNTACTICALLY nullable lambda result (`x?.Member`)
    /// keeps its deliberate nullability — no `!!` is forced onto the
    /// conditional access.
    /// </summary>
    [Fact]
    public void RuntimeLambdaResult_ConditionalAccessShape_StaysBare()
    {
        string printed = TranslateOblivious(@"
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
}");

        Assert.DoesNotContain("Trim()!!", printed);
    }

    /// <summary>
    /// Precision guard: a non-nullable value in the expanded params tail grows
    /// no assertion.
    /// </summary>
    [Fact]
    public void ExpandedParamsArgument_NonNullableValue_StaysBare()
    {
        string printed = TranslateOblivious(@"
using System.IO;

namespace Demo
{
    public static class Combiner
    {
        public static string Build(string root)
        {
            return Path.Combine(root, ""a"", ""b"", ""c"", ""d"");
        }
    }
}");

        Assert.DoesNotContain("root!!", printed);
    }

    /// <summary>
    /// Regression guard for the already-working sibling shape: a LOCAL
    /// initialized from an annotated-BCL `string?` value renders the promoted
    /// `string?` declaration with `!!` at the non-null use site, and the whole
    /// document still binds.
    /// </summary>
    [Fact]
    public void AnnotatedBclLocalInitializer_PromotesAndAssertsAtUse()
    {
        string printed = TranslateOblivious(@"
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
}");

        Assert.Contains("projectDirectory string?", printed);
        Assert.Contains("projectDirectory!!", printed);
    }

    private static string TranslateOblivious(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("Snippet.cs", source) });
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));
        Assert.Equal(
            NullableContextOptions.Disable,
            project.Compilation.Options.NullableContextOptions);

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        return PrintAndValidate(new CSharpToGSharpTranslator().TranslateDocument(document, context));
    }

    private static string PrintAndValidate(CompilationUnit unit)
    {
        string printed = GSharpPrinter.Print(unit);
        RoundTripResult result = TranslationTestValidation.AssertBinds(printed);
        Assert.True(
            result.Success,
            "Translated G# must round-trip. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + printed);
        return printed;
    }
}
