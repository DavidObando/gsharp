// <copyright file="Issue4116NarrowShiftLeftOperandPromotionTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import GSharp.Core.CodeAnalysis
import GSharp.Tests
import System
import Xunit

/// Issue #4116 (split from #4045's #3932/#3939 residual metadata-decode
/// failures): C# binary numeric promotion (§12.4.7) widens a `byte`/`sbyte`/
/// `short`/`ushort`/`char` LEFT operand of `<<`/`>>`/`>>>`
/// to `int`, unconditionally, independent of the right operand's own
/// (separate) conversion to `int` for the shift count. Issue #1232 already
/// covers the count side; this issue is the LEFT side, which #1232's own
/// comment mistakenly treated as already-handled.
///
/// G#'s shift operators deliberately do NOT widen a non-`char` narrow
/// integral operand (gsc issue #2227 special-cased only `char`): `uint8 <<
/// n` stays `uint8`-typed. Left un-widened by the translator, a C# expression
/// like `byteValue << 24` (used to reassemble a multi-byte value
/// from individually-read bytes — the exact shape in the migrated
/// `Issue3932GenericEmitSitesTests`/`Issue3939GenericStaticSiblingEmitTests`
/// metadata-token decoders) silently collapses to `0` instead of the C#
/// value, because shifting a `uint8` left by 24 shifts every bit out of an
/// 8-bit value.
open class Issue4116NarrowShiftLeftOperandPromotionTranslationTests {
    @Fact
    func ByteLeftOperand_LeftShift_WidensToInt32() {
        let rendered = Render(`
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
`)
        Assert.Contains("int32(value) << 24", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func ByteLeftOperand_LeftShift_ReconstitutesAMultiByteToken() {
        // The exact shape from Issue3932GenericEmitSitesTests' /
        // Issue3939GenericStaticSiblingEmitTests' metadata-token decoders:
        // OR-ing four individually-shifted bytes back into one int32. Without
        // widening the left operand of each shift, every term past the first
        // collapses to 0 and the reconstructed token is wrong.
        let rendered = Render(`
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
`)
        Assert.Contains("int32(il[i + 2]) << 8", rendered, StringComparison.Ordinal)
        Assert.Contains("int32(il[i + 3]) << 16", rendered, StringComparison.Ordinal)
        Assert.Contains("int32(il[i + 4]) << 24", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
        // End-to-end proof: compile and RUN the emitted G# itself (not a
        // parallel C# re-implementation of the same arithmetic, which would
        // pass unconditionally regardless of what the translator emitted).
        // Without the fix, the byte-typed slots stay uint8-shifted and every
        // term past the first collapses to 0, so the reconstructed value
        // would be 1 (just il[i + 1]) instead of the correct 0x04030201.
        let result = EmittedOracle.Evaluate(
            rendered + Environment.NewLine + "Holder().Decode([]uint8{0, 1, 2, 3, 4}, 0)"
        )
        Assert.DoesNotContain(result.Diagnostics, (diagnostic Diagnostic) -> diagnostic.IsError)
        Assert.Null(result.UnhandledException)
        Assert.Equal(0x04030201, result.Value)
    }

    @Fact
    func ShortLeftOperand_RightShift_WidensToInt32() {
        let rendered = Render(`
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
`)
        Assert.Contains("int32(value) >> 3", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func IntLeftOperand_LeftShift_StaysUnwrapped() {
        // Control (mirrors Issue1880's own coverage): an already-`int` left
        // operand needs no coercion, so a mutant that wraps unconditionally
        // is caught here.
        let rendered = Render(`
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
`)
        Assert.Contains("value << 4", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("int32(value)", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func ByteLeftOperand_CompoundLeftShiftAssignment_StaysUnwrapped() {
        // Control: a compound `<<=` assigns back into the same narrow-typed
        // location, so C# does NOT promote its left operand the way a plain
        // `<<` expression's left operand is promoted — the fix must not touch
        // this shape.
        let rendered = Render(`
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
`)
        Assert.Contains("value <<= 2", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("int32(value)", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    shared {
        private func AssertRoundTripParses(rendered string) {
            let result RoundTripResult? = TranslationTestValidation.AssertBinds(rendered)
            Assert.True(
                result!!.Success,
                "Sanitized G# must round-trip-parse. Errors:\n" + string.Join("\n", result!!.Errors) + `

Printed:
` + rendered
            )
        }

        private func Render(source string) string {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Source.cs", source)})
            Assert.True(
                project.BoundWithoutErrors,
                "inline source should bind with no C# errors: " + string.Join(
                    Environment.NewLine,
                    project.ErrorDiagnostics
                )
            )
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            Assert.Empty(context.Diagnostics)
            return GSharpPrinter.Print(unit)
        }
    }
}
