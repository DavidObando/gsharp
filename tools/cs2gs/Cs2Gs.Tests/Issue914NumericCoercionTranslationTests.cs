// <copyright file="Issue914NumericCoercionTranslationTests.cs" company="GSharp">
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
/// Translation tests for the three numeric/guard translator defects discovered
/// migrating <c>Oahu.Decrypt</c> (issue #914):
/// (1) numeric coercion to a non-nullable value type must use the
/// conversion-call form <c>T(x)</c>, not <c>(x as T)</c> (GS0270);
/// (2) numeric promotion must extend to bitwise / null-coalescing / char /
/// compound-assignment operands (GS0129);
/// (3) a negated type-pattern guard (<c>is not T t</c>) must keep its binding
/// available after the <c>if</c> via a hoisted nullable local (GS0157).
/// </summary>
public class Issue914NumericCoercionTranslationTests
{
    /// <summary>
    /// Task 1: coercing a constant operand to a non-nullable value type emits the
    /// conversion-call form <c>uint8(1)</c> (not the GS0270-rejected
    /// <c>(1 as uint8)</c>).
    /// </summary>
    [Fact]
    public void NumericCoercion_NonNullableValueTarget_UsesConversionCallForm()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public class C
    {
        public bool F(byte b) => b > 1;
    }
}");

        Assert.Contains("uint8(1)", printed);
        Assert.DoesNotContain("as uint8", printed);
    }

    /// <summary>
    /// Task 1 guard: a nullable value-type target keeps the <c>as</c> form, which
    /// G# accepts (<c>(2 as uint16?)</c>).
    /// </summary>
    [Fact]
    public void NumericCoercion_NullableValueTarget_KeepsAsForm()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public class Entry { public ushort ChannelCount { get; set; } }

    public class C
    {
        public bool IsStereo(Entry? e) => e?.ChannelCount == 2;
    }
}");

        Assert.Contains("(2 as uint16?)", printed);
    }

    /// <summary>
    /// Task 2: a bitwise operator over differing numeric operands is promoted, so
    /// the constant operand is retyped via the conversion-call form
    /// (<c>a &amp; uint32(255)</c>).
    /// </summary>
    [Fact]
    public void BitwiseOperator_DifferingNumericOperands_Promoted()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public class C
    {
        public uint B(uint a) => a & 0xFF;
    }
}");

        Assert.Contains("& uint32(", printed);
        Assert.DoesNotContain("as uint32", printed);
    }

    /// <summary>
    /// Task 2: null-coalescing over a nullable numeric coerces the right operand
    /// to the left operand's underlying numeric type (<c>x ?? uint32(0)</c>).
    /// </summary>
    [Fact]
    public void NullCoalescing_NullableNumeric_CoercesRightToUnderlying()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public class C
    {
        public uint N(uint? x) => x ?? 0;
    }
}");

        Assert.Contains("?? uint32(0)", printed);
    }

    /// <summary>
    /// Task 2: null-coalescing over non-numeric operands is left untouched (no
    /// spurious numeric conversion is inserted).
    /// </summary>
    [Fact]
    public void NullCoalescing_NonNumericOperands_NotPerturbed()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public class C
    {
        public string N(string? a, string b) => a ?? b;
    }
}");

        Assert.Contains("a ?? b", printed);
    }

    /// <summary>
    /// Task 2: a char operand participates in promotion; comparing a byte with a
    /// char literal coerces the char to the byte's numeric type
    /// (<c>b == uint8('A')</c>).
    /// </summary>
    [Fact]
    public void CharOperand_InComparison_Promoted()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public class C
    {
        public bool Ch(byte b) => b == 'A';
    }
}");

        Assert.Contains("uint8(", printed);
        Assert.Contains("'A'", printed);
    }

    /// <summary>
    /// Task 2: a compound numeric assignment with a differing RHS numeric type
    /// coerces the RHS to the LHS type (<c>total += int64(count)</c>).
    /// </summary>
    [Fact]
    public void CompoundAssignment_DifferingNumericRhs_Coerced()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public class C
    {
        public long T(int count)
        {
            long total = 0;
            total += count;
            return total;
        }
    }
}");

        Assert.Contains("total += int64(count)", printed);
    }

    /// <summary>
    /// Task 3: a negated type-pattern guard (<c>is not T t</c>) is lowered to a
    /// hoisted nullable local plus a nil-guard, so the binder <c>t</c> stays in
    /// scope (and smart-casts) after the <c>if</c>.
    /// </summary>
    [Fact]
    public void NegatedTypePatternGuard_HoistsBindingPastIf()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public class TrunBox { public int DoThing() => 1; }

    public class C
    {
        public int G(object box)
        {
            if (box is not TrunBox trun)
            {
                throw new System.InvalidOperationException();
            }

            return trun.DoThing();
        }
    }
}");

        Assert.Contains("let trun TrunBox? = box as TrunBox", printed);
        Assert.Contains("if trun == nil", printed);
        Assert.Contains("trun.DoThing()", printed);
    }

    /// <summary>
    /// Task 3: a negated type-pattern guard over a property-path receiver
    /// (<c>child.Header is not T t</c>) hoists the receiver into the local, which
    /// G# cannot smart-cast in place.
    /// </summary>
    [Fact]
    public void NegatedTypePatternGuard_PropertyPathReceiver_HoistsLocal()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public class Header { }
    public class TrunBox : Header { public int DoThing() => 1; }
    public class Child { public Header Box { get; set; } }

    public class C
    {
        public int G(Child child)
        {
            if (child.Box is not TrunBox trun)
            {
                return 0;
            }

            return trun.DoThing();
        }
    }
}");

        Assert.Contains("let trun TrunBox? = child.Box as TrunBox", printed);
        Assert.Contains("if trun == nil", printed);
        Assert.Contains("trun.DoThing()", printed);
    }

    /// <summary>
    /// A shift count of a non-<c>int32</c> integral (here <c>byte</c>, which C#
    /// implicitly widens to <c>int</c>) is wrapped as <c>int32(count)</c> so the
    /// shift binds in G# (which requires an <c>int32</c> shift count; a
    /// <c>uint8</c>/<c>uint32</c> count is GS0129).
    /// </summary>
    [Fact]
    public void Shift_NonInt32Count_WrapsInInt32Conversion()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public class C
    {
        public uint F(uint value, byte count) => value << count;
    }
}");

        Assert.Contains("value << int32(count)", printed);
    }

    /// <summary>
    /// A shift whose count is already <c>int32</c> is left unchanged (no redundant
    /// conversion).
    /// </summary>
    [Fact]
    public void Shift_Int32Count_LeftUnchanged()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public class C
    {
        public uint F(uint value, int count) => value << count;
    }
}");

        Assert.Contains("value << count", printed);
        Assert.DoesNotContain("int32(count)", printed);
    }

    /// <summary>
    /// A compound shift-assignment <c>value &lt;&lt;= count</c> coerces the count to
    /// <c>int32</c>, NOT to the left operand's numeric type (the previous behavior
    /// wrongly emitted <c>uint32(count)</c>, yielding GS0129).
    /// </summary>
    [Fact]
    public void CompoundShiftAssignment_NonInt32Count_CoercesCountToInt32()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public class C
    {
        public uint F(uint value, byte count)
        {
            value <<= count;
            return value;
        }
    }
}");

        Assert.Contains("value <<= int32(count)", printed);
        Assert.DoesNotContain("uint32(count)", printed);
    }

    /// <summary>
    /// A ternary whose arms are differing numeric primitives coerces the diverging
    /// arm to the conditional's non-nullable numeric result type (G# has no implicit
    /// numeric promotion; mismatched arms are GS0263). Here C#'s common type of
    /// <c>1u</c> and <c>0</c> is <c>uint</c>, so the <c>0</c> arm becomes <c>uint32(0)</c>.
    /// </summary>
    [Fact]
    public void Ternary_DivergingNumericArms_CoercesToResultType()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public class C
    {
        public uint F(bool b) => b ? 1u : 0;
    }
}");

        Assert.Contains("uint32(0)", printed);
    }

    /// <summary>
    /// A direct delegate/event <c>Invoke(...)</c> is rewritten to G#'s native
    /// invocation form (<c>d(args)</c>); G# has no <c>Delegate.Invoke</c> member.
    /// </summary>
    [Fact]
    public void DelegateInvoke_IdentifierReceiver_RewritesToNativeCall()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public class C
    {
        private System.Action<int> handler;
        public void Raise(int x) => handler.Invoke(x);
    }
}");

        Assert.Contains("handler(x)", printed);
        Assert.DoesNotContain(".Invoke(x)", printed);
    }

    /// <summary>
    /// A null-conditional delegate invocation with a simple identifier receiver
    /// renders as G#'s <c>d?(args)</c> (the parser disambiguates <c>name?(</c> as a
    /// null-conditional invoke).
    /// </summary>
    [Fact]
    public void NullConditionalInvoke_IdentifierReceiver_RewritesToNullConditionalCall()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public class C
    {
        private System.Action<int> handler;
        public void Raise(int x) => handler?.Invoke(x);
    }
}");

        Assert.Contains("handler?(x)", printed);
        Assert.DoesNotContain(".Invoke(x)", printed);
    }

    /// <summary>
    /// A null-conditional delegate invocation whose receiver is a call (its text ends
    /// in <c>)</c>) keeps the explicit <c>?.Invoke(...)</c>: G# would parse
    /// <c>GetHandler()?(args)</c> as the ternary operator, so the rewrite is skipped.
    /// </summary>
    [Fact]
    public void NullConditionalInvoke_CallReceiver_KeepsExplicitInvoke()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public class C
    {
        private System.Action<int> GetHandler() => null;
        public void Raise(int x) => GetHandler()?.Invoke(x);
    }
}");

        Assert.Contains("GetHandler()?.Invoke(x)", printed);
        Assert.DoesNotContain("?(x)", printed);
    }

    /// <summary>
    /// A nullable-enabled local declaration (`Box? t1 = null`) keeps its `?` in the
    /// emitted G# type. The local symbol's flow annotation is honored (not the bare
    /// type-syntax info, which drops `?`), so the binding is `var t1 Box? = nil` and
    /// later `t1 = nil` / `t1 == nil` type-check.
    /// </summary>
    [Fact]
    public void NullableLocal_AnnotatedReference_KeepsNullableType()
    {
        string printed = TranslateUnit(@"
#nullable enable
namespace Demo
{
    public class Box { }
    public class C
    {
        Box Source() => new Box();
        public Box? M(bool flag)
        {
            Box? t1 = null;
            if (flag)
            {
                t1 = Source();
                Use(t1);
            }
            return t1;
        }
        void Use(Box b) { }
    }
}");
        Assert.Contains("var t1 Box? = nil", printed);
    }

    /// <summary>
    /// A C# constant `or` pattern on a nullable numeric (`b is 11 or 12`) lowers to
    /// equality tests whose literals are retyped to the receiver's numeric type, so
    /// the result type-checks under G#'s no-implicit-promotion rule (a bare
    /// `b == 11` of `uint8?` vs `int32` is GS0129).
    /// </summary>
    [Fact]
    public void ConstantOrPattern_NullableNumericReceiver_RetypesLiterals()
    {
        string printed = TranslateUnit(@"
#nullable enable
namespace Demo
{
    public class C
    {
        public byte? Mode { get; set; }
        public bool M() => Mode is 11 or 12 or 13;
    }
}");
        Assert.Contains("Mode == (11 as uint8?)", printed);
        Assert.Contains("Mode == (12 as uint8?)", printed);
    }

    /// <summary>
    /// A C# conversion operator with a block body must keep that body when
    /// translated. The body switch in <c>TranslateBodyCore</c> previously had no
    /// arm for <c>ConversionOperatorDeclarationSyntax</c>, so the operator was
    /// emitted with an empty block (silently dropping the conversion logic, which
    /// also yielded GS0100 "not all code paths return a value").
    /// </summary>
    [Fact]
    public void ConversionOperator_BlockBody_IsTranslated()
    {
        string printed = TranslateUnit(@"
using System;
namespace Demo
{
    public readonly struct Meters
    {
        public Meters(int value) { Value = value; }
        public int Value { get; }

        public static implicit operator Meters(int value)
        {
            ArgumentOutOfRangeException.ThrowIfNegative(value);
            return new Meters(value);
        }
    }
}");
        Assert.Contains("func operator implicit", printed);
        Assert.Contains("ThrowIfNegative", printed);
        Assert.Contains("return Meters", printed);
    }

    /// <summary>
    /// An argument whose declared numeric type differs from the type C# implicitly
    /// converted it to at the call site (here a <c>ushort</c> constant passed where
    /// generic inference selected <c>int</c>) must carry that conversion explicitly,
    /// since G# performs no implicit numeric promotion at the call site (an
    /// un-coerced operand defeats generic inference → GS0159).
    /// </summary>
    [Fact]
    public void Argument_ImplicitNumericConversion_EmitsExplicitConversion()
    {
        string printed = TranslateUnit(@"
using System;
namespace Demo
{
    public class C
    {
        public void M(int x)
        {
            ArgumentOutOfRangeException.ThrowIfGreaterThan(x, ushort.MaxValue);
        }
    }
}");
        Assert.Contains("int32(UInt16.MaxValue)", printed);
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

        string printed = GSharpPrinter.Print(unit);
        RoundTripResult result = GSharpRoundTrip.Validate(printed);
        Assert.True(
            result.Success,
            "Translated G# must round-trip. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + printed);
        return printed;
    }
}
