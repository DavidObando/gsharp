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
/// (1) a C# reference cast PRESERVES null, so a cast of a promoted-nullable
/// operand must emit the null-preserving safe cast (`expr as T`) rather than
/// `cast[T](expr)`, whose operand must be non-null; and
/// (2) an iterator's element is the method's return sink, so a tainted
/// iterator (yielding promoted-nullable values) must render `sequence[T?]` —
/// previously the yield-seam bridge correctly stood down (the return IS
/// promoted) while the signature disagreed with its own yields.
/// </summary>
public class Issue3501NullableSeamResidualTests
{
    [Fact]
    public void Oblivious_ReferenceCastOfPromotedOperand_UsesNullPreservingSafeCast()
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

        Assert.Contains("as Base", printed);
        Assert.DoesNotContain("cast[Base](", printed);
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
