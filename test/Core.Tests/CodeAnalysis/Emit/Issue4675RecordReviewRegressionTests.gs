// <copyright file="Issue4675RecordReviewRegressionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Emit

import System
import System.Collections.Immutable
import System.Linq
import System.Reflection
import System.Text
import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Tests
import Xunit
import GSharp.Core.Tests
import System.Collections.Generic

open class Issue4675RecordReviewRegressionTests {
    @Fact
    func NativeBodyDataClass_WithSelfEquatable_RetainsDeconstruct() {
        let result = EmittedOracle.Evaluate(`import System
data class Body : IEquatable[Body] { public var Value int32 }
Body{}`)
        Assert.Empty(result.Diagnostics)
        Assert.NotNull(result.Value)
        Assert.NotNull(result.Value!!.GetType().GetMethod("Deconstruct"))
    }

    @Fact
    func PrimaryOnlyDataBase_ImplicitCallMaterializesOptionalDefault() {
        let result = EmittedOracle.Evaluate(`open data class Base(Value int32 = 7) {
    public func GetValue() int32 -> Value
}
class Derived : Base
Derived().GetValue()`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(7, result.Value)
    }

    @Fact
    func PrimaryOnlyDataBase_ImplicitCallDiagnosesMissingRequiredArgument() {
        let result = EmittedOracle.Evaluate(`open data class Base(Value int32)
class Derived : Base
Derived()`)
        Assert.Contains(result.Diagnostics, (diagnostic Diagnostic) -> diagnostic.Id == "GS0214")
    }

    @Fact
    func PrimaryOnlyDataBase_ExplicitDerivedInitMaterializesOptionalDefault() {
        let result = EmittedOracle.Evaluate(`open data class Base(Value int32 = 7) {
    public func GetValue() int32 -> Value
}
class Derived : Base {
    init() { }
}
Derived().GetValue()`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(7, result.Value)
    }

    @Fact
    func PrimaryOnlyDataBase_ExplicitDerivedInitDiagnosesMissingRequiredArgument() {
        let result = EmittedOracle.Evaluate(`open data class Base(Value int32)
class Derived : Base {
    init() { }
}
Derived()`)
        Assert.Contains(result.Diagnostics, (diagnostic Diagnostic) -> diagnostic.Id == "GS0214")
    }

    @Fact
    func OrdinaryPrimaryClass_RetainsDefaultAndPrimaryConstructors() {
        let result = EmittedOracle.Evaluate(`open class Base(Value int32) {
    public func GetValue() int32 -> Value
}
class Derived : Base
Base(42).GetValue() + Derived().GetValue()`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(42, result.Value)
    }

    @Theory
    @InlineData(int32(4))
    @InlineData(int32(8))
    @InlineData(int32(12))
    func SharedChildInitializers_VisitEachOwnerExpressionOnce(depth int32) {
        let source = StringBuilder(`class Flags { shared { public var Recurse bool } }
class Node0 { public var Marker int32 = 1 }
`)
        for var i = 1; i <= depth; i++ {
            source.AppendLine("class Node$i {")
            source.AppendLine("public var First Node${i - 1}? = Flags.Recurse ? Node${i - 1}{} : nil")
            source.AppendLine("public var Second Node${i - 1}? = Flags.Recurse ? Node${i - 1}{} : nil")
            source.AppendLine("public var Marker int32 = 1")
            source.AppendLine("}")
        }
        source.AppendLine("func Main() { let item = Node$depth{} }")
        let compilation = Compilation(SyntaxTree.Parse(source.ToString()))
        Assert.Empty(compilation.GlobalScope.Diagnostics.Where((d Diagnostic) -> d.IsError))
        let program = compilation.BoundProgram
        Assert.Empty(program.Diagnostics.Where((d Diagnostic) -> d.IsError))
        let analyzerType Type? = typeof(BoundTreeWalker).Assembly.GetType(
            "GSharp.Core.CodeAnalysis.Binding.ManagedReferenceSafetyAnalyzer"
        )
        Assert.NotNull(analyzerType)
        let diagnostics = DiagnosticBag()
        let analyzer = Assert.IsAssignableFrom[BoundTreeWalker](
            Activator.CreateInstance(
                analyzerType!!,
                BindingFlags.Instance | BindingFlags.NonPublic,
                binder: nil,
                args: []object{diagnostics},
                culture: nil
            )
        )
        analyzer.Visit(
            program
                .Functions
                .Single((pair KeyValuePair[FunctionSymbol, BoundBlockStatement]) -> pair.Key.Name == "Main")
                .Value
        )
        Assert.Empty(diagnostics)
        let counter PropertyInfo? = analyzerType!!.GetProperty(
            "InitializerVisitCount",
            BindingFlags.Instance | BindingFlags.NonPublic
        )
        Assert.NotNull(counter)
        Assert.Equal((3 * depth) + 1, Assert.IsType[int32](counter!!.GetValue(analyzer)))
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func ConstructorInitializerCache_PreservesSameNamedPackageTypeIdentity(safeFirst bool) {
        let firstType = if safeFirst {
            "Safe.Payload"
        } else {
            "Required.Payload"
        }
        let secondType = if safeFirst {
            "Required.Payload"
        } else {
            "Safe.Payload"
        }
        let compilation = Compilation(
            SyntaxTree.Parse("package Safe\npublic struct Payload { public var Value int32 }"),
            SyntaxTree.Parse("package Required\npublic struct Payload { public var Handle readonly managed[int32] }"),
            SyntaxTree.Parse((`package SameNamedOwners
class Holder[T] { public var Saved T = default(T) }
class Pair {
    public var First Holder[` + "$firstType" + `]
    public var Second Holder[` + "$secondType" + `]
}
class Outer {
    public var Value Pair = Pair{
        First: Holder[` + "$firstType" + `]{},
        Second: Holder[` + "$secondType" + `]{},
    }
}
func Main() { let outer = Outer{} }`))
        )
        Assert.Empty(compilation.GlobalScope.Diagnostics.Where((d Diagnostic) -> d.IsError))
        let program = compilation.BoundProgram
        let analyzerType Type? = typeof(BoundTreeWalker).Assembly.GetType(
            "GSharp.Core.CodeAnalysis.Binding.ManagedReferenceSafetyAnalyzer"
        )
        Assert.NotNull(analyzerType)
        let diagnostics = DiagnosticBag()
        let analyzer = Assert.IsAssignableFrom[BoundTreeWalker](
            Activator.CreateInstance(
                analyzerType!!,
                BindingFlags.Instance | BindingFlags.NonPublic,
                binder: nil,
                args: []object{diagnostics},
                culture: nil
            )
        )
        analyzer.Visit(
            program
                .Functions
                .Single((pair KeyValuePair[FunctionSymbol, BoundBlockStatement]) -> pair.Key.Name == "Main")
                .Value
        )
        Assert.Contains(diagnostics, (diagnostic Diagnostic) -> diagnostic.Id == "GS0604")
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func IndirectDataBaseEquality_ComparesInheritedState(generic bool) {
        let result = EmittedOracle.Evaluate(`data class Child(Own int32) : MiddleTYPE
open class MiddlePARAM : BasePARENT
open data class BasePARAM : IEquatable[BasePARAM] { public var BaseValue int32 }
Child(7)`.Replace(
                "TYPE",
                if generic {
                    "[int32]"
                } else {
                    string.Empty
                },
                StringComparison.Ordinal
            ).Replace(
                "PARAM",
                if generic {
                    "[T]"
                } else {
                    string.Empty
                },
                StringComparison.Ordinal
            ).Replace(
                "PARENT",
                if generic {
                    "[T]"
                } else {
                    string.Empty
                },
                StringComparison.Ordinal
            ))
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.NotNull(result.Value)
        let type = result.Value!!.GetType()
        let other object? = Activator.CreateInstance(type, []object{7})
        let dataBase Type? = type.BaseType!!.BaseType
        let field FieldInfo? = dataBase!!.GetField("BaseValue")
        Assert.NotNull(field)
        field!!.SetValue(result.Value, 1)
        field!!.SetValue(other, 2)
        let baseEquality MethodInfo? = typeof(IEquatable[_]).MakeGenericType(dataBase!!).GetMethod("Equals")
        Assert.NotNull(baseEquality)
        Assert.Equal(false, baseEquality!!.Invoke(result.Value, []object{other}))
        Assert.False(result.Value!!.Equals(other))
        field!!.SetValue(other, 1)
        Assert.Equal(true, baseEquality!!.Invoke(result.Value, []object{other}))
        Assert.True(result.Value!!.Equals(other))
    }

    @Theory
    @InlineData("data struct")
    @InlineData("data class")
    func CompositeBeforePositionalMember_ReportsEvaluationOrderDiagnostic(kind string) {
        let result = EmittedOracle.Evaluate((`import System.Collections.Generic
` + "$kind" + ` Pair(A int32) {
    public var Items List[int32] = List[int32]()
    public func Add(value int32) { Items.Add(value) }
}
Pair{Items: {1}, A: 2}`))
        Assert.Contains(result.Diagnostics, (diagnostic Diagnostic) -> diagnostic.Id == "GS0622")
        Assert.Null(result.UnhandledException)
    }

    @Fact
    func PositionalLiteral_UsesPrimaryParameterNullability() {
        let result = EmittedOracle.Evaluate(`data class Item(Value string) {
    private let Storage string = Value
    public prop Value string? {
        get { return Storage }
        init { }
    }
}
Item{Value: nil}`)
        Assert.Contains(result.Diagnostics, (diagnostic Diagnostic) -> diagnostic.Id == "GS0155")
        Assert.Null(result.UnhandledException)
    }

    @Fact
    func OmittedPositionalSlice_UsesSoundZeroValue() {
        let result = EmittedOracle.Evaluate("data struct Bag(Items []int32)\nBag{}.Items.Length")
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(0, result.Value)
    }

    @Fact
    func NearestPropertyWinsOverInheritedFieldForAssignmentAndRead() {
        let result = EmittedOracle.Evaluate(`open class Base { public var Value int32 = 1 }
class Derived : Base {
    private var current int32
    public prop Value int32 {
        get { return current }
        set { current = value }
    }
}
let item = Derived()
item.Value = 7
item.Value`)
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(7, result.Value)
    }

    @Fact
    func NearestPropertyWinsForEffectfulMemberAssignment() {
        let result = EmittedOracle.Evaluate(`class Counter { shared { public var Count int32 } }
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
Counter.Count * 100 + item.Value * 10 + item.ReadBase()`)
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(171, result.Value)
    }

    @Fact
    func NearestInitPropertyWinsForInitializerSuffix() {
        let result = EmittedOracle.Evaluate(`open class Base { public var Value int32 = 1 }
class Derived : Base {
    public prop Value int32 { get; init; }
    public func ReadBase() int32 -> base.Value
}
let item = Derived(){ Value = 7 }
item.Value * 10 + item.ReadBase()`)
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(71, result.Value)
    }

    @Fact
    func ConstructedGenericZeroSynthesis_RemainsLinearEnoughForDeepChains() {
        const depth = 24
        let source = StringBuilder("import System.Collections.Generic\n")
        source.AppendLine(`struct Node0[T] {
private var Values List[int32]
}`)
        for var index = 1; index <= depth; index++ {
            source.AppendLine((`struct Node` + "$index" + `[T] {
public var Child Node` + "${index - 1}" + `[T]
private var Values List[int32]
}`))
        }
        source.AppendLine("var value Node$depth[int32]")
        let result = EmittedOracle.Evaluate(source.ToString())
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
    }

    @Fact
    func SealedIntermediaryDataEqualityOverride_IsRejectedBeforeEmission() {
        let result = EmittedOracle.Evaluate(`open data class Base : IEquatable[Base]
open class Middle : Base {
    public override func Equals(other Base?) bool -> false
}
data class Child : Middle
Child()`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0184")
        Assert.Contains("Equals", diagnostic.Message, StringComparison.Ordinal)
        Assert.Null(result.UnhandledException)
        Assert.Null(result.Value)
    }

    @Fact
    func OpenIntermediaryDataEqualityOverride_IsRejectedBeforeEmission() {
        let result = EmittedOracle.Evaluate(`open data class Root(Tag int32) : IEquatable[Root]
open class Middle : Root {
    public open override func Equals(other Root?) bool -> true
}
data class Leaf(Value int32) : Middle
Leaf(1)`)
        Assert.Contains(result.Diagnostics, (diagnostic Diagnostic) -> diagnostic.Id == "GS0184")
        Assert.Null(result.UnhandledException)
    }

    @Fact
    func SealedImportedRecordEqualityOverride_IsRejectedBeforeEmission() {
        using let fixture = CSharpFixture("namespace ImportedEquality;\npublic record Root;")
        using let references = fixture.RuntimeReferences()
        let compilation = Compilation(references, SyntaxTree.Parse(`package ImportedEquality
open class Middle : Root {
    public override func Equals(other Root?) bool -> false
}
data class Child : Middle`)){IsLibrary = true}
        let diagnostics = EmittedOracle.CompileDiagnostics(compilation)
        let diagnostic = Assert.Single(diagnostics, (d Diagnostic) -> d.Id == "GS0184")
        Assert.Contains("Equals", diagnostic.Message, StringComparison.Ordinal)
    }

    @Fact
    func SealedConstructedGenericEqualityOverride_IsRejectedBeforeEmission() {
        let result = EmittedOracle.Evaluate(`open data class Base[T] : IEquatable[Base[T]]
open class Middle[T] : Base[T] {
    public override func Equals(other Base[T]?) bool -> false
}
data class Child : Middle[int32]
Child()`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0184")
        Assert.Contains("Equals", diagnostic.Message, StringComparison.Ordinal)
        Assert.Null(result.UnhandledException)
        Assert.Null(result.Value)
    }

    @Fact
    func SealedByRefEqualityOverload_DoesNotBlockDataEquality() {
        let result = EmittedOracle.Evaluate(`open data class Base : IEquatable[Base]
open class OverloadOwner : Base {
    open func Equals(ref other Base?) bool -> true
}
open class Middle : OverloadOwner {
    public override func Equals(ref other Base?) bool -> false
}
data class Child : Middle
Child()`)
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.NotNull(result.Value)
    }

    @Fact
    func EqualityBlockerPredicate_RequiresNonGenericByValueReturn() {
        let method = FunctionSymbol(
            "Equals",
            ImmutableArray.Create(ParameterSymbol("other", TypeSymbol.String)),
            TypeSymbol.Bool,
            declaration: nil,
            $package: nil,
            Accessibility.Public,
            receiverType: nil,
            isOpen: false,
            isOverride: true
        )
        method.TypeParameters = ImmutableArray.Create(
            TypeParameterSymbol("T", 0, TypeParameterConstraint.Any, TypeParameterVariance.None)
        )
        Assert.False(DataEqualityMemberModel.IsSealedIntermediaryEqualityOverride(method, TypeSymbol.String))
        method.TypeParameters = ImmutableArray[TypeParameterSymbol].Empty
        method.ReturnRefKind = RefKind.Ref
        Assert.False(DataEqualityMemberModel.IsSealedIntermediaryEqualityOverride(method, TypeSymbol.String))
        method.ReturnRefKind = RefKind.None
        Assert.True(DataEqualityMemberModel.IsSealedIntermediaryEqualityOverride(method, TypeSymbol.String))
    }

    @Theory
    @InlineData(false, false)
    @InlineData(false, true)
    @InlineData(true, false)
    @InlineData(true, true)
    func PositionalLiteral_DoesNotConsumeHiddenInheritedField(tree bool, generic bool) {
        let source = `import System
import System.Linq.Expressions
open class BasePARAM { public var Value FIELD }
data class Child(Value int32) : BaseTYPE
CONSTRUCTION`.Replace(
            "PARAM",
            if generic {
                "[T]"
            } else {
                string.Empty
            },
            StringComparison.Ordinal
        ).Replace(
            "FIELD",
            if generic {
                "T"
            } else {
                "string"
            },
            StringComparison.Ordinal
        ).Replace(
            "TYPE",
            if generic {
                "[string]"
            } else {
                string.Empty
            },
            StringComparison.Ordinal
        ).Replace(
            "CONSTRUCTION",
            if tree {
                "let expression Expression[Func[Child]] = () -> Child{Value: \"hello\"}\nexpression.Compile()()"
            } else {
                "Child{Value: \"hello\"}"
            },
            StringComparison.Ordinal
        )
        let result = EmittedOracle.Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.NotNull(result.Value)
        let type = result.Value!!.GetType()
        let field FieldInfo? = type.BaseType!!.GetField("Value")
        let property PropertyInfo? = type.GetProperty("Value")
        Assert.NotNull(field)
        Assert.NotNull(property)
        Assert.Equal("hello", field!!.GetValue(result.Value))
        Assert.Equal(0, property!!.GetValue(result.Value))
    }

    @Theory
    @InlineData(false, false)
    @InlineData(false, true)
    @InlineData(true, false)
    @InlineData(true, true)
    func PositionalLiteral_HiddenInheritedFieldKeepsCollectionOrder(content bool, generic bool) {
        let source = `import System.Collections.Generic
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
Child{ENTRY, Value: Counter.Next()}`.Replace(
            "PARAM",
            if generic {
                "[T]"
            } else {
                string.Empty
            },
            StringComparison.Ordinal
        ).Replace(
            "FIELD",
            if generic {
                "T"
            } else {
                "int32"
            },
            StringComparison.Ordinal
        ).Replace(
            "TYPE",
            if generic {
                "[int32]"
            } else {
                string.Empty
            },
            StringComparison.Ordinal
        ).Replace(
            "ENTRY",
            if content {
                "Items: List[int32](), Counter.Next()"
            } else {
                "Items: {Counter.Next()}"
            },
            StringComparison.Ordinal
        )
        let result = EmittedOracle.Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.NotNull(result.Value)
        let type = result.Value!!.GetType()
        let field FieldInfo? = type.BaseType!!.GetField("Value")
        let property PropertyInfo? = type.GetProperty("Value")
        let itemsField FieldInfo? = type.GetField("Items")
        Assert.NotNull(field)
        Assert.NotNull(property)
        Assert.NotNull(itemsField)
        Assert.Equal(2, field!!.GetValue(result.Value))
        Assert.Equal(0, property!!.GetValue(result.Value))
        let items = Assert.IsType[List[int32]](itemsField!!.GetValue(result.Value))
        Assert.Equal(1, Assert.Single(items))
    }

    @Fact
    func StructLiteral_PreservesThreeParameterClrConstructor() {
        Assert.NotNull(
            typeof(BoundStructLiteralExpression).GetConstructor(
                []Type{typeof(SyntaxNode), typeof(StructSymbol), typeof(ImmutableArray[BoundFieldInitializer])}
            )
        )
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func PositionalLiteral_RewrittenDeclaredInitializerRunsOnce(ordered bool) {
        let result = EmittedOracle.Evaluate(`import System.Collections.Generic
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
Counter.Count * 100 + item.Marker * 10 + Counter.Values[0]`.Replace(
                "SUFFIX",
                if ordered {
                    ", Items: {1}"
                } else {
                    string.Empty
                },
                StringComparison.Ordinal
            ))
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(111, result.Value)
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func ForwardEmittedBaseEquality_ComparesInheritedState(generic bool) {
        let result = EmittedOracle.Evaluate(`data class Child(Own int32) : BaseTYPE
open data class BasePARAM : IEquatable[BasePARAM] { public var BaseValue int32 }
Child(7)`.Replace(
                "TYPE",
                if generic {
                    "[int32]"
                } else {
                    string.Empty
                },
                StringComparison.Ordinal
            )
                .Replace(
                "PARAM",
                if generic {
                    "[T]"
                } else {
                    string.Empty
                },
                StringComparison.Ordinal
            ))
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.NotNull(result.Value)
        let type = result.Value!!.GetType()
        let other object? = Activator.CreateInstance(type, []object{7})
        let field FieldInfo? = type.BaseType!!.GetField("BaseValue")
        Assert.NotNull(field)
        field!!.SetValue(result.Value, 1)
        field!!.SetValue(other, 2)
        Assert.False(result.Value!!.Equals(other))
        let baseEquality MethodInfo? = typeof(IEquatable[_]).MakeGenericType(type.BaseType!!).GetMethod("Equals")
        Assert.NotNull(baseEquality)
        Assert.Equal(false, baseEquality!!.Invoke(result.Value, []object{other}))
        field!!.SetValue(other, 1)
        Assert.True(result.Value!!.Equals(other))
        Assert.Equal(true, baseEquality!!.Invoke(result.Value, []object{other}))
    }

    @Fact
    func SelfEquality_DoesNotOverrideUndeclaredInheritedOverload() {
        let result = EmittedOracle.Evaluate(`open class Base {
    public open func Equals(other Derived) bool -> false
}
data class Derived(Value int32) : Base
let derived = Derived(7)
let parent Base = derived
parent.Equals(Derived(7))`)
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(false, result.Value)
    }

    @Theory
    @InlineData("data struct")
    @InlineData("data class")
    func StagedPositionalLiteral_RemainsAvailableInExpressionTrees(kind string) {
        let result = EmittedOracle.Evaluate(`import System
import System.Linq.Expressions
KIND Point(X int32)
let expression Expression[Func[Point]] = () -> Point{X: 1}
expression.Compile()().X`.Replace("KIND", kind, StringComparison.Ordinal))
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(1, result.Value)
    }

    @Theory
    @InlineData("data struct")
    @InlineData("data class")
    func ExpressionTreeLiteral_PreservesWrittenOrderAndConstructorScope(kind string) {
        let result = EmittedOracle.Evaluate(`import System
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
before * 1000000 + first.Read() * 1000 + second.Read()`.Replace("KIND", kind, StringComparison.Ordinal))
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        // Data structs evaluate B and A, construct Marker, then evaluate Extra.
        Assert.Equal(
            if kind == "data struct" {
                313646
            } else {
                421754
            },
            result.Value
        )
    }

    @Theory
    @InlineData("data struct")
    @InlineData("data class")
    func ExpressionTreeLiteral_PreservesGenericDefaultsAndPropertyUpdates(kind string) {
        let result = EmittedOracle.Evaluate(`import System
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
before * 1000000 + first.Read() * 1000 + second.Read() + first.A * 10 + second.A`.Replace(
                "KIND",
                kind,
                StringComparison.Ordinal
            ))
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        // Data structs evaluate A, construct Marker, then evaluate Extra.
        Assert.Equal(
            if kind == "data struct" {
                203520
            } else {
                301629
            },
            result.Value
        )
    }
}
