// <copyright file="Adr0169SemanticModelTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Generic
import System.Linq
import System.Threading.Tasks
import Xunit

/// Covers the ADR-0169 (cref:SemanticModel) (syntax→symbol,
/// syntax→bound-node, syntax→type queries), (cref:Symbol.DeclaringSyntaxNodes),
/// and (cref:GSharpSyntaxWalker).
open class Adr0169SemanticModelTests {
    @Fact
    func StaticQualifierQuery_UsesCanonicalPrimitiveAliasAndClosedOwner() {
        const source = `package Query
import D = System.Decimal
class Box[T] {
    shared {
        prop Items []string -> []string{"one"}
        func Select[U](value U) []string -> []string{"selected"}
    }
}
func Run() {
    let primitive = decimal.Zero
    let alias = D.Zero
    let alternate = byte.MaxValue
    let generic = Box[int32?].Items
    let genericCall = Box[int32?].Select[string]("value")
}
`
        let (compilation, model, tree) = CreateQualifierModel(source)
        for name in[]string{"primitive", "alias", "alternate"} {
            let root = QualifierInitializer(tree, name)
            let (type, qualifier, read) = QueryQualifier(model, root)
            Assert.Same(root.LeftPart, qualifier)
            if read is BoundClrPropertyAccessExpression imported {
                Assert.Equal(imported.Member.DeclaringType, type.ClrType)
            } else {
                Assert.Same(TypeSymbol.UInt8, Assert.IsType[BoundLiteralExpression](read).Type)
            }
            Assert.Equal(
                if name == "alternate" {
                    typeof(byte)
                } else {
                    typeof(decimal)
                },
                type.ClrType
            )
        }
        let genericRoot = QualifierInitializer(tree, "generic")
        let (closedType, syntax, selected) = QueryQualifier(model, genericRoot)
        let property = Assert.IsType[BoundPropertyAccessExpression](selected)
        Assert.Same(property.StructType, closedType)
        Assert.Same(genericRoot.LeftPart, syntax)
        let closed = Assert.IsType[StructSymbol](closedType)
        Assert.Same(
            compilation.GlobalScope.Structs.Single((type StructSymbol) -> type.Name == "Box"),
            closed.Definition
        )
        Assert.Same(
            TypeSymbol.Int32,
            Assert.IsType[NullableTypeSymbol](Assert.Single(closed.TypeArguments)).UnderlyingType
        )
        let (callType, _, callRead) = QueryQualifier(model, QualifierInitializer(tree, "genericCall"))
        let call = Assert.IsType[BoundCallExpression](callRead)
        Assert.Same(callType, call.StaticGenericOwnerType)
        Assert.Same(TypeSymbol.String, Assert.Single(call.MethodTypeArguments))
    }

    @Fact
    func StaticQualifierQuery_PreservesTypeParametersShadowingAndColorColor() {
        const source = `package Query
class Box[T] {
    shared { prop Items []string -> []string{"one"} }
}
class Instance { prop Items []string -> []string{"instance"} }
class Palette {
    func Tag(value string) string -> value
    shared { func Tag(value int32) string -> "static" }
}
func Generic[T]() { let generic = Box[T].Items }
func Shadow(Box []Instance) { let value = Box[0].Items }
func Color(Palette Palette) {
    let staticCall = Palette.Tag(1)
    let instanceCall = Palette.Tag("instance")
}
`
        let (compilation, model, tree) = CreateQualifierModel(source)
        let (type, _, _) = QueryQualifier(model, QualifierInitializer(tree, "generic"))
        let genericFunction = compilation
            .GlobalScope
            .Functions
            .Single((function FunctionSymbol) -> function.Name == "Generic")
        Assert.Same(
            Assert.Single(genericFunction.TypeParameters),
            Assert.Single(Assert.IsType[StructSymbol](type).TypeArguments)
        )
        let shadow = QualifierInitializer(tree, "value")
        Assert.False(model.TryGetStaticTypeQualifier(shadow, shadow.RightPart, out _, out _, out _))
        let staticRoot = QualifierInitializer(tree, "staticCall")
        let (owner, _, selected) = QueryQualifier(model, staticRoot)
        let call = Assert.IsType[BoundCallExpression](selected)
        Assert.True(call.Function.IsStatic)
        Assert.Same(TypeSymbol.Int32, Assert.Single(call.Function.Parameters).Type)
        Assert.Same(call.Function.StaticOwnerType, owner)
        let instanceRoot = QualifierInitializer(tree, "instanceCall")
        Assert.False(model.TryGetStaticTypeQualifier(instanceRoot, instanceRoot.RightPart, out _, out _, out _))
    }

    @Fact
    func StaticQualifierQuery_IsConcurrentReadOnlyAndSnapshotScoped() {
        const source = `package Query
class Box[T] {
    shared { prop Items []string -> []string{"one"} }
}
func Run() { let result = Box[ARGUMENT].Items }
`
        let (oldCompilation, oldModel, oldTree) = CreateQualifierModel(source.Replace("ARGUMENT", "int32"))
        let (_, newModel, newTree) = CreateQualifierModel(source.Replace("ARGUMENT", "int32?"))
        let oldRoot = QualifierInitializer(oldTree, "result")
        let newRoot = QualifierInitializer(newTree, "result")
        let nodes = oldTree.Root.DescendantNodesAndSelf().ToArray()
        let parents = nodes.Select((node SyntaxNode) -> node.Parent).ToArray()
        let program = oldCompilation.BoundProgram
        let (oldType, oldQualifier, oldRead) = QueryQualifier(oldModel, oldRoot)
        let (newType, _, _) = QueryQualifier(newModel, newRoot)
        Parallel.For(
            0,
            16,
            (i int32) -> {
                let (found, qualifier, read) = QueryQualifier(oldModel, oldRoot)
                Assert.Same(oldType, found)
                Assert.Same(oldQualifier, qualifier)
                Assert.Same(oldRead, read)
                Assert.Same(TypeSymbol.Int32, Assert.Single(Assert.IsType[StructSymbol](found).TypeArguments))
                let (current, _, _) = QueryQualifier(newModel, newRoot)
                Assert.Same(newType, current)
                Assert.IsType[NullableTypeSymbol](Assert.Single(Assert.IsType[StructSymbol](current).TypeArguments))
            }
        )
        Assert.Same(program, oldCompilation.BoundProgram)
        Assert.False(newModel.TryGetStaticTypeQualifier(oldRoot, oldRoot.RightPart, out _, out _, out _))
        for var i = 0; i < nodes.Length; i++ {
            Assert.Same(oldTree, nodes[i].SyntaxTree)
            Assert.Same(parents[i], nodes[i].Parent)
        }
    }

    private func CreateQualifierModel(source string)(Compilation, SemanticModel, SyntaxTree) {
        let tree = SyntaxTree.Parse(SourceText.From(source, "qualifier-query.gs"))
        let compilation = Compilation(tree)
        Assert.Empty(compilation.GlobalScope.Diagnostics)
        Assert.Empty(compilation.BoundProgram.Diagnostics)
        return (compilation, compilation.GetSemanticModel(tree), tree)
    }

    private func QualifierInitializer(tree SyntaxTree, name string) AccessorExpressionSyntax ->
    Assert.IsType[AccessorExpressionSyntax](
        tree
            .Root
            .DescendantNodes()
            .OfType[VariableDeclarationSyntax]()
            .Single((declaration VariableDeclarationSyntax) -> declaration.Identifier.Text == name)
            .Initializer
    )

    private func QueryQualifier(model SemanticModel, root AccessorExpressionSyntax)(
        TypeSymbol,
        ExpressionSyntax,
        BoundExpression
    ) {
        Assert.True(
            model.TryGetStaticTypeQualifier(root, root.RightPart, out var type, out var qualifier, out var read)
        )
        return (type, qualifier, read)
    }

    @Fact
    func GetDeclaredSymbol_OnFunctionDeclaration_ReturnsFunctionSymbol() {
        let (model, tree) = CreateModel(Source)
        let declaration = NodesOfType[FunctionDeclarationSyntax](tree).First(
            (f FunctionDeclarationSyntax) -> f.Identifier.Text == "Add"
        )
        let symbol Symbol? = model.GetDeclaredSymbol(declaration)
        let function = Assert.IsType[FunctionSymbol](symbol)
        Assert.Equal("Add", function.Name)
        Assert.Contains(declaration, function.DeclaringSyntaxNodes)
    }

    @Fact
    func GetSymbolInfo_OnCallExpression_ResolvesInvokedFunction() {
        let (model, tree) = CreateModel(Source)
        let call = NodesOfType[CallExpressionSyntax](tree).First((c CallExpressionSyntax) -> c.Identifier.Text == "Add")
        let info = model.GetSymbolInfo(call)
        let function = Assert.IsType[FunctionSymbol](info.Symbol)
        Assert.Equal("Add", function.Name)
    }

    @Fact
    func GetTypeInfo_OnCallExpression_ReturnsInt32() {
        let (model, tree) = CreateModel(Source)
        let call = NodesOfType[CallExpressionSyntax](tree).First((c CallExpressionSyntax) -> c.Identifier.Text == "Add")
        let info = model.GetTypeInfo(call)
        Assert.NotNull(info.Type)
        Assert.Equal("int32", info.Type!!.Name)
    }

    @Fact
    func GetBoundNode_OnStatement_ReturnsBoundCounterpart() {
        let (model, tree) = CreateModel(Source)
        let declaration = NodesOfType[FunctionDeclarationSyntax](tree).First(
            (f FunctionDeclarationSyntax) -> f.Identifier.Text == "Add"
        )
        let call = NodesOfType[CallExpressionSyntax](tree).First((c CallExpressionSyntax) -> c.Identifier.Text == "Add")
        // The binder anchors call expressions; nodes it does not anchor (or
        // tokens) legitimately have no bound counterpart.
        Assert.NotNull(model.GetBoundNode(call))
        Assert.Null(model.GetBoundNode(declaration.Identifier))
    }

    @Fact
    func GetSymbolInfo_OnTheCallNodeOfAQualifiedCall_ResolvesTheInvokedFunction() {
        let (model, tree) = CreateModel(QualifiedCallSource)
        for name in[]string{"Wrap", "Twice", "Bare"} {
            let call = NodesOfType[CallExpressionSyntax](tree).Single(
                (c CallExpressionSyntax) -> c.Identifier.Text == name
            )
            let symbol Symbol? = model.GetSymbolInfo(call).Symbol
            // Each call node resolves to its OWN function: the qualified ones
            // must not collapse onto an enclosing call's symbol.
            let function = Assert.IsType[FunctionSymbol](symbol)
            Assert.Equal(name, function.Name)
            Assert.NotEmpty(function.DeclaringSyntaxNodes)
        }
    }

    @Fact
    func GetTypeInfo_AndGetBoundNode_AgreeOnBothCallShapes() {
        let (model, tree) = CreateModel(QualifiedCallSource)
        let qualified = NodesOfType[CallExpressionSyntax](tree).Single(
            (c CallExpressionSyntax) -> c.Identifier.Text == "Wrap"
        )
        let unqualified = NodesOfType[CallExpressionSyntax](tree).Single(
            (c CallExpressionSyntax) -> c.Identifier.Text == "Bare"
        )
        Assert.NotNull(model.GetBoundNode(qualified))
        Assert.NotNull(model.GetBoundNode(unqualified))
        Assert.Equal("int32", model.GetTypeInfo(qualified).Type?.Name)
        Assert.Equal("int32", model.GetTypeInfo(unqualified).Type?.Name)
        // The qualified call node borrows the answer of the accessor that
        // encloses it, and only of that accessor: the accessor's LEFT part is
        // a different node and keeps its own (absent) answer.
        let accessor = NodesOfType[AccessorExpressionSyntax](tree).Single(
            (a AccessorExpressionSyntax) -> object.ReferenceEquals(a.RightPart, qualified)
        )
        Assert.Same(model.GetBoundNode(accessor), model.GetBoundNode(qualified))
        Assert.Null(model.GetBoundNode(accessor.LeftPart))
    }

    @Fact
    func GetBoundNode_DoesNotInventAnAnswerForUnanchoredNodes() {
        // The guard rail for the qualified-call fallback: it is miss-only and
        // shape-specific, so nodes the binder does not anchor stay unanchored.
        let (model, tree) = CreateModel(QualifiedCallSource)
        for node in AllNodes(tree).OfType[TypeClauseSyntax]() {
            Assert.Null(model.GetBoundNode(node))
        }
        let declaration = NodesOfType[FunctionDeclarationSyntax](tree).First(
            (f FunctionDeclarationSyntax) -> f.Identifier.Text == "Use"
        )
        Assert.Null(model.GetBoundNode(declaration.Identifier))
    }

    @Fact
    func GetSemanticModel_CachesPerTree_AndRejectsForeignTrees() {
        let tree = SyntaxTree.Parse(SourceText.From(Source, "app.gs"))
        let compilation = Compilation(tree)
        let foreign = SyntaxTree.Parse(SourceText.From(Source, "foreign.gs"))
        Assert.Same(compilation.GetSemanticModel(tree), compilation.GetSemanticModel(tree))
        Assert.Throws[ArgumentException](
            func () object? {
                return compilation.GetSemanticModel(foreign)
            }
        )
    }

    @Fact
    func GetDeclaredSymbol_OnLocalDeclaration_ReturnsVariableSymbol() {
        let (model, tree) = CreateModel(Source)
        let declaredSymbols = AllNodes(tree)
            .Select((node SyntaxNode) -> model.GetDeclaredSymbol(node))
            .Where((symbol Symbol) -> symbol is VariableSymbol)
            .Cast[VariableSymbol]()
            .ToList()
        Assert.Contains(declaredSymbols, (v VariableSymbol) -> v.Name == "total")
        Assert.Contains(declaredSymbols, (v VariableSymbol) -> v.Name == "left")
    }

    @Fact
    func SyntaxWalker_VisitsEveryNodeDepthFirst() {
        let tree = SyntaxTree.Parse(SourceText.From(Source, "app.gs"))
        let collector = CollectingWalker()
        collector.Visit(tree.Root)
        Assert.Contains(collector.Nodes, (n SyntaxNode) -> n is CallExpressionSyntax)
        Assert.Contains(collector.Nodes, (n SyntaxNode) -> n is FunctionDeclarationSyntax)
        Assert.True(collector.TokenCount > 0)
        // Depth-first: a function declaration is visited before the call inside it.
        let declarationIndex = collector.Nodes.FindIndex((n SyntaxNode) -> n is FunctionDeclarationSyntax)
        let callIndex = collector.Nodes.FindIndex((n SyntaxNode) -> n is CallExpressionSyntax)
        Assert.True(declarationIndex < callIndex)
    }

    private class CollectingWalker : GSharpSyntaxWalker {
        init() {
            Nodes = List[SyntaxNode]()
        }

        prop Nodes List[SyntaxNode] {
            get;
        }

        prop TokenCount int32 {
            get;
            private set;
        }

        override func Visit(node SyntaxNode) {
            if node != nil && !(node is SyntaxToken) {
                Nodes.Add(node)
            }
            base.Visit(node)
        }

        override func VisitToken(token SyntaxToken) {
            TokenCount++
        }
    }

    shared {
        private const Source string = `package App
import System

func Add(left int32, right int32) int32 {
    return left + right
}

func Main() {
    var total = Add(1, 2)
    Console.WriteLine(total)
}
`

        /// A qualified call and an unqualified call to the same functions, so one
        /// model answers both shapes. G# splits `Form.Wrap(x)` across an
        /// (cref:AccessorExpressionSyntax) (which the binder anchors) and a
        /// nested (cref:CallExpressionSyntax) (which it does not); Roslyn
        /// has a single `InvocationExpressionSyntax` for both shapes, so an
        /// analyzer that walks for call nodes must get the same answer either way
        /// (issue #3822).
        private const QualifiedCallSource string = `package App

class Form {
    shared {
        func Wrap(value int32) int32 {
            return value + 1
        }

        func Twice(value int32) int32 {
            return value * 2
        }
    }
}

func Bare(value int32) int32 {
    return value
}

func Use(value int32) int32 {
    return Form.Twice(Form.Wrap(Bare(value)))
}
`

        private func CreateModel(source string)(Model SemanticModel, Tree SyntaxTree) {
            let tree = SyntaxTree.Parse(SourceText.From(source, "app.gs"))
            let compilation = Compilation(tree)
            Assert.Empty(compilation.GlobalScope.Diagnostics.Where((d Diagnostic) -> d.IsError))
            Assert.Empty(compilation.BoundProgram.Diagnostics.Where((d Diagnostic) -> d.IsError))
            return (compilation.GetSemanticModel(tree), tree)
        }

        private func NodesOfType[T SyntaxNode](tree SyntaxTree) IEnumerable[T] {
            let collector = CollectingWalker()
            collector.Visit(tree.Root)
            return collector.Nodes.OfType[T]()
        }

        private func AllNodes(tree SyntaxTree) sequence[SyntaxNode] {
            let pending = Stack[SyntaxNode]()
            pending.Push(tree.Root)
            while pending.Count > 0 {
                let node = pending.Pop()
                yield node
                for child in node.GetChildren() {
                    pending.Push(child)
                }
            }
        }
    }
}
