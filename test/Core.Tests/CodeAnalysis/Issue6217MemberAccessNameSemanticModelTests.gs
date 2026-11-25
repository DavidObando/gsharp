// <copyright file="Issue6217MemberAccessNameSemanticModelTests.gs" company="GSharp">
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

/// Issue #6217: the name node (`NameExpressionSyntax`) of a member access — at the end or in the
/// middle of a chain — and inner right-nested `AccessorExpressionSyntax` nodes answer `GetSymbolInfo`,
/// `GetTypeInfo`, and `GetMemberGroup` as their terminal member does.
open class Issue6217MemberAccessNameSemanticModelTests {
    @Fact
    func ReproFromIssue_AllMemberNamesAndInnerAccessorsAnswer() {
        let source = `package P

import System.Text

class Descriptor {
    let Id string = "x"
    func Name() string -> Id
}

shared class Descriptors {
    let First Descriptor = Descriptor()
}

class Bag {
    let D Descriptor = Descriptor()
}

func Use(bag Bag) {
    let a = Descriptors.First
    let c = Descriptors.First.Id
    let d = bag.D.Name()
    let e = bag.D.Id.Length
    let sb = StringBuilder()
    let f = sb.Length
    let g = sb.Append(1).Length
}
`
        let (model, tree, compilation) = CreateModel(source, recordMemberGroups: true)
        let before = compilation.GetDiagnostics().ToArray()
        Assert.Empty(before)

        // let a = Descriptors.First
        let aInit = InitializerAccessor(tree, "a")
        let aFirst = Assert.IsType[NameExpressionSyntax](aInit.RightPart)
        AssertField(model, aInit, "First", "Descriptor")
        AssertField(model, aFirst, "First", "Descriptor")
        Assert.Same(model.GetSymbolInfo(aInit).Symbol, model.GetSymbolInfo(aFirst).Symbol)
        Assert.Same(model.GetSymbolInfo(aFirst).Symbol, Assert.Single(model.GetMemberGroup(aFirst)))
        let aDescriptors = Assert.IsType[NameExpressionSyntax](aInit.LeftPart)
        Assert.Equal("Descriptors", Assert.IsType[StructSymbol](model.GetSymbolInfo(aDescriptors).Symbol).Name)
        Assert.Null(model.GetTypeInfo(aDescriptors).Type)
        Assert.Null(model.GetBoundNode(aDescriptors))

        // let c = Descriptors.First.Id
        let cInit = InitializerAccessor(tree, "c")
        let cInner = Assert.IsType[AccessorExpressionSyntax](cInit.RightPart)
        let cFirst = Assert.IsType[NameExpressionSyntax](cInner.LeftPart)
        let cId = Assert.IsType[NameExpressionSyntax](cInner.RightPart)
        AssertField(model, cFirst, "First", "Descriptor")
        AssertField(model, cId, "Id", "string")
        AssertField(model, cInner, "Id", "string")
        AssertField(model, cInit, "Id", "string")
        Assert.Same(model.GetSymbolInfo(cId).Symbol, Assert.Single(model.GetMemberGroup(cInner)))

        // let d = bag.D.Name()
        let dInit = InitializerAccessor(tree, "d")
        let dInner = Assert.IsType[AccessorExpressionSyntax](dInit.RightPart)
        let dD = Assert.IsType[NameExpressionSyntax](dInner.LeftPart)
        let dNameCall = Assert.IsType[CallExpressionSyntax](dInner.RightPart)
        AssertField(model, dD, "D", "Descriptor")
        Assert.Equal("Name", Assert.IsAssignableFrom[FunctionSymbol](model.GetSymbolInfo(dInner).Symbol).Name)
        Assert.Same(TypeSymbol.String, model.GetTypeInfo(dInner).Type)
        Assert.Same(model.GetSymbolInfo(dNameCall).Symbol, model.GetSymbolInfo(dInner).Symbol)

        // let e = bag.D.Id.Length
        let eInit = InitializerAccessor(tree, "e")
        let eMiddleAccessor = Assert.IsType[AccessorExpressionSyntax](eInit.RightPart)
        let eD = Assert.IsType[NameExpressionSyntax](eMiddleAccessor.LeftPart)
        let eInnerAccessor = Assert.IsType[AccessorExpressionSyntax](eMiddleAccessor.RightPart)
        let eId = Assert.IsType[NameExpressionSyntax](eInnerAccessor.LeftPart)
        let eLength = Assert.IsType[NameExpressionSyntax](eInnerAccessor.RightPart)
        AssertField(model, eD, "D", "Descriptor")
        AssertField(model, eId, "Id", "string")
        AssertProperty(model, eLength, "Length", "int32")
        AssertProperty(model, eInnerAccessor, "Length", "int32")
        AssertProperty(model, eMiddleAccessor, "Length", "int32")
        AssertProperty(model, eInit, "Length", "int32")
        Assert.Same(model.GetSymbolInfo(eInit).Symbol, model.GetSymbolInfo(eLength).Symbol)
        Assert.Same(model.GetSymbolInfo(eLength.IdentifierToken).Symbol, Assert.Single(model.GetMemberGroup(eLength)))
        Assert.Equal("Length", Assert.Single(model.GetMemberGroup(eLength)).Name)

        // let f = sb.Length
        let fInit = InitializerAccessor(tree, "f")
        let fLength = Assert.IsType[NameExpressionSyntax](fInit.RightPart)
        AssertProperty(model, fInit, "Length", "int32")
        AssertProperty(model, fLength, "Length", "int32")
        Assert.Equal(model.GetSymbolInfo(fInit).Symbol, model.GetSymbolInfo(fLength).Symbol)

        // let g = sb.Append(1).Length
        let gInit = InitializerAccessor(tree, "g")
        let gInner = Assert.IsType[AccessorExpressionSyntax](gInit.RightPart)
        let gAppend = Assert.IsType[CallExpressionSyntax](gInner.LeftPart)
        let gLength = Assert.IsType[NameExpressionSyntax](gInner.RightPart)
        Assert.Equal("Append", Assert.IsType[ImportedFunctionSymbol](model.GetSymbolInfo(gAppend).Symbol).Name)
        Assert.Equal("System.Text.StringBuilder", model.GetTypeInfo(gAppend).Type?.Name)
        AssertProperty(model, gLength, "Length", "int32")
        AssertProperty(model, gInner, "Length", "int32")
        AssertProperty(model, gInit, "Length", "int32")

        Assert.Equal(before, compilation.GetDiagnostics().ToArray())
    }

    @Fact
    func ImplicitConversionsNullConditionalsMethodGroupsAndAdditionalMemberKinds_AnswerExpectedSymbolsAndTypes() {
        let source = `package P

import System

enum Color { Red, Green }

interface Box[T] {
    prop Value T { get; }
}

class Holder {
    prop Auto string { get; set; }
    let Items []string = []string{"hi"}
    init() {
        Auto = "abc"
    }
    func Self() int32 -> Auto.Length
    shared {
        const ConstVal int32 = 42
    }
}

class Wrapper {
    let H Holder? = nil
    func Greet() string -> "hi"
}

func AsObject() []object {
    return []object{Holder().Auto.Length}
}

func Run(w Wrapper, box Box[string]) {
    let ncField = w.H?.Auto
    let ncChain = w.H?.Auto.Length
    let enumStr = Color.Red.ToString()
    let constStr = Holder.ConstVal.ToString()
    let ifaceLen = box.Value.Length
    let idxLen = Holder().Items[0].Length
    let envLen = Environment.NewLine.Length
    let fn Func[string] = w.Greet
}
`
        let (model, tree, compilation) = CreateModel(source)
        Assert.Empty(compilation.GetDiagnostics())

        // Implicit conversion on outer accessor: member name keeps member's own type
        let convLenInit = Assert.IsType[AccessorExpressionSyntax](
            tree
                .Root
                .DescendantNodes()
                .OfType[FunctionDeclarationSyntax]()
                .Single((f FunctionDeclarationSyntax) -> f.Identifier.Text == "AsObject")
                .DescendantNodes()
                .OfType[ArrayCreationExpressionSyntax]()
                .Single()
                .Elements!![0]
        )
        let convLenInner = Assert.IsType[AccessorExpressionSyntax](convLenInit.RightPart)
        let convLenName = Assert.IsType[NameExpressionSyntax](convLenInner.RightPart)
        Assert.Equal("object", model.GetTypeInfo(convLenInit).Type?.ToString())
        AssertProperty(model, convLenName, "Length", "int32")
        AssertProperty(model, convLenInner, "Length", "int32")

        // Null-conditional member access
        let ncFieldInit = InitializerAccessor(tree, "ncField")
        let ncFieldInner = Assert.IsType[AccessorExpressionSyntax](ncFieldInit.RightPart)
        let ncH = Assert.IsType[NameExpressionSyntax](ncFieldInner.LeftPart)
        let ncAuto = Assert.IsType[NameExpressionSyntax](ncFieldInner.RightPart)
        AssertField(model, ncH, "H", "Holder?")
        AssertProperty(model, ncAuto, "Auto", "string")
        AssertProperty(model, ncFieldInner, "Auto", "string")
        Assert.Equal("string?", model.GetTypeInfo(ncFieldInit).Type?.ToString())

        let ncChainInit = InitializerAccessor(tree, "ncChain")
        let ncChainMid = Assert.IsType[AccessorExpressionSyntax](ncChainInit.RightPart)
        let ncChainInner = Assert.IsType[AccessorExpressionSyntax](ncChainMid.RightPart)
        let ncChainAuto = Assert.IsType[NameExpressionSyntax](ncChainInner.LeftPart)
        let ncChainLen = Assert.IsType[NameExpressionSyntax](ncChainInner.RightPart)
        AssertProperty(model, ncChainAuto, "Auto", "string")
        AssertProperty(model, ncChainLen, "Length", "int32")

        // Folded enum member and constant in middle of chain
        let enumInit = InitializerAccessor(tree, "enumStr")
        let enumMid = Assert.IsType[AccessorExpressionSyntax](enumInit.RightPart)
        let enumRed = Assert.IsType[NameExpressionSyntax](enumMid.LeftPart)
        Assert.Equal("Red", Assert.IsType[EnumMemberSymbol](model.GetSymbolInfo(enumRed).Symbol).Name)
        Assert.Equal("Color", model.GetTypeInfo(enumRed).Type?.Name)

        let constInit = InitializerAccessor(tree, "constStr")
        let constMid = Assert.IsType[AccessorExpressionSyntax](constInit.RightPart)
        let constVal = Assert.IsType[NameExpressionSyntax](constMid.LeftPart)
        Assert.Equal("ConstVal", Assert.IsAssignableFrom[FieldSymbol](model.GetSymbolInfo(constVal).Symbol).Name)
        Assert.Same(TypeSymbol.Int32, model.GetTypeInfo(constVal).Type)

        // Generic interface property in middle of chain
        let ifaceInit = InitializerAccessor(tree, "ifaceLen")
        let ifaceInner = Assert.IsType[AccessorExpressionSyntax](ifaceInit.RightPart)
        let ifaceVal = Assert.IsType[NameExpressionSyntax](ifaceInner.LeftPart)
        AssertProperty(model, ifaceVal, "Value", "string")

        // Indexed member in chain
        let idxInit = InitializerAccessor(tree, "idxLen")
        let idxInner = Assert.IsType[AccessorExpressionSyntax](idxInit.RightPart)
        let idxExpr = Assert.IsType[IndexExpressionSyntax](idxInner.LeftPart)
        let itemsName = Assert.IsType[NameExpressionSyntax](idxExpr.Target)
        AssertField(model, itemsName, "Items", "[]string")
        AssertProperty(model, Assert.IsType[NameExpressionSyntax](idxInner.RightPart), "Length", "int32")

        // Imported static property in middle of chain
        let envInit = InitializerAccessor(tree, "envLen")
        let envInner = Assert.IsType[AccessorExpressionSyntax](envInit.RightPart)
        let envNewLine = Assert.IsType[NameExpressionSyntax](envInner.LeftPart)
        AssertProperty(model, envNewLine, "NewLine", "string")
        let envName = Assert.IsType[NameExpressionSyntax](envInit.LeftPart)
        Assert.Equal(
            "System.Environment",
            Assert.IsAssignableFrom[TypeSymbol](model.GetSymbolInfo(envName).Symbol).Name
        )
        Assert.Null(model.GetTypeInfo(envName).Type)

        // Method group name node
        let fnInit = InitializerAccessor(tree, "fn")
        let fnName = Assert.IsType[NameExpressionSyntax](fnInit.RightPart)
        Assert.Equal("Greet", Assert.IsAssignableFrom[FunctionSymbol](model.GetSymbolInfo(fnName).Symbol).Name)
        Assert.NotEqual(TypeSymbol.Error, model.GetTypeInfo(fnName).Type)
        Assert.Equal("() -> string", model.GetTypeInfo(fnName).Type?.ToString())
    }

    shared {
        private func AssertField(model SemanticModel, node SyntaxNode, expectedName string, expectedType string) {
            let symbol = Assert.IsAssignableFrom[FieldSymbol](model.GetSymbolInfo(node).Symbol)
            Assert.Equal(expectedName, symbol.Name)
            Assert.Equal(expectedType, model.GetTypeInfo(node).Type?.ToString())
        }

        private func AssertProperty(model SemanticModel, node SyntaxNode, expectedName string, expectedType string) {
            let symbol = Assert.IsAssignableFrom[PropertySymbol](model.GetSymbolInfo(node).Symbol)
            Assert.Equal(expectedName, symbol.Name)
            Assert.Equal(expectedType, model.GetTypeInfo(node).Type?.ToString())
        }

        private func InitializerAccessor(tree SyntaxTree, variableName string) AccessorExpressionSyntax ->
        Assert.IsType[AccessorExpressionSyntax](
            tree
                .Root
                .DescendantNodes()
                .OfType[VariableDeclarationSyntax]()
                .Single((d VariableDeclarationSyntax) -> d.Identifier.Text == variableName)
                .Initializer
        )

        private func CreateModel(source string, recordMemberGroups bool = false)(
            SemanticModel,
            SyntaxTree,
            Compilation
        ) {
            let tree = SyntaxTree.Parse(SourceText.From(source, "issue6217.gs"))
            let compilation = Compilation(tree)
            compilation.RecordMemberGroups = recordMemberGroups
            return (compilation.GetSemanticModel(tree), tree, compilation)
        }
    }
}
