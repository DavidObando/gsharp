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
    /// Issue #1026: a C# <c>unsafe class</c> maps to a G# <c>unsafe class</c>.
    /// Issue #3684 (family F9): the <c>unsafe</c> modifier FOLLOWS the
    /// visibility keyword — ADR-0078's aggregate head is
    /// <c>[visibility]? [unsafe]? [open|sealed]? class …</c> and gsc's
    /// <c>ParseMember</c> consumes the accessibility keyword before it probes
    /// for a declaration head, so <c>unsafe internal class</c> does not parse
    /// at all.
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

        // `public` is G#'s default visibility, so the rendered head is bare
        // `unsafe class` — what matters is that no accessibility keyword ever
        // follows the `unsafe` modifier.
        Assert.Contains("unsafe class Native", printed);
        Assert.DoesNotContain("unsafe public", printed);
    }

    /// <summary>
    /// Issue #3684 (family F9): a C# <c>file unsafe sealed class</c> with a
    /// pointer-typed member parameter. The type's visibility is `internal`, so
    /// the modifier order regression showed up as `unsafe internal class`; with
    /// the canonical order the `unsafe` modifier actually takes effect and the
    /// <c>*T</c> parameter binds as an UNMANAGED pointer rather than a managed
    /// by-ref (which gsc rejects as a parameter type with GS0243).
    /// </summary>
    [Fact]
    public void UnsafeInternalClassWithPointerParameter_EmitsVisibilityBeforeUnsafe()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    internal unsafe sealed class Fixture<T>
        where T : unmanaged
    {
        public void AcceptPointer(T* value) => _ = value;
    }
}");

        // G# classes are sealed by default (`open` is the opt-in), so `sealed`
        // is dropped; the load-bearing part is that `unsafe` follows `internal`.
        Assert.Contains("internal unsafe class Fixture[T unmanaged]", printed);
        Assert.DoesNotContain("unsafe internal", printed);
        Assert.Contains("value *T", printed);
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

        // Issue #3358: renders as G#'s native multi-target assignment (ADR-0015)
        // rather than a decon binding plus per-target writes. The parenthesised
        // C# TARGET-TUPLE form is still absent, which is what this test guards.
        Assert.Contains("a, b = x, y", printed);
        Assert.DoesNotContain("__decon", printed);
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

    /// <summary>
    /// Issue #4371: a C# fixed-size buffer field (<c>public fixed sbyte
    /// Name[32];</c>) maps to G#'s own fixed-size buffer field form (ADR-0122
    /// §10, issue #1035): <c>fixed Name [32]int8</c>. Pre-fix, the translator
    /// read the field's C#-exposed <c>sbyte*</c> pointer type at face value
    /// and emitted a bare <c>var Name *int8</c> raw-pointer field — losing the
    /// buffer's storage/length entirely and producing G# that gsc's <c>fixed</c>
    /// statement then rejected with GS0401 when pinned (Raylib-cs
    /// <c>BoneInfo.Name</c>/<c>ModelAnimation</c> interop pattern).
    /// </summary>
    [Fact]
    public void FixedSizeBufferField_TranslatesToFaithfulFixedBufferDeclaration()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public unsafe struct NativeName
    {
        public fixed sbyte Name[32];
    }
}");

        Assert.Contains("fixed Name [32]int8", printed);
        Assert.DoesNotContain("var Name", printed);
    }

    /// <summary>
    /// Issue #4371: <c>fixed</c>-size buffer fields of other blittable element
    /// types map through the same C#-to-G# element-type mapper as every other
    /// field (<c>byte</c> -&gt; <c>uint8</c>, <c>int</c> -&gt; <c>int32</c>),
    /// with each declarator's own element count preserved.
    /// </summary>
    [Fact]
    public void FixedSizeBufferField_OtherElementTypes_MapElementTypeAndLength()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public unsafe struct NativeBuffers
    {
        public fixed byte Raw[8];
        public fixed int Numbers[4];
    }
}");

        Assert.Contains("fixed Raw [8]uint8", printed);
        Assert.Contains("fixed Numbers [4]int32", printed);
    }

    /// <summary>
    /// Issue #4371: C# allows indexing a fixed-size buffer field directly
    /// (read or write), without a <c>fixed</c> statement, from inside the
    /// declaring struct's own methods — the identifier <c>Name</c> carries an
    /// implicit <c>this.</c> receiver. gsc's fixed-buffer-to-pointer decay
    /// only fires through the explicit-receiver member-access binding path,
    /// so the translator must supply the qualifier C# leaves implicit; the
    /// naive bare <c>Name[0]</c> gsc rejects with "is not indexable".
    /// </summary>
    [Fact]
    public void FixedSizeBufferField_BareIndexAccess_EmitsExplicitThisQualifier()
    {
        (string printed, TranslationContext context) = Translate(@"
namespace Demo
{
    public unsafe struct NativeName
    {
        public fixed sbyte Name[32];

        public sbyte First()
        {
            return Name[0];
        }

        public void SetFirst(sbyte value)
        {
            Name[0] = value;
        }
    }
}");

        Assert.Contains("this.Name[0]", printed);
        Assert.DoesNotContain(context.Diagnostics, d => d.Severity == TranslationSeverity.Unsupported);
    }

    /// <summary>
    /// Issue #4371 / #4378 (ADR-0125 amendment): the ORIGINAL reported repro,
    /// <c>fixed (sbyte* p = Name) return p[0];</c>. gsc's <c>fixed</c>
    /// statement now accepts a fixed-size buffer field as its pinning source
    /// (C# parity: the buffer's containing storage stays pinned for the
    /// block), so the translator emits the faithful G# <c>fixed</c> statement
    /// over the buffer instead of the interim Unsupported gap report, and the
    /// output binds through the real gsc front-end.
    /// </summary>
    [Fact]
    public void FixedStatementPinningFixedSizeBufferField_TranslatesToFixedStatement()
    {
        (string printed, TranslationContext context) = Translate(@"
namespace Demo
{
    public unsafe struct NativeName
    {
        public fixed sbyte Name[32];

        public sbyte First()
        {
            fixed (sbyte* p = Name) return p[0];
        }
    }
}");

        Assert.Contains("fixed p *int8 = this.Name {", printed);
        Assert.DoesNotContain(context.Diagnostics, d => d.Severity == TranslationSeverity.Unsupported);
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
        RoundTripResult result = TranslationTestValidation.AssertBinds(printed);
        Assert.True(
            result.Success,
            "Translated G# must round-trip. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + printed);
        return (printed, context);
    }
}
