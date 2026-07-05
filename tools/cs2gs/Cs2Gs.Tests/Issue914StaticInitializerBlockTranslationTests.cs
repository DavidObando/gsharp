// <copyright file="Issue914StaticInitializerBlockTranslationTests.cs" company="GSharp">
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
/// Issue #914 (cs2gs): a non-foldable C# <c>static</c> constructor now maps to
/// the G# <c>init { ... }</c> static-initializer block inside the type's
/// <c>shared { }</c> block (ADR-0140, ADR-0115 §B.11). Previously such a
/// constructor was reported as unsupported and dropped. A foldable static
/// constructor (only simple <c>Field = value;</c> assignments) must still fold
/// its initializers onto the field declarations and emit NO <c>init { }</c>.
/// </summary>
public class Issue914StaticInitializerBlockTranslationTests
{
    /// <summary>
    /// The canonical CRC-table shape: a static constructor whose body is a
    /// nested loop populating a static array. It maps to a G# <c>init { }</c>
    /// static-initializer block inside the <c>shared { }</c> block, and must
    /// round-trip.
    /// </summary>
    [Fact]
    public void StaticConstructor_CrcTableLoop_MapsToStaticInitializerBlock()
    {
        string printed = TranslateUnit(@"
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
}");

        Assert.Contains("shared {", printed);
        Assert.Contains("init {", printed);
        Assert.Contains("Table[i]", printed);
        // The field initializer stays on the field declaration; it is not
        // re-emitted inside the init block.
        Assert.DoesNotContain("Table = uint", printed);
    }

    /// <summary>
    /// A static constructor initializing multiple interdependent static fields
    /// with non-trivial logic (loops, accumulation) maps to a single
    /// <c>init { }</c> block preserving statement order, and round-trips.
    /// </summary>
    [Fact]
    public void StaticConstructor_InterdependentFields_MapsToStaticInitializerBlock()
    {
        string printed = TranslateUnit(@"
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
}");

        Assert.Contains("shared {", printed);
        Assert.Contains("init {", printed);
        Assert.Contains("Total", printed);
        Assert.Contains("Scaled", printed);
    }

    /// <summary>
    /// Regression guard for the unchanged foldable path: a static constructor
    /// whose body is only simple <c>Field = value;</c> assignments still folds
    /// the initializers onto the field declarations and emits NO
    /// <c>init { }</c> block.
    /// </summary>
    [Fact]
    public void StaticConstructor_FoldableOnly_StillFoldsAndEmitsNoInitBlock()
    {
        string printed = TranslateUnit(@"
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
}");

        Assert.DoesNotContain("init {", printed);
        Assert.Contains("A", printed);
        Assert.Contains("B", printed);
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
