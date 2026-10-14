// <copyright file="Issue3421CheckedReferenceCastTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import System
import System.Collections.Generic
import System.Linq
import System.Reflection.Emit
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import Xunit
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.Tests
import System.Reflection
import System.Text

/// Issue #3421 checked reference conversion-call coverage.
class Issue3421CheckedReferenceCastTests {
    @Fact
    func BinderClassifiesReferenceDowncastsAsExplicit() {
        using let fixture = CSharpFixture(
            "public class OpenReference3421 {}\npublic sealed class SealedReference3421 {}"
        )
        let contracts = fixture.Load()
        let openReference Type? = contracts.GetType("OpenReference3421", throwOnError: true)
        let sealedReference Type? = contracts.GetType("SealedReference3421", throwOnError: true)
        Assert.False(openReference!!.IsSealed)
        Assert.True(sealedReference!!.IsSealed)
        let baseType = TypeSymbol.FromClrType(typeof(Exception))
        let derivedType = TypeSymbol.FromClrType(typeof(ArgumentException))
        let interfaceType = TypeSymbol.FromClrType(typeof(ICloneable))
        let nullableBase = NullableTypeSymbol.Get(baseType)
        let nullableDerived = NullableTypeSymbol.Get(derivedType)
        Assert.True(Conversion.Classify(baseType, derivedType).IsExplicit)
        Assert.True(Conversion.Classify(nullableBase, nullableDerived).IsExplicit)
        Assert.True(Conversion.Classify(interfaceType, derivedType).IsExplicit)
        Assert.True(
            Conversion.Classify(TypeSymbol.FromClrType(typeof([]object)), TypeSymbol.FromClrType(typeof([]string)))
                .IsExplicit
        )
        Assert.True(
            Conversion.Classify(TypeSymbol.FromClrType(typeof(IUnrelated3421)), TypeSymbol.FromClrType(openReference))
                .IsExplicit
        )
        Assert.False(
            Conversion.Classify(TypeSymbol.FromClrType(typeof(IUnrelated3421)), TypeSymbol.FromClrType(sealedReference))
                .Exists
        )
        Assert.False(Conversion.Classify(TypeSymbol.String, TypeSymbol.FromClrType(typeof(Uri))).Exists)
    }

    @Fact
    func BinderAcceptsClassInterfaceNullableAndGenericForms() {
        let result = EmittedOracle.Evaluate([]string{`import System.Collections.Generic

open class Base3421 {}
interface IMarker3421 {}
class Derived3421 : Base3421, IMarker3421 {}

func FromBase(value Base3421) Derived3421 -> Derived3421(value)
func FromInterface(value IMarker3421) Derived3421 -> Derived3421(value)
func FromNullable(value Base3421?) Derived3421? -> Derived3421?(value)
func FromGeneric[T Base3421](value Base3421) T -> T(value)

open class GenericBase3421[T] {}
class GenericDerived3421[T] : GenericBase3421[T] {}
func FromConstructed(
    value GenericBase3421[int32]
) GenericDerived3421[int32] -> GenericDerived3421[int32](value)

func FromImportedGeneric(value object) List[int32] -> List[int32](value)
func FromImportedGenericNullable(value object?) List[int32]? -> List[int32]?(value)

interface IOut3421[out T] {}
func FromGenericInterface(
    value IOut3421[object]
) IOut3421[string] -> IOut3421[string](value)
func FromArray(value []object) []string -> []string(value)`}, EmittedOracleOptions{IsLibrary: true})
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func EmitterUsesCastclassForConcreteReferenceDowncast() {
        let result = EmittedOracle.Evaluate(`open class Base3421 {}
class Derived3421 : Base3421 {}

func Cast3421(value Base3421) Derived3421 -> Derived3421(value)
let value Base3421 = Derived3421()
Cast3421(value)`)
        Assert.Empty(result.Diagnostics)
        Assert.NotNull(result.Assembly)
        let method = Assert.Single(
            result.Assembly!!.GetTypes().SelectMany(
                func (type Type) IEnumerable[MethodInfo] {
                    return type.GetMethods()
                }
            ),
            (candidate MethodInfo) -> candidate.Name == "Cast3421"
        )
        let body MethodBody? = method.GetMethodBody()
        Assert.NotNull(body)
        let il[]?uint8 = body!!.GetILAsByteArray()
        Assert.NotNull(il)
        Assert.Contains(unchecked(uint8(OpCodes.Castclass.Value)), il!!)
    }

    @Fact
    func ApplicableSingleArgumentConstructorStillWins() {
        let result = EmittedOracle.Evaluate(`class Wrapper3421(value object) {}

func Construct3421(value object) Wrapper3421 -> Wrapper3421(value)
Construct3421("payload")`)
        Assert.Empty(result.Diagnostics)
        Assert.NotNull(result.Assembly)
        let method = Assert.Single(
            result.Assembly!!.GetTypes().SelectMany(
                func (type Type) IEnumerable[MethodInfo] {
                    return type.GetMethods()
                }
            ),
            (candidate MethodInfo) -> candidate.Name == "Construct3421"
        )
        let body MethodBody? = method.GetMethodBody()
        Assert.NotNull(body)
        let il[]?uint8 = body!!.GetILAsByteArray()
        Assert.NotNull(il)
        Assert.Contains(unchecked(uint8(OpCodes.Newobj.Value)), il!!)
        Assert.DoesNotContain(unchecked(uint8(OpCodes.Castclass.Value)), il!!)
    }

    @Fact
    func UnambiguousCastBypassesApplicableSingleArgumentConstructor() {
        let result = EmittedOracle.Evaluate(`import System

open class Base3421 {}
class Target3421(payload object) : Base3421 {}

func Cast3421(value Base3421) Target3421 -> cast[Target3421](value)

let target Target3421 = Target3421("constructed")
let compatible Base3421 = target
Console.WriteLine(Cast3421(compatible) is Target3421)

try {
    Cast3421(Base3421())
    Console.WriteLine("constructed")
} catch (e InvalidCastException) {
    Console.WriteLine(e.GetType().Name)
}`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(
            string.Join(Environment.NewLine, "True", "InvalidCastException") + Environment.NewLine,
            result.Output
        )
        Assert.Equal(string.Empty, result.ErrorOutput)
        Assert.Equal(0, result.ExitCode)
        let method = Assert.Single(
            result.Assembly!!.GetTypes().SelectMany(
                func (type Type) IEnumerable[MethodInfo] {
                    return type.GetMethods()
                }
            ),
            (candidate MethodInfo) -> candidate.Name == "Cast3421"
        )
        let il = method.GetMethodBody()!!.GetILAsByteArray()!!
        Assert.Contains(unchecked(uint8(OpCodes.Castclass.Value)), il)
        Assert.DoesNotContain(unchecked(uint8(OpCodes.Newobj.Value)), il)
    }

    @Fact
    func UnambiguousCastBoxesValueTypesToInterfaces() {
        let result = EmittedOracle.Evaluate(`import System

interface IValue3421 {
    func Read() int32;
}

struct Value3421 : IValue3421 {
    func Read() int32 -> 7
}

Console.WriteLine(cast[IValue3421](Value3421{}).Read())
Console.WriteLine(cast[IValue3421?](Value3421{})!!.Read())
Console.WriteLine(cast[IValue3421](default(Value3421?)) == nil)`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(string.Join(Environment.NewLine, "7", "7", "True") + Environment.NewLine, result.Output)
        Assert.Equal(string.Empty, result.ErrorOutput)
        Assert.Equal(0, result.ExitCode)
    }

    @Fact
    func FailedClrConstructorFallbackBindsCaptureArgumentOnce() {
        let tree = SyntaxTree.Parse(SourceText.From(`import System.Text

class Holder3421 {
    prop Value object? { get; init; }
}

func CastCaptured3421(holder Holder3421?) StringBuilder? ->
    StringBuilder(holder?.Value)`))
        let compilation = Compilation(tree){IsLibrary = true}
        Assert.Empty(compilation.GlobalScope.Diagnostics)
        let function = compilation
            .BoundProgram
            .Functions
            .Keys
            .Single((candidate FunctionSymbol) -> candidate.Name == "CastCaptured3421")
        let collector = CaptureCollector()
        collector.Visit(compilation.BoundProgram.Functions[function])
        let capture = Assert.Single(collector.Captures)
        // A discarded first binding produced $ncap_2 here.
        Assert.Equal("$$ncap_1", capture.Capture.Name)
        let conversion = Assert.Single(
            collector.Conversions,
            (candidate BoundConversionExpression) -> object.ReferenceEquals(candidate.Expression, capture)
        )
        Assert.Equal(typeof(StringBuilder), conversion.Type.ClrType)
    }

    @Theory
    @InlineData("cast(x)", "GS0148")
    @InlineData("cast[A, B](x)", "GS0148")
    @InlineData("cast[T](a, b)", "GS0144")
    func IntrinsicRejectsInvalidTypeAndValueArgumentCounts(expression string, expectedDiagnostic string) {
        let result = EmittedOracle.Evaluate([]string{(`func cast(value object) object -> value
func InvalidCastShape3421[T, A, B](
    x object,
    a object,
    b object
) object -> ` + "$expression")}, EmittedOracleOptions{IsLibrary: true})
        let diagnostic = Assert.Single(result.Diagnostics)
        Assert.Equal(expectedDiagnostic, diagnostic.Id)
    }

    @Fact
    func RuntimePreservesSuccessFailureNullInterfaceAndGenericSemantics() {
        let result = EmittedOracle.Evaluate(`import System
import System.Collections.Generic

interface IMarker3421 {}
open class Base3421 {}
class Derived3421 : Base3421, IMarker3421 {
    prop Value int32 -> 42
}
class Other3421 : Base3421, IMarker3421 {}
interface IOut3421[out T] {}
class StringOut3421 : IOut3421[string] {}
open class GenericBase3421[T] {}
class GenericDerived3421[T] : GenericBase3421[T] {}

func FromBase(value Base3421) Derived3421 -> Derived3421(value)
func FromInterface(value IMarker3421) Derived3421 -> Derived3421(value)
func FromGeneric[T Base3421](value Base3421) T -> T(value)
func FromConstructed(
    value GenericBase3421[int32]
) GenericDerived3421[int32] -> GenericDerived3421[int32](value)
func FromImportedGeneric(value object) List[int32] -> List[int32](value)
func FromGenericInterface(
    value IOut3421[object]
) IOut3421[string] -> IOut3421[string](value)

let derived Base3421 = Derived3421()
Console.WriteLine(FromBase(derived).Value)
Console.WriteLine(FromInterface(Derived3421()).Value)
Console.WriteLine(FromGeneric[Derived3421](derived) is Derived3421)
let genericBase GenericBase3421[int32] = GenericDerived3421[int32]()
Console.WriteLine(FromConstructed(genericBase) is GenericDerived3421[int32])
let imported object = List[int32]()
Console.WriteLine(FromImportedGeneric(imported).Count)
let wide IOut3421[object] = StringOut3421()
Console.WriteLine(FromGenericInterface(wide) is IOut3421[string])
let arrayObject object = []string{"array"}
let wideArray = []object(arrayObject)
Console.WriteLine([]string(wideArray)[0])

let missing Base3421? = nil
Console.WriteLine(Derived3421?(missing) == nil)

try {
    let wrong Base3421 = Other3421()
    Console.WriteLine(Derived3421(wrong).Value)
} catch (e InvalidCastException) {
    Console.WriteLine(e.GetType().Name)
}

try {
    let wrong IMarker3421 = Other3421()
    Console.WriteLine(Derived3421?(wrong) == nil)
} catch (e InvalidCastException) {
    Console.WriteLine(e.GetType().Name)
}`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(
            string.Join(
                Environment.NewLine,
                "42",
                "42",
                "True",
                "True",
                "0",
                "True",
                "array",
                "True",
                "InvalidCastException",
                "InvalidCastException"
            ) +
                Environment.NewLine,
            result.Output
        )
        Assert.Equal(string.Empty, result.ErrorOutput)
        Assert.Equal(0, result.ExitCode)
    }

    private interface IUnrelated3421 { }

    private class CaptureCollector : BoundTreeWalker {
        init() {
            Captures = List[BoundNullConditionalAccessExpression]()
            Conversions = List[BoundConversionExpression]()
        }

        prop Captures List[BoundNullConditionalAccessExpression] {
            get;
        }

        prop Conversions List[BoundConversionExpression] {
            get;
        }

        override func VisitExpression(node BoundExpression) {
            if node is BoundNullConditionalAccessExpression capture {
                Captures.Add(capture)
            }
            if node is BoundConversionExpression conversion {
                Conversions.Add(conversion)
            }
            base.VisitExpression(node)
        }
    }
}
