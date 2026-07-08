// <copyright file="Issue2228AutoPropertyRecordDataClassTranslationTests.cs" company="GSharp">
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
/// Issue #2228: a C# <c>record</c>/<c>record class</c> whose data lives
/// entirely in body <c>init</c>/get-only auto-properties (no positional
/// primary-constructor parameters) must still translate to a G#
/// <c>data class</c> — not downgrade to a plain <c>class</c> — so it keeps
/// value equality and <c>with</c>-expression support. cs2gs lifts each such
/// auto-property into a synthetic primary-constructor parameter (+ field),
/// mirroring the existing lift already used for an explicit
/// parameter-copy constructor (ADR-0115 §B.3/§B.4).
/// </summary>
public class Issue2228AutoPropertyRecordDataClassTranslationTests
{
    /// <summary>
    /// The exact reported shape (<c>OahuConfig</c>): several init auto-properties,
    /// a nullable reference-typed property, an enum-typed property with a default
    /// via a member-access initializer, and a plain literal default — all must
    /// survive as primary-constructor parameters on a 'data class', not be
    /// dropped to a plain class.
    /// </summary>
    [Fact]
    public void RecordWithOnlyInitAutoProperties_TranslatesToDataClass()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public enum DownloadQuality { Low, Medium, High }

    public static class CliPaths
    {
        public const string DefaultDownloadDir = ""downloads"";
    }

    public sealed record OahuConfig
    {
        public string DownloadDirectory { get; init; } = CliPaths.DefaultDownloadDir;
        public DownloadQuality DefaultQuality { get; init; } = DownloadQuality.High;
        public int MaxParallelJobs { get; init; } = 1;
        public string? DefaultProfileAlias { get; init; }
        public string? Theme { get; init; }
        public bool VerboseLogging { get; init; }
    }
}");

        Assert.Contains("data class OahuConfig(", printed);
        Assert.DoesNotContain("class OahuConfig {", printed);
        Assert.Contains("DownloadDirectory string = CliPaths.DefaultDownloadDir", printed);
        Assert.Contains("DefaultQuality DownloadQuality = DownloadQuality.High", printed);
        Assert.Contains("MaxParallelJobs int32 = 1", printed);
        Assert.Contains("DefaultProfileAlias string?", printed);
        Assert.Contains("Theme string?", printed);
        Assert.Contains("VerboseLogging bool", printed);
    }

    /// <summary>
    /// A record-struct-shaped auto-property-only record must reach a G#
    /// 'data struct', not a plain struct, by the same lift.
    /// </summary>
    [Fact]
    public void RecordStructWithOnlyInitAutoProperties_TranslatesToDataStruct()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public record struct Point3
    {
        public double X { get; init; }
        public double Y { get; init; }
        public double Z { get; init; }
    }
}");

        Assert.Contains("data struct Point3(", printed);
        Assert.DoesNotContain("struct Point3 {", printed);
    }

    /// <summary>
    /// A record whose auto-property implements an interface member cannot be
    /// lifted to a primary-constructor parameter (a G# primary-ctor parameter is
    /// not a property, OD-T1) — it must still fall back to the existing plain
    /// class downgrade rather than silently drop the interface contract.
    /// </summary>
    [Fact]
    public void RecordWithInterfaceAutoProperty_StillDowngradesToPlainClass()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public interface INamed
    {
        string Name { get; }
    }

    public sealed record NamedThing : INamed
    {
        public string Name { get; init; } = ""thing"";
    }
}");

        Assert.Contains("class NamedThing", printed);
        Assert.DoesNotContain("data class NamedThing", printed);
    }

    private static string TranslateUnit(string source)
    {
        (string printed, _) = Translate(source);
        return printed;
    }

    private static (string Printed, TranslationContext Context) Translate(string source)
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
        return (printed, context);
    }
}
