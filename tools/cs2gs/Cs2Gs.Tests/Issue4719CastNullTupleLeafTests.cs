// <copyright file="Issue4719CastNullTupleLeafTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Tests;
using Microsoft.CodeAnalysis;
using Xunit;

namespace Cs2Gs.Tests;

public sealed class Issue4719CastNullTupleLeafTests : IDisposable
{
    private readonly string fixtureDirectory = Path.Combine(
        AppContext.BaseDirectory,
        "issue4719-fixtures",
        Guid.NewGuid().ToString("N"));

    [Theory]
    [InlineData("(string)null")]
    [InlineData("((string)null)")]
    [InlineData("(string)default")]
    [InlineData("(string)default(string)")]
    [InlineData("(string)(object)null")]
    [InlineData("choose ? (string)null : \"x\"")]
    [InlineData("choose switch { true => (string)null, false => \"x\" }")]
    public void CastNullTupleLeaf_PromotesOnlyTheNullBearingLeaf(string value)
    {
        string printed = Translate($$"""
            public static class Obj {
                public static ((string Text, string Keep) Names, int Code) Rows(bool choose) {
                    ((string Text, string Keep) Names, int Code) Missing() {
                        return choose ? (({{value}}, "keep"), 1) : (("x", "keep"), 2);
                    }
                    return Missing();
                }
            }
            """);

        Assert.Contains("let Missing = func () (Names (Text string?, Keep string), Code int32)", printed);
        Assert.Contains("func Rows(choose bool) (Names (Text string?, Keep string), Code int32)", printed);
        TranslationTestValidation.AssertBinds(printed);
    }

    [Fact]
    public void CastNullTupleAndScalarReturns_PreserveRuntimeNull()
    {
        string printed = Translate("""
            public static class Obj {
                public static string Missing() => (string)null;
                public static string Forward() => Missing();
                public static (string Text, int Code) Row() => ((string)null, 1);
                public static bool Run() {
                    var row = Row();
                    return row.Text is null && row.Code == 1 && Forward() is null;
                }
            }
            """);

        Assert.Contains("func Missing() string?", printed);
        Assert.Contains("func Forward() string?", printed);
        Assert.Contains("func Row() (Text string?, Code int32)", printed);
        TranslationTestValidation.AssertBinds(printed);
        EmittedOracleResult result = EmittedOracle.Evaluate(printed + Environment.NewLine + "Obj.Run()");
        Assert.False(result.Diagnostics.Any(diagnostic => diagnostic.IsError), string.Join(Environment.NewLine, result.Diagnostics));
        Assert.Null(result.UnhandledException);
        Assert.Equal(true, result.Value);
    }

    [Theory]
    [InlineData("(string)(object)\"keep\"")]
    [InlineData("(string)null ?? \"keep\"")]
    [InlineData("(int)(object)null")]
    [InlineData("(Box)(string)null")]
    public void CastWithoutNullResult_DoesNotPromoteItsTupleLeaf(string value)
    {
        string type = value.StartsWith("(int)", StringComparison.Ordinal) ? "int"
            : value.StartsWith("(Box)", StringComparison.Ordinal) ? "Box" : "string";
        string mappedType = type == "int" ? "int32" : type;
        string printed = Translate($$"""
            public sealed class Box {
                public static explicit operator Box(string text) => new Box();
            }
            public static class Obj {
                public static ({{type}} Value, int Code) Row() => ({{value}}, 1);
            }
            """);

        Assert.Contains($"func Row() (Value {mappedType}, Code int32)", printed);
        TranslationTestValidation.AssertBinds(printed);
    }

    [Fact]
    public void OriginalNestedIteratorAndCastYield_PreserveContractsAndDeferredEvaluation()
    {
        string fixture = this.EmitFixture();
        string printed = Translate("""
            using System.Collections.Generic;
            using Issue4719Fixture;
            public static class Obj {
                public static IEnumerable<(string Text, int Code)> Rows(bool choose) {
                    IEnumerable<(string Text, int Code)> Missing() {
                        yield return choose ? ((string)null, 1) : ("x", 2);
                    }
                    if (choose) { yield break; }
                    yield return ("keep", 2);
                }

                public static IEnumerable<(string Text, int Code)> MissingRows(bool choose) {
                    IEnumerable<(string Text, int Code)> Missing() {
                        yield return Probe.Choose(choose) ? ((string)null, 1) : ("x", 2);
                    }
                    return Missing();
                }

                public static IEnumerable<(string Text, int Code)> CastRows(bool choose) {
                    yield return ((string Text, int Code))
                        (Probe.Choose(choose) ? ((string)(null), 1) : ("x", 2));
                    yield return (Probe.Text(choose), 3);
                }

                public static int Run() {
                    int total = 0;
                    foreach (var row in Rows(true)) { return -1; }
                    foreach (var row in Rows(false)) {
                        if (row.Text != "keep" || row.Code != 2) { return -2; }
                        total += row.Code;
                    }
                    Probe.Reset();
                    var missing = MissingRows(true);
                    if (Probe.Calls != 0) { return -3; }
                    foreach (var row in missing) {
                        if (row.Text != null || row.Code != 1 || Probe.Calls != 1) { return -4; }
                        total += row.Code;
                    }
                    foreach (var row in MissingRows(false)) {
                        if (row.Text != "x" || row.Code != 2 || Probe.Calls != 2) { return -5; }
                        total += row.Code;
                    }
                    Probe.Reset();
                    var deferred = CastRows(true);
                    if (Probe.Calls != 0) { return -6; }
                    foreach (var row in deferred) {
                        if (row.Text != null || row.Code != 1 || Probe.Calls != 1) { return -7; }
                        total += row.Code;
                        break;
                    }
                    if (Probe.Calls != 1) { return -8; }
                    Probe.Reset();
                    foreach (var row in CastRows(true)) {
                        if (row.Text != null || Probe.Calls != (row.Code == 1 ? 1 : 2)) { return -9; }
                        total += row.Code;
                    }
                    if (Probe.Calls != 2) { return -10; }
                    Probe.Reset();
                    foreach (var row in CastRows(false)) {
                        if (row.Text != "x" || Probe.Calls != (row.Code == 2 ? 1 : 2)) { return -11; }
                        total += row.Code;
                    }
                    if (Probe.Calls != 2) { return -12; }
                    return total;
                }
            }
            """, fixture);

        Assert.Contains("func Rows(choose bool) sequence[(Text string, Code int32)]", printed);
        Assert.Equal(2, printed.Split("let Missing = func () IEnumerable[(Text string?, Code int32)]").Length - 1);
        Assert.Contains("func CastRows(choose bool) sequence[(Text string?, Code int32)]", printed);
        AssertTypedHoists(printed, "(Text string?, Code int32)", expectedCount: 3);
        AssertBindsAndRuns(printed, fixture, expected: 15);
    }

    [Theory]
    [InlineData("IEnumerable", "", "sequence")]
    [InlineData("IEnumerator", "", "IEnumerator")]
    [InlineData("IAsyncEnumerable", "async ", "IAsyncEnumerable")]
    [InlineData("IAsyncEnumerator", "async ", "IAsyncEnumerator")]
    public void CastTupleYield_UsesPromotedElementTypeForItsMaterializedLocal(
        string envelope,
        string modifier,
        string mappedEnvelope)
    {
        string fixture = this.EmitFixture();
        string printed = Translate($$"""
            using System.Collections.Generic;
            using Issue4719Fixture;
            public static class Obj {
                public static {{modifier}}{{envelope}}<(string Text, int Code)> Rows(bool choose) {
                    yield return ((string Text, int Code))
                        (Probe.Choose(choose) ? ((string)null, 1) : ("x", 2));
                }
            }
            """, fixture);

        Assert.Contains($"func Rows(choose bool) {mappedEnvelope}[(Text string?, Code int32)]", printed);
        AssertTypedHoists(printed, "(Text string?, Code int32)", expectedCount: 1);
        using var resolver = ReferenceResolver.WithReferences(new[] { fixture });
        TranslationTestValidation.AssertBinds(resolver, printed);
    }

    [Theory]
    [InlineData("choose ? ((string)text, 1) : (\"x\", 2)", true)]
    [InlineData("choose switch { true => ((string)text, 1), false => (\"x\", 2) }", true)]
    [InlineData("(choose ? (string)text : \"x\", 1)", false)]
    [InlineData("(choose switch { true => (string)text, false => \"x\" }, 1)", false)]
    public void GuardedCastTupleLeaf_PreservesTheNonNullContractAndRuntimeGuard(string yielded, bool materialized)
    {
        string fixture = this.EmitFixture();
        string printed = Translate($$"""
            using System.Collections.Generic;
            using Issue4719Fixture;
            public static class Obj {
                public static IEnumerable<(string Text, int Code)> Rows(bool choose) {
                    string? text = choose ? null : "x";
                    if (text != null) {
                        Probe.Choose(choose);
                        yield return {{yielded}};
                    }
                }
                public static int Run() {
                    Probe.Reset();
                    foreach (var row in Rows(true)) { return -1; }
                    if (Probe.Calls != 0) { return -2; }
                    var present = Rows(false);
                    if (Probe.Calls != 0) { return -3; }
                    int count = 0;
                    foreach (var row in present) {
                        if (row.Text != "x" || Probe.Calls != 1) { return -4; }
                        count++;
                    }
                    return count;
                }
            }
            """, fixture);

        Assert.Contains("func Rows(choose bool) sequence[(Text string, Code int32)]", printed);
        Assert.DoesNotContain("text!!", printed);
        if (materialized)
        {
            AssertTypedHoists(printed, "(Text string, Code int32)", expectedCount: 1);
        }

        AssertBindsAndRuns(printed, fixture, expected: 1);
    }

    [Fact]
    public void GuardedNestedCastTupleLeaf_StillPromotesTheNullSibling()
    {
        string fixture = this.EmitFixture();
        string printed = Translate("""
            using System.Collections.Generic;
            using Issue4719Fixture;
            public static class Obj {
                public static IEnumerable<((string Text, string Missing) Names, int Code)> Rows(bool choose) {
                    string? text = choose ? null : "x";
                    if (text != null) {
                        yield return choose
                            ? (((string)text, (string)null), 1)
                            : (((string)text, (string)(null)), 2);
                    }
                }
                public static int Run() {
                    foreach (var row in Rows(true)) { return -1; }
                    int count = 0;
                    foreach (var row in Rows(false)) {
                        if (row.Names.Text != "x" || row.Names.Missing != null || row.Code != 2) { return -2; }
                        count++;
                    }
                    return count;
                }
            }
            """, fixture);

        const string tuple = "(Names (Text string, Missing string?), Code int32)";
        Assert.Contains("func Rows(choose bool) sequence[" + tuple + "]", printed);
        AssertTypedHoists(printed, tuple, expectedCount: 1);
        AssertBindsAndRuns(printed, fixture, expected: 1);
    }

    [Theory]
    [InlineData("(string)(object)\"keep\"", "string", "\"keep\"", "string")]
    [InlineData("(string)null ?? \"keep\"", "string", "\"keep\"", "string")]
    [InlineData("(int)(object)null", "int", "1", "int32")]
    [InlineData("(Box)(string)null", "Box", "new Box()", "Box")]
    public void IteratorCastWithoutNullResult_PreservesElementAndHoistPrecision(
        string value,
        string type,
        string fallback,
        string mappedType)
    {
        string fixture = this.EmitFixture();
        string printed = Translate($$"""
            using System.Collections.Generic;
            using Issue4719Fixture;
            public static class Obj {
                public static IEnumerable<({{type}} Value, int Code)> Rows(bool choose) {
                    yield return choose ? ({{value}}, 1) : ({{fallback}}, 2);
                }
            }
            """, fixture);

        string tuple = $"(Value {mappedType}, Code int32)";
        Assert.Contains("func Rows(choose bool) sequence[" + tuple + "]", printed);
        AssertTypedHoists(printed, tuple, expectedCount: 1);
        using var resolver = ReferenceResolver.WithReferences(new[] { fixture });
        TranslationTestValidation.AssertBinds(resolver, printed);
    }

    public void Dispose()
    {
        try
        {
            if (Directory.Exists(this.fixtureDirectory))
            {
                Directory.Delete(this.fixtureDirectory, recursive: true);
            }
        }
        catch (IOException)
        {
            // A collectible oracle assembly can still hold the fixture on Windows.
        }
        catch (UnauthorizedAccessException)
        {
            // Best-effort cleanup, as above.
        }
    }

    private string EmitFixture()
    {
        Directory.CreateDirectory(this.fixtureDirectory);
        string assemblyName = "Issue4719Fixture" + Guid.NewGuid().ToString("N");
        string path = Path.Combine(this.fixtureDirectory, assemblyName + ".dll");
        LoadedCSharpProject fixture = CSharpProjectLoader.LoadInMemory(new[]
        {
            ("Fixture.cs", """
                namespace Issue4719Fixture {
                    public sealed class Box {
                        public static explicit operator Box(string text) => new Box();
                    }
                    public static class Probe {
                        public static int Calls;
                        public static void Reset() { Calls = 0; }
                        public static bool Choose(bool choose) { Calls++; return choose; }
                        public static string Text(bool missing) { Calls++; return missing ? null : "x"; }
                    }
                }
                """),
        });
        Assert.True(fixture.BoundWithoutErrors, string.Join(Environment.NewLine, fixture.ErrorDiagnostics));
        var emitted = fixture.Compilation.WithAssemblyName(assemblyName).Emit(path);
        Assert.True(emitted.Success, string.Join(Environment.NewLine, emitted.Diagnostics));
        return path;
    }

    private static void AssertTypedHoists(string printed, string tuple, int expectedCount)
    {
        MatchCollection locals = Regex.Matches(printed, @"let (?<name>__yielded\d+) " + Regex.Escape(tuple) + " =");
        Assert.NotEmpty(locals);
        Assert.Equal(expectedCount, locals.Count);
        Assert.All(
            locals.Cast<Match>(),
            local => Assert.Matches(@"\byield " + Regex.Escape(local.Groups["name"].Value) + @"\b", printed));
    }

    private static void AssertBindsAndRuns(string printed, string fixture, int expected)
    {
        using var resolver = ReferenceResolver.WithReferences(new[] { fixture });
        TranslationTestValidation.AssertBinds(resolver, printed);
        EmittedOracleResult result = EmittedOracle.Evaluate(
            printed + Environment.NewLine + "Obj.Run()",
            new[] { fixture });
        Assert.False(result.Diagnostics.Any(diagnostic => diagnostic.IsError), string.Join(Environment.NewLine, result.Diagnostics));
        Assert.Null(result.UnhandledException);
        Assert.Equal(expected, result.Value);
    }

    private static string Translate(string source, string fixture = null)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Snippet.cs", source) },
            fixture is null
                ? null
                : CSharpProjectLoader.RuntimeReferences().Append(MetadataReference.CreateFromFile(fixture)).ToArray());
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        Assert.Equal(NullableContextOptions.Disable, project.Compilation.Options.NullableContextOptions);
        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);
        Assert.DoesNotContain(context.Diagnostics, diagnostic => diagnostic.Severity == TranslationSeverity.Unsupported);
        return GSharpPrinter.Print(unit);
    }
}
