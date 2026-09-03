// <copyright file="Issue3843NullableOperandCastTranslationTests.cs" company="GSharp">
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
/// Issue #3843: a C# explicit reference cast over a NULLABLE operand stays
/// <c>cast[T](expr)</c> — it must not become <c>expr as T</c>.
/// <para>
/// The canonical repro is cs2gs's own
/// <c>CSharpToGSharpTranslator.PragmaSuppressions.cs</c>:
/// <c>Select(t =&gt; (PragmaWarningDirectiveTriviaSyntax)t.GetStructure())
/// .Where(d =&gt; d is not null).OrderBy(d =&gt; d.SpanStart)</c>. Lowering the
/// cast to <c>as</c> made the element type <c>T?</c>, and a sequence-level
/// <c>Where</c> does not narrow an ELEMENT type, so the emitted G# disagreed
/// with itself one line later — a nullable lambda parameter feeding a
/// non-nullable continuation (GS0158 / GS0154). It took nine apps red in
/// #3831. <c>cast[T]</c>'s result is non-nullable <c>T</c>, exactly as the C#
/// cast's type is <c>T</c>, so the chain stays consistent.
/// </para>
/// <para>
/// The runtime half of the same defect — <c>as</c> yields nil where C#
/// <c>(T)x</c> throws <see cref="InvalidCastException"/> — is proved by the
/// EXECUTING tests in
/// <c>test/Core.Tests/.../Issue3843NullableOperandCheckedCastTests.cs</c>,
/// because no compile-time or ILVerify check can see it.
/// </para>
/// </summary>
public class Issue3843NullableOperandCastTranslationTests
{
    [Fact]
    public void AnnotatedNullableOperand_SelectCastWhereNotNull_KeepsNonNullableElement()
    {
        string printed = Translate(@"
#nullable enable
using System.Collections.Generic;
using System.Linq;

namespace Demo
{
    public class Structure { public int SpanStart { get; set; } }
    public class Pragma : Structure { public string Keyword { get; set; } = """"; }

    public class Trivia
    {
        public Structure? GetStructure() => null;
    }

    public class Scanner
    {
        public List<Pragma> Collect(IEnumerable<Trivia> trivia)
        {
            return trivia
                .Select(t => (Pragma)t.GetStructure())
                .Where(d => d is not null)
                .OrderBy(d => d.SpanStart)
                .ToList();
        }
    }
}");

        // The cast keeps the checked conversion-call form...
        Assert.Contains("cast[Pragma](", printed);
        Assert.DoesNotContain("as Pragma", printed);

        // ...and the chain is INTERNALLY CONSISTENT: every lambda in it
        // takes the same element type, and the dereference that follows the
        // filter carries its own assertion. The `as` lowering printed
        // `.Where((d Pragma?) -> ...)` immediately followed by
        // `.OrderBy((d Pragma) -> d.SpanStart)` — a nullable element feeding
        // a non-nullable continuation, which is what stopped compiling
        // (GS0158 / GS0154). `Translate` above proves it binds; these pin the
        // shape so a future regression is legible.
        Assert.Contains(".Where((d Pragma?) -> d != nil)", printed);
        Assert.Contains(".OrderBy((d Pragma?) -> d!!.SpanStart)", printed);
    }

    [Fact]
    public void ObliviousPromotedOperand_CastStaysCheckedConversionCall()
    {
        string printed = Translate(@"
namespace Demo
{
    public class Base { }
    public class Derived : Base { public int Value; }

    public class Holder
    {
        public Derived Primary;

        public void Clear() { this.Primary = null; }

        public int Read()
        {
            return ((Derived)(Base)this.Primary).Value;
        }
    }
}");

        Assert.Contains("cast[Derived](", printed);
        Assert.DoesNotContain(" as Derived", printed);
    }

    private static string Translate(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("Snippet.cs", source) });
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);
        Assert.DoesNotContain(
            context.Diagnostics,
            diagnostic => diagnostic.Severity == TranslationSeverity.Unsupported);

        string printed = GSharpPrinter.Print(unit);
        RoundTripResult result = TranslationTestValidation.AssertBinds(printed);
        Assert.True(
            result.Success,
            "Translated G# must bind. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + printed);
        return printed;
    }
}
