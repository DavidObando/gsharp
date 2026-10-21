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
import System.Collections.Immutable
import System.Linq
import System.Reflection
import System.Threading.Tasks
import Xunit

/// Covers the ADR-0169 (cref:SemanticModel) (syntax→symbol,
/// syntax→bound-node, syntax→type queries), (cref:Symbol.DeclaringSyntaxNodes),
/// and (cref:GSharpSyntaxWalker).
open class Adr0169SemanticModelTests {
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
    func OwnershipDiscovery_IsShared_AndOtherTreesDetailedIndexesStayLazy() {
        let trees = Enumerable
            .Range(0, 3)
            .Select(
            (i int32) -> SyntaxTree.Parse(
                SourceText.From("package App\nfunc F${i}(value int32) int32 { return value + ${i} }", "file${i}.gs")
            )
        )
            .ToArray()
        let compilation = Compilation(trees){IsLibrary = true}
        let functions = compilation.BoundProgram.Functions
        Assert.Equal(3, functions.Count)
        using let measurements = CompilationMeasurements.Start("semantic-test")
        let models = trees.Select((tree SyntaxTree) -> compilation.GetSemanticModel(tree)).ToArray()
        Assert.Equal(int64(0), measurements.GetCounter("semantic.index.builds"))
        Assert.Equal(int64(0), measurements.GetCounter("semantic.function.visits"))
        let first = NodesOfType[FunctionDeclarationSyntax](trees[0]).Single()
        let canonical = functions.Keys.Single((f FunctionSymbol) -> object.ReferenceEquals(f.Declaration, first))
        Assert.Same(canonical, models[0].GetDeclaredSymbol(first))
        Assert.Equal(int64(1), measurements.GetCounter("semantic.index.builds"))
        Assert.Equal(int64(1), measurements.GetCounter("semantic.index.bodies"))
        for i in Enumerable.Range(1, 2) {
            let declaration = NodesOfType[FunctionDeclarationSyntax](trees[i]).Single()
            Assert.NotNull(models[i].GetDeclaredSymbol(declaration))
        }
        Assert.Same(canonical, models[0].GetDeclaredSymbol(first))
        Assert.Equal(int64(3), measurements.GetCounter("semantic.index.builds"))
        Assert.Equal(int64(functions.Count), measurements.GetCounter("semantic.function.visits"))
        Assert.Equal(int64(functions.Count), measurements.GetCounter("semantic.declaration_function.visits"))
        Assert.Equal(int64(1), measurements.GetCounter("semantic.ownership.builds"))
    }

    @Fact
    func ConcurrentQueries_PublishOneOwnershipSnapshot_AndOneIndexPerTree() {
        let tree = SyntaxTree.Parse(SourceText.From(Source, "app.gs"))
        let otherTree = SyntaxTree.Parse(SourceText.From("package App\nfunc Other() int32 { return 42 }", "other.gs"))
        let compilation = Compilation(tree, otherTree)
        let functions = compilation.BoundProgram.Functions
        let declaration = NodesOfType[FunctionDeclarationSyntax](tree).First(
            (f FunctionDeclarationSyntax) -> f.Identifier.Text == "Add"
        )
        let canonical = functions.Keys.Single((f FunctionSymbol) -> object.ReferenceEquals(f.Declaration, declaration))
        using let measurements = CompilationMeasurements.Start("semantic-concurrent-test")
        Parallel.For(
            0,
            24,
            (i int32) -> {
                if i % 2 == 0 {
                    Assert.Same(canonical, compilation.GetSemanticModel(tree).GetDeclaredSymbol(declaration))
                } else {
                    let other = NodesOfType[FunctionDeclarationSyntax](otherTree).Single()
                    Assert.NotNull(compilation.GetSemanticModel(otherTree).GetDeclaredSymbol(other))
                }
            }
        )
        Assert.Equal(int64(1), measurements.GetCounter("semantic.ownership.builds"))
        Assert.Equal(int64(2), measurements.GetCounter("semantic.index.builds"))
    }

    @Fact
    func ProducerFacts_DoNotBuildSemanticMaps_AndFirstQueryAvoidsDeepDiscovery() {
        let left = SyntaxTree.Parse(
            SourceText.From("package App\nclass Left { prop Value int32 { get { return 1 } } }", "left.gs")
        )
        let right = SyntaxTree.Parse(
            SourceText.From("package App\nclass Right { prop Value int32 { get { return 2 } } }", "right.gs")
        )
        using let measurements = CompilationMeasurements.Start("semantic-producer-test")
        let compilation = Compilation(left, right){IsLibrary = true}
        let program = compilation.BoundProgram
        Assert.Empty(program.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.True(measurements.GetCounter("semantic.ownership.fact-roots.captured") >= int64(2))
        Assert.Equal(int64(0), measurements.GetCounter("semantic.ownership.builds"))
        Assert.Equal(int64(0), measurements.GetCounter("semantic.index.builds"))
        let property = program.Structs.Single((s StructSymbol) -> s.Name == "Left").Properties.Single()
        let declaration = property.DeclaringSyntaxNodes.Single()
        Assert.Same(left, declaration.SyntaxTree)
        Assert.Same(property, compilation.GetSemanticModel(left).GetDeclaredSymbol(declaration))
        let body = program
            .Functions
            .Single(
            (pair KeyValuePair[FunctionSymbol, BoundBlockStatement]) -> object.ReferenceEquals(
                pair.Key.AssociatedSymbol,
                property
            )
        )
            .Value
        let statement = body.Statements.OfType[BoundReturnStatement]().Single()
        Assert.Same(statement, compilation.GetSemanticModel(left).GetBoundNode(statement.Syntax!!))
        Assert.Equal(int64(1), measurements.GetCounter("semantic.index.builds"))
        Assert.True(measurements.GetCounter("semantic.ownership.fact-roots.reused") >= int64(2))
        Assert.Equal(int64(0), measurements.GetCounter("semantic.ownership.fallback-record-visits"))
    }

    @Fact
    func ProducerFacts_DeferComputedSymbolGetters_UntilCompletedProgram() {
        let firstTree = SyntaxTree.Parse(SourceText.From("package App\nclass Before { }", "before.gs"))
        let secondTree = SyntaxTree.Parse(SourceText.From("package App\nclass After { }", "after.gs"))
        let compilation = Compilation(firstTree, secondTree){IsLibrary = true}
        let program = compilation.BoundProgram
        let before = program.Structs.Single((s StructSymbol) -> s.Name == "Before")
        let after = program.Structs.Single((s StructSymbol) -> s.Name == "After")
        let function = FunctionSymbol("inferred", ImmutableArray[ParameterSymbol].Empty, before)
        let call = BoundCallExpression(nil, function, ImmutableArray[BoundExpression].Empty)
        let body = BoundBlockStatement(nil, ImmutableArray.Create[BoundStatement](BoundExpressionStatement(nil, call)))
        // A bound-graph fixture: the real Type getter follows the function's inferred return.
        SyntaxAnchoringWalker.Anchor(body, firstTree.Root)
        function.SetRichAnonymousReturnType(after)
        ReplaceBoundProgram(
            compilation,
            BoundProgram(
                program.EntryPointPackage,
                program.Packages,
                program.Diagnostics,
                ImmutableDictionary[FunctionSymbol, BoundBlockStatement].Empty.Add(function, body),
                nil,
                BoundBlockStatement(nil, ImmutableArray[BoundStatement].Empty)
            )
        )
        Assert.Same(after, compilation.GetSemanticModel(secondTree).GetDeclaredSymbol(after.Declaration!!))
        Assert.Null(compilation.GetSemanticModel(firstTree).GetDeclaredSymbol(before.Declaration!!))
    }

    @Fact
    func Reanchoring_InvalidatesFactsCollectedBeforeSyntaxWasAssigned() {
        let firstTree = SyntaxTree.Parse(SourceText.From("package App\nfunc First() int32 { return 1 }", "first.gs"))
        let secondTree = SyntaxTree.Parse(
            SourceText.From("package App\nfunc Second(value int32) int32 { return value }", "second.gs")
        )
        let compilation = Compilation(firstTree, secondTree){IsLibrary = true}
        let program = compilation.BoundProgram
        let parameter = program.Functions.Keys.Single((f FunctionSymbol) -> f.Name == "Second").Parameters.Single()
        let body = BoundBlockStatement(
            nil,
            ImmutableArray.Create[BoundStatement](
                BoundExpressionStatement(nil, BoundVariableExpression(nil, parameter))
            )
        )
        let _ = body.GetSourceOwnership()
        let anchor = NodesOfType[FunctionDeclarationSyntax](firstTree).Single()
        // This anchor suppresses producer collection, so invalidation must permit the same collector's fallback.
        SyntaxAnchoringWalker.Anchor(body, anchor)
        let owner = FunctionSymbol("synthesized", ImmutableArray[ParameterSymbol].Empty, TypeSymbol.Void)
        ReplaceBoundProgram(
            compilation,
            BoundProgram(
                program.EntryPointPackage,
                program.Packages,
                program.Diagnostics,
                ImmutableDictionary[FunctionSymbol, BoundBlockStatement].Empty.Add(owner, body),
                nil,
                BoundBlockStatement(nil, ImmutableArray[BoundStatement].Empty)
            )
        )
        Assert.Same(body, compilation.GetSemanticModel(firstTree).GetBoundNode(anchor))
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func DeclarationlessRoots_KeepAllTrees_AndUnanchoredSymbolDeclarations(topLevel bool) {
        let firstTree = SyntaxTree.Parse(
            SourceText.From("package App\nfunc First(value int32) int32 { return value }", "first.gs")
        )
        let secondTree = SyntaxTree.Parse(
            SourceText.From("package App\nfunc Second() int32 { var local = 2; return local }", "generated.g.gs")
        )
        let compilation = Compilation(firstTree, secondTree){IsLibrary = true}
        let program = compilation.BoundProgram
        Assert.Empty(program.Diagnostics.Where((d Diagnostic) -> d.IsError))
        let first = program.Functions.Keys.Single((f FunctionSymbol) -> f.Name == "First")
        let second = program.Functions.Keys.Single((f FunctionSymbol) -> f.Name == "Second")
        let parameter = first.Parameters.Single()
        // A bound-graph fixture, not a driver test: the first tree appears only in a symbol.
        // The only syntax anchors belong to the generated second tree.
        let reference = BoundVariableExpression(nil, parameter)
        let root = BoundBlockStatement(
            nil,
            ImmutableArray.Create[BoundStatement](BoundExpressionStatement(nil, reference), program.Functions[second])
        )
        let synthetic = FunctionSymbol("synthesized", ImmutableArray[ParameterSymbol].Empty, TypeSymbol.Void)
        let functions = if topLevel {
            ImmutableDictionary[FunctionSymbol, BoundBlockStatement].Empty
        } else {
            ImmutableDictionary[FunctionSymbol, BoundBlockStatement].Empty.Add(synthetic, root)
        }
        let replacement = BoundProgram(
            program.EntryPointPackage,
            program.Packages,
            program.Diagnostics,
            functions,
            nil,
            if topLevel {
                root
            } else {
                BoundBlockStatement(nil, ImmutableArray[BoundStatement].Empty)
            }
        )
        ReplaceBoundProgram(compilation, replacement)
        Assert.Same(
            parameter,
            compilation.GetSemanticModel(firstTree).GetDeclaredSymbol(parameter.DeclaringSyntaxNodes.Single())
        )
        let secondModel = compilation.GetSemanticModel(secondTree)
        let boundBody = program.Functions[second]
        Assert.Same(boundBody, secondModel.GetBoundNode(boundBody.Syntax!!))
        let local = boundBody.Statements.OfType[BoundVariableDeclaration]().Single().Variable
        Assert.Same(local, secondModel.GetDeclaredSymbol(local.DeclaringSyntaxNodes.Single()))
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
        private func ReplaceBoundProgram(compilation Compilation, program BoundProgram) {
            let field = Assert.IsAssignableFrom[FieldInfo](
                typeof(Compilation).GetField("boundProgram", BindingFlags.NonPublic | BindingFlags.Instance)
            )
            field.SetValue(compilation, program)
        }

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
