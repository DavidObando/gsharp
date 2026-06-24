// <copyright file="FaithfulUnsafeFormTranslationTests.cs" company="GSharp">
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
/// Targeted translation tests for the faithful G# forms that the translator now
/// emits for previously-unsupported C# constructs (ADR-0115 §B; translator
/// follow-up to issues #1017, #1024, #1026, #1027): user-defined conversion
/// operators, <c>stackalloc</c>, the <c>fixed</c> statement (with its required
/// <c>unsafe</c>-context modifier mapping), and post/pre increment/decrement
/// used as a value-producing expression. Each test asserts the faithful G# form
/// is present and that the emitted G# round-trip-parses through the real gsc
/// front-end (the round-trip assertion lives in <see cref="Translate"/>).
/// </summary>
public class FaithfulUnsafeFormTranslationTests
{
    /// <summary>
    /// Issue #1017: a C# <c>public static implicit operator T(U x)</c> maps to an
    /// in-body <c>func operator implicit (x U) T</c> member; the source parameter
    /// becomes the single parameter and the C# operator target becomes the return
    /// type.
    /// </summary>
    [Fact]
    public void ImplicitConversionOperator_TranslatesToFuncOperatorImplicit()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public readonly struct Celsius
    {
        public Celsius(float value) { Value = value; }
        public float Value { get; }
        public static implicit operator float(Celsius c) => c.Value;
    }
}");

        Assert.Contains("func operator implicit(c Celsius) float32", printed);
    }

    /// <summary>
    /// Issue #1017: a C# <c>public static explicit operator T(U x)</c> maps to an
    /// in-body <c>func operator explicit (x U) T</c> member.
    /// </summary>
    [Fact]
    public void ExplicitConversionOperator_TranslatesToFuncOperatorExplicit()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public readonly struct Celsius
    {
        public Celsius(float value) { Value = value; }
        public float Value { get; }
        public static explicit operator Celsius(float f) => new Celsius(f);
    }
}");

        Assert.Contains("func operator explicit(f float32) Celsius", printed);
    }

    /// <summary>
    /// Issue #1024 / #1057: a C# <c>stackalloc byte[2]</c> maps to the faithful
    /// G#-style <c>stackalloc [2]uint8</c> expression (bracketed count first,
    /// then the element type mapped through the C#-to-G# type mapper).
    /// </summary>
    [Fact]
    public void StackAlloc_TranslatesToFaithfulStackAllocExpression()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    using System;
    public static class Buffers
    {
        public static int First()
        {
            Span<byte> word = stackalloc byte[2];
            return word.Length;
        }
    }
}");

        Assert.Contains("stackalloc [2]uint8", printed);
    }

    /// <summary>
    /// Issue #1041: a C# <c>stackalloc int[] { 1, 2, 3 }</c> maps to the
    /// faithful G#-style initializer form <c>stackalloc [3]int32{1, 2, 3}</c>,
    /// with the length inferred from the initializer.
    /// </summary>
    [Fact]
    public void StackAlloc_WithInitializer_TranslatesToFaithfulInitializerForm()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    using System;
    public static class Buffers
    {
        public static int Sum()
        {
            Span<int> data = stackalloc int[] { 1, 2, 3 };
            return data.Length;
        }
    }
}");

        Assert.Contains("stackalloc [3]int32{1, 2, 3}", printed);
    }

    /// <summary>
    /// Issue #1026: a C# <c>fixed (byte* p = src) { ... }</c> inside an
    /// <c>unsafe</c> method maps to the paren-less G# <c>fixed p *uint8 = src { ...
    /// }</c>. The method's <c>unsafe</c> modifier is mapped by wrapping the body in
    /// an <c>unsafe { }</c> block (required for the <c>fixed</c> form to be legal).
    /// </summary>
    [Fact]
    public void FixedStatement_TranslatesToFaithfulFixedInsideUnsafe()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public static class Pinner
    {
        public static unsafe void Zero(byte[] destination)
        {
            fixed (byte* pD = destination)
            {
                pD[0] = 0;
            }
        }
    }
}");

        Assert.Contains("unsafe {", printed);
        Assert.Contains("fixed pD *uint8 = destination {", printed);
    }

    /// <summary>
    /// Issue #1026: a C# <c>unsafe class</c> maps to a G# <c>unsafe class</c> (the
    /// <c>unsafe</c> modifier precedes the visibility on the type declaration).
    /// </summary>
    [Fact]
    public void UnsafeClass_TranslatesToUnsafeClassModifier()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public unsafe class Native
    {
        public int Value;
    }
}");

        Assert.Contains("unsafe class Native", printed);
    }

    /// <summary>
    /// Issue #1027: a C# post-decrement used as a value inside a short-circuit
    /// <c>&amp;&amp;</c> condition (no canonical statement seam) is emitted inline
    /// as the faithful value-producing G# <c>i--</c> expression.
    /// </summary>
    [Fact]
    public void PostDecrementInShortCircuitCondition_EmitsInlineDecrement()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public static class Scanner
    {
        public static int LastNonZero(byte[] data)
        {
            int i = data.Length;
            do
            {
                i = i;
            }
            while (i > 0 && data[i - 1] == 0 && i-- > 0);
            return i;
        }
    }
}");

        Assert.Contains("i--", printed);
    }

    /// <summary>
    /// ADR-0115 §B: a C# tuple-deconstruction *assignment* to existing variables
    /// (<c>(a, b) = (x, y)</c>) has no G# tuple-assignment form, so it is lowered
    /// to element-wise assignments through temporaries (preserving C#'s
    /// evaluate-all-then-assign order). The emitted G# must round-trip-parse.
    /// </summary>
    [Fact]
    public void TupleDeconstructionAssignment_LowersToElementWiseAssignments()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public static class Swapper
    {
        public static int Combine(int x, int y)
        {
            int a = 0;
            int b = 0;
            (a, b) = (x, y);
            return a - b;
        }
    }
}");

        Assert.Contains("a = __decon", printed);
        Assert.Contains("b = __decon", printed);
        Assert.DoesNotContain("(a, b) =", printed);
    }

    /// <summary>
    /// ADR-0115 §B.3: a C# <c>record struct</c> with an explicit
    /// parameter-to-member constructor cannot keep an in-body <c>init</c> (the G#
    /// parser only accepts a primary constructor on a <c>data struct</c>), so the
    /// constructor is lifted to the primary constructor.
    /// </summary>
    [Fact]
    public void RecordStructWithExplicitConstructor_LiftsToPrimaryConstructor()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public readonly record struct Entry
    {
        public Entry(uint first, uint second)
        {
            First = first;
            Second = second;
        }

        public uint First { get; }

        public uint Second { get; }
    }
}");

        Assert.Contains("data struct Entry(", printed);
        Assert.DoesNotContain("init(", printed);
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
