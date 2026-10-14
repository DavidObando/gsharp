// <copyright file="StringConcatenationTranslationTests.cs" company="GSharp">
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

/// Translation tests for C# string concatenation (issue #914). C# `a + b`
/// implicitly converts non-`string` operands through its predefined
/// concatenation operators. G# handles `char` natively; remaining operand
/// types are rewritten to explicit `ToString()` calls.
open class StringConcatenationTranslationTests {
    @Fact
    func UserObjectConcatenatedWithString_GetsToStringCall() {
        let printed = TranslateUnit(`
namespace Demo
{
    public class Indent { public override string ToString() => "i"; }
    public class C
    {
        public string F(Indent ind, string s) => ind + s;
    }
}`)
        Assert.Contains("ind.ToString() + s", printed)
    }

    @Fact
    func StringConcatenatedWithUserObject_GetsToStringCall() {
        let printed = TranslateUnit(`
namespace Demo
{
    public class Indent { public override string ToString() => "i"; }
    public class C
    {
        public string F(Indent ind, string s) => s + ind;
    }
}`)
        Assert.Contains("s + ind.ToString()", printed)
    }

    @Fact
    func PrimitiveConcatenatedWithString_GetsToStringCall() {
        let printed = TranslateUnit(`
namespace Demo
{
    public class C
    {
        public string F(int n) => "n=" + n;
    }
}`)
        Assert.Contains("\"n=\" + n.ToString()", printed)
    }

    @Fact
    func CharConcatenation_UsesNativeGSharpOperator() {
        let printed = TranslateUnit(`
namespace Demo
{
    public class C
    {
        public string F(char ch)
        {
            string value = "root";
            value += ch;
            return ch + value;
        }
    }
}`)
        Assert.Contains("value += ch", printed)
        Assert.Contains("return ch + value", printed)
        Assert.DoesNotContain("ch.ToString()", printed)
    }

    @Fact
    func ChainedConcatenation_ConvertsOnlyNonStringOperands() {
        let printed = TranslateUnit(`
namespace Demo
{
    public class Indent { public override string ToString() => "i"; }
    public class C
    {
        public string F(Indent ind, string m, string d) => ind + m + d;
    }
}`)
        // Left-associative: only the leading non-string `ind` needs conversion;
        // the remaining `+ m + d` are string-to-string.
        Assert.Contains("ind.ToString() + m + d", printed)
    }

    @Fact
    func NilableReferenceOperand_GetsNullConditionalToStringCall() {
        // Issue #4287: C# concatenates a null operand as the empty string, so a
        // `T?` operand converts through `?.ToString()`. `o.ToString()` was an
        // instance call on a stated `T?` receiver, which gsc now rejects
        // (GS0159), and which threw on nil where C# did not. `TranslateUnit`
        // binds the output, so this also witnesses that it compiles.
        let printed = TranslateUnit(`
#nullable enable
namespace Demo
{
    public class Indent { public override string ToString() => "i"; }
    public class C
    {
        public string F(object? o, Indent? ind, Indent plain)
            => "o=" + o + ind + plain;
    }
}`)
        Assert.Contains("\"o=\" + o?.ToString() + ind?.ToString() + plain.ToString()", printed)
    }

    @Fact
    func NilableReferenceOperand_InAnExpressionTree_UsesStringConcat() {
        // Issue #4287 (review): `?.` is not representable in an expression
        // tree (GS0473), so there the nilable operand converts through the
        // static `string.Concat(object?)`, which is null-as-empty like C# and
        // evaluates the operand once. `TranslateUnit` binds the output.
        let printed = TranslateUnit(`
#nullable enable
using System;
using System.Linq.Expressions;
namespace Demo
{
    public class C
    {
        public Expression<Func<object?, string>> F() => o => "p:" + o;
    }
}`)
        Assert.Contains("Concat(o)", printed)
        Assert.DoesNotContain("o?.ToString()", printed)
    }

    @Fact
    func PureStringConcatenation_IsUnchanged() {
        let printed = TranslateUnit(`
namespace Demo
{
    public class C
    {
        public string F(string a, string b) => a + b;
    }
}`)
        Assert.Contains("a + b", printed)
        Assert.DoesNotContain("ToString", printed)
    }

    @Fact
    func NumericAddition_IsNotTreatedAsConcatenation() {
        let printed = TranslateUnit(`
namespace Demo
{
    public class C
    {
        public int F(int a, int b) => a + b;
    }
}`)
        Assert.Contains("a + b", printed)
        Assert.DoesNotContain("ToString", printed)
    }

    shared {
        private func TranslateUnit(source string) string {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Snippet.cs", source)})
            Assert.True(
                project.BoundWithoutErrors,
                "Snippet should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
            )
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            let printed = GSharpPrinter.Print(unit)
            let result RoundTripResult? = TranslationTestValidation.AssertBinds(printed)
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
