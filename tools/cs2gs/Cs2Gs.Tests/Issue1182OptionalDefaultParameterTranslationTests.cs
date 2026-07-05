// <copyright file="Issue1182OptionalDefaultParameterTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #1182 / #914: an optional parameter whose default is the zero value
/// (<c>= default</c>, <c>= default(T)</c>, or <c>= null</c>) was previously
/// silently dropped, turning the optional parameter into a required one and
/// producing GS0144 ("requires N arguments") at call sites. cs2gs now emits the
/// explicit zero default: <c>default(T)</c> for a non-nullable value type (bare
/// <c>default</c> is rejected by gsc with GS0265), and <c>nil</c> for a reference
/// or nullable value type. The default is preserved on ordinary <c>func</c>
/// parameters and on a parameter that is lifted into a primary constructor.
/// </summary>
public class Issue1182OptionalDefaultParameterTranslationTests
{
    private const string Source = @"
using System;

namespace Corpus.Issue1182
{
    public class ChapterInfo
    {
        public ChapterInfo(TimeSpan offsetFromBeginning = default)
        {
            this.Offset = offsetFromBeginning;
        }

        public TimeSpan Offset { get; }
    }

    public class Defaults
    {
        public void ValueTypeDefault(TimeSpan span = default(TimeSpan)) { }

        public void ReferenceDefault(string name = null) { }

        public void NullableValueDefault(int? count = null) { }

        public void IntLiteralDefault(int n = 3) { }
    }
}
";

    [Fact]
    public void ValueTypeDefault_OnFunc_RendersAsTypedDefault()
    {
        string rendered = Render();

        // `TimeSpan span = default(TimeSpan)` survives as a typed default
        // (gsc rejects a bare `= default`).
        Assert.Contains("span TimeSpan = default(TimeSpan)", rendered, StringComparison.Ordinal);
    }

    [Fact]
    public void ValueTypeDefault_LiftedIntoPrimaryConstructor_RendersAsTypedDefault()
    {
        string rendered = Render();

        // The explicit constructor `ChapterInfo(TimeSpan offsetFromBeginning = default)`
        // is lifted into a primary constructor; the optional default must survive the
        // lift so callers can write `ChapterInfo()`.
        Assert.Contains("class ChapterInfo(Offset TimeSpan = default(TimeSpan))", rendered, StringComparison.Ordinal);
    }

    [Fact]
    public void ReferenceAndNullableDefaults_RenderAsNil()
    {
        string rendered = Render();

        // A reference-type `= null` default is null-tainted, so under a
        // nullable-oblivious compilation issue #2113 promotes it to `string?`; a
        // nullable value-type `= null` is `int32?`. Both render `= nil`.
        Assert.Contains("name string? = nil", rendered, StringComparison.Ordinal);
        Assert.Contains("count int32? = nil", rendered, StringComparison.Ordinal);
    }

    [Fact]
    public void LiteralDefault_StillRendersAsLiteral()
    {
        string rendered = Render();

        Assert.Contains("n int32 = 3", rendered, StringComparison.Ordinal);
    }

    [Fact]
    public void TranslatedOutput_ContainsNoBareDefault()
    {
        string rendered = Render();

        // A bare `= default` (GS0265) must never appear; it is always typed or `nil`.
        Assert.DoesNotContain("= default\n", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("= default)", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("= default ", rendered, StringComparison.Ordinal);
    }

    private static string Render()
    {
        (CompilationUnit unit, _) = Translate();
        return GSharpPrinter.Print(unit);
    }

    private static (CompilationUnit Unit, TranslationContext Context) Translate()
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("ChapterInfo.cs", Source) });

        Assert.True(
            project.BoundWithoutErrors,
            "inline source should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);
        return (unit, context);
    }
}
