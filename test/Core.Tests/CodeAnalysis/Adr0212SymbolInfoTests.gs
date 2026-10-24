// <copyright file="Adr0212SymbolInfoTests.cs" company="GSharp">
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
import System.Threading
import Xunit

/// ADR-0212 slice S2: (cref:SemanticModel.GetSymbolInfo) answers what a bound node means,
/// and (cref:SemanticModel.GetReceiverTypeInfo) and
/// (cref:SemanticModel.GetTypeClauseSymbols) answer the questions the language server asked
/// of internal bound-node members.
open class Adr0212SymbolInfoTests {
    @Fact
    func FoldedConstant_NamesTheConstantField() {
        let (model, tree) = CreateModel(Source)
        let token = NameToken(tree, "Value", "Fold", 0)
        let field = Assert.IsAssignableFrom[FieldSymbol](model.GetSymbolInfo(token).Symbol)
        Assert.Equal("Value", field.Name)
        Assert.True(field.IsConst)
    }

    @Fact
    func FoldedEnumMember_NamesTheEnumMember() {
        let (model, tree) = CreateModel(Source)
        let token = NameToken(tree, "Red", "Run", 0)
        let member = Assert.IsType[EnumMemberSymbol](model.GetSymbolInfo(token).Symbol)
        Assert.Equal("Red", member.Name)
    }

    @Fact
    func StaticQualifier_OfAFoldedRead_NamesTheQualifierType() {
        let (model, tree) = CreateModel(Source)
        let qualifier = tree
            .Root
            .DescendantNodes()
            .OfType[NameExpressionSyntax]()
            .Single((name NameExpressionSyntax) -> name.IdentifierToken.Text == "Color")
        let type = Assert.IsType[EnumSymbol](model.GetSymbolInfo(qualifier).Symbol)
        Assert.Equal("Color", type.Name)
    }

    @Fact
    func PropertyAtConstructedReceiver_ReportsTheSubstitutedType() {
        let (model, tree) = CreateModel(Source)
        let token = NameToken(tree, "Value", "Read", 0)
        let property = Assert.IsType[PropertySymbol](model.GetSymbolInfo(token).Symbol)
        Assert.Equal("Value", property.Name)
        Assert.Same(TypeSymbol.String, property.Type)
    }

    @Fact
    func Parenthesized_AnswersForItsOperand() {
        let (model, tree) = CreateModel(Source)
        let parenthesized = tree.Root.DescendantNodes().OfType[ParenthesizedExpressionSyntax]().Single()
        let inner = parenthesized.Expression
        Assert.NotNull(model.GetSymbolInfo(inner).Symbol)
        Assert.Same(model.GetSymbolInfo(inner).Symbol, model.GetSymbolInfo(parenthesized).Symbol)
    }

    @Fact
    func Queries_HonourACancelledToken() {
        let (model, tree) = CreateModel(Source)
        let token = NameToken(tree, "Value", "Fold", 0)
        let cancelled = CancellationToken(true)
        Assert.Throws[OperationCanceledException](() -> model.GetSymbolInfo(token, cancelled))
    }

    @Fact
    func ReceiverTypeInfo_OfAReceiverName_IsTheReceiverType() {
        let (model, tree) = CreateModel(Source)
        let receiver = tree
            .Root
            .DescendantNodes()
            .OfType[NameExpressionSyntax]()
            .First((n NameExpressionSyntax) -> n.IdentifierToken.Text == "box")
        let type = model.GetReceiverTypeInfo(receiver).Type
        Assert.NotNull(type)
        Assert.Equal("Box[string]", type?.Name)
    }

    @Fact
    func TypeClauseSymbols_PairEachIdentifierWithItsType() {
        let (_, tree) = CreateModel(Source)
        let declaration = tree
            .Root
            .DescendantNodes()
            .OfType[VariableDeclarationSyntax]()
            .Single((d VariableDeclarationSyntax) -> d.Identifier.Text == "typed")
        let pairs = SemanticModel.GetTypeClauseSymbols(declaration.TypeClause, TypeSymbol.Int32)
        Assert.NotEmpty(pairs)
        Assert.Contains(pairs, (p(Token SyntaxToken, Symbol TypeSymbol)) -> p.Token.Text == "int32")
    }

    shared {
        private const Source string = `package Query
enum Color { Red, Green }
interface Box[T] {
    prop Value T { get; }
}
interface Shape[T] {
    func Area(a T) int32
    func Area(a T, b T) int32
}
interface Calc {
    shared {
        private func Help(a string) int32 { return 1 }
        func Help(a int32) int32 { return 2 }
        func Inside() int32 { return Help(3) }
    }
}
func Outside() int32 -> Calc.Help(4)
func UseShape(shape Shape[string]) int32 -> shape.Area("a")
func Pick(a int32) string -> "i"
func Pick(a string) string -> "s"
class Constants {
    shared { const Value int32 = 1 }
}
func Fold() {
    let competing = System.Text.StringBuilder().ToString()
    let indexed = Constants.Value.ToString()[^1]
}
class Holder {
    shared {
        func Run() string {
            let a = ""
            let b = Color.Red.ToString()
            let p = (Pick(1))
            let n = Pick(2)
            return a + b + p + n
        }
        func Read(box Box[string]) string {
            let typed int32 = 1
            return box.Value
        }
    }
}
`

        private func CreateModel(source string)(SemanticModel, SyntaxTree) {
            let tree = SyntaxTree.Parse(SourceText.From(source, "adr0212-query.gs"))
            let compilation = Compilation(tree)
            Assert.Empty(compilation.GlobalScope.Diagnostics)
            Assert.Empty(compilation.BoundProgram.Diagnostics)
            return (compilation.GetSemanticModel(tree), tree)
        }

        /// The identifier token of the [`occurrence`](paramref)th name or call named [`name`](paramref)
        /// inside the function [`function`](paramref).
        private func NameToken(tree SyntaxTree, name string, function string, occurrence int32) SyntaxToken {
            let declaration = tree
                .Root
                .DescendantNodes()
                .OfType[FunctionDeclarationSyntax]()
                .Single((f FunctionDeclarationSyntax) -> f.Identifier.Text == function)
            return declaration
                .DescendantNodes()
                .OfType[NameExpressionSyntax]()
                .Where((n NameExpressionSyntax) -> n.IdentifierToken.Text == name)
                .ElementAt(occurrence)
                .IdentifierToken
        }
    }
}
