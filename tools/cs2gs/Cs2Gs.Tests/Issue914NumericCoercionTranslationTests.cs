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
