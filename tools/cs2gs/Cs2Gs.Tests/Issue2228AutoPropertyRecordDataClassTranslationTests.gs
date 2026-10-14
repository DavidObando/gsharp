// <copyright file="Issue2228AutoPropertyRecordDataClassTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import System.Linq
import Xunit

/// Issue #2228: a C# `record`/`record class` whose data lives
/// entirely in body `init`/get-only auto-properties (no positional
/// primary-constructor parameters) must still translate to a G#
/// `data class` — not downgrade to a plain `class` — so it keeps
/// value equality and `with`-expression support. The members remain
/// properties so their init-only metadata and accessor semantics survive.
open class Issue2228AutoPropertyRecordDataClassTranslationTests {
    /// The exact reported shape (`OahuConfig`): several init auto-properties,
    /// a nullable reference-typed property, an enum-typed property with a default
    /// via a member-access initializer, and a plain literal default — all must
    /// survive as init-only properties on a 'data class', not be
    /// downgraded to mutable fields or a plain class.
    @Fact
    func RecordWithOnlyInitAutoProperties_TranslatesToDataClass() {
        let printed = TranslateUnit(`
namespace Demo
{
    public enum DownloadQuality { Low, Medium, High }

    public static class CliPaths
    {
        public const string DefaultDownloadDir = "downloads";
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
}`)
        Assert.Contains("data class OahuConfig", printed)
        Assert.DoesNotContain("${Environment.NewLine}class OahuConfig {", printed)
        Assert.Contains("private var _downloadDirectory string = CliPaths.DefaultDownloadDir", printed)
        Assert.Contains("private var _defaultQuality DownloadQuality = DownloadQuality.High", printed)
        Assert.Contains("private var _maxParallelJobs int32 = 1", printed)
        Assert.Contains("prop DefaultProfileAlias string? {", printed)
        Assert.Contains("prop Theme string? {", printed)
        Assert.Contains("prop VerboseLogging bool {", printed)
        Assert.Contains("init;", printed)
    }

    /// A record-struct-shaped auto-property-only record must reach a G#
    /// 'data struct', not a plain struct, while retaining its init accessors.
    @Fact
    func RecordStructWithOnlyInitAutoProperties_TranslatesToDataStruct() {
        let printed = TranslateUnit(`
namespace Demo
{
    public record struct Point3
    {
        public double X { get; init; }
        public double Y { get; init; }
        public double Z { get; init; }
    }
}`)
        Assert.Contains("data struct Point3", printed)
        Assert.DoesNotContain("${Environment.NewLine}struct Point3 {", printed)
        Assert.Contains("prop X float64 {", printed)
        Assert.Contains("init;", printed)
    }

    /// A record whose auto-property implements an interface member cannot be
    /// remains a property, so the data class can preserve both its value
    /// semantics and interface contract.
    @Fact
    func RecordWithInterfaceAutoProperty_RemainsDataClassProperty() {
        let printed = TranslateUnit(`
namespace Demo
{
    public interface INamed
    {
        string Name { get; }
    }

    public sealed record NamedThing : INamed
    {
        public string Name { get; init; } = "thing";
    }
}`)
        Assert.Contains("data class NamedThing", printed)
        Assert.Contains("prop Name string {", printed)
    }

    shared {
        private func TranslateUnit(source string) string {
            let (printed, _) = Translate(source)
            return printed
        }

        private func Translate(source string)(Printed string, Context TranslationContext) {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Snippet.cs", source)})
            Assert.True(
                project.BoundWithoutErrors,
                "Snippet should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
            )
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
            return (printed, context)
        }
    }
}
