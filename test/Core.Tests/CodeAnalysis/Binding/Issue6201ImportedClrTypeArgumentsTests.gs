// <copyright file="Issue6201ImportedClrTypeArgumentsTests.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import System
import System.Linq
import Xunit

/// Issue #6201: type arguments on a non-generic (or wrong-arity generic) imported CLR method or
/// constructor report GS0148 instead of GS0159, keep call arguments in SemanticModel, and preserve
/// GS0159 when no method of that name exists.
open class Issue6201ImportedClrTypeArgumentsTests {
    @Theory
    @InlineData("Console.WriteLine[int32](x)", "GS0148", "requires 0 type arguments but was given 1")
    @InlineData("Console.WriteLine[int32, string](x)", "GS0148", "requires 0 type arguments but was given 2")
    @InlineData("let s = \"a\".Trim[int32]()", "GS0148", "requires 0 type arguments but was given 1")
    @InlineData("xs.Add[int32](x)", "GS0148", "requires 0 type arguments but was given 1")
    @InlineData("let s = d.ToString[int32]()", "GS0148", "requires 0 type arguments but was given 1")
    @InlineData("d.Dispose[int32]()", "GS0148", "requires 0 type arguments but was given 1")
    @InlineData("let s = user.ToString[int32]()", "GS0148", "requires 0 type arguments but was given 1")
    @InlineData("let b = e.HasFlag[int32](e)", "GS0148", "requires 0 type arguments but was given 1")
    @InlineData("let ys = xs.ToList[int32, string]()", "GS0148", "requires 1 type arguments but was given 2")
    @InlineData("let span = \"a\".AsSpan[int32]()", "GS0148", "requires 0 type arguments but was given 1")
    @InlineData("let sb = StringBuilder[int32](x)", "GS0148", "requires 0 type arguments but was given 1")
    @InlineData("let sb = System.Text.StringBuilder[int32](x)", "GS0148", "requires 0 type arguments but was given 1")
    @InlineData("let ys = List[int32, string](x)", "GS0148", "requires 1 type arguments but was given 2")
    @InlineData(
        "let ys = System.Collections.Generic.List[int32, string](x)",
        "GS0148",
        "requires 1 type arguments but was given 2"
    )
    @InlineData("Console.MissingMethod[int32](x)", "GS0159", "Cannot find function MissingMethod.")
    @InlineData("let s = \"a\".MissingMethod[int32](x)", "GS0159", "Cannot find function MissingMethod.")
    func ImportedClrCallsWithWrongTypeArguments_ReportExpectedDiagnosticAndKeepArguments(
        statement string,
        expectedId string,
        expectedFragment string
    ) {
        let source = Template(statement)
        let (model, tree, compilation) = CreateModel(source)
        let error = Assert.Single(
            compilation.GetDiagnostics().Where((d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
        )
        Assert.Equal(expectedId, error.Id)
        Assert.Contains(expectedFragment, error.Message, StringComparison.Ordinal)
        for arg in tree
            .Root
            .DescendantNodes()
            .OfType[NameExpressionSyntax]()
            .Where((n NameExpressionSyntax) -> n.IdentifierToken.Text == "x") {
            Assert.Equal("x", Assert.IsAssignableFrom[VariableSymbol](model.GetSymbolInfo(arg).Symbol).Name)
            Assert.Same(TypeSymbol.Int32, model.GetTypeInfo(arg).Type)
        }
    }

    @Fact
    func TypeParameterConstrainedImportedClrMethodsWithTypeArguments_ReportGS0148() {
        let source = `package P
import System

func TpToString[T](v T) string -> v.ToString[int32]()
func TpDispose[T IDisposable](v T) {
    v.Dispose[int32]()
}
`
        let compilation = Compilation(SyntaxTree.Parse(SourceText.From(source, "issue6201_tp.gs")))
        let errors = compilation
            .GetDiagnostics()
            .Where((d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
            .ToArray()
        Assert.Equal(2, errors.Length)
        Assert.All(
            errors,
            (d Diagnostic) -> {
                Assert.Equal("GS0148", d.Id)
                Assert.Contains("requires 0 type arguments but was given 1", d.Message, StringComparison.Ordinal)
            }
        )
    }

    @Fact
    func UsingStaticNonGenericClrMethodWithTypeArguments_ReportsGS0148() {
        let source = `package P
import System.Console

func F(x int32) {
    WriteLine[int32](x)
}
`
        let (model, tree, compilation) = CreateModel(source)
        let error = Assert.Single(
            compilation.GetDiagnostics().Where((d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
        )
        Assert.Equal("GS0148", error.Id)
        Assert.Contains("requires 0 type arguments but was given 1", error.Message, StringComparison.Ordinal)
        let arg = Assert.Single(
            tree
                .Root
                .DescendantNodes()
                .OfType[NameExpressionSyntax]()
                .Where((n NameExpressionSyntax) -> n.IdentifierToken.Text == "x")
        )
        Assert.Equal("x", Assert.IsAssignableFrom[VariableSymbol](model.GetSymbolInfo(arg).Symbol).Name)
        Assert.Same(TypeSymbol.Int32, model.GetTypeInfo(arg).Type)
    }

    @Fact
    func GenericExtensionOverNonGenericInstanceMethod_StillResolvesAndExecutes() {
        // String.Contains is non-generic, while Enumerable.Contains[T] is generic: `"a".Contains[char]('a')`
        // must still resolve through the generic extension method.
        let result = EmittedOracle.Evaluate(`package P
import System
import System.Linq

func Run() bool {
    return "abc".Contains[char]('b')
}
Run()
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(true, result.Value)
    }

    shared {
        private func Template(statement string) string -> `package P
import System
import System.Collections.Generic
import System.Linq
import System.Text

class User {
    var V int32 = 1
}

enum E {
    A = 1
}

func F(xs List[int32], d IDisposable, user User, e E) {
    let x = 1
    ` + statement + `
}
`

        private func CreateModel(source string)(SemanticModel, SyntaxTree, Compilation) {
            let tree = SyntaxTree.Parse(SourceText.From(source, "issue6201.gs"))
            let compilation = Compilation(tree)
            return (compilation.GetSemanticModel(tree), tree, compilation)
        }
    }
}
