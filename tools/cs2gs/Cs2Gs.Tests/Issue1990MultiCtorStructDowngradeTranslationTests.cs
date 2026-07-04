// <copyright file="Issue1990MultiCtorStructDowngradeTranslationTests.cs" company="GSharp">
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
/// Issue #1990: a C# struct with multiple constructors that cannot ALL be
/// lifted to a single G# primary-constructor form used to fall through to
/// <c>TranslateConstructor</c> unconditionally, emitting an explicit
/// <c>init(...)</c> constructor body on the translated <c>struct</c> — but
/// the G# parser only accepts <c>init(...)</c> on a <c>class</c> header
/// (<c>DeclarationBinder.BindConstructors</c> early-returns for a non-class
/// type; ADR-0065 §5's primary+explicit coexistence is class-only), so the
/// translated output failed to parse. The same defect applied to a
/// single-constructor struct whose constructor could not collapse to a
/// primary constructor (e.g. it reads an instance member) and to a C#
/// record struct with a non-positional multi-ctor shape.
///
/// Fixed by downgrading such a struct/record-struct to a class/data class —
/// the same "no direct G# form" downgrade already used elsewhere for
/// unsupported record shapes — instead of emitting an invalid <c>init</c> on
/// a struct.
/// </summary>
public class Issue1990MultiCtorStructDowngradeTranslationTests
{
    [Fact]
    public void MultiCtorStruct_DowngradesToClass_InsteadOfInvalidStructInit()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public struct Point
    {
        public int X;
        public int Y;

        public Point(int x, int y)
        {
            X = x;
            Y = y;
        }

        public Point(int both)
        {
            X = both;
            Y = both;
        }
    }
}");

        Assert.Contains("class Point", printed);
        Assert.DoesNotContain("struct Point", printed);
        Assert.Contains("init(x int32, y int32)", printed);
        Assert.Contains("init(both int32)", printed);
    }

    [Fact]
    public void SingleUnliftableCtorStruct_DowngradesToClass()
    {
        // The ctor's RHS (`Buffer = new int[Capacity]`) reads the instance
        // member `Capacity`, so it cannot become a field initializer or a
        // primary-constructor parameter — the lift bails, and (pre-fix) the
        // explicit ctor was kept and emitted as an invalid struct `init`.
        string printed = TranslateUnit(@"
namespace Demo
{
    public struct Ring
    {
        public int Capacity;
        public int[] Buffer;

        public Ring(int capacity)
        {
            Capacity = capacity;
            Buffer = new int[Capacity];
        }
    }
}");

        Assert.Contains("class Ring", printed);
        Assert.DoesNotContain("struct Ring", printed);
        Assert.Contains("init(capacity int32)", printed);
    }

    [Fact]
    public void RecordStruct_MultiCtor_DowngradesToDataClass()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public readonly record struct Coord(int X, int Y)
    {
        public Coord(int both) : this(both, both) { }
    }
}");

        Assert.Contains("data class Coord", printed);
        Assert.DoesNotContain("data struct Coord", printed);
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
            "Translated G# must round-trip (parse with no errors). Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + printed);
        return printed;
    }
}
