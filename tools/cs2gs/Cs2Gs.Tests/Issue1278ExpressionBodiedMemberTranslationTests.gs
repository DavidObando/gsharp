// <copyright file="Issue1278ExpressionBodiedMemberTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import GSharp.Core.CodeAnalysis
import GSharp.Tests
import System
import Xunit

/// Issue #1278 (ADR-0131): a C# expression-bodied member (fat arrow
/// `=>`) translates to the idiomatic G# arrow form (`->`) across
/// the full set of member kinds that route through the same parser path:
/// methods/free functions, read-only properties, get/set accessors, indexers,
/// operators, and user-defined conversion operators. The C# fat arrow
/// `=>` is never emitted.
open class Issue1278ExpressionBodiedMemberTranslationTests {
    @Fact
    func ExpressionBodiedMethod_RendersAsArrow() {
        let g = Render(`
namespace N
{
    public class C
    {
        public int Square(int x) => x * x;
    }
}`)
        Assert.Contains("func Square(x int32) int32 -> x * x", g, StringComparison.Ordinal)
        Assert.DoesNotContain("=>", g, StringComparison.Ordinal)
    }

    @Fact
    func TupleReturningExpressionBodiedMethod_TranslatedGSharp_ParsesBindsAndCompiles() {
        let g = Render(`
namespace N
{
    public class C
    {
        private static (int, int) Pair() => (1, 2);
    }
}`)
        Assert.Contains("private func Pair() (int32, int32) -> (1, 2)", g, StringComparison.Ordinal)
        let result = EmittedOracle.Evaluate([]string{g}, EmittedOracleOptions{IsLibrary: true})
        Assert.DoesNotContain(result.Diagnostics, (diagnostic Diagnostic) -> diagnostic.IsError)
        Assert.Equal(0, result.ExitCode)
    }

    @Fact
    func ExpressionBodiedVoidMethod_RendersAsArrow() {
        let g = Render(`
namespace N
{
    using System;
    public class C
    {
        public void Shout(string s) => Console.WriteLine(s);
    }
}`)
        Assert.Contains("func Shout(s string) -> Console.WriteLine(s)", g, StringComparison.Ordinal)
        Assert.DoesNotContain("=>", g, StringComparison.Ordinal)
    }

    @Fact
    func ExpressionBodiedReadOnlyProperty_RendersAsArrow() {
        let g = Render(`
namespace N
{
    public class C
    {
        public string Tag => "x";
    }
}`)
        Assert.Contains("prop Tag string -> \"x\"", g, StringComparison.Ordinal)
        Assert.DoesNotContain("=>", g, StringComparison.Ordinal)
    }

    @Fact
    func ExpressionBodiedOperator_RendersAsArrow() {
        let g = Render(`
namespace N
{
    public struct V
    {
        public int X;
        public static V operator +(V a, V b) => new V { X = a.X + b.X };
    }
}`)
        // The receiver-clause operator form carries the arrow body.
        Assert.Contains("operator +", g, StringComparison.Ordinal)
        Assert.Contains("->", g, StringComparison.Ordinal)
        Assert.DoesNotContain("=>", g, StringComparison.Ordinal)
    }

    @Fact
    func ExpressionBodiedConversionOperator_RendersAsArrow() {
        let g = Render(`
namespace N
{
    public struct Celsius
    {
        public int Degrees;
        public static implicit operator int(Celsius c) => c.Degrees;
    }
}`)
        Assert.Contains("func operator implicit", g, StringComparison.Ordinal)
        Assert.Contains("-> c.Degrees", g, StringComparison.Ordinal)
        Assert.DoesNotContain("=>", g, StringComparison.Ordinal)
    }

    @Fact
    func ExpressionBodiedIndexer_RendersAsArrow() {
        let g = Render(`
namespace N
{
    public class C
    {
        private int[] data;
        public int this[int i] => this.data[i];
    }
}`)
        Assert.Contains("prop this[i int32] int32 -> this.data[i]", g, StringComparison.Ordinal)
        Assert.DoesNotContain("=>", g, StringComparison.Ordinal)
    }

    shared {
        private func Render(csharp string) string {
            let project = CSharpProjectLoader.LoadInMemory([](string, csharp string){("Source.cs", csharp)})
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
            return GSharpPrinter.Print(unit)
        }
    }
}
