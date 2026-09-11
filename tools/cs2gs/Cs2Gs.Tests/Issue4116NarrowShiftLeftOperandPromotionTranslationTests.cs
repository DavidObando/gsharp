// <copyright file="Issue4116NarrowShiftLeftOperandPromotionTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using GSharp.Tests;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #4116 (split from #4045's #3932/#3939 residual metadata-decode
/// failures): C# binary numeric promotion (§12.4.7) widens a `byte`/`sbyte`/
/// `short`/`ushort`/`char` LEFT operand of `&lt;&lt;`/`&gt;&gt;`/`&gt;&gt;&gt;`
/// to `int`, unconditionally, independent of the right operand's own
/// (separate) conversion to `int` for the shift count. Issue #1232 already
/// covers the count side; this issue is the LEFT side, which #1232's own
/// comment mistakenly treated as already-handled.
/// <para>
/// G#'s shift operators deliberately do NOT widen a non-`char` narrow
/// integral operand (gsc issue #2227 special-cased only `char`): `uint8 &lt;&lt;
/// n` stays `uint8`-typed. Left un-widened by the translator, a C# expression
/// like <c>byteValue &lt;&lt; 24</c> (used to reassemble a multi-byte value
/// from individually-read bytes — the exact shape in the migrated
/// <c>Issue3932GenericEmitSitesTests</c>/<c>Issue3939GenericStaticSiblingEmitTests</c>
/// metadata-token decoders) silently collapses to <c>0</c> instead of the C#
/// value, because shifting a `uint8` left by 24 shifts every bit out of an
/// 8-bit value.
/// </para>
/// </summary>
public class Issue4116NarrowShiftLeftOperandPromotionTranslationTests
{
    [Fact]
    public void ByteLeftOperand_LeftShift_WidensToInt32()
    {
        string rendered = Render(@"
namespace Corpus.Issue4116
{
    public class Holder
    {
        public int Shift(byte value)
        {
            return value << 24;
        }
    }
}
");

        Assert.Contains("int32(value) << 24", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void ByteLeftOperand_LeftShift_ReconstitutesAMultiByteToken()
    {
        // The exact shape from Issue3932GenericEmitSitesTests' /
        // Issue3939GenericStaticSiblingEmitTests' metadata-token decoders:
        // OR-ing four individually-shifted bytes back into one int32. Without
        // widening the left operand of each shift, every term past the first
        // collapses to 0 and the reconstructed token is wrong.
        string rendered = Render(@"
namespace Corpus.Issue4116
{
    public class Holder
    {
        public int Decode(byte[] il, int i)
        {
            return il[i + 1] | (il[i + 2] << 8) | (il[i + 3] << 16) | (il[i + 4] << 24);
        }
    }
}
");

        Assert.Contains("int32(il[i + 2]) << 8", rendered, StringComparison.Ordinal);
        Assert.Contains("int32(il[i + 3]) << 16", rendered, StringComparison.Ordinal);
        Assert.Contains("int32(il[i + 4]) << 24", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);

        // End-to-end proof: compile and RUN the emitted G# itself (not a
        // parallel C# re-implementation of the same arithmetic, which would
        // pass unconditionally regardless of what the translator emitted).
        // Without the fix, the byte-typed slots stay uint8-shifted and every
        // term past the first collapses to 0, so the reconstructed value
        // would be 1 (just il[i + 1]) instead of the correct 0x04030201.
        EmittedOracleResult result = EmittedOracle.Evaluate(
            rendered + Environment.NewLine + "Holder().Decode([]uint8{0, 1, 2, 3, 4}, 0)");
        Assert.DoesNotContain(result.Diagnostics, diagnostic => diagnostic.IsError);
        Assert.Null(result.UnhandledException);
        Assert.Equal(0x04030201, result.Value);
    }

    [Fact]
    public void ShortLeftOperand_RightShift_WidensToInt32()
    {
        string rendered = Render(@"
namespace Corpus.Issue4116
{
    public class Holder
    {
        public int Shift(short value)
        {
            return value >> 3;
        }
    }
}
");

        Assert.Contains("int32(value) >> 3", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void IntLeftOperand_LeftShift_StaysUnwrapped()
    {
        // Control (mirrors Issue1880's own coverage): an already-`int` left
        // operand needs no coercion, so a mutant that wraps unconditionally
        // is caught here.
        string rendered = Render(@"
namespace Corpus.Issue4116
{
    public class Holder
    {
        public int Shift(int value)
        {
            return value << 4;
        }
    }
}
");

        Assert.Contains("value << 4", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("int32(value)", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void ByteLeftOperand_CompoundLeftShiftAssignment_StaysUnwrapped()
    {
        // Control: a compound `<<=` assigns back into the same narrow-typed
        // location, so C# does NOT promote its left operand the way a plain
        // `<<` expression's left operand is promoted — the fix must not touch
        // this shape.
        string rendered = Render(@"
namespace Corpus.Issue4116
{
    public class Holder
    {
        public byte Shift(byte value)
        {
            value <<= 2;
            return value;
        }
    }
}
");

        Assert.Contains("value <<= 2", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("int32(value)", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    private static void AssertRoundTripParses(string rendered)
    {
        RoundTripResult result = TranslationTestValidation.AssertBinds(rendered);

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
        Assert.Empty(context.Diagnostics);
        return GSharpPrinter.Print(unit);
    }
}
