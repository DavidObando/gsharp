// <copyright file="Issue914StaticInitializerBlockTranslationTests.cs" company="GSharp">
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

/// Issue #914 (cs2gs): a non-foldable C# `static` constructor now maps to
/// the G# `init { ... }` static-initializer block inside the type's
/// `shared { }` block (ADR-0140, ADR-0115 §B.11). Previously such a
/// constructor was reported as unsupported and dropped. A foldable static
/// constructor (only simple `Field = value;` assignments) must still fold
/// its initializers onto the field declarations and emit NO `init { }`.
open class Issue914StaticInitializerBlockTranslationTests {
    /// The canonical CRC-table shape: a static constructor whose body is a
    /// nested loop populating a static array. It maps to a G# `init { }`
    /// static-initializer block inside the `shared { }` block, and must
    /// round-trip.
    @Fact
    func StaticConstructor_CrcTableLoop_MapsToStaticInitializerBlock() {
        let printed = TranslateUnit(`
namespace Demo
{
    public static class Crc32
    {
        private const uint Polynomial = 0xEDB88320;
        private static readonly uint[] Table = new uint[256];

        static Crc32()
        {
            for (uint i = 0; i < Table.Length; i++)
            {
                uint value = i;
                for (int j = 0; j < 8; j++)
                {
                    value = ((value & 1) != 0) ? (value >> 1) ^ Polynomial : value >> 1;
                }

                Table[i] = value;
            }
        }
    }
}`)
        // ADR-0195: a C# static class is a `shared class`, whose body is the shared member
        // list, so the static initializer is a flat `init { }` (no `shared { }` block).
        Assert.Contains("shared class ", printed)
        Assert.DoesNotContain("shared {", printed)
        Assert.Contains("init {", printed)
        Assert.Contains("Table[i]", printed)
        // The field initializer stays on the field declaration; it is not
        // re-emitted inside the init block.
        Assert.DoesNotContain("Table = uint", printed)
    }

    /// A static constructor initializing multiple interdependent static fields
    /// with non-trivial logic (loops, accumulation) maps to a single
    /// `init { }` block preserving statement order, and round-trips.
    @Fact
    func StaticConstructor_InterdependentFields_MapsToStaticInitializerBlock() {
        let printed = TranslateUnit(`
namespace Demo
{
    public static class Config
    {
        private static readonly int Base;
        private static readonly int Scaled;
        private static readonly int Total;

        static Config()
        {
            Base = 10;
            int acc = 0;
            for (int i = 0; i < Base; i++)
            {
                acc += i;
            }

            Scaled = Base * 2;
            Total = acc + Scaled;
        }
    }
}`, "G# currently rejects assignments to let fields inside their static initializer block.")
        // ADR-0195: a C# static class is a `shared class`, whose body is the shared member
        // list, so the static initializer is a flat `init { }` (no `shared { }` block).
        Assert.Contains("shared class ", printed)
        Assert.DoesNotContain("shared {", printed)
        Assert.Contains("init {", printed)
        Assert.Contains("Total", printed)
        Assert.Contains("Scaled", printed)
    }

    /// Regression guard for the unchanged foldable path: a static constructor
    /// whose body is only simple `Field = value;` assignments still folds
    /// the initializers onto the field declarations and emits NO
    /// `init { }` block.
    @Fact
    func StaticConstructor_FoldableOnly_StillFoldsAndEmitsNoInitBlock() {
        let printed = TranslateUnit(`
namespace Demo
{
    public static class Constants
    {
        private static readonly int A;
        private static readonly int B;

        static Constants()
        {
            A = 1;
            B = 2;
        }
    }
}`)
        Assert.DoesNotContain("init {", printed)
        Assert.Contains("A", printed)
        Assert.Contains("B", printed)
    }

    shared {
        private func TranslateUnit(source string, roundTripOnlyReason string? = nil) string {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Snippet.cs", source)})
            Assert.True(
                project.BoundWithoutErrors,
                "Snippet should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
            )
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            let printed = GSharpPrinter.Print(unit)
            let result RoundTripResult? = if roundTripOnlyReason == nil {
                TranslationTestValidation.AssertBinds(printed)
            } else {
                TranslationTestValidation.ValidateRoundTripOnly(printed, roundTripOnlyReason)
            }
            Assert.True(
                result!!.Success,
                "Translated G# must round-trip. Errors:\n" + string.Join("\n", result!!.Errors) + `

Printed:
` + printed
            )
            return printed
        }
    }
}
