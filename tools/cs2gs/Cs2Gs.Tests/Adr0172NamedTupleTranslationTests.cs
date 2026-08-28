// <copyright file="Adr0172NamedTupleTranslationTests.cs" company="GSharp">
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
/// ADR-0172 Phase C: cs2gs preserves C# tuple element names end-to-end —
/// types print name-first (<c>(Line int32, Column int32)</c>), literal labels
/// survive (<c>(Line: 1, Column: 2)</c>), and a named element ACCESS stays
/// by-name instead of lowering to <c>.ItemN</c> (amending ADR-0115 §B.4).
/// Every translated snippet must re-bind through the real G# compiler, which
/// exercises gsc's own ADR-0172 front end. Witness of discrimination: before
/// Phase C the printed output contained <c>(int32, int32)</c> and
/// <c>.Item1</c>/<c>.Item2</c> for every case below.
/// </summary>
public class Adr0172NamedTupleTranslationTests
{
    [Fact]
    public void NamedTupleType_PrintsNameFirst()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public sealed class C
    {
        public (int Line, int Column) Find() => (3, 5);
    }
}");

        Assert.Contains("(Line int32, Column int32)", printed);
        Assert.DoesNotContain("Item1", printed);
    }

    [Fact]
    public void NamedElementAccess_StaysByName()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public sealed class C
    {
        public int Total()
        {
            (string Name, int Price, int Quantity) item = (""x"", 2, 3);
            return item.Price * item.Quantity;
        }
    }
}");

        Assert.Contains("item.Price * item.Quantity", printed);
        Assert.DoesNotContain("Item2", printed);
        Assert.DoesNotContain("Item3", printed);
    }

    [Fact]
    public void PositionalAccessOnNamedTuple_StaysPositional()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public sealed class C
    {
        public int First()
        {
            (int Line, int Column) pos = (3, 5);
            return pos.Item1;
        }
    }
}");

        Assert.Contains("pos.Item1", printed);
    }

    [Fact]
    public void LiteralLabels_ArePreserved()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public sealed class C
    {
        public (int Count, string Name) Make() => (Count: 3, Name: ""three"");
    }
}");

        Assert.Contains("(Count: 3, Name: \"three\")", printed);
    }

    [Fact]
    public void UnnamedTuples_Unchanged()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public sealed class C
    {
        public (int, string) Make() => (1, ""x"");
        public int First() => Make().Item1;
    }
}");

        Assert.Contains("(int32, string)", printed);
        Assert.Contains(".Item1", printed);
    }

    [Fact]
    public void NamedTupleInsideGeneric_PrintsNames()
    {
        string printed = TranslateUnit(@"
using System.Collections.Generic;

namespace Demo
{
    public sealed class C
    {
        public List<(int Line, int Column)> All() => new List<(int Line, int Column)>();
        public int FirstLine() => All()[0].Line;
    }
}");

        Assert.Contains("List[(Line int32, Column int32)]", printed);
        Assert.Contains(".Line", printed);
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
        RoundTripResult result = TranslationTestValidation.AssertBinds(printed);
        Assert.True(
            result.Success,
            "Translated G# must round-trip. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + printed);
        return printed;
    }
}
