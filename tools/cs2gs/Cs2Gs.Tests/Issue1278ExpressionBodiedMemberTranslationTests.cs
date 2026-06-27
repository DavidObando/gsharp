// <copyright file="Issue1278ExpressionBodiedMemberTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #1278 (ADR-0131): a C# expression-bodied member (fat arrow
/// <c>=&gt;</c>) translates to the idiomatic G# arrow form (<c>-&gt;</c>) across
/// the full set of member kinds that route through the same parser path:
/// methods/free functions, read-only properties, get/set accessors, indexers,
/// operators, and user-defined conversion operators. The C# fat arrow
/// <c>=&gt;</c> is never emitted.
/// </summary>
public class Issue1278ExpressionBodiedMemberTranslationTests
{
    [Fact]
    public void ExpressionBodiedMethod_RendersAsArrow()
    {
        string g = Render(@"
namespace N
{
    public class C
    {
        public int Square(int x) => x * x;
    }
}");

        Assert.Contains("func Square(x int32) int32 -> x * x", g, StringComparison.Ordinal);
        Assert.DoesNotContain("=>", g, StringComparison.Ordinal);
    }

    [Fact]
    public void ExpressionBodiedVoidMethod_RendersAsArrow()
    {
        string g = Render(@"
namespace N
{
    using System;
    public class C
    {
        public void Shout(string s) => Console.WriteLine(s);
    }
}");

        Assert.Contains("func Shout(s string) -> Console.WriteLine(s)", g, StringComparison.Ordinal);
        Assert.DoesNotContain("=>", g, StringComparison.Ordinal);
    }

    [Fact]
    public void ExpressionBodiedReadOnlyProperty_RendersAsArrow()
    {
        string g = Render(@"
namespace N
{
    public class C
    {
        public string Tag => ""x"";
    }
}");

        Assert.Contains("prop Tag string -> \"x\"", g, StringComparison.Ordinal);
        Assert.DoesNotContain("=>", g, StringComparison.Ordinal);
    }

    [Fact]
    public void ExpressionBodiedOperator_RendersAsArrow()
    {
        string g = Render(@"
namespace N
{
    public struct V
    {
        public int X;
        public static V operator +(V a, V b) => new V { X = a.X + b.X };
    }
}");

        // The receiver-clause operator form carries the arrow body.
        Assert.Contains("operator +", g, StringComparison.Ordinal);
        Assert.Contains("->", g, StringComparison.Ordinal);
        Assert.DoesNotContain("=>", g, StringComparison.Ordinal);
    }

    [Fact]
    public void ExpressionBodiedConversionOperator_RendersAsArrow()
    {
        string g = Render(@"
namespace N
{
    public struct Celsius
    {
        public int Degrees;
        public static implicit operator int(Celsius c) => c.Degrees;
    }
}");

        Assert.Contains("func operator implicit", g, StringComparison.Ordinal);
        Assert.Contains("-> c.Degrees", g, StringComparison.Ordinal);
        Assert.DoesNotContain("=>", g, StringComparison.Ordinal);
    }

    [Fact]
    public void ExpressionBodiedIndexer_RendersAsArrow()
    {
        string g = Render(@"
namespace N
{
    public class C
    {
        private int[] data;
        public int this[int i] => this.data[i];
    }
}");

        Assert.Contains("prop this[i int32] int32 -> this.data[i]", g, StringComparison.Ordinal);
        Assert.DoesNotContain("=>", g, StringComparison.Ordinal);
    }

    private static string Render(string csharp)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Source.cs", csharp) });

        Assert.True(
            project.BoundWithoutErrors,
            "inline source should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);
        return GSharpPrinter.Print(unit);
    }
}
