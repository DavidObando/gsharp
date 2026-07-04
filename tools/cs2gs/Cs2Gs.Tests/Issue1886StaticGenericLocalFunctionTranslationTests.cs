// <copyright file="Issue1886StaticGenericLocalFunctionTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Regression tests for issue #1886:
/// <list type="number">
/// <item><description>A <c>static</c> local function's call site was translated
/// as a class-member access (<c>Fixture.Square(6)</c>, GS0158) instead of a
/// direct call to its <c>let</c> binding (<c>Square(6)</c>) — Roslyn reports a
/// local function's <c>ContainingType</c> as the enclosing type even though it
/// is not a sibling type member.</description></item>
/// <item><description>A generic local function (<c>T First&lt;T&gt;(a, b)</c>)
/// could not be represented at all because G# function literals had no way to
/// declare type parameters (GS0113 on the body's <c>T</c>). cs2gs now emits the
/// new <c>let Name[T, ...] = func (...) ... { ... }</c> generic
/// function-literal syntax.</description></item>
/// </list>
/// </summary>
public class Issue1886StaticGenericLocalFunctionTranslationTests
{
    [Fact]
    public void StaticLocalFunction_CallSite_IsBareIdentifierCall_NotMemberAccess()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public class Fixture
    {
        public void M()
        {
            static int Square(int x) => x * x;
            System.Console.WriteLine(Square(6));
        }
    }
}");

        Assert.Contains("Square(6)", printed);
        Assert.DoesNotContain("Fixture.Square", printed);
    }

    [Fact]
    public void GenericLocalFunction_TranslatesToGenericFunctionLiteralLetBinding()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public class Fixture
    {
        public void M()
        {
            T First<T>(T a, T b) => a;
            System.Console.WriteLine(First(1, 2));
            System.Console.WriteLine(First(""x"", ""y""));
        }
    }
}");

        Assert.Contains("let First[T]", printed);
        Assert.Contains("First(1, 2)", printed);
        Assert.DoesNotContain("Fixture.First", printed);
    }

    [Fact]
    public void GenericLocalFunction_MultipleTypeParameters_TranslatesAllOfThem()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public class Fixture
    {
        public void M()
        {
            string Combine<T, U>(T a, U b) => a.ToString() + b.ToString();
            System.Console.WriteLine(Combine(1, ""y""));
        }
    }
}");

        Assert.Contains("let Combine[T, U]", printed);
    }

    private static string TranslateUnit(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("Snippet.cs", source) });
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: " +
                string.Join(System.Environment.NewLine, project.ErrorDiagnostics));

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
