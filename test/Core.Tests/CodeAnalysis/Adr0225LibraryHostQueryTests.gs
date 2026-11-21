// <copyright file="Adr0225LibraryHostQueryTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Generic
import System.Linq
import Xunit

/// The library-host queries of ADR-0225 D6.7 and the Oats design note §6 (#6079): fragment parsing,
/// declared symbols of parameters and locals, the symbol of a constructor call, and the expected type.
open class Adr0225LibraryHostQueryTests {
    @Fact
    func GetDeclaredSymbol_AnswersForParameterAndLocalDeclarations() {
        const source = `package P

func F(p int32, unused string) {
    let x = 1
    var y int64 = 2
}
`
        let (tree, model) = Model(source)
        let parameters = Descendants(tree.Root).OfType[ParameterSyntax]().ToList()
        Assert.Equal(2, parameters.Count)
        let p = Assert.IsAssignableFrom[ParameterSymbol](model.GetDeclaredSymbol(parameters[0]))
        Assert.Equal("p", p.Name)
        Assert.Equal(TypeSymbol.Int32, p.Type)
        // A parameter that the body never reads.
        Assert.Equal("unused", Assert.IsAssignableFrom[ParameterSymbol](model.GetDeclaredSymbol(parameters[1])).Name)
        let locals = Descendants(tree.Root).OfType[VariableDeclarationSyntax]().ToList()
        Assert.Equal(2, locals.Count)
        let x = Assert.IsAssignableFrom[LocalVariableSymbol](model.GetDeclaredSymbol(locals[0]))
        Assert.Equal("x", x.Name)
        let y = Assert.IsAssignableFrom[LocalVariableSymbol](model.GetDeclaredSymbol(locals[1]))
        Assert.Equal(TypeSymbol.Int64, y.Type)
        // The identifier token answers the same symbol.
        Assert.Same(x, model.GetDeclaredSymbol(locals[0].Identifier))
    }

    @Fact
    func GetSymbolInfo_OfASourceConstructorCall_IsTheChosenConstructor() {
        const source = `package P

class Box {
    init(v int32) {
    }

    init(s string) {
    }
}

func F() {
    let a = Box(1)
    let b = Box("s")
}
`
        let (tree, model) = Model(source)
        let box = Assert.IsType[StructSymbol](
            model.GetDeclaredSymbol(Descendants(tree.Root).OfType[StructDeclarationSyntax]().Single())
        )
        let calls = Descendants(tree.Root).OfType[CallExpressionSyntax]().ToList()
        Assert.Equal(2, calls.Count)
        Assert.Same(box.ExplicitConstructors[0].Function, model.GetSymbolInfo(calls[0]).Symbol)
        Assert.Same(box.ExplicitConstructors[1].Function, model.GetSymbolInfo(calls[1]).Symbol)
    }

    @Fact
    func ParseExpressionAndStatement_ParseAFragmentOnItsOwn() {
        let expression = Assert.IsType[BinaryExpressionSyntax](SyntaxTree.ParseExpression("a + 1"))
        Assert.Equal(0, expression.Span.Start)
        Assert.Equal(5, expression.Span.End)
        Assert.Empty(expression.SyntaxTree.Diagnostics)
        let statement = Assert.IsType[VariableDeclarationSyntax](SyntaxTree.ParseStatement("let x = 1"))
        Assert.Equal("x", statement.Identifier.Text)
        // A parse error stays on the fragment's tree.
        let broken = SyntaxTree.ParseExpression("a +")
        Assert.NotNull(broken)
        Assert.NotEmpty(broken!!.SyntaxTree.Diagnostics)
        Assert.Null(SyntaxTree.ParseStatement("func F() {}"))
        Assert.Null(SyntaxTree.ParseStatement("let a = 1\nlet b = 2"))
        Assert.Null(SyntaxTree.ParseStatement(""))
        Assert.Null(SyntaxTree.ParseExpression("let x = 1"))
        // A parsed expression binds speculatively at a position of another tree.
        const source = "package P\n\nfunc F(p int32) {\n    let q = p\n}\n"
        let (_, model) = Model(source)
        let speculative = model.GetSpeculativeTypeInfo(
            source.IndexOf("let q", StringComparison.Ordinal),
            SyntaxTree.ParseExpression("p + 1")!!
        )
        Assert.Equal(TypeSymbol.Int32, speculative.Type)
    }

    @Fact
    func GetExpectedType_AnswersTheTypeOfTheContext() {
        const source = `package P

func Take(a int32, b string, c int64) {
}

func F() int64 {
    var s string = "x"
    let typed float64 = 1.0
    s = "y"
    Take(1, "z", 3)
    let f = func () bool {
        return true
    }
    let g = (n int32) -> n
    return 4
}
`
        let (_, model) = Model(source)
        Assert.Equal(TypeSymbol.Float64, model.GetExpectedType(source.IndexOf("1.0", StringComparison.Ordinal)))
        Assert.Equal(TypeSymbol.String, model.GetExpectedType(source.IndexOf("\"y\"", StringComparison.Ordinal)))
        Assert.Equal(TypeSymbol.Int32, model.GetExpectedType(source.IndexOf("1, \"z\"", StringComparison.Ordinal)))
        Assert.Equal(TypeSymbol.String, model.GetExpectedType(source.IndexOf("\"z\"", StringComparison.Ordinal)))
        Assert.Equal(TypeSymbol.Int64, model.GetExpectedType(source.IndexOf("3)", StringComparison.Ordinal)))
        Assert.Equal(TypeSymbol.Bool, model.GetExpectedType(source.IndexOf("true", StringComparison.Ordinal)))
        Assert.Equal(TypeSymbol.Int64, model.GetExpectedType(source.IndexOf("4\n", StringComparison.Ordinal)))
        // A declaration without a type, and a lambda body, expect nothing.
        Assert.Null(model.GetExpectedType(source.IndexOf("func () bool", StringComparison.Ordinal)))
        Assert.Null(model.GetExpectedType(source.IndexOf("-> n", StringComparison.Ordinal) + 3))
    }

    @Fact
    func GetExpectedType_InAnOpenArgumentList_ReadsTheCandidates() {
        const text = `package P

func Put(a int32, b string) {
}

func Put(a int32, b string, c bool) {
}

func Mix(a int32) {
}

func Mix(a string) {
}

func F() {
    Put(1, `
        let tree = SyntaxTree.Parse(SourceText.From(text, "prefix.gs"))
        let compilation = Compilation(tree){.RecordMemberGroups: true}
        let result = compilation.BindPrefix(tree, text.Length, PrefixBindOptions(PrefixRemainder.Nothing))
        let model = result.Compilation.GetSemanticModel(result.SyntaxTree)
        // Both overloads take a string in the second slot.
        Assert.Equal(TypeSymbol.String, model.GetExpectedType(text.Length))
        let mixText = text.Replace("Put(1, ", "Mix(")
        let mixTree = SyntaxTree.Parse(SourceText.From(mixText, "prefix.gs"))
        let mix = Compilation(mixTree){.RecordMemberGroups: true}.BindPrefix(
            mixTree,
            mixText.Length,
            PrefixBindOptions(PrefixRemainder.Nothing)
        )
        // The candidates disagree.
        Assert.Null(mix.Compilation.GetSemanticModel(mix.SyntaxTree).GetExpectedType(mixText.Length))
    }

    @Fact
    func GetExpectedType_AnswersOnlyWhenTheSlotMapsToASourceParameter() {
        const source = `package P

import System

class Box {
    func Put(v int32, w string) {
    }
}

func (b Box) Tag(label string, weight float64) {
}

func Same[T](a T, b T) {
}

func Named(a int32, b string) {
}

func F() {
    let box = Box()
    box.Put(1, "a")
    box.Tag("t", 2.0)
    Same(1, 2)
    Console.WriteLine("x")
    Named(b: "q", a: 3)
}
`
        let (_, model) = Model(source)
        // An instance method and a receiver function map slots to their declared parameters.
        Assert.Equal(TypeSymbol.String, model.GetExpectedType(source.IndexOf("\"a\")", StringComparison.Ordinal)))
        Assert.Equal(TypeSymbol.String, model.GetExpectedType(source.IndexOf("\"t\"", StringComparison.Ordinal)))
        Assert.Equal(TypeSymbol.Float64, model.GetExpectedType(source.IndexOf("2.0", StringComparison.Ordinal)))
        // A generic callee, an imported method and a named argument answer nothing.
        Assert.Null(model.GetExpectedType(source.IndexOf("1, 2)", StringComparison.Ordinal)))
        Assert.Null(model.GetExpectedType(source.IndexOf("\"x\"", StringComparison.Ordinal)))
        Assert.Null(model.GetExpectedType(source.IndexOf("3)", StringComparison.Ordinal)))
    }

    shared {
        private func Model(source string)(SyntaxTree, SemanticModel) {
            let tree = SyntaxTree.Parse(SourceText.From(source, "query.gs"))
            let compilation = Compilation(tree)
            Assert.Empty(compilation.GetDiagnostics().Where((d Diagnostic) -> d.IsError))
            return (tree, compilation.GetSemanticModel(tree))
        }

        private func Descendants(node SyntaxNode) List[SyntaxNode] {
            let nodes = List[SyntaxNode]()
            let pending = Stack[SyntaxNode]()
            pending.Push(node)
            while pending.Count > 0 {
                let current = pending.Pop()
                nodes.Add(current)
                for child in current.GetChildren().Reverse() {
                    pending.Push(child)
                }
            }
            return nodes
        }
    }
}
