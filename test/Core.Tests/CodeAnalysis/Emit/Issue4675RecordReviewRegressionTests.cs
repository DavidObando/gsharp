// <copyright file="Issue4675RecordReviewRegressionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Immutable;
using System.Linq;
using System.Reflection;
using System.Text;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Emit;

public class Issue4675RecordReviewRegressionTests
{
    [Theory]
    [InlineData(4)]
    [InlineData(8)]
    [InlineData(12)]
    public void SharedChildInitializers_VisitEachOwnerExpressionOnce(int depth)
    {
        var source = new StringBuilder("""
            class Flags { shared { public var Recurse bool } }
            class Node0 { public var Marker int32 = 1 }

            """);
        for (var i = 1; i <= depth; i++)
        {
            source.AppendLine($"class Node{i} {{");
            source.AppendLine($"public var First Node{i - 1}? = Flags.Recurse ? Node{i - 1}{{}} : nil");
            source.AppendLine($"public var Second Node{i - 1}? = Flags.Recurse ? Node{i - 1}{{}} : nil");
            source.AppendLine("public var Marker int32 = 1");
            source.AppendLine("}");
        }

        source.AppendLine($"func Main() {{ let item = Node{depth}{{}} }}");
        var compilation = new Compilation(SyntaxTree.Parse(source.ToString()));
        Assert.Empty(compilation.GlobalScope.Diagnostics.Where(d => d.IsError));
        var program = compilation.BoundProgram;
        Assert.Empty(program.Diagnostics.Where(d => d.IsError));
        var analyzerType = typeof(BoundTreeWalker).Assembly.GetType("GSharp.Core.CodeAnalysis.Binding.ManagedReferenceSafetyAnalyzer");
        Assert.NotNull(analyzerType);
        var diagnostics = new DiagnosticBag();
        var analyzer = Assert.IsAssignableFrom<BoundTreeWalker>(Activator.CreateInstance(
            analyzerType, BindingFlags.Instance | BindingFlags.NonPublic, binder: null, args: new object[] { diagnostics }, culture: null));
        analyzer.Visit(program.Functions.Single(pair => pair.Key.Name == "Main").Value);
        Assert.Empty(diagnostics);
        var counter = analyzerType.GetProperty("InitializerVisitCount", BindingFlags.Instance | BindingFlags.NonPublic);
        Assert.NotNull(counter);
        Assert.Equal((3 * depth) + 1, Assert.IsType<int>(counter.GetValue(analyzer)));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void ConstructorInitializerCache_PreservesSameNamedPackageTypeIdentity(bool safeFirst)
    {
        var firstType = safeFirst ? "Safe.Payload" : "Required.Payload";
        var secondType = safeFirst ? "Required.Payload" : "Safe.Payload";
        var compilation = new Compilation(
            SyntaxTree.Parse("package Safe\npublic struct Payload { public var Value int32 }"),
            SyntaxTree.Parse("package Required\npublic struct Payload { public var Handle readonly managed[int32] }"),
            SyntaxTree.Parse($$"""
                package SameNamedOwners
                class Holder[T] { public var Saved T = default(T) }
                class Pair {
                    public var First Holder[{{firstType}}]
                    public var Second Holder[{{secondType}}]
                }
                class Outer {
                    public var Value Pair = Pair{
                        First: Holder[{{firstType}}]{},
                        Second: Holder[{{secondType}}]{},
                    }
                }
                func Main() { let outer = Outer{} }
                """));
        Assert.Empty(compilation.GlobalScope.Diagnostics.Where(d => d.IsError));
        var program = compilation.BoundProgram;
        var analyzerType = typeof(BoundTreeWalker).Assembly.GetType("GSharp.Core.CodeAnalysis.Binding.ManagedReferenceSafetyAnalyzer");
        Assert.NotNull(analyzerType);
        var diagnostics = new DiagnosticBag();
        var analyzer = Assert.IsAssignableFrom<BoundTreeWalker>(Activator.CreateInstance(
            analyzerType, BindingFlags.Instance | BindingFlags.NonPublic, binder: null, args: new object[] { diagnostics }, culture: null));
        analyzer.Visit(program.Functions.Single(pair => pair.Key.Name == "Main").Value);
        Assert.Contains(diagnostics, diagnostic => diagnostic.Id == "GS0604");
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void IndirectDataBaseEquality_ComparesInheritedState(bool generic)
    {
        var result = EmittedOracle.Evaluate("""
            data class Child(Own int32) : MiddleTYPE
            open class MiddlePARAM : BasePARENT
            open data class BasePARAM : IEquatable[BasePARAM] { public var BaseValue int32 }
            Child(7)
            """.Replace("TYPE", generic ? "[int32]" : string.Empty, StringComparison.Ordinal)
                .Replace("PARAM", generic ? "[T]" : string.Empty, StringComparison.Ordinal)
                .Replace("PARENT", generic ? "[T]" : string.Empty, StringComparison.Ordinal));
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.NotNull(result.Value);
        var type = result.Value.GetType();
        var other = Activator.CreateInstance(type, new object[] { 7 });
        var dataBase = type.BaseType.BaseType;
        var field = dataBase.GetField("BaseValue");
        Assert.NotNull(field);
        field.SetValue(result.Value, 1);
        field.SetValue(other, 2);
        var baseEquality = typeof(IEquatable<>).MakeGenericType(dataBase).GetMethod("Equals");
        Assert.NotNull(baseEquality);
        Assert.Equal(false, baseEquality.Invoke(result.Value, new[] { other }));
        Assert.False(result.Value.Equals(other));
        field.SetValue(other, 1);
        Assert.Equal(true, baseEquality.Invoke(result.Value, new[] { other }));
        Assert.True(result.Value.Equals(other));
    }

    [Theory]
    [InlineData("data struct")]
    [InlineData("data class")]
    public void CompositeBeforePositionalMember_ReportsEvaluationOrderDiagnostic(string kind)
    {
        var result = EmittedOracle.Evaluate($$"""
            import System.Collections.Generic
            {{kind}} Pair(A int32) {
                public var Items List[int32] = List[int32]()
                public func Add(value int32) { Items.Add(value) }
            }
            Pair{Items: {1}, A: 2}
            """);

        Assert.Contains(result.Diagnostics, diagnostic => diagnostic.Id == "GS0622");
        Assert.Null(result.UnhandledException);
    }

    [Fact]
    public void PositionalLiteral_UsesPrimaryParameterNullability()
    {
        var result = EmittedOracle.Evaluate("""
            data class Item(Value string) {
                private let Storage string = Value
                public prop Value string? {
                    get { return Storage }
                    init { }
                }
            }
            Item{Value: nil}
            """);

        Assert.Contains(result.Diagnostics, diagnostic => diagnostic.Id == "GS0155");
        Assert.Null(result.UnhandledException);
    }

    [Fact]
    public void OmittedPositionalSlice_UsesSoundZeroValue()
    {
        var result = EmittedOracle.Evaluate("""
            data struct Bag(Items []int32)
            Bag{}.Items.Length
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(0, result.Value);
    }

    [Fact]
    public void NearestPropertyWinsOverInheritedFieldForAssignmentAndRead()
    {
        var result = EmittedOracle.Evaluate("""
            open class Base { public var Value int32 = 1 }
            class Derived : Base {
                private var current int32
                public prop Value int32 {
                    get { return current }
                    set { current = value }
                }
            }
            let item = Derived()
            item.Value = 7
            item.Value
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(7, result.Value);
    }

    [Fact]
    public void NearestPropertyWinsForEffectfulMemberAssignment()
    {
        var result = EmittedOracle.Evaluate("""
            class Counter { shared { public var Count int32 } }
            open class Base { public var Value int32 = 1 }
            class Derived : Base {
                private var current int32
                public prop Value int32 {
                    get { return current }
                    set { current = value }
                }
                public func ReadBase() int32 -> base.Value
            }
            func GetItem() Derived {
                Counter.Count += 1
                return item
            }
            let item = Derived()
            GetItem().Value = 7
            Counter.Count * 100 + item.Value * 10 + item.ReadBase()
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(171, result.Value);
    }

    [Fact]
    public void NearestInitPropertyWinsForInitializerSuffix()
    {
        var result = EmittedOracle.Evaluate("""
            open class Base { public var Value int32 = 1 }
            class Derived : Base {
                public prop Value int32 { get; init; }
                public func ReadBase() int32 -> base.Value
            }
            let item = Derived(){ Value = 7 }
            item.Value * 10 + item.ReadBase()
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(71, result.Value);
    }

    [Fact]
    public void ConstructedGenericZeroSynthesis_RemainsLinearEnoughForDeepChains()
    {
        const int depth = 24;
        var source = new StringBuilder("import System.Collections.Generic\n");
        source.AppendLine("struct Node0[T] {\nprivate var Values List[int32]\n}");
        for (var index = 1; index <= depth; index++)
        {
            source.AppendLine($"struct Node{index}[T] {{\npublic var Child Node{index - 1}[T]\nprivate var Values List[int32]\n}}");
        }

        source.AppendLine($"var value Node{depth}[int32]");
        var result = EmittedOracle.Evaluate(source.ToString());
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
    }

    [Fact]
    public void SealedIntermediaryDataEqualityOverride_IsRejectedBeforeEmission()
    {
        var result = EmittedOracle.Evaluate("""
            open data class Base : IEquatable[Base]
            open class Middle : Base {
                public override func Equals(other Base?) bool -> false
            }
            data class Child : Middle
            Child()
            """);

        var diagnostic = Assert.Single(result.Diagnostics, d => d.Id == "GS0184");
        Assert.Contains("Equals", diagnostic.Message, StringComparison.Ordinal);
        Assert.Null(result.UnhandledException);
        Assert.Null(result.Value);
    }

    [Fact]
    public void OpenIntermediaryDataEqualityOverride_IsRejectedBeforeEmission()
    {
        var result = EmittedOracle.Evaluate("""
            open data class Root(Tag int32) : IEquatable[Root]
            open class Middle : Root {
                public open override func Equals(other Root?) bool -> true
            }
            data class Leaf(Value int32) : Middle
            Leaf(1)
            """);

        Assert.Contains(result.Diagnostics, diagnostic => diagnostic.Id == "GS0184");
        Assert.Null(result.UnhandledException);
    }

    [Fact]
    public void SealedImportedRecordEqualityOverride_IsRejectedBeforeEmission()
    {
        using var fixture = new CSharpFixture("""
            namespace ImportedEquality;
            public record Root;
            """);
        using var references = fixture.RuntimeReferences();
        var compilation = new Compilation(references, SyntaxTree.Parse("""
            package ImportedEquality
            open class Middle : Root {
                public override func Equals(other Root?) bool -> false
            }
            data class Child : Middle
            """)) { IsLibrary = true };

        var diagnostics = EmittedOracle.CompileDiagnostics(compilation);
        var diagnostic = Assert.Single(diagnostics, d => d.Id == "GS0184");
        Assert.Contains("Equals", diagnostic.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void SealedConstructedGenericEqualityOverride_IsRejectedBeforeEmission()
    {
        var result = EmittedOracle.Evaluate("""
            open data class Base[T] : IEquatable[Base[T]]
            open class Middle[T] : Base[T] {
                public override func Equals(other Base[T]?) bool -> false
            }
            data class Child : Middle[int32]
            Child()
            """);

        var diagnostic = Assert.Single(result.Diagnostics, d => d.Id == "GS0184");
        Assert.Contains("Equals", diagnostic.Message, StringComparison.Ordinal);
        Assert.Null(result.UnhandledException);
        Assert.Null(result.Value);
    }

    [Fact]
    public void SealedByRefEqualityOverload_DoesNotBlockDataEquality()
    {
        var result = EmittedOracle.Evaluate("""
            open data class Base : IEquatable[Base]
            open class OverloadOwner : Base {
                open func Equals(ref other Base?) bool -> true
            }
            open class Middle : OverloadOwner {
                public override func Equals(ref other Base?) bool -> false
            }
            data class Child : Middle
            Child()
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.NotNull(result.Value);
    }

    [Fact]
    public void EqualityBlockerPredicate_RequiresNonGenericByValueReturn()
    {
        var method = new FunctionSymbol(
            "Equals",
            ImmutableArray.Create(new ParameterSymbol("other", TypeSymbol.String)),
            TypeSymbol.Bool,
            declaration: null,
            package: null,
            Accessibility.Public,
            receiverType: null,
            isOpen: false,
            isOverride: true);

        method.TypeParameters = ImmutableArray.Create(
            new TypeParameterSymbol("T", 0, TypeParameterConstraint.Any, TypeParameterVariance.None));
        Assert.False(DataEqualityMemberModel.IsSealedIntermediaryEqualityOverride(method, TypeSymbol.String));

        method.TypeParameters = ImmutableArray<TypeParameterSymbol>.Empty;
        method.ReturnRefKind = RefKind.Ref;
        Assert.False(DataEqualityMemberModel.IsSealedIntermediaryEqualityOverride(method, TypeSymbol.String));

        method.ReturnRefKind = RefKind.None;
        Assert.True(DataEqualityMemberModel.IsSealedIntermediaryEqualityOverride(method, TypeSymbol.String));
    }

    [Theory]
    [InlineData(false, false)]
    [InlineData(false, true)]
    [InlineData(true, false)]
    [InlineData(true, true)]
    public void PositionalLiteral_DoesNotConsumeHiddenInheritedField(bool tree, bool generic)
    {
        var source = """
            import System
            import System.Linq.Expressions
            open class BasePARAM { public var Value FIELD }
            data class Child(Value int32) : BaseTYPE
            CONSTRUCTION
            """.Replace("PARAM", generic ? "[T]" : string.Empty, StringComparison.Ordinal)
                .Replace("FIELD", generic ? "T" : "string", StringComparison.Ordinal)
                .Replace("TYPE", generic ? "[string]" : string.Empty, StringComparison.Ordinal)
                .Replace("CONSTRUCTION", tree
                    ? "let expression Expression[Func[Child]] = () -> Child{Value: \"hello\"}\nexpression.Compile()()"
                    : "Child{Value: \"hello\"}", StringComparison.Ordinal);
        var result = EmittedOracle.Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.NotNull(result.Value);
        var type = result.Value.GetType();
        var field = type.BaseType.GetField("Value");
        var property = type.GetProperty("Value");
        Assert.NotNull(field);
        Assert.NotNull(property);
        Assert.Equal("hello", field.GetValue(result.Value));
        Assert.Equal(0, property.GetValue(result.Value));
    }

    [Theory]
    [InlineData(false, false)]
    [InlineData(false, true)]
    [InlineData(true, false)]
    [InlineData(true, true)]
    public void PositionalLiteral_HiddenInheritedFieldKeepsCollectionOrder(bool content, bool generic)
    {
        var source = """
            import System.Collections.Generic
            class Counter {
                shared {
                    public var Count int32
                    public func Next() int32 {
                        Count += 1
                        return Count
                    }
                }
            }
            open class BasePARAM { public var Value FIELD }
            data class Child(Value int32) : BaseTYPE {
                public var Items List[int32] = List[int32]()
                public func Add(value int32) { Items.Add(value) }
            }
            Child{ENTRY, Value: Counter.Next()}
            """.Replace("PARAM", generic ? "[T]" : string.Empty, StringComparison.Ordinal)
                .Replace("FIELD", generic ? "T" : "int32", StringComparison.Ordinal)
                .Replace("TYPE", generic ? "[int32]" : string.Empty, StringComparison.Ordinal)
                .Replace("ENTRY", content ? "Items: List[int32](), Counter.Next()" : "Items: {Counter.Next()}", StringComparison.Ordinal);
        var result = EmittedOracle.Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.NotNull(result.Value);
        var type = result.Value.GetType();
        var field = type.BaseType.GetField("Value");
        var property = type.GetProperty("Value");
        var itemsField = type.GetField("Items");
        Assert.NotNull(field);
        Assert.NotNull(property);
        Assert.NotNull(itemsField);
        Assert.Equal(2, field.GetValue(result.Value));
        Assert.Equal(0, property.GetValue(result.Value));
        var items = Assert.IsType<System.Collections.Generic.List<int>>(itemsField.GetValue(result.Value));
        Assert.Equal(1, Assert.Single(items));
    }

    [Fact]
    public void StructLiteral_PreservesThreeParameterClrConstructor()
    {
        Assert.NotNull(typeof(BoundStructLiteralExpression).GetConstructor(new[]
        {
            typeof(SyntaxNode),
            typeof(StructSymbol),
            typeof(ImmutableArray<BoundFieldInitializer>),
        }));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void PositionalLiteral_RewrittenDeclaredInitializerRunsOnce(bool ordered)
    {
        var result = EmittedOracle.Evaluate("""
            import System.Collections.Generic
            class Counter {
                shared {
                    public var Values []int32 = []int32{0}
                    public var Count int32
                    public func Next() int32 {
                        Count += 1
                        return Count
                    }
                }
            }
            data struct Item(Value int32) {
                public var Marker int32 = (Counter.Values[0] = Counter.Next())
                public var Items List[int32] = List[int32]()
            }
            let item = Item{Value: 7SUFFIX}
            Counter.Count * 100 + item.Marker * 10 + Counter.Values[0]
            """.Replace("SUFFIX", ordered ? ", Items: {1}" : string.Empty, StringComparison.Ordinal));
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(111, result.Value);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void ForwardEmittedBaseEquality_ComparesInheritedState(bool generic)
    {
        var result = EmittedOracle.Evaluate("""
            data class Child(Own int32) : BaseTYPE
            open data class BasePARAM : IEquatable[BasePARAM] { public var BaseValue int32 }
            Child(7)
            """.Replace("TYPE", generic ? "[int32]" : string.Empty, StringComparison.Ordinal)
                .Replace("PARAM", generic ? "[T]" : string.Empty, StringComparison.Ordinal));
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.NotNull(result.Value);
        var type = result.Value.GetType();
        var other = Activator.CreateInstance(type, new object[] { 7 });
        var field = type.BaseType.GetField("BaseValue");
        Assert.NotNull(field);
        field.SetValue(result.Value, 1);
        field.SetValue(other, 2);
        Assert.False(result.Value.Equals(other));
        var baseEquality = typeof(IEquatable<>).MakeGenericType(type.BaseType).GetMethod("Equals");
        Assert.NotNull(baseEquality);
        Assert.Equal(false, baseEquality.Invoke(result.Value, new[] { other }));
        field.SetValue(other, 1);
        Assert.True(result.Value.Equals(other));
        Assert.Equal(true, baseEquality.Invoke(result.Value, new[] { other }));
    }

    [Fact]
    public void SelfEquality_DoesNotOverrideUndeclaredInheritedOverload()
    {
        var result = EmittedOracle.Evaluate("""
            open class Base {
                public open func Equals(other Derived) bool -> false
            }
            data class Derived(Value int32) : Base
            let derived = Derived(7)
            let parent Base = derived
            parent.Equals(Derived(7))
            """);
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(false, result.Value);
    }

    [Theory]
    [InlineData("data struct")]
    [InlineData("data class")]
    public void StagedPositionalLiteral_RemainsAvailableInExpressionTrees(string kind)
    {
        var result = EmittedOracle.Evaluate("""
            import System
            import System.Linq.Expressions
            KIND Point(X int32)
            let expression Expression[Func[Point]] = () -> Point{X: 1}
            expression.Compile()().X
            """.Replace("KIND", kind, StringComparison.Ordinal));
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(1, result.Value);
    }

    [Theory]
    [InlineData("data struct")]
    [InlineData("data class")]
    public void ExpressionTreeLiteral_PreservesWrittenOrderAndConstructorScope(string kind)
    {
        var result = EmittedOracle.Evaluate("""
            import System
            import System.Linq.Expressions
            class Counter {
                shared {
                    public var Count int32
                    public func Next() int32 {
                        Count += 1
                        return Count
                    }
                }
            }
            KIND Pair(A int32, B int32) {
                private let Marker int32 = A * 10 + B
                public var Extra int32
                public func Read() int32 -> Marker * 10 + Extra
            }
            let expression Expression[Func[int32, Pair]] = (offset int32) ->
                Pair{Extra: Counter.Next(), B: Counter.Next(), A: Counter.Next() + offset}
            let compiled = expression.Compile()
            let before = Counter.Count
            let first = compiled(1)
            let second = compiled(1)
            before * 1000000 + first.Read() * 1000 + second.Read()
            """.Replace("KIND", kind, StringComparison.Ordinal));
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(421754, result.Value);
    }

    [Theory]
    [InlineData("data struct")]
    [InlineData("data class")]
    public void ExpressionTreeLiteral_PreservesGenericDefaultsAndPropertyUpdates(string kind)
    {
        var result = EmittedOracle.Evaluate("""
            import System
            import System.Linq.Expressions
            class Counter {
                shared {
                    public var Count int32
                    public func Next() int32 {
                        Count += 1
                        return Count
                    }
                }
            }
            KIND Pair[T](A T, B int32) {
                private let Marker int32 = Counter.Next()
                public prop Extra int32 { get; init; }
                public func Read() int32 -> Marker * 100 + B * 10 + Extra
            }
            let expression Expression[Func[Pair[int32]]] = () ->
                Pair[int32]{Extra: Counter.Next(), A: Counter.Next()}
            let compiled = expression.Compile()
            let before = Counter.Count
            let first = compiled()
            let second = compiled()
            before * 1000000 + first.Read() * 1000 + second.Read() + first.A * 10 + second.A
            """.Replace("KIND", kind, StringComparison.Ordinal));
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(301629, result.Value);
    }
}
