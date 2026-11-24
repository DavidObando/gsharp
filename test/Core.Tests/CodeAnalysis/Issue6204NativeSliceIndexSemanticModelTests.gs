// <copyright file="Issue6204NativeSliceIndexSemanticModelTests.gs" company="GSharp">
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

/// Issue #6204: the index of a native-slice element access answers its own symbol and type in
/// the semantic model, including in failed operator, compound-assignment, and write expressions.
open class Issue6204NativeSliceIndexSemanticModelTests {
    @Theory
    @InlineData("let k = s[x]")
    @InlineData("let k = s[x] + c")
    @InlineData("s[x] += c")
    @InlineData("s[x] = c")
    @InlineData("let k = ss[x]")
    @InlineData("let k = ss[x] + c")
    @InlineData("ss[x] += c")
    @InlineData("ss[x] = c")
    @InlineData("let k = rs[x] + c")
    @InlineData("let k = s[^x] + c")
    @InlineData("let k = h.Items[x] + c")
    @InlineData("h.Items[x] += c")
    @InlineData("h.Items[x] = c")
    @InlineData("let k = sc[x]++")
    @InlineData("arr[x] = c")
    @InlineData("m[x] = c")
    func IndexVariable_AnswersLocalAndInt32(statement string) {
        let (model, tree, _) = CreateModel(statement)
        let x = Assert.Single(Names(tree, "x"))
        let local = Assert.IsAssignableFrom[LocalVariableSymbol](model.GetSymbolInfo(x).Symbol)
        Assert.Equal("x", local.Name)
        Assert.Same(TypeSymbol.Int32, model.GetTypeInfo(x).Type)
        Assert.Same(local, model.GetSymbolInfo(x.IdentifierToken).Symbol)
        if statement.Contains("c") && !statement.Contains("sc") {
            let c = Assert.Single(Names(tree, "c"))
            Assert.Equal("c", Assert.IsType[ParameterSymbol](model.GetSymbolInfo(c).Symbol).Name)
            Assert.Equal("C", model.GetTypeInfo(c).Type?.Name)
        }
    }

    @Fact
    func Issue6204Repro_BothIndexUsesAndOtherOperandsAnswer() {
        let source = `package P

class C { }

func F(c C) {
    let x = 0
    let s = slice[int32]{1, 2}
    let k = s[x] + c
    s[x] += c
}
`
        let tree = SyntaxTree.Parse(SourceText.From(source, "issue6204_repro.gs"))
        let compilation = Compilation(tree)
        let model = compilation.GetSemanticModel(tree)
        let errors = compilation
            .GetDiagnostics()
            .Where((d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
            .ToArray()
        Assert.Equal(2, errors.Length)

        let xs = Names(tree, "x")
        Assert.Equal(2, xs.Length)
        for reference in xs {
            let local = Assert.IsAssignableFrom[LocalVariableSymbol](model.GetSymbolInfo(reference).Symbol)
            Assert.Equal("x", local.Name)
            Assert.Same(TypeSymbol.Int32, model.GetTypeInfo(reference).Type)
            Assert.Same(local, model.GetSymbolInfo(reference.IdentifierToken).Symbol)
        }

        let ss = Names(tree, "s")
        Assert.Equal(2, ss.Length)
        for reference in ss {
            Assert.Equal("s", Assert.IsAssignableFrom[LocalVariableSymbol](model.GetSymbolInfo(reference).Symbol).Name)
        }

        let cs = Names(tree, "c")
        Assert.Equal(2, cs.Length)
        for reference in cs {
            Assert.Equal("c", Assert.IsType[ParameterSymbol](model.GetSymbolInfo(reference).Symbol).Name)
            Assert.Equal("C", model.GetTypeInfo(reference).Type?.Name)
        }
    }

    @Theory
    @InlineData("let k = s[u8] + c")
    @InlineData("let k = s[r] + c")
    @InlineData("let k = s[a..b] + c")
    @InlineData("let k = arr[a..b] + c")
    func ImplicitlyConvertedAndRangeIndices_AnswerOwnSymbolAndType(statement string) {
        let (model, tree, compilation) = CreateModel(statement)
        Assert.Contains(compilation.GetDiagnostics(), (d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
        if statement.Contains("u8") {
            let u8 = Assert.Single(Names(tree, "u8"))
            Assert.Equal("u8", Assert.IsAssignableFrom[LocalVariableSymbol](model.GetSymbolInfo(u8).Symbol).Name)
            Assert.Same(TypeSymbol.UInt8, model.GetTypeInfo(u8).Type)
        }
        if statement.Contains("r]") {
            let r = Assert.Single(Names(tree, "r"))
            Assert.Equal("r", Assert.IsAssignableFrom[LocalVariableSymbol](model.GetSymbolInfo(r).Symbol).Name)
            Assert.Equal("System.Range", model.GetTypeInfo(r).Type?.ToString())
        }
        if statement.Contains("a..b") {
            for name in[]string{"a", "b"} {
                let bound = Assert.Single(Names(tree, name))
                Assert.Equal(name, Assert.IsAssignableFrom[LocalVariableSymbol](model.GetSymbolInfo(bound).Symbol).Name)
                Assert.Same(TypeSymbol.Int32, model.GetTypeInfo(bound).Type)
            }
        }
    }

    @Fact
    func ContextuallyConvertedSliceAccess_KeepsConvertedAccessTypeAndOwnIndexSymbol() {
        let source = `package P

func F(flag bool) {
    let x = 0
    let s = slice[int32]{1, 2}
    let k int64 = if flag { s[x] } else { 0 }
}
`
        let tree = SyntaxTree.Parse(SourceText.From(source, "issue6204_converted.gs"))
        let compilation = Compilation(tree)
        Assert.Empty(compilation.GetDiagnostics())
        let model = compilation.GetSemanticModel(tree)
        let indexExpr = tree.Root.DescendantNodes().OfType[IndexExpressionSyntax]().Single()
        Assert.Null(model.GetSymbolInfo(indexExpr).Symbol)
        Assert.Same(TypeSymbol.Int64, model.GetTypeInfo(indexExpr).Type)
        let x = Assert.Single(Names(tree, "x"))
        let local = Assert.IsAssignableFrom[LocalVariableSymbol](model.GetSymbolInfo(x).Symbol)
        Assert.Equal("x", local.Name)
        Assert.Same(TypeSymbol.Int32, model.GetTypeInfo(x).Type)
    }

    @Fact
    func FailedConversionAndNestedSliceIndex_AnswerOwnSymbolsAndTypes() {
        let source = `package P

class C { }

func F(c C) {
    let x = 0
    let s = slice[int32]{1, 2}
    let ss = slice[string]{"a", "b"}
    let bad = s[c]
    let nested = ss[s[x]]
}
`
        let tree = SyntaxTree.Parse(SourceText.From(source, "issue6204_nested.gs"))
        let compilation = Compilation(tree)
        Assert.Contains(compilation.GetDiagnostics(), (d Diagnostic) -> d.Id == "GS0155")
        let model = compilation.GetSemanticModel(tree)

        let c = Assert.Single(Names(tree, "c"))
        let cParam = Assert.IsType[ParameterSymbol](model.GetSymbolInfo(c).Symbol)
        Assert.Equal("c", cParam.Name)
        Assert.Equal("C", model.GetTypeInfo(c).Type?.Name)
        Assert.Same(cParam, model.GetSymbolInfo(c.IdentifierToken).Symbol)

        let innerAccess = tree
            .Root
            .DescendantNodes()
            .OfType[IndexExpressionSyntax]()
            .Single(
            (ix IndexExpressionSyntax) -> ix.Target is NameExpressionSyntax name &&
                name.IdentifierToken.Text == "s" &&
                ix.Parent is IndexExpressionSyntax
        )
        Assert.Null(model.GetSymbolInfo(innerAccess).Symbol)
        Assert.Same(TypeSymbol.Int32, model.GetTypeInfo(innerAccess).Type)

        let x = Assert.Single(Names(tree, "x"))
        let xLocal = Assert.IsAssignableFrom[LocalVariableSymbol](model.GetSymbolInfo(x).Symbol)
        Assert.Equal("x", xLocal.Name)
        Assert.Same(TypeSymbol.Int32, model.GetTypeInfo(x).Type)
    }

    @Fact
    func QualifiedSharedMethodIndexCall_AnswersOnBothAccessorAndNestedCall() {
        let source = `package P

class C { }

class Holder {
    shared {
        func Index() int32 -> 0
    }
}

func F(c C) {
    let s = slice[int32]{1, 2}
    let k = s[Holder.Index()] + c
}
`
        let tree = SyntaxTree.Parse(SourceText.From(source, "issue6204_qualified_index.gs"))
        let compilation = Compilation(tree)
        Assert.Contains(compilation.GetDiagnostics(), (d Diagnostic) -> d.Id == "GS0129")
        let model = compilation.GetSemanticModel(tree)
        let accessor = tree.Root.DescendantNodes().OfType[AccessorExpressionSyntax]().Single()
        let nestedCall = Assert.IsType[CallExpressionSyntax](accessor.RightPart)
        let expectedMethod = compilation
            .GlobalScope
            .Structs
            .Single((s StructSymbol) -> s.Name == "Holder")
            .StaticMethods
            .Single((m FunctionSymbol) -> m.Name == "Index")
        Assert.Same(expectedMethod, model.GetSymbolInfo(accessor).Symbol)
        Assert.Same(TypeSymbol.Int32, model.GetTypeInfo(accessor).Type)
        Assert.Same(expectedMethod, model.GetSymbolInfo(nestedCall).Symbol)
        Assert.Same(TypeSymbol.Int32, model.GetTypeInfo(nestedCall).Type)
    }

    @Fact
    func InferredSuspendingNativeSliceIndex_PreservesCapturedTypeAndSymbol() {
        let source = `package P

func Take(ch chan[uint8]) uint8 -> <-ch

func Run(ch chan[uint8]) int32 {
    let s = slice[int32]{1, 2}
    return s[Take(ch)]
}
`
        let tree = SyntaxTree.Parse(SourceText.From(source, "issue6204_suspend.gs"))
        let compilation = Compilation(tree)
        Assert.Empty(compilation.GetDiagnostics().Where((d Diagnostic) -> d.Severity == DiagnosticSeverity.Error))
        let take = compilation.GlobalScope.Functions.Single((f FunctionSymbol) -> f.Name == "Take")
        Assert.Equal("Inferred", take.SuspendingKind.ToString())
        let model = compilation.GetSemanticModel(tree)
        let call = tree
            .Root
            .DescendantNodes()
            .OfType[CallExpressionSyntax]()
            .Single((call CallExpressionSyntax) -> call.Identifier.Text == "Take")
        Assert.Same(take, model.GetSymbolInfo(call).Symbol)
        Assert.Same(TypeSymbol.UInt8, model.GetTypeInfo(call).Type)
    }

    @Fact
    func CallIndexInFailedOperator_CallAndArgumentAnswer() {
        let (model, tree, compilation) = CreateModel("let k = s[Use(x)] + c")
        Assert.Contains(compilation.GetDiagnostics(), (d Diagnostic) -> d.Id == "GS0129")
        let call = tree
            .Root
            .DescendantNodes()
            .OfType[CallExpressionSyntax]()
            .Single((call CallExpressionSyntax) -> call.Identifier.Text == "Use")
        Assert.Equal("Use", Assert.IsType[FunctionSymbol](model.GetSymbolInfo(call).Symbol).Name)
        Assert.Same(TypeSymbol.Int32, model.GetTypeInfo(call).Type)
        let x = Assert.Single(Names(tree, "x"))
        Assert.Equal("x", Assert.IsAssignableFrom[LocalVariableSymbol](model.GetSymbolInfo(x).Symbol).Name)
        Assert.Same(TypeSymbol.Int32, model.GetTypeInfo(x).Type)
    }

    @Theory
    @InlineData("let k = s[x] + c", "GS0129 +: Binary operator '+' is not defined for types 'int32' and 'C'.")
    @InlineData("s[x] += c", "GS0129 +=: Binary operator '+=' is not defined for types 'int32' and 'C'.")
    @InlineData("s[x] = c", "GS0155 c: Cannot convert type 'C' to 'int32'.")
    @InlineData("let k = s[a..b] + c", "GS0129 +: Binary operator '+' is not defined for types 'slice[int32]' and 'C'.")
    func Diagnostics_AreUnchanged(statement string, expected string) {
        let source = Source(statement)
        let tree = SyntaxTree.Parse(SourceText.From(source, "issue6204_diag.gs"))
        let compilation = Compilation(tree)
        let before = Render(source, compilation)
        let model = compilation.GetSemanticModel(tree)
        let references = Names(tree, "x")
            .Concat(Names(tree, "a"))
            .Concat(Names(tree, "b"))
            .Concat(Names(tree, "c"))
            .ToArray()
        Assert.NotEmpty(references)
        for reference in references {
            Assert.NotNull(model.GetSymbolInfo(reference).Symbol)
        }
        Assert.Equal(expected, string.Join("|", before))
        Assert.Equal(before, Render(source, compilation))
    }

    shared {
        private func Source(statement string) string -> `package P

class C { }

class Holder {
    prop Items slice[int32] -> slice[int32]{1, 2}
}

func Use(v int32) int32 -> v

func F(c C, h Holder, arr []int32, m map[int32, int32]) {
    let x = 0
    let a = 0
    let b = 1
    let u8 uint8 = 0
    let r = 0..1
    let s = slice[int32]{1, 2}
    let ss = slice[string]{"a", "b"}
    let rs readonly slice[int32] = slice[int32]{1, 2}
    let sc = slice[C]{C()}
    ` + statement + "\n}\n"

        private func CreateModel(statement string)(SemanticModel, SyntaxTree, Compilation) {
            let tree = SyntaxTree.Parse(SourceText.From(Source(statement), "issue6204.gs"))
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
