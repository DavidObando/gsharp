// <copyright file="Issue6202MixedOverloadTypeArgumentsTests.gs" company="GSharp">
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

/// Issue #6202: mixed generic/non-generic overload sets report GS0148 against the generic
/// candidate(s) when no candidate has the supplied type-argument count, and keep valid
/// generic/non-generic selection intact.
open class Issue6202MixedOverloadTypeArgumentsTests {
    @Theory
    @InlineData(
        "let b = Mixed[int32, int32](x)",
        "GS0148 Generic function 'Mixed' requires 1 type arguments but was given 2."
    )
    @InlineData(
        "let b = c.Mixed[int32, int32](x)",
        "GS0148 Generic function 'Mixed' requires 1 type arguments but was given 2."
    )
    @InlineData(
        "let b = C.StaticMixed[int32, int32](x)",
        "GS0148 Generic function 'StaticMixed' requires 1 type arguments but was given 2."
    )
    @InlineData(
        "let b = c.ExtMixed[int32, int32](x)",
        "GS0148 Generic function 'ExtMixed' requires 1 type arguments but was given 2."
    )
    @InlineData(
        "let b = Multi[int32, int32, int32](x)",
        "GS0148 Generic function 'Multi' requires 1 type arguments but was given 3."
    )
    @InlineData(
        "let b = Multi[int32, int32, int32](x, x)",
        "GS0148 Generic function 'Multi' requires 2 type arguments but was given 3."
    )
    @InlineData(
        "let b = Mixed[Nope, int32](x)",
        "GS0113 Type 'Nope' doesn't exist.|GS0148 Generic function 'Mixed' requires 1 type arguments but was given 2."
    )
    func WrongTypeArgumentArityOnMixedOverloadSet_ReportsGenericArity(statement string, expected string) {
        let source = Source(statement)
        let (model, tree, compilation) = CreateModel(source)
        Assert.Equal(expected.Split('|'), DescribeErrors(compilation))
        let fBody = tree.Root.DescendantNodes().OfType[FunctionDeclarationSyntax]().Last()
        let args = fBody
            .DescendantNodes()
            .OfType[NameExpressionSyntax]()
            .Where((n NameExpressionSyntax) -> n.IdentifierToken.Text == "x")
            .ToArray()
        Assert.NotEmpty(args)
        for arg in args {
            let local = Assert.IsAssignableFrom[VariableSymbol](model.GetSymbolInfo(arg).Symbol)
            Assert.Equal("x", local.Name)
            Assert.Same(TypeSymbol.Int32, model.GetTypeInfo(arg).Type)
        }
    }

    @Theory
    @InlineData("let a = Mixed[int32]()", "GS0267")
    @InlineData("let a = c.Mixed[int32]()", "GS0144")
    @InlineData("let a = C.StaticMixed[int32]()", "GS0144")
    @InlineData("let a = c.ExtMixed[int32]()", "GS0144")
    @InlineData("let a = Mixed[Nope](x)", "GS0113")
    @InlineData("let a = c.Mixed[Nope](x)", "GS0113")
    @InlineData("let a = Constrained[int32](x)", "GS0152")
    func MatchingTypeArgumentArityWithOtherFailure_DoesNotReportGS0148(statement string, expectedId string) {
        let diagnostics = Compilation(SyntaxTree.Parse(SourceText.From(Source(statement), "issue6202.gs")))
            .GetDiagnostics()
            .Where((d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
            .ToArray()
        let single = Assert.Single(diagnostics)
        Assert.Equal(expectedId, single.Id)
    }

    @Fact
    func MixedOverloadSet_ValidGenericAndNonGenericCalls_ExecuteCorrectly() {
        let result = EmittedOracle.Evaluate(`package P

func Mixed(x int32) int32 -> x + 1
func Mixed[T](x T) T -> x

class C {
    func Mixed(x int32) int32 -> x + 10
    func Mixed[T](x T) T -> x
}

func Run() int32 {
    let c = C()
    return Mixed(5) + Mixed[int32](5) + c.Mixed(5) + c.Mixed[int32](5)
}
Run()
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(31, result.Value)
    }

    shared {
        private func Source(statement string) string -> Declarations +
            "\nfunc F(c C) {\n    let x = 1\n    " +
            statement +
            "\n}\n"

        private let Declarations string = `package P

interface IDisposableLike {
    func Close();
}

class C {
    func Mixed(x int32) int32 -> x
    func Mixed[T](x T) T -> x
    shared {
        func StaticMixed(x int32) int32 -> x
        func StaticMixed[T](x T) T -> x
    }
}

func (c C) ExtMixed(x int32) int32 -> x
func (c C) ExtMixed[T](x T) T -> x

func Mixed(x int32) int32 -> x
func Mixed[T](x T) T -> x

func Multi(x int32) int32 -> x
func Multi[T](x T) T -> x
func Multi[A, B](a A, b B) A -> a

func Constrained(x string) string -> x
func Constrained[T IDisposableLike](x T) T -> x
`

        private func CreateModel(source string)(SemanticModel, SyntaxTree, Compilation) {
            let tree = SyntaxTree.Parse(SourceText.From(source, "issue6202.gs"))
            let compilation = Compilation(tree)
            return (compilation.GetSemanticModel(tree), tree, compilation)
        }

        private func DescribeErrors(compilation Compilation)[]string -> compilation
            .GetDiagnostics()
            .Where((d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
            .Select((d Diagnostic) -> d.Id + " " + d.Message)
            .ToArray()
    }
}
