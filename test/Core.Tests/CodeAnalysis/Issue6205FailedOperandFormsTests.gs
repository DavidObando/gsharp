// <copyright file="Issue6205FailedOperandFormsTests.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Linq
import Xunit

/// Issue #6205: failed if-expressions, switch-expressions, `&x`/`*x` unary expressions, and
/// relational patterns retain their bound operands for the semantic model without changing diagnostics.
open class Issue6205FailedOperandFormsTests {
    @Theory
    @InlineData("let k = if Use(x) == 1 { Use(x) } else { Use(x, x) }")
    @InlineData("let k = if Use(x) == 1 { Use(x, x) } else { Use(x) }")
    @InlineData("let k = if Use(x, x) == 1 { Use(x) } else { Use(x) }")
    @InlineData("let k = if Use(x) { Use(x) } else { Use(x) }")
    @InlineData("let k = if Use(x) == 1 { Use(x) } else { c }")
    @InlineData("let k = if Use(x) == 1 { Use(x) } else if Use(x) == 2 { Use(x, x) } else { Use(x) }")
    @InlineData("let k = if Use(x) == 1 { let a = Use(x); Use(x, x) } else { Use(x) }")
    @InlineData("let k = if Use(x) == 1 { if flag { Use(x) }; Use(x, x) } else { Use(x) }")
    @InlineData("let k = if var y = Use(x); y == 1 { Use(x) } else { Use(x, x) }")
    @InlineData("let k = if let y = Opt(x) && Use(x) == 1 { Use(x) } else { Use(x, x) }")
    func IfExpressionFailures_RetainBoundOperands(statement string) {
        AssertOperandsAnswer(statement)
    }

    @Theory
    @InlineData("let k = switch x { case 1: Use(x) default: Use(x, x) }")
    @InlineData("let k = switch x { case 1: Use(x, x) default: Use(x) }")
    @InlineData("let k = switch x { case 1: Use(x) default: c }")
    @InlineData("let k = switch Use(x) + Use(x, x) { case 1: 1 default: 0 }")
    @InlineData("let k = switch x { case > Use(x) when Use(x) == 1: Use(x) default: Use(x, x) }")
    @InlineData("let k = switch c { case Use(x): Use(x) default: Use(x) }")
    @InlineData("let k = switch Use(x) { }")
    func SwitchExpressionFailures_RetainBoundOperands(statement string) {
        AssertOperandsAnswer(statement)
    }

    @Theory
    @InlineData("let k = &Use(x)")
    @InlineData("let k = &Use(x, x)")
    @InlineData("let k = &x")
    @InlineData("let k = &(flag ? Use(x) : x)")
    @InlineData("let k = &(flag ? Use(x, x) : x)")
    @InlineData("let k = *Use(x)")
    @InlineData("let k = *Use(x, x)")
    func AddressOfAndDereferenceFailures_RetainBoundOperands(statement string) {
        AssertOperandsAnswer(statement)
    }

    @Fact
    func AddressOfMethodGroup_RetainsMethodSymbol() {
        let (model, tree, compilation) = CreateModel("let k = &Use")
        Assert.Contains(compilation.GetDiagnostics(), (d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
        let useName = Assert.Single(Names(tree, "Use"))
        Assert.Equal("Use", Assert.IsType[FunctionSymbol](model.GetSymbolInfo(useName).Symbol).Name)
    }

    @Theory
    @InlineData("let k = c is > Use(x)")
    @InlineData("let k = x is > Use(x, x)")
    @InlineData("let k = x is == Use(x) + Use(x, x)")
    @InlineData("let k = c is == Use(x)")
    @InlineData("let k = x is (> Use(x) and < Use(x, x))")
    @InlineData("let k = c is (not > Use(x))")
    func RelationalPatternFailures_RetainBoundOperands(statement string) {
        AssertOperandsAnswer(statement)
    }

    @Fact
    func RelationalPatternUndefinedOperator_RetainsBothOperands() {
        let (model, tree, compilation) = CreateModel("let k = c is > c")
        Assert.Contains(compilation.GetDiagnostics(), (d Diagnostic) -> d.Id == "GS0174")
        let cs = Names(tree, "c")
        Assert.Equal(2, cs.Length)
        for c in cs {
            Assert.Equal("c", Assert.IsType[ParameterSymbol](model.GetSymbolInfo(c).Symbol).Name)
            Assert.Equal("C", model.GetTypeInfo(c).Type?.Name)
        }
    }

    @Fact
    func BlockPrefixUnusedLocalDeclaration_RetainsDeclaredSymbol() {
        let (model, tree, compilation) = CreateModel("let k = if flag { let unused = 1; Use(x, x) } else { Use(x) }")
        Assert.Contains(compilation.GetDiagnostics(), (d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
        let declaration = tree
            .Root
            .DescendantNodes()
            .OfType[VariableDeclarationSyntax]()
            .Single((v VariableDeclarationSyntax) -> v.Identifier.Text == "unused")
        let local = Assert.IsAssignableFrom[LocalVariableSymbol](model.GetDeclaredSymbol(declaration))
        Assert.Equal("unused", local.Name)
        Assert.Same(TypeSymbol.Int32, local.Type)
    }

    @Fact
    func FailedIfLetUnusedHeaderBinding_RetainsDeclaredSymbol() {
        let (model, tree, compilation) = CreateModel("let k = if let unused = Opt(x) { Use(x, x) } else { Use(x) }")
        Assert.Contains(compilation.GetDiagnostics(), (d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
        let clause = tree.Root.DescendantNodes().OfType[IfLetBindingClauseSyntax]().Single()
        let local = Assert.IsAssignableFrom[LocalVariableSymbol](model.GetDeclaredSymbol(clause.Identifier))
        Assert.Equal("unused", local.Name)
        Assert.Equal("int32?", local.Type.ToString())
    }

    @Fact
    func UnsafeVoidPointerDereference_RetainsOperand() {
        let source = `package P

unsafe func F(vp *void) {
    let k = *vp
}
`
        let tree = SyntaxTree.Parse(SourceText.From(source, "issue6205_voidptr.gs"))
        let compilation = Compilation(tree)
        Assert.Contains(compilation.GetDiagnostics(), (d Diagnostic) -> d.Id == "GS0403")
        let model = compilation.GetSemanticModel(tree)
        let vp = Assert.Single(Names(tree, "vp"))
        Assert.Equal("vp", Assert.IsType[ParameterSymbol](model.GetSymbolInfo(vp).Symbol).Name)
        Assert.Equal("*void", model.GetTypeInfo(vp).Type?.ToString())
    }

    @Fact
    func GenericSwitchValidateSourceNullableFailure_RetainsPatternGuardAndArms() {
        let source = `package P

func Use(v int32) int32 -> v

func G[T](t T, flag bool) {
    let x = 1
    let k = switch flag {
        case true when Use(x) == 1: t
        default: nil
    }
}
`
        let tree = SyntaxTree.Parse(SourceText.From(source, "issue6205_genericswitch.gs"))
        let compilation = Compilation(tree)
        Assert.Contains(compilation.GetDiagnostics(), (d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
        let model = compilation.GetSemanticModel(tree)
        let x = Assert.Single(Names(tree, "x"))
        Assert.Equal("x", Assert.IsAssignableFrom[VariableSymbol](model.GetSymbolInfo(x).Symbol).Name)
        Assert.Same(TypeSymbol.Int32, model.GetTypeInfo(x).Type)
        let t = Assert.Single(Names(tree, "t"))
        Assert.Equal("t", Assert.IsType[ParameterSymbol](model.GetSymbolInfo(t).Symbol).Name)
    }

    @Theory
    @InlineData(
        "let k = if Use(x) == 1 { Use(x) } else { Use(x, x) }",
        "GS0144 , x: Function 'Use' requires 1 arguments but was given 2."
    )
    @InlineData(
        "let k = if Use(x) == 1 { Use(x) } else { c }",
        "GS0263 if Use(x) == 1 { Use(x) } else { c }: Conditional expression branches have no common result type — the true branch is 'int32' and the false branch is 'C'. Add an explicit conversion to align the two arms."
    )
    @InlineData(
        "let k = switch x { case 1: Use(x) default: Use(x, x) }",
        "GS0144 , x: Function 'Use' requires 1 arguments but was given 2."
    )
    @InlineData(
        "let k = switch x { case 1: Use(x) default: c }",
        "GS0179 c: All switch-expression arms must produce the same type; expected 'int32' but arm produces 'C'."
    )
    @InlineData("let k = &x", "GS9005 &: Cannot take address of constant 'x'.")
    @InlineData("let k = *Use(x)", "GS0128 *: Unary operator '*' is not defined for type 'int32'.")
    @InlineData(
        "let k = c is > Use(x)",
        "GS0155 Use(x): Cannot convert type 'int32' to 'C'.|GS0174 >: Relational pattern operator '>' is not defined for type 'C'."
    )
    @InlineData("let k = c is == Use(x)", "GS0129 ==: Binary operator '==' is not defined for types 'C' and 'int32'.")
    func Diagnostics_AreUnchanged(statement string, expected string) {
        let source = Source(statement)
        let tree = SyntaxTree.Parse(SourceText.From(source, "issue6205_diag.gs"))
        let compilation = Compilation(tree)
        let before = Render(source, compilation)
        let model = compilation.GetSemanticModel(tree)
        let references = Names(tree, "x").Concat(Names(tree, "c")).ToArray()
        Assert.NotEmpty(references)
        for reference in references {
            Assert.NotNull(model.GetSymbolInfo(reference).Symbol)
        }
        Assert.Equal(expected.Split('|'), before)
        Assert.Equal(before, Render(source, compilation))
    }

    shared {
        private func AssertOperandsAnswer(statement string) {
            let (model, tree, compilation) = CreateModel(statement)
            Assert.Contains(compilation.GetDiagnostics(), (d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
            let xs = Names(tree, "x")
            Assert.NotEmpty(xs)
            for reference in xs {
                let local = Assert.IsAssignableFrom[VariableSymbol](model.GetSymbolInfo(reference).Symbol)
                Assert.Equal("x", local.Name)
                Assert.Same(TypeSymbol.Int32, model.GetTypeInfo(reference).Type)
            }
            if statement.Contains("Use(") {
                let validCall = tree
                    .Root
                    .DescendantNodes()
                    .OfType[CallExpressionSyntax]()
                    .FirstOrDefault(
                    (call CallExpressionSyntax) -> call.Identifier.Text == "Use" && call.Arguments.Count == 1
                )
                if validCall != nil {
                    Assert.Equal("Use", Assert.IsType[FunctionSymbol](model.GetSymbolInfo(validCall).Symbol).Name)
                    Assert.Same(TypeSymbol.Int32, model.GetTypeInfo(validCall).Type)
                }
            }
            if statement.Contains("c ") || statement.EndsWith(" c", StringComparison.Ordinal) || statement.Contains(
                " c}"
            ) {
                for c in Names(tree, "c") {
                    Assert.Equal("c", Assert.IsType[ParameterSymbol](model.GetSymbolInfo(c).Symbol).Name)
                    Assert.Equal("C", model.GetTypeInfo(c).Type?.Name)
                }
            }
            if statement.Contains("flag") {
                let flag = Assert.Single(Names(tree, "flag"))
                Assert.Equal("flag", Assert.IsType[ParameterSymbol](model.GetSymbolInfo(flag).Symbol).Name)
                Assert.Same(TypeSymbol.Bool, model.GetTypeInfo(flag).Type)
            }
        }

        private func Source(statement string) string -> `package P

class C { }

func Use(v int32) int32 -> v

func Opt(v int32) int32? -> v

func F(c C, flag bool) {
    let x = 1
    ` + statement + "\n}\n"

        private func CreateModel(statement string)(SemanticModel, SyntaxTree, Compilation) {
            let tree = SyntaxTree.Parse(SourceText.From(Source(statement), "issue6205.gs"))
            let compilation = Compilation(tree)
            return (compilation.GetSemanticModel(tree), tree, compilation)
        }

        private func Render(source string, compilation Compilation)[]string -> compilation
            .GetDiagnostics()
            .Where((d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
            .Select(
            (d Diagnostic) -> d.Id + " " + source.Substring(d.Location.Span.Start, d.Location.Span.Length) +
                ": " +
                d.Message
        )
            .ToArray()

        private func Names(tree SyntaxTree, name string)[]NameExpressionSyntax -> tree
            .Root
            .DescendantNodes()
            .OfType[NameExpressionSyntax]()
            .Where((n NameExpressionSyntax) -> n.IdentifierToken.Text == name)
            .ToArray()
    }
}
