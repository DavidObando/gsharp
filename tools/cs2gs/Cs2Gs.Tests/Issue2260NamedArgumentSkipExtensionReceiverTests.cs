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
/// Issue #2260/#3090: reduced extension calls preserve their named arguments;
/// gsc maps them after the implicit receiver and supplies skipped defaults.
/// </summary>
/// <remarks>
/// Native named-argument binding eliminates translator-side ordinal filling,
/// including the former reduced-extension receiver offset special case.
/// </remarks>
public class Issue2260NamedArgumentSkipExtensionReceiverTests
{
    [Fact]
    public void NamedArgument_SkipsExtensionOptionalParameterWithEnumMemberDefault_PreservesName()
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
        Assert.Contains("AddBoldColumn(\"Length\", noWrap: true)", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void NamedArgument_SkipsExtensionOptionalParameterWithDefaultKeywordDefault_PreservesName()
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
        Assert.Contains("AddOptions(\"Length\", noWrap: true)", printed, StringComparison.Ordinal);
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
        Assert.Contains(
            "AddColumn(header: \"Length\", noWrap: true)",
            printed,
            StringComparison.Ordinal);
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
        RoundTripResult result = TranslationTestValidation.AssertBinds(printed);
        Assert.True(
            result.Success,
            "Translated G# must round-trip. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + printed);
        return printed;
    }
}
