// <copyright file="Issue914PointerConversionTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #914: in C# a pointer→pointer conversion between different pointee
/// types (<c>byte* → void*</c>) is IMPLICIT, but per ADR-0122 §6 G# requires
/// it to be spelled explicitly as the conversion-call <c>*&lt;TargetPointee&gt;(expr)</c>
/// (<c>*void(expr)</c>, <c>*uint8(expr)</c>). Emitting the bare operand fails
/// gsc with GS0156 ("An explicit conversion exists"). These tests cover the
/// implicit conversion at argument, assignment, return, and local-initializer
/// positions, verify a same-pointee argument is NOT wrapped, and verify an
/// already-explicit C# cast is not double-wrapped.
/// </summary>
public class Issue914PointerConversionTranslationTests
{
    [Fact]
    public void ImplicitBytePtrToVoidPtr_Argument_EmitsExplicitConversion()
    {
        string rendered = Render(@"
namespace Corpus.Issue914
{
    public static unsafe class Holder
    {
        public static void Sink(void* p) { }

        public static void Pass(byte* pBuf)
        {
            Sink(pBuf);
        }
    }
}
");

        Assert.Contains("Sink(*void(pBuf))", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void ImplicitBytePtrToVoidPtr_Assignment_EmitsExplicitConversion()
    {
        string rendered = Render(@"
namespace Corpus.Issue914
{
    public static unsafe class Holder
    {
        public static void Assign(byte* p)
        {
            void* q = null;
            q = p;
        }
    }
}
");

        Assert.Contains("q = *void(p)", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void ImplicitIntPtrToVoidPtr_Return_EmitsExplicitConversion()
    {
        string rendered = Render(@"
namespace Corpus.Issue914
{
    public static unsafe class Holder
    {
        public static void* Widen(int* p)
        {
            return p;
        }
    }
}
");

        Assert.Contains("return *void(p)", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void ImplicitBytePtrToVoidPtr_LocalInitializer_EmitsExplicitConversion()
    {
        string rendered = Render(@"
namespace Corpus.Issue914
{
    public static unsafe class Holder
    {
        public static void Init(byte* pBuf)
        {
            void* p = pBuf;
        }
    }
}
");

        Assert.Contains("*void(pBuf)", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void SamePointeeArgument_IsNotWrapped()
    {
        // `void* → void*` needs no conversion; the argument must stay bare.
        string rendered = Render(@"
namespace Corpus.Issue914
{
    public static unsafe class Holder
    {
        public static void Sink(void* p) { }

        public static void Pass(void* pBuffer)
        {
            Sink(pBuffer);
        }
    }
}
");

        Assert.Contains("Sink(pBuffer)", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("*void(pBuffer)", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void ExplicitCastArgument_IsNotDoubleWrapped()
    {
        // An explicit C# `(void*)pBuf` already renders as `*void(pBuf)`; the
        // implicit-conversion pass must not wrap it again.
        string rendered = Render(@"
namespace Corpus.Issue914
{
    public static unsafe class Holder
    {
        public static void Sink(void* p) { }

        public static void Pass(byte* pBuf)
        {
            Sink((void*)pBuf);
        }
    }
}
");

        Assert.Contains("Sink(*void(pBuf))", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("*void(*void(pBuf))", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    private static void AssertRoundTripParses(string rendered)
    {
        RoundTripResult result = GSharpRoundTrip.Validate(rendered);

        Assert.True(
            result.Success,
            "Sanitized G# must round-trip-parse. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + rendered);
    }

    private static string Render(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Source.cs", source) });

        Assert.True(
            project.BoundWithoutErrors,
            "inline source should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        Cs2Gs.CodeModel.Ast.CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);
        Assert.DoesNotContain(context.Diagnostics, d => d.Severity == TranslationSeverity.Unsupported);
        return GSharpPrinter.Print(unit);
    }
}
