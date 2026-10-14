// <copyright file="FaithfulUnsafeFormTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import Xunit

/// Targeted translation tests for the faithful G# forms that the translator now
/// emits for previously-unsupported C# constructs (ADR-0115 §B; translator
/// follow-up to issues #1017, #1024, #1026, #1027): user-defined conversion
/// operators, `stackalloc`, the `fixed` statement (with its required
/// `unsafe`-context modifier mapping), and post/pre increment/decrement
/// used as a value-producing expression. Each test asserts the faithful G# form
/// is present and that the emitted G# round-trip-parses through the real gsc
/// front-end (the round-trip assertion lives in (cref:Translate)).
open class FaithfulUnsafeFormTranslationTests {
    /// Issue #1017: a C# `public static implicit operator T(U x)` maps to an
    /// in-body `func operator implicit (x U) T` member; the source parameter
    /// becomes the single parameter and the C# operator target becomes the return
    /// type.
    @Fact
    func ImplicitConversionOperator_TranslatesToFuncOperatorImplicit() {
        let printed = TranslateUnit(`
namespace Demo
{
    public readonly struct Celsius
    {
        public Celsius(float value) { Value = value; }
        public float Value { get; }
        public static implicit operator float(Celsius c) => c.Value;
    }
}`)
        Assert.Contains("func operator implicit(c Celsius) float32", printed)
    }

    /// Issue #1017: a C# `public static explicit operator T(U x)` maps to an
    /// in-body `func operator explicit (x U) T` member.
    @Fact
    func ExplicitConversionOperator_TranslatesToFuncOperatorExplicit() {
        let printed = TranslateUnit(`
namespace Demo
{
    public readonly struct Celsius
    {
        public Celsius(float value) { Value = value; }
        public float Value { get; }
        public static explicit operator Celsius(float f) => new Celsius(f);
    }
}`)
        Assert.Contains("func operator explicit(f float32) Celsius", printed)
    }

    /// Issue #1024 / #1057: a C# `stackalloc byte[2]` maps to the faithful
    /// G#-style `stackalloc [2]uint8` expression (bracketed count first,
    /// then the element type mapped through the C#-to-G# type mapper).
    @Fact
    func StackAlloc_TranslatesToFaithfulStackAllocExpression() {
        let printed = TranslateUnit(`
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
}`)
        Assert.Contains("stackalloc [2]uint8", printed)
    }

    /// Issue #1041: a C# `stackalloc int[] { 1, 2, 3 }` maps to the
    /// faithful G#-style initializer form `stackalloc [3]int32{1, 2, 3}`,
    /// with the length inferred from the initializer.
    @Fact
    func StackAlloc_WithInitializer_TranslatesToFaithfulInitializerForm() {
        let printed = TranslateUnit(`
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
}`)
        Assert.Contains("stackalloc [3]int32{1, 2, 3}", printed)
    }

    /// Issue #1026: a C# `fixed (byte* p = src) { ... }` inside an
    /// `unsafe` method maps to the paren-less G# `fixed p *uint8 = src { ...
    /// }`. The method's `unsafe` modifier is mapped by wrapping the body in
    /// an `unsafe { }` block (required for the `fixed` form to be legal).
    @Fact
    func FixedStatement_TranslatesToFaithfulFixedInsideUnsafe() {
        let printed = TranslateUnit(`
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
}`)
        Assert.Contains("unsafe {", printed)
        Assert.Contains("fixed pD *uint8 = destination {", printed)
    }

    /// Issue #1026: a C# `unsafe class` maps to a G# `unsafe class`.
    /// Issue #3684 (family F9): the `unsafe` modifier FOLLOWS the
    /// visibility keyword — ADR-0078's aggregate head is
    /// `[visibility]? [unsafe]? [open|sealed]? class …` and gsc's
    /// `ParseMember` consumes the accessibility keyword before it probes
    /// for a declaration head, so `unsafe internal class` does not parse
    /// at all.
    @Fact
    func UnsafeClass_TranslatesToUnsafeClassModifier() {
        let printed = TranslateUnit(`
namespace Demo
{
    public unsafe class Native
    {
        public int Value;
    }
}`)
        // `public` is G#'s default visibility, so the rendered head is bare
        // `unsafe open class` (issue #4674: a public non-sealed C# class stays
        // inheritable) — what matters is that no accessibility keyword ever
        // follows the `unsafe` modifier.
        Assert.Contains("unsafe open class Native", printed)
        Assert.DoesNotContain("unsafe public", printed)
    }

    /// Issue #3684 (family F9): a C# `file unsafe sealed class` with a
    /// pointer-typed member parameter. The type's visibility is `internal`, so
    /// the modifier order regression showed up as `unsafe internal class`; with
    /// the canonical order the `unsafe` modifier actually takes effect and the
    /// `*T` parameter binds as an UNMANAGED pointer rather than a managed
    /// by-ref (which gsc rejects as a parameter type with GS0243).
    @Fact
    func UnsafeInternalClassWithPointerParameter_EmitsVisibilityBeforeUnsafe() {
        let printed = TranslateUnit(`
namespace Demo
{
    internal unsafe sealed class Fixture<T>
        where T : unmanaged
    {
        public void AcceptPointer(T* value) => _ = value;
    }
}`)
        // G# classes are sealed by default (`open` is the opt-in), so `sealed`
        // is dropped; the load-bearing part is that `unsafe` follows `internal`.
        Assert.Contains("internal unsafe class Fixture[T unmanaged]", printed)
        Assert.DoesNotContain("unsafe internal", printed)
        Assert.Contains("value *T", printed)
    }

    /// Issue #1027: a C# post-decrement used as a value inside a short-circuit
    /// `&&` condition (no canonical statement seam) is emitted inline
    /// as the faithful value-producing G# `i--` expression.
    @Fact
    func PostDecrementInShortCircuitCondition_EmitsInlineDecrement() {
        let printed = TranslateUnit(`
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
}`)
        Assert.Contains("i--", printed)
    }

    /// ADR-0115 §B: a C# tuple-deconstruction *assignment* to existing variables
    /// (`(a, b) = (x, y)`) has no G# tuple-assignment form, so it is lowered
    /// to element-wise assignments through temporaries (preserving C#'s
    /// evaluate-all-then-assign order). The emitted G# must round-trip-parse.
    @Fact
    func TupleDeconstructionAssignment_LowersToElementWiseAssignments() {
        let printed = TranslateUnit(`
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
}`)
        // Issue #3358: renders as G#'s native multi-target assignment (ADR-0015)
        // rather than a decon binding plus per-target writes. The parenthesised
        // C# TARGET-TUPLE form is still absent, which is what this test guards.
        Assert.Contains("a, b = x, y", printed)
        Assert.DoesNotContain("__decon", printed)
        Assert.DoesNotContain("(a, b) =", printed)
    }

    /// ADR-0115 §B.3: a C# `record struct` with an explicit
    /// parameter-to-member constructor cannot keep an in-body `init` (the G#
    /// parser only accepts a primary constructor on a `data struct`), so the
    /// constructor is lifted to the primary constructor.
    @Fact
    func RecordStructWithExplicitConstructor_LiftsToPrimaryConstructor() {
        let printed = TranslateUnit(`
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
}`)
        Assert.Contains("data struct Entry(", printed)
        Assert.DoesNotContain("init(", printed)
    }

    /// Issue #4371: a C# fixed-size buffer field (`public fixed sbyte
    /// Name[32];`) maps to G#'s own fixed-size buffer field form (ADR-0122
    /// §10, issue #1035): `fixed Name [32]int8`. Pre-fix, the translator
    /// read the field's C#-exposed `sbyte*` pointer type at face value
    /// and emitted a bare `var Name *int8` raw-pointer field — losing the
    /// buffer's storage/length entirely and producing G# that gsc's `fixed`
    /// statement then rejected with GS0401 when pinned (Raylib-cs
    /// `BoneInfo.Name`/`ModelAnimation` interop pattern).
    @Fact
    func FixedSizeBufferField_TranslatesToFaithfulFixedBufferDeclaration() {
        let printed = TranslateUnit(`
namespace Demo
{
    public unsafe struct NativeName
    {
        public fixed sbyte Name[32];
    }
}`)
        Assert.Contains("fixed Name [32]int8", printed)
        Assert.DoesNotContain("var Name", printed)
    }

    /// Issue #4371: `fixed`-size buffer fields of other blittable element
    /// types map through the same C#-to-G# element-type mapper as every other
    /// field (`byte` -> `uint8`, `int` -> `int32`),
    /// with each declarator's own element count preserved.
    @Fact
    func FixedSizeBufferField_OtherElementTypes_MapElementTypeAndLength() {
        let printed = TranslateUnit(`
namespace Demo
{
    public unsafe struct NativeBuffers
    {
        public fixed byte Raw[8];
        public fixed int Numbers[4];
    }
}`)
        Assert.Contains("fixed Raw [8]uint8", printed)
        Assert.Contains("fixed Numbers [4]int32", printed)
    }

    /// Issue #4371: C# allows indexing a fixed-size buffer field directly
    /// (read or write), without a `fixed` statement, from inside the
    /// declaring struct's own methods — the identifier `Name` carries an
    /// implicit `this.` receiver. gsc's fixed-buffer-to-pointer decay
    /// only fires through the explicit-receiver member-access binding path,
    /// so the translator must supply the qualifier C# leaves implicit; the
    /// naive bare `Name[0]` gsc rejects with "is not indexable".
    @Fact
    func FixedSizeBufferField_BareIndexAccess_EmitsExplicitThisQualifier() {
        let (printed, context) = Translate(`
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
}`)
        Assert.Contains("this.Name[0]", printed)
        Assert.DoesNotContain(
            context.Diagnostics,
            (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported
        )
    }

    /// Issue #4371 / #4378 (ADR-0125 amendment): the ORIGINAL reported repro,
    /// `fixed (sbyte* p = Name) return p[0];`. gsc's `fixed`
    /// statement now accepts a fixed-size buffer field as its pinning source
    /// (C# parity: the buffer's containing storage stays pinned for the
    /// block), so the translator emits the faithful G# `fixed` statement
    /// over the buffer instead of the interim Unsupported gap report, and the
    /// output binds through the real gsc front-end.
    @Fact
    func FixedStatementPinningFixedSizeBufferField_TranslatesToFixedStatement() {
        let (printed, context) = Translate(`
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
}`)
        Assert.Contains("fixed p *int8 = this.Name {", printed)
        Assert.DoesNotContain(
            context.Diagnostics,
            (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported
        )
    }

    shared {
        private func TranslateUnit(source string) string {
            let (printed, _) = Translate(source)
            return printed
        }

        private func Translate(source string)(Printed string, Context TranslationContext) {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Snippet.cs", source)})
            Assert.True(
                project.BoundWithoutErrors,
                "Snippet should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
            )
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            let printed = GSharpPrinter.Print(unit)
            let result RoundTripResult? = TranslationTestValidation.AssertBinds(printed)
            Assert.True(
                result!!.Success,
                "Translated G# must round-trip. Errors:\n" + string.Join("\n", result!!.Errors) + `

Printed:
` + printed
            )
            return (printed, context)
        }
    }
}
