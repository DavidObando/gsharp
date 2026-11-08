package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Tests
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import Xunit

class Issue5815InferredOptionalFunctionTests {
    @Fact
    func Review6MixedDelegatesCompareInvokeContracts() {
        let parameter = ParameterSymbol("x", TypeSymbol.Int32)
        parameter.SetExplicitDefaultValue(7)
        let plain = FunctionTypeSymbol.Get(ImmutableArray.Create(TypeSymbol.Int32), TypeSymbol.Int32)
        let optional = plain.WithParameters(ImmutableArray.Create(parameter))
        let requiresOptional = FunctionTypeSymbol.Get(ImmutableArray.Create[TypeSymbol](optional), TypeSymbol.Int32)
        let consumer = DelegateTypeSymbol(
            "Consumer5815",
            "Contracts",
            Accessibility.Public,
            ImmutableArray.Create(ParameterSymbol("callback", plain)),
            TypeSymbol.Int32,
            nil
        )
        Assert.False(Conversion.Classify(requiresOptional, consumer).Exists)
        let t = TypeParameterSymbol("T", 0, TypeParameterConstraint.Any, TypeParameterVariance.None)
        let definition = DelegateTypeSymbol(
            "GenericConsumer5815",
            "Contracts",
            Accessibility.Public,
            ImmutableArray.Create(ParameterSymbol("callback", t), ParameterSymbol("tag", TypeSymbol.Int32)),
            TypeSymbol.Int32,
            nil
        )
        definition.SetTypeParameters(ImmutableArray.Create(t))
        let generic = DelegateTypeSymbol.Construct(definition, ImmutableArray.Create[TypeSymbol](optional))
        let matching = FunctionTypeSymbol.Get(
            ImmutableArray.Create[TypeSymbol](optional, TypeSymbol.Int32),
            TypeSymbol.Int32
        )
        Assert.True(Conversion.Classify(matching, generic).IsImplicit)
    }

    @Fact
    func Review6NullableStructPositionsRemainInvariant() {
        let parameter = ParameterSymbol("x", TypeSymbol.Int32)
        parameter.SetExplicitDefaultValue(7)
        let plain = FunctionTypeSymbol.Get(ImmutableArray.Create(TypeSymbol.Int32), TypeSymbol.Int32)
        let optional = plain.WithParameters(ImmutableArray.Create(parameter))
        let closed = typeof(Issue5815ContractCell[Func[int32, int32]])
        let definition = closed.GetGenericTypeDefinition()
        let source = ImportedTypeSymbol.GetConstructed(closed, definition, ImmutableArray.Create[TypeSymbol](optional))
        let target = ImportedTypeSymbol.GetConstructed(closed, definition, ImmutableArray.Create[TypeSymbol](plain))
        Assert.False(
            Conversion.Classify(
                SequenceTypeSymbol.Get(NullableTypeSymbol.Get(source)),
                SequenceTypeSymbol.Get(NullableTypeSymbol.Get(target))
            )
                .Exists
        )
    }

    @Fact
    func Review6SourceDelegateArgumentsUseDeclaredVariance() {
        let parameter = ParameterSymbol("x", TypeSymbol.Int32)
        parameter.SetExplicitDefaultValue(7)
        let plain = FunctionTypeSymbol.Get(ImmutableArray.Create(TypeSymbol.Int32), TypeSymbol.Int32)
        let optional = plain.WithParameters(ImmutableArray.Create(parameter))
        let t = TypeParameterSymbol("T", 0, TypeParameterConstraint.Any, TypeParameterVariance.None)
        let definition = DelegateTypeSymbol(
            "InvariantConsumer5815",
            "Contracts",
            Accessibility.Public,
            ImmutableArray.Create(ParameterSymbol("callback", t)),
            TypeSymbol.Int32,
            nil
        )
        definition.SetTypeParameters(ImmutableArray.Create(t))
        let source = DelegateTypeSymbol.Construct(definition, ImmutableArray.Create[TypeSymbol](optional))
        let target = DelegateTypeSymbol.Construct(definition, ImmutableArray.Create[TypeSymbol](plain))
        Assert.False(Conversion.Classify(SequenceTypeSymbol.Get(source), SequenceTypeSymbol.Get(target)).Exists)
    }

    @Fact
    func Review6CheckedInterfaceCastsCannotEraseWritableContracts() {
        let result = EmittedOracle.Evaluate(`import System.Collections.Generic
func One[T](value T) List[T] -> List[T]{value}
let f = (x int32 = 7) -> x
let values = One(f)
let alias = cast[IList[(int32) -> int32]](values)`)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0155" && d.Location.StartLine == 4)
    }

    @Theory
    @InlineData("map")
    @InlineData("sequence")
    @InlineData("async")
    @InlineData("channel")
    func Review6WrappedFunctionCacheKeysRetainContracts(kind string) {
        let parameter7 = ParameterSymbol("x", TypeSymbol.Int32)
        parameter7.SetExplicitDefaultValue(7)
        let parameter9 = ParameterSymbol("x", TypeSymbol.Int32)
        parameter9.SetExplicitDefaultValue(9)
        let plain = FunctionTypeSymbol.Get(ImmutableArray.Create(TypeSymbol.Int32), TypeSymbol.Int32)
        let first = plain.WithParameters(ImmutableArray.Create(parameter7))
        let second = plain.WithParameters(ImmutableArray.Create(parameter9))
        let Wrap = func (element TypeSymbol) TypeSymbol {
            return switch kind {
                case "map": MapTypeSymbol.Get(TypeSymbol.Int32, element)
                case "sequence": SequenceTypeSymbol.Get(element)
                case "async": AsyncSequenceTypeSymbol.Get(element)
                default: ChannelTypeSymbol.Get(element)
            }
        }
        let factory7 = FunctionTypeSymbol.Get(ImmutableArray[TypeSymbol].Empty, Wrap(first))
        let factory9 = FunctionTypeSymbol.Get(ImmutableArray[TypeSymbol].Empty, Wrap(second))
        Assert.False(Conversion.Classify(factory9, factory7).Exists)
    }

    @Fact
    func Review6MapFactoriesKeepDistinctDefaultsAtInvocation() {
        let result = EmittedOracle.Evaluate(`func Wrap[T](value T) map[int32, T] -> map[int32, T]{0: value}
let first = () -> Wrap((x int32 = 7) -> x)
let second = () -> Wrap((x int32 = 9) -> x)
first()[0]() * 100 + second()[0]()`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(709, result.Value)
    }

    @Fact
    func Review6ValueDiscardingAdaptersRetainMatchingParameters() {
        let result = EmittedOracle.Evaluate(`var trace = 0
var f = func(x int32 = 7) void {}
f = func(x int32 = 7) int32 { return trace += x }
f()
trace`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(7, result.Value)
    }

    @Fact
    func Review4WrittenGenericFunctionCastsEraseOptionalDefaults() {
        let prefix = "func Run[T](value T) T { return cast[(int32) -> T](func(x int32 = 7) T { return value })"
        let valid = EmittedOracle.Evaluate(prefix + "(3) }\nRun(7)")
        Assert.Empty(valid.Diagnostics)
        Assert.Equal(7, valid.Value)
        let invalid = EmittedOracle.Evaluate(prefix + "() }\nRun(7)")
        Assert.Contains(invalid.Diagnostics, (d Diagnostic) -> d.Id == "GS0144" && d.Location.StartLine == 0)
    }

    @Fact
    func Review4NeverConversionsPreserveGenericOverloads() {
        let parameter = ParameterSymbol("x", TypeSymbol.Int32)
        parameter.SetExplicitDefaultValue(7)
        let optional = FunctionTypeSymbol.Get(ImmutableArray.Create(TypeSymbol.Int32), TypeSymbol.Int32).WithParameters(
            ImmutableArray.Create(parameter)
        )
        Assert.True(Conversion.Classify(TypeSymbol.Never, optional).IsImplicit)
        Assert.True(Conversion.Classify(TypeSymbol.Never, SliceTypeSymbol.Get(optional)).IsImplicit)
        let result = EmittedOracle.Evaluate(`import System
func Choose[T](left T, right T) T -> left
func Choose(left int32, right int32) int32 -> left
let f = (x int32 = 7) -> x
var result = 0
try { Choose(f, throw InvalidOperationException()) } catch { result = 7 }
result`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(7, result.Value)
    }

    @Fact
    func Review4UserDefinedWrapperConversionUsesItsResultContract() {
        let declarations = `class Box[T] {
var Value T
init(value T) { Value = value }
func operator implicit(value Box[T]) T -> value.Value
func operator implicit(value T) Box[T] -> Box[T](value)
}
func MakeBox[T](value T) Box[T] -> Box[T](value)
var f = (x int32 = 7) -> x
`
        let valid = EmittedOracle.Evaluate(declarations + `f = MakeBox(f)
var box = MakeBox(f)
box = (x int32 = 7) -> x + 1
f = box
f()`)
        Assert.Empty(valid.Diagnostics)
        Assert.Equal(8, valid.Value)
        for suffix in[]string{
            "let g = (x int32 = 9) -> x\nf = MakeBox(g)",
            "var box = MakeBox(f)\nbox = (x int32 = 9) -> x"
        } {
            let invalid = EmittedOracle.Evaluate(declarations + suffix)
            Assert.Contains(invalid.Diagnostics, (d Diagnostic) -> d.Id == "GS0155" && d.Location.StartLine == 9)
        }
    }

    @Fact
    func Review3CallbackContractsFollowParameterAndReturnVariance() {
        let parameter = ParameterSymbol("x", TypeSymbol.Int32)
        parameter.SetExplicitDefaultValue(7)
        let plain = FunctionTypeSymbol.Get(ImmutableArray.Create(TypeSymbol.Int32), TypeSymbol.Int32)
        let optional = plain.WithParameters(ImmutableArray.Create(parameter))
        let acceptsPlain = FunctionTypeSymbol.Get(ImmutableArray.Create[TypeSymbol](plain), TypeSymbol.Int32)
        let acceptsOptional = FunctionTypeSymbol.Get(ImmutableArray.Create[TypeSymbol](optional), TypeSymbol.Int32)
        Assert.False(Conversion.Classify(acceptsOptional, acceptsPlain).Exists)
        Assert.True(Conversion.Classify(acceptsPlain, acceptsOptional).IsImplicit)
        let returnsPlain = FunctionTypeSymbol.Get(ImmutableArray[TypeSymbol].Empty, plain)
        let returnsOptional = FunctionTypeSymbol.Get(ImmutableArray[TypeSymbol].Empty, optional)
        Assert.True(Conversion.Classify(returnsOptional, returnsPlain).IsImplicit)
        Assert.False(Conversion.Classify(returnsPlain, returnsOptional).Exists)
        let plainRef = ByRefTypeSymbol.Get(plain)
        let optionalRef = ByRefTypeSymbol.Get(optional)
        Assert.False(Conversion.Classify(optionalRef, plainRef).Exists)
        Assert.False(Conversion.Classify(plainRef, optionalRef).Exists)
    }

    @Fact
    func Review3DeclaredByRefCallbackContractsAreInvariant() {
        let value = ParameterSymbol("x", TypeSymbol.Int32)
        value.SetExplicitDefaultValue(7)
        let plain = FunctionTypeSymbol.Get(ImmutableArray.Create(TypeSymbol.Int32), TypeSymbol.Int32)
        let optional = plain.WithParameters(ImmutableArray.Create(value))
        let plainConsumer = FunctionTypeSymbol.Get(
            ImmutableArray.Create[TypeSymbol](plain, TypeSymbol.Int32),
            TypeSymbol.Int32
        )
            .WithParameters(ImmutableArray.Create(ParameterSymbol("callback", plain, refKind: RefKind.Ref), value))
        let optionalConsumer = FunctionTypeSymbol.Get(
            ImmutableArray.Create[TypeSymbol](optional, TypeSymbol.Int32),
            TypeSymbol.Int32
        )
            .WithParameters(ImmutableArray.Create(ParameterSymbol("callback", optional, refKind: RefKind.Ref), value))
        Assert.False(Conversion.Classify(optionalConsumer, plainConsumer).Exists)
        Assert.False(Conversion.Classify(plainConsumer, optionalConsumer).Exists)
    }

    @Theory
    @InlineData("x int32 = 9")
    @InlineData("x int32")
    func Review3GenericLambdaAdaptersRejectChangedOptionalContracts(replacement string) {
        let result = EmittedOracle.Evaluate(`func Run[T](value T) T {
var f = func(x int32 = 7) T { return value }
f = func(` + replacement + `) T { return value }
return f()
}
Run(1)`)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0155" && d.Location.StartLine == 2)
    }

    @Theory
    @InlineData("MakeChild(f, 0)")
    @InlineData("MakeClass(f, 0)")
    func Review3SourceInterfaceProjectionPreservesCallableContracts(replacement string) {
        let declarations = `interface IBase[T] {}
interface IChild[T, U] : IBase[T] {}
class C[T, U] : IChild[T, U] {}
func MakeBase[T](value T) IBase[T] -> C[T, int32]()
func MakeChild[T, U](value T, tag U) IChild[T, U] -> C[T, U]()
func MakeClass[T, U](value T, tag U) C[T, U] -> C[T, U]()
let f = (x int32 = 7) -> x
var value = MakeBase(f)
`
        let result = EmittedOracle.Evaluate(declarations + "value = " + replacement + "\n1")
        Assert.Empty(result.Diagnostics)
        Assert.Equal(1, result.Value)
        let invalid = EmittedOracle.Evaluate(
            declarations + "let g = (x int32 = 9) -> x\nvalue = " + replacement.Replace("(f,", "(g,")
        )
        Assert.Contains(
            invalid.Diagnostics,
            (d Diagnostic) -> (d.Id == "GS0155" || d.Id == "GS0490") && d.Location.StartLine == 9
        )
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func Review3ConstructedInterfaceUsesDeclaredCovariance(nested bool) {
        let declarations = if nested {
            `class Outer[P] {
public interface ISource[out T] {}
public class C[T] : ISource[T] {}
}
`
        } else {
            `interface ISource[out T] {}
class C[T] : ISource[T] {}
`
        }
        let prefix = if nested {
            "Outer[int32]."
        } else {
            ""
        }
        let result = EmittedOracle.Evaluate(
            declarations + "func MakeSource[T](value T) " + prefix + "ISource[T] -> " + prefix + `C[T]()
let f = (x int32 = 7) -> x
let source = MakeSource(f)
let widened ` + prefix + `ISource[(int32) -> int32] = source
widened != nil`
        )
        Assert.Empty(result.Diagnostics)
        Assert.Equal(true, result.Value)
    }

    @Fact
    func Review2NumericReturnAdapterRetainsTheOptionalContract() {
        let result = EmittedOracle.Evaluate(`var f = func(x int32 = 7) int64 { return int64(x) }
f = func(x int32 = 7) int32 { return x }
f()`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(7L, result.Value)
    }

    @Theory
    @InlineData("float64", "d")
    @InlineData("float32", "f")
    func Review2FloatingZeroDefaultsCompareByRepresentation(type string, suffix string) {
        let declaration = "var f = (x " + type + " = 0" + suffix + ") -> 1" + suffix + " / x\n"
        let valid = EmittedOracle.Evaluate(declaration + "f()")
        Assert.Empty(valid.Diagnostics)
        Assert.Equal(
            if type == "float64" {
                object(float64.PositiveInfinity)
            } else {
                object(float32.PositiveInfinity)
            },
            valid.Value
        )
        let result = EmittedOracle.Evaluate(
            declaration + "f = (x " + type + " = -0" + suffix + ") -> 1" + suffix + " / x"
        )
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0155" && d.Location.StartLine == 1)
    }

    @Fact
    func Review2GenericBaseProjectionRetainsExactCallableArguments() {
        let declarations = `open class Base[T] {
    var Value T
    init(value T) { Value = value }
}
class Derived[T, U] : Base[T] {
    init(value T) : base(value) { }
}
func MakeBase[T](value T) Base[T] -> Base[T](value)
func MakeDerived[T, U](value T, tag U) Derived[T, U] -> Derived[T, U](value)
let f = (x int32 = 7) -> x
var value = MakeBase(f)
`
        let valid = EmittedOracle.Evaluate(declarations + "value = MakeDerived(f, 0)\nvalue.Value(3)")
        Assert.Empty(valid.Diagnostics)
        Assert.Equal(3, valid.Value)
        let invalid = EmittedOracle.Evaluate(declarations + "let g = (x int32 = 9) -> x\nvalue = MakeDerived(g, 0)")
        Assert.Contains(
            invalid.Diagnostics,
            (d Diagnostic) -> (d.Id == "GS0155" || d.Id == "GS0490") && d.Location.StartLine == 12
        )
    }

    @Theory
    @InlineData(
        "func One[T](value T) []T -> []T{value}",
        "let items = One(f)\nlet alias = cast[[]((int32) -> int32)](items)",
        "GS0155",
        4
    )
    @InlineData(
        "func One[T](value T) List[T] -> List[T]{value}",
        "let items = One(f)\nlet alias = cast[List[(int32) -> int32]](items)",
        "GS0155",
        4
    )
    @InlineData("func Replace(ref value (int32) -> int32) { value = (x int32 = 9) -> x }", "Replace(&f)", "GS0154", 3)
    func Review2WritableAliasesCannotEraseOptionalContracts(declarations string, body string, id string, line int32) {
        let valid = EmittedOracle.Evaluate("let f = (x int32 = 7) -> x\ncast[(int32) -> int32](f)(3)")
        Assert.Empty(valid.Diagnostics)
        Assert.Equal(3, valid.Value)
        let invalid = EmittedOracle.Evaluate(
            "import System.Collections.Generic\n" + declarations + "\nvar f = (x int32 = 7) -> x\n" + body
        )
        Assert.Contains(invalid.Diagnostics, (d Diagnostic) -> d.Id == id && d.Location.StartLine == line)
    }

    @Theory
    @InlineData("let f = func(x int32 = 7) int32 { return x }\nf()", 7)
    @InlineData("(func(x int32 = 7) int32 { return x })()", 7)
    @InlineData("var f = (x int32 = 7) -> x\nf()", 7)
    @InlineData("let f = (x int32 = 7) -> x\nlet alias = f\n(alias)()", 7)
    @InlineData("let f = (x int32 = 7, y int32) -> x + y\nf(y: 3)", 10)
    @InlineData("let f = (x int32 = 7, y int32 = 8) -> x + y\nf(y: 3)", 10)
    @InlineData("let f = (x int32 = 7, tail ...int32) -> x + tail.Length\nf()", 7)
    @InlineData("let f = (x int32 = 7, tail ...int32) -> x + tail.Length\nf(tail: []int32{1, 2})", 9)
    @InlineData("let f = (x int32 = 7) -> x\nlet g = (x int32 = 9) -> x\nf() + g()", 16)
    @InlineData("var f = (x int32 = 7) -> x\nf = (x int32 = 7) -> x + 1\nf()", 8)
    @InlineData("let f = func(x int32? = 7) int32 { return x ?? -1 }\nf()", 7)
    @InlineData("struct Point { var X int32 }\nlet f = (x Point = default(Point)) -> x.X\nf()", 0)
    @InlineData("enum Choice { A, B }\nlet f = (x Choice = Choice.B) -> int32(x)\nf()", 1)
    @InlineData("let f = (x decimal = default(decimal)) -> int32(x)\nf()", 0)
    @InlineData("let outer = () -> (x int32 = 7) -> x\nouter()()", 7)
    @InlineData(`var trace = 0
let next = func() int32 {
    trace += 1
    return trace
}
let f = (x int32 = 7, y int32 = 8, z int32 = 9) -> x * 100 + y * 10 + z
f(z: next(), y: next()) + trace * 1000`, 2721)
    func OmittedArgumentsUseTheInferredContract(source string, expected int32) {
        let result = EmittedOracle.Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(expected, result.Value)
    }

    @Fact
    func DeclaredFunctionTypesEraseLiteralDefaults() {
        let inferred = EmittedOracle.Evaluate("let f = (x int32 = 7) -> x\nf()")
        Assert.Empty(inferred.Diagnostics)
        Assert.Equal(7, inferred.Value)
        let widened = EmittedOracle.Evaluate(
            "let f = (x int32 = 7) -> x\nlet erased = cast[(int32) -> int32](f)\nerased(3)"
        )
        Assert.Empty(widened.Diagnostics)
        Assert.Equal(3, widened.Value)
        for source in[]string{
            "let f (int32) -> int32 = (x int32 = 7) -> x\nf()",
            "func Apply(f (int32) -> int32) int32 { return f() }\nApply((x int32 = 7) -> x)",
            "let f = (x int32 = 7) -> x\nlet erased = cast[(int32) -> int32](f)\nerased()"
        } {
            let result = EmittedOracle.Evaluate(source)
            let diagnostic = Assert.Single(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
            Assert.Equal("GS0144", diagnostic.Id)
        }
    }

    @Fact
    func ReassignmentCannotChangeAnInferredOptionalContract() {
        let valid = EmittedOracle.Evaluate("var f = (x int32 = 7) -> x\nf = (x int32 = 7) -> x + 1\nf()")
        Assert.Empty(valid.Diagnostics)
        Assert.Equal(8, valid.Value)
        for replacement in[]string{"(x int32 = 9) -> x", "(x int32) -> x"} {
            let result = EmittedOracle.Evaluate("var f = (x int32 = 7) -> x\nf = " + replacement)
            let diagnostic = Assert.Single(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
            Assert.Equal("GS0155", diagnostic.Id)
            Assert.Equal(1, diagnostic.Location.StartLine)
        }
    }

    @Fact
    func ReviewNestedConversionsPreserveTheCompleteCallableContract() {
        for suffix in[]string{
            "let pair = (f, 0)\nlet erased = cast[((int32) -> int32, int32)](pair)\nerased.Item1",
            "let erased = cast[((int32) -> int32)?](f)\nerased?",
            "let outer = () -> f\nlet erased = cast[() -> ((int32) -> int32)](outer)\nerased()"
        } {
            let prefix = "let f = (x int32 = 7) -> x\n" + suffix
            let supplied = EmittedOracle.Evaluate(prefix + "(3)")
            Assert.Empty(supplied.Diagnostics)
            Assert.Equal(3, supplied.Value)
            let omitted = EmittedOracle.Evaluate(prefix + "()")
            let diagnostic = Assert.Single(omitted.Diagnostics.Where((d Diagnostic) -> d.IsError))
            Assert.Equal("GS0144", diagnostic.Id)
        }
    }

    @Fact
    func ReviewNestedReassignmentRejectsChangedDefaults() {
        for source in[]string{`let f = (x int32 = 7) -> x
let g = (x int32 = 9) -> x
var pair = (f, 0)
pair = (g, 0)`, `let f = (x int32 = 7) -> x
let g = (x int32 = 9) -> x
var factory = () -> f
factory = () -> g`} {
            let result = EmittedOracle.Evaluate(source)
            Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0155" && d.Location.StartLine == 3)
        }
    }
}

struct Issue5815ContractCell[T] {
    var Values List[T]
}

class Issue5864HeaderInitializerParsingTests {
    @Theory
    @InlineData("[]Item{Item{Value: 1}}")
    @InlineData("[1]Item{Item{Value: 1}}")
    @InlineData("[][]Item{[]Item{Item{Value: 1}}}")
    @InlineData("map[int32,Item]{1: Item{Value: 1}}")
    @InlineData("map[Item,int32]{Item{Value: 1}: 1}")
    @InlineData("[]Outer{Outer{Inner: Item{Value: 1}}}")
    @InlineData("[]List[Item]{List[Item]{Item{Value: 1}}}")
    func NestedLiteralsStayInsideEveryHeaderInitializer(initializer string) {
        for header in[]string{
            "for item in " + initializer,
            "if " + initializer + ".Length > 0",
            "while " + initializer + ".Length > 0",
            "switch " + initializer
        } {
            let tree = SyntaxTree.Parse("func Run() { " + header + " { } }")
            Assert.Empty(tree.Diagnostics)
        }
    }
}

class Issue5872SignedInt64BoundaryTests {
    @Theory
    @InlineData("9223372036854775808")
    @InlineData("9_223_372_036_854_775_808")
    @InlineData("09223372036854775808")
    @InlineData("0_9223372036854775808")
    func UnsuffixedDecimalBoundaryUsesTheSameUnaryMinusRule(magnitude string) {
        let negative = EmittedOracle.Evaluate("-" + magnitude)
        Assert.Empty(negative.Diagnostics)
        Assert.Equal(int64.MinValue, negative.Value)
        let positive = EmittedOracle.Evaluate(magnitude)
        Assert.Empty(positive.Diagnostics)
        Assert.Equal(uint64(int64.MaxValue) + 1UL, positive.Value)
    }

    @Theory
    @InlineData("9223372036854775808UL")
    @InlineData("9223372036854775808uL")
    @InlineData("9223372036854775808LU")
    @InlineData("0x8000_0000_0000_0000UL")
    func ReviewUnsignedBoundariesRemainUnsigned(magnitude string) {
        let expected = uint64(int64.MaxValue) + 1UL
        for prefix in[]string{"", "+"} {
            let result = EmittedOracle.Evaluate(prefix + magnitude)
            Assert.Empty(result.Diagnostics)
            Assert.Equal(expected, result.Value)
        }
        let rejected = EmittedOracle.Evaluate("-" + magnitude)
        let diagnostic = Assert.Single(rejected.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal("GS0128", diagnostic.Id)
        Assert.Equal(0, diagnostic.Location.StartCharacter)
    }

    @Theory
    @InlineData("9223372036854775808L")
    @InlineData("9223372036854775808l")
    @InlineData("9_223_372_036_854_775_808L")
    func OnlyDirectUnaryMinusAcceptsTheSignedBoundary(magnitude string) {
        let result = EmittedOracle.Evaluate("-" + magnitude)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(int64.MinValue, result.Value)
        for prefix in[]string{"", "+", "-("} {
            let expression = prefix +
                magnitude +
                (
                if prefix == "-(" {
                    ")"
                } else {
                    ""
                }
            )
            let tree = SyntaxTree.Parse("let value = " + expression)
            let diagnostic = Assert.Single(tree.Diagnostics)
            Assert.Equal("GS0004", diagnostic.Id)
            Assert.Equal(0, diagnostic.Location.StartLine)
            Assert.Equal(12 + prefix.Length, diagnostic.Location.StartCharacter)
            Assert.Equal(magnitude.Length, diagnostic.Location.Span.Length)
        }
        let array = SyntaxTree.Parse("let values = [" + magnitude + "]int32")
        let arrayDiagnostic = Assert.Single(array.Diagnostics)
        Assert.Equal("GS0004", arrayDiagnostic.Id)
        Assert.Equal(14, arrayDiagnostic.Location.StartCharacter)
    }
}
