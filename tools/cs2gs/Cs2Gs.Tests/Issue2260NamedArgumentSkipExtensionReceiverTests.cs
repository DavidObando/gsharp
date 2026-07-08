// <copyright file="Issue2260NamedArgumentSkipExtensionReceiverTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #2260: a named-argument call invoked in reduced/dot EXTENSION-METHOD
/// form (e.g. <c>table.AddBoldColumn("Length", noWrap: true)</c> against
/// <c>AddBoldColumn(this Table table, string header, Align align = Align.Left,
/// bool noWrap = false)</c>) that skips an earlier optional parameter whose
/// default is NON-LITERAL (e.g. an enum member or <c>default(T)</c>) mis-fired
/// the "not a simple literal" gap and silently dropped the skipped argument
/// from the emitted call.
/// </summary>
/// <remarks>
/// Root cause: <c>TranslateNamedArguments</c> resolves every argument's
/// <c>Ordinal</c> via <c>IArgumentOperation.Parameter</c>, which is always
/// bound against the extension method's UNREDUCED definition — i.e. the
/// receiver ("this") parameter occupies ordinal 0 — even though the call was
/// written in reduced/dot form, where the receiver is bound implicitly and
/// never appears as a syntactic argument at all. The gap-filling loop started
/// at ordinal 0 unconditionally, so it always tried to fill the (non-optional,
/// no-default) receiver parameter FIRST, failed immediately, and gave up
/// before ever reaching the real skipped optional parameter — dropping it
/// from the emitted call instead of reporting or filling it. The fix computes
/// how many leading ordinals the reduced call's receiver consumes (the
/// difference between the unreduced and reduced parameter counts) and starts
/// the gap-filling loop after them, so the loop only ever considers ordinals
/// that correspond to real syntactic argument positions.
/// </remarks>
public class Issue2260NamedArgumentSkipExtensionReceiverTests
{
    [Fact]
    public void NamedArgument_SkipsExtensionOptionalParameterWithEnumMemberDefault_FillsDefaultPositionally()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public enum Align { Left, Right }

    public class Table { }

    public static class TableExtensions
    {
        public static Table AddBoldColumn(this Table table, string header, Align align = Align.Left, bool noWrap = false)
        {
            return table;
        }
    }

    public class C
    {
        public void Caller(Table table)
        {
            table.AddBoldColumn(""Length"", noWrap: true);
        }
    }
}");
        Assert.Contains("AddBoldColumn(\"Length\", Align.Left, true)", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void NamedArgument_SkipsExtensionOptionalParameterWithDefaultKeywordDefault_FillsDefaultPositionally()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public struct Options { public int X; }

    public class Table { }

    public static class TableExtensions
    {
        public static Table AddOptions(this Table table, string header, Options options = default, bool noWrap = false)
        {
            return table;
        }
    }

    public class C
    {
        public void Caller(Table table)
        {
            table.AddOptions(""Length"", noWrap: true);
        }
    }
}");
        Assert.Contains("AddOptions(\"Length\", default(Options), true)", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void NamedArgument_OnExtensionCallWithNoSkippedParameter_StillWorks()
    {
        // Baseline: an extension-method call whose named argument does NOT skip
        // any optional parameter must be unaffected by the ordinal-offset fix.
        string printed = TranslateUnit(@"
namespace Demo
{
    public class Table { }

    public static class TableExtensions
    {
        public static Table AddColumn(this Table table, string header, bool noWrap = false)
        {
            return table;
        }
    }

    public class C
    {
        public void Caller(Table table)
        {
            table.AddColumn(header: ""Length"", noWrap: true);
        }
    }
}");
        Assert.Contains("AddColumn(\"Length\", true)", printed, StringComparison.Ordinal);
    }

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
        Assert.DoesNotContain(context.Diagnostics, d => d.Severity == TranslationSeverity.Unsupported);
        string printed = GSharpPrinter.Print(unit);
        RoundTripResult result = GSharpRoundTrip.Validate(printed);
        Assert.True(
            result.Success,
            "Translated G# must round-trip. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + printed);
        return printed;
    }
}
