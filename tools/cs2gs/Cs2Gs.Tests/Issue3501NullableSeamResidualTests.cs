// <copyright file="Issue3501NullableSeamResidualTests.cs" company="GSharp">
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
/// Issue #3501 residual nullability seams:
/// (1) a C# reference cast PRESERVES null — and so does `cast[T](expr)`
/// (ADR-0167), including over a nullable operand, so the cast of a
/// promoted-nullable operand stays `cast[T](expr)`. This assertion was
/// INVERTED by issue #3843: it previously demanded `expr as T`, on the premise
/// that `cast[T]` required a non-null operand. That premise was false for the
/// identity and downcast directions and has since been closed for the upcast
/// direction too, and `as` was the wrong rendering anyway — it yields `T?`
/// (breaking a non-nullable continuation) and returns nil where C# throws
/// `InvalidCastException`; and
/// (2) an iterator's element is the method's return sink, so a tainted
/// iterator (yielding promoted-nullable values) must render `sequence[T?]` —
/// previously the yield-seam bridge correctly stood down (the return IS
/// promoted) while the signature disagreed with its own yields.
/// </summary>
public class Issue3501NullableSeamResidualTests
{
    [Fact]
    public void Oblivious_ReferenceCastOfPromotedOperand_StaysCheckedConversionCall()
    {
        string printed = TranslateOblivious(@"
namespace Demo
{
    public class Base { }
    public class Derived : Base { }

    public class Holder
    {
        public Derived Primary { get; set; }
        public Base Fallback { get; set; }

        public void Clear() { this.Primary = null; }

        public Base Pick()
        {
            return (Base)this.Primary ?? this.Fallback;
        }
    }
}");

        Assert.Contains("cast[Base](", printed);
        Assert.DoesNotContain("as Base", printed);
    }

    [Fact]
    public void Oblivious_TaintedIterator_PromotesSequenceElement()
    {
        string printed = TranslateOblivious(@"
using System.Collections.Generic;

namespace Demo
{
    public class C
    {
        public string Find(bool b)
        {
            if (b) { return null; }
            return ""x"";
        }

        public IEnumerable<string> Names(bool includeMissing)
        {
            if (includeMissing)
            {
                yield return null;
            }

            var candidate = Find(true);
            if (!string.IsNullOrEmpty(candidate))
            {
                yield return candidate;
            }
        }
    }
}");

        Assert.Contains("Names(includeMissing bool) sequence[string?]", printed);
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
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);
        Assert.DoesNotContain(
            context.Diagnostics,
            diagnostic => diagnostic.Severity == TranslationSeverity.Unsupported);

        string printed = GSharpPrinter.Print(unit);
        RoundTripResult result = TranslationTestValidation.AssertBinds(printed);
        Assert.True(
            result.Success,
            "Translated G# must round-trip. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + printed);
        return printed;
    }
}
