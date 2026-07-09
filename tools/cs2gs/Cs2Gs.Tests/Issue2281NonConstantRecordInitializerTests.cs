// <copyright file="Issue2281NonConstantRecordInitializerTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Linq;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Regression tests for issue #2281: a C# property-bodied record whose
/// auto-property initializer is NOT a compile-time constant (a static
/// property/method call, <c>new Foo()</c>, etc.) was previously lifted to a
/// G# primary-constructor parameter DEFAULT (issue #2228's lift), which is
/// invalid — G# optional-parameter defaults must be compile-time constants
/// (GS0265) — and cascaded into GS0144/GS0161 at every construction and
/// <c>with</c> call site. The fix distinguishes the initializer shape via the
/// Roslyn semantic model (<c>GetConstantValue</c>, not a syntactic guess):
/// a constant initializer stays a primary-constructor parameter default
/// (unchanged, issue #2228 behavior); a non-constant one is instead lifted to
/// a plain body <c>let</c> field carrying the initializer, which the data
/// class's always-emitted parameterless constructor runs on every
/// construction — mirroring the C# record's own per-instance initializer
/// semantics without requiring a compile-time constant anywhere.
/// </summary>
public class Issue2281NonConstantRecordInitializerTests
{
    [Fact]
    public void RecordWithNonConstantStaticPropertyInitializer_LiftsToBodyLetField_NotParameterDefault()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public static class CliPaths
    {
        public static string DefaultDownloadDir => ""downloads"";
    }

    public sealed record OahuConfig
    {
        public string DownloadDirectory { get; init; } = CliPaths.DefaultDownloadDir;
        public int MaxParallelJobs { get; init; } = 1;
    }
}");

        Assert.Contains("data class OahuConfig(MaxParallelJobs int32 = 1)", printed);
        Assert.DoesNotContain("(DownloadDirectory string = CliPaths.DefaultDownloadDir", printed);
        Assert.Contains("public let DownloadDirectory string = CliPaths.DefaultDownloadDir", printed);
    }

    [Fact]
    public void RecordWithNonConstantMethodCallInitializer_LiftsToBodyLetField()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public sealed class Widget
    {
        public int Value;
    }

    public sealed record Holder
    {
        public Widget Item { get; init; } = new Widget();
        public int Count { get; init; } = 1;
    }
}");

        Assert.Contains("data class Holder(Count int32 = 1)", printed);
        Assert.Contains("public let Item Widget = Widget()", printed);
    }

    [Fact]
    public void RecordWithOnlyNonConstantInitializers_TranslatesToDataClassWithEmptyPrimaryCtor()
    {
        // Every property has a non-constant initializer: the primary
        // constructor's positional parameter list ends up EMPTY, and every
        // property becomes a body 'let' field — still a valid 'data class'
        // (at least one field, via the body fields), never downgraded to a
        // plain class.
        string printed = TranslateUnit(@"
namespace Demo
{
    public static class CliPaths
    {
        public static string DefaultDownloadDir => ""downloads"";
    }

    public sealed record OahuConfig
    {
        public string DownloadDirectory { get; init; } = CliPaths.DefaultDownloadDir;
    }
}");

        Assert.Contains("data class OahuConfig()", printed);
        Assert.DoesNotContain("class OahuConfig {", printed);
        Assert.Contains("public let DownloadDirectory string = CliPaths.DefaultDownloadDir", printed);
    }

    [Fact]
    public void RecordWithConstantInitializer_StillUsesParameterDefault()
    {
        // Baseline/regression from issue #2228: a genuinely constant
        // initializer (a `const` field reference) is unaffected and keeps
        // the primary-constructor-parameter-default form.
        string printed = TranslateUnit(@"
namespace Demo
{
    public static class CliPaths
    {
        public const string DefaultDownloadDir = ""downloads"";
    }

    public sealed record OahuConfig
    {
        public string DownloadDirectory { get; init; } = CliPaths.DefaultDownloadDir;
    }
}");

        Assert.Contains("data class OahuConfig(DownloadDirectory string = CliPaths.DefaultDownloadDir)", printed);
        Assert.DoesNotContain("let DownloadDirectory", printed);
    }

    // Note: a `data struct` (record struct) counterpart of the non-constant-
    // initializer scenario above is not independently testable — C# itself
    // (CS8983) rejects a struct with ANY auto-property/field initializer that
    // lacks an explicitly declared instance constructor, and
    // AnalyzeAutoPropertyLift only ever runs when there is no explicit
    // instance constructor. So a record struct can never reach this
    // translator path with a non-constant initializer in the first place —
    // the defensive `kind == TypeDeclarationKind.DataStruct` bail in
    // AnalyzeAutoPropertyLift exists purely as a "never guess" safety net
    // (ADR-0115) in case that C# restriction is ever relaxed.

    private static string TranslateUnit(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("Snippet.cs", source) });
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);

        string printed = GSharpPrinter.Print(unit);
        RoundTripResult result = GSharpRoundTrip.Validate(printed);
        Assert.True(
            result.Success,
            "Translated G# must round-trip. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + printed);
        return printed;
    }
}
