// <copyright file="Adr0193FunnelMergeTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import System.Linq
import GSharp.Tests
import Xunit
import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.Tests
import System
import System.Collections.Generic

/// ADR-0193 Phase 2 (issue #4363): signature positions that were converted
/// with a bare `TypeSymbol.FromClrType` or an unmerged
/// `MapOpenClrTypeToSymbolic` now go through the funnel readers, so a
/// declaration's `string?` reaches the binder. Each case below compiled
/// with no diagnostic before — the declared `?` was dropped, so a nil
/// value flowed into a non-null `string` unchecked.
class Adr0193FunnelMergeTests {
    @Theory
    @InlineData(false)
    @InlineData(true)
    func ByRefFunctionPointerLayouts_PreservePointeeAndConstructedArgumentNullability(constructed bool) {
        using let fixture = CSharpFixture(`#nullable enable
namespace SignatureLayouts {
    public unsafe class Managed<T> {
        public delegate*<ref T?, ref string> Value;
    }
}`, allowUnsafe: true)
        let argument = if constructed {
            typeof(List[string])
        } else {
            typeof(string)
        }
        let closed = fixture.Load().GetType("SignatureLayouts.Managed`1")!!.MakeGenericType(argument)
        let field = closed.GetField("Value")!!
        let readers = []TypeSymbol{
            ClrNullability.GetFieldTypeSymbol(field),
            MemberLookup.GetClrFieldTypeSymbol(ImportedTypeSymbol.Get(closed), field)
        }
        Assert.NotEmpty(readers)
        Assert.All(
            readers,
            (type TypeSymbol) -> {
                let pointer = Assert.IsType[FunctionPointerTypeSymbol](type)
                Assert.True(pointer.IsManaged)
                let result = Assert.IsType[ByRefTypeSymbol](pointer.ReturnType).PointeeType
                Assert.Equal(typeof(string), result.ClrType)
                Assert.Equal(ReferenceNullabilityKind.NotNull, result.ReferenceNullability)
                let parameter = Assert.IsType[ByRefTypeSymbol](Assert.Single(pointer.ParameterTypes)).PointeeType
                Assert.Equal(argument, parameter.ClrType)
                Assert.Equal(ReferenceNullabilityKind.Nullable, parameter.ReferenceNullability)
                if constructed {
                    let element = Assert.Single(parameter.GetElementPositions())
                    Assert.Equal(typeof(string), element.ClrType)
                    Assert.Equal(ReferenceNullabilityKind.NotNull, element.ReferenceNullability)
                }
            }
        )
    }

    @Theory
    @InlineData("Field")
    @InlineData("Property")
    @InlineData("Return")
    @InlineData("Parameter")
    func FunctionPointerLayouts_AgreeWithReceiverProjectionForConstructedArguments(kind string) {
        using let fixture = CSharpFixture(`#nullable enable
namespace SignatureLayouts {
    public unsafe class Managed<T> {
        public delegate*<T?, T?> Value;
        public delegate*<T?, T?> Property => Value;
        public delegate*<T?, T?> Get() => Value;
        public void Set(delegate*<T?, T?> value) { Value = value; }
    }
}`, allowUnsafe: true)
        let closed = fixture.Load().GetType("SignatureLayouts.Managed`1")!!.MakeGenericType(typeof(List[string]))
        let receiver = ImportedTypeSymbol.Get(closed)
        let readers = switch kind {
            case "Field": []TypeSymbol{
                ClrNullability.GetFieldTypeSymbol(closed.GetField("Value")!!),
                MemberLookup.GetClrFieldTypeSymbol(receiver, closed.GetField("Value")!!)
            }
            case "Property": []TypeSymbol{
                ClrNullability.GetPropertyTypeSymbol(closed.GetProperty("Property")!!),
                MemberLookup.GetClrPropertyTypeSymbol(receiver, closed.GetProperty("Property")!!)
            }
            case "Return": []TypeSymbol{
                ClrNullability.GetReturnTypeSymbol(closed.GetMethod("Get")!!),
                MemberLookup.GetClrMethodReturnTypeSymbol(receiver, closed.GetMethod("Get")!!)
            }
            case "Parameter": []TypeSymbol{
                ClrNullability.GetParameterTypeSymbol(closed.GetMethod("Set")!!.GetParameters()[0]),
                MemberLookup.GetClrMethodParameterTypeSymbol(receiver, closed.GetMethod("Set")!!, 0)
            }
            default: throw InvalidOperationException(kind)
        }
        Assert.NotEmpty(readers)
        Assert.All(
            readers,
            (type TypeSymbol) -> {
                let pointer = Assert.IsType[FunctionPointerTypeSymbol](type)
                Assert.True(pointer.IsManaged)
                let parameter = Assert.Single(pointer.ParameterTypes)
                Assert.Equal(ReferenceNullabilityKind.Nullable, pointer.ReturnType.ReferenceNullability)
                Assert.Equal(ReferenceNullabilityKind.Nullable, parameter.ReferenceNullability)
                for position in[]TypeSymbol{pointer.ReturnType, parameter} {
                    let element = Assert.Single(position.GetElementPositions())
                    Assert.Equal(ReferenceNullabilityKind.NotNull, element.ReferenceNullability)
                    Assert.Equal(typeof(string), element.ClrType)
                }
            }
        )
    }

    @Fact
    func PatternEnumeratorCurrentKeepsItsDeclaredNullability() {
        AssertNullableStringRejected(`import Adr0193Contracts

func Take(items NullableItems) {
    for item in items {
        let s string = item
    }
}`)
    }

    @Fact
    func AsyncPatternEnumeratorCurrentKeepsItsDeclaredNullability() {
        AssertNullableStringRejected(`import Adr0193Contracts

async func Take(items NullableAsyncItems) {
    await for item in items {
        let s string = item
    }
}`)
    }

    @Fact
    func UserEnumerableThroughAClrEnumeratorKeepsItsDeclaredNullability() {
        AssertNullableStringRejected(`import Adr0193Contracts

class Bag {
    func GetEnumerator() NullableEnumerator -> NullableEnumerator()
}

func Take(bag Bag) {
    for item in bag {
        let s string = item
    }
}`)
    }

    @Fact
    func AwaiterGetResultKeepsItsDeclaredNullability() {
        AssertNullableStringRejected(`import Adr0193Contracts

async func Take(awaitable NullableAwaitable) {
    let s string = await awaitable
}`)
    }

    @Fact
    func InlineOutVarKeepsItsBareShape() {
        // The cs2gs Oahu gate's shape: the out parameter is declared
        // `[NotNullWhen(true)] out Uri? result`, and the result is used after
        // a `bool` guard that does not narrow. The inline local keeps the bare
        // shape it had before Phase 2 (#4363 tracks reading the declared `?`
        // once `out var` narrowing exists).
        let result = EmittedOracle.Evaluate([]string{`import System

func Parse(text string) Uri {
    while true {
        let ok = Uri.TryCreate(text, UriKind.Absolute, out var parsed)
        if !ok {
            continue
        }

        return parsed
    }
}`}, EmittedOracleOptions{IsLibrary: true})
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func OptionalNullDefaultParametersOnGenericReceiversLiftToNullable() {
        // Issue #4403: a reference-substituted optional parameter with a null
        // default (`T value = default`) lifts to `T?` through symbolic receiver
        // projection too, for both methods and indexers, while a value-type
        // instantiation (`Box[int32]`) stays non-nullable `int32`.
        using let fixture = CSharpFixture(Contract)
        let openBox = fixture.Load().GetType("Adr0193Contracts.OptionalBox`1")!!
        let closedStringBox = openBox.MakeGenericType(typeof(string))
        let stringReceiver = ImportedTypeSymbol.GetConstructed(
            closedStringBox,
            openBox,
            System.Collections.Immutable.ImmutableArray.Create[TypeSymbol](TypeSymbol.String)
        )
        Assert.Same(
            NullableTypeSymbol.Get(TypeSymbol.String),
            MemberLookup.GetClrMethodParameterTypeSymbol(stringReceiver, closedStringBox.GetMethod("Put")!!, 0)
        )
        Assert.Same(
            NullableTypeSymbol.Get(TypeSymbol.String),
            MemberLookup.GetIndexerParameterTypeSymbol(stringReceiver, closedStringBox.GetProperty("Item")!!, 1)
        )

        let closedIntBox = openBox.MakeGenericType(typeof(int32))
        let intReceiver = ImportedTypeSymbol.GetConstructed(
            closedIntBox,
            openBox,
            System.Collections.Immutable.ImmutableArray.Create[TypeSymbol](TypeSymbol.Int32)
        )
        Assert.Same(
            TypeSymbol.Int32,
            MemberLookup.GetClrMethodParameterTypeSymbol(intReceiver, closedIntBox.GetMethod("Put")!!, 0)
        )
        Assert.Same(
            TypeSymbol.Int32,
            MemberLookup.GetIndexerParameterTypeSymbol(intReceiver, closedIntBox.GetProperty("Item")!!, 1)
        )

        let ok = EmittedOracle.Evaluate([]string{`import Adr0193Contracts

func Use(box OptionalBox[string], maybe string?) string? {
    box.Put(nil)
    box.Put(maybe)
    return box[0, nil]
}`}, EmittedOracleOptions{IsLibrary: true, References: []string{fixture.AssemblyPath}})
        Assert.Empty(ok.Diagnostics)

        let valueRejected = EmittedOracle.Evaluate([]string{`import Adr0193Contracts

func Use(box OptionalBox[int32], maybe int32?) {
    box.Put(maybe)
}`}, EmittedOracleOptions{IsLibrary: true, References: []string{fixture.AssemblyPath}})
        Assert.Contains(
            valueRejected.Diagnostics,
            (diagnostic Diagnostic) -> diagnostic.Id is "GS0154" or "GS0155" or "GS0159"
        )
    }

    @Fact
    func RangeSliceReturningReceiverTypeKeepsDeclaredAndObliviousNullability() {
        // Issue #4473: a slice member (`Slice(int, int)` or `this[Range]`)
        // whose reflected return type equals the receiver's CLR type must read
        // its return nullability through the receiver-aware funnel readers
        // rather than returning `target.Type` verbatim.
        using let fixture = CSharpFixture(Contract)
        for (targetType, expression) in[](string, string){
            ("NullableSliceWindow", "w[1..3]"),
            ("NullableSliceWindow", "w[r]"),
            ("NullableRangeWindow", "idx[1..3]"),
            ("NullableRangeWindow", "idx[r]"),
            ("GenericNullableSliceWindow[string]", "gw[1..3]"),
            ("GenericNullableSliceWindow[string]", "gw[r]")
        } {
            let rejected = EmittedOracle.Evaluate(
                []string{
                    "import System\nimport Adr0193Contracts\n\nfunc Take(w NullableSliceWindow, idx NullableRangeWindow, gw GenericNullableSliceWindow[string], r Range) {\n    let a " +
                        targetType +
                        " = " +
                        expression +
                        "\n}"
                },
                EmittedOracleOptions{IsLibrary: true, References: []string{fixture.AssemblyPath}}
            )
            Assert.Contains(
                rejected.Diagnostics,
                (diagnostic Diagnostic) -> diagnostic.Message.Contains(targetType + "?", StringComparison.Ordinal)
            )
        }

        let accepted = EmittedOracle.Evaluate([]string{`import System
import Adr0193Contracts

func Take(
    w NullableSliceWindow,
    idx NullableRangeWindow,
    gw GenericNullableSliceWindow[string],
    ow ObliviousSliceWindow,
    r Range
) (NullableSliceWindow?, NullableRangeWindow?, GenericNullableSliceWindow[string]?, ObliviousSliceWindow?) {
    return (w[1..3], idx[r], gw[1..3], ow[1..3])
}`}, EmittedOracleOptions{IsLibrary: true, References: []string{fixture.AssemblyPath}})
        Assert.Empty(accepted.Diagnostics)

        let receiver = ImportedTypeSymbol.Get(fixture.Load().GetType("Adr0193Contracts.ObliviousSliceWindow")!!)
        let sliceMethod = receiver.ClrType!!.GetMethod("Slice")!!
        Assert.Equal(
            ReferenceNullabilityKind.Platform,
            MemberLookup.GetClrMethodReturnTypeSymbol(receiver, sliceMethod).ReferenceNullability
        )
    }

    @Fact
    func ImportedClrOperatorsKeepTheirDeclaredReturnAndParameterNullability() {
        // Issue #4487: imported unary and binary CLR operators route their
        // return and operand positions through `ClrNullability`, so a
        // declared `string?` / `Money?` return is rejected at a non-null
        // target while a nullable target compiles cleanly.
        AssertNullableStringRejected(`import Adr0193Contracts

func Unary(m Money) {
    let s string = -m
}`)
        using let fixture = CSharpFixture(Contract)
        let binaryRejected = EmittedOracle.Evaluate([]string{`import Adr0193Contracts

func Binary(a Money, b Money) {
    let sum Money = a + b
}`}, EmittedOracleOptions{IsLibrary: true, References: []string{fixture.AssemblyPath}})
        Assert.Contains(
            binaryRejected.Diagnostics,
            (diagnostic Diagnostic) -> diagnostic.Message.Contains("Money?", StringComparison.Ordinal)
        )

        let accepted = EmittedOracle.Evaluate([]string{`import Adr0193Contracts

func Accepted(a Money, b Money) (string?, Money?, Money?) {
    return (-a, a + b, a * nil)
}`}, EmittedOracleOptions{IsLibrary: true, References: []string{fixture.AssemblyPath}})
        Assert.Empty(accepted.Diagnostics)
    }

    shared {
        private const Contract string = `#nullable enable
namespace Adr0193Contracts
{
    public sealed class OptionalBox<T>
    {
        public void Put(T value = default!) { }

        public T? this[int index, T fallback = default!] => fallback;
    }

    public sealed class NullableSliceWindow
    {
        public int Length => 4;

        public NullableSliceWindow? Slice(int start, int length) => null;
    }

    public sealed class NullableRangeWindow
    {
        public NullableRangeWindow? this[System.Range range] => null;
    }

    public sealed class GenericNullableSliceWindow<T>
    {
        public int Length => 4;

        public GenericNullableSliceWindow<T>? Slice(int start, int length) => null;
    }

    public sealed class Money
    {
        public static string? operator -(Money value) => null;

        public static Money? operator +(Money left, Money right) => null;

        public static Money? operator *(Money left, string? note) => null;
    }
#nullable disable
    public sealed class ObliviousSliceWindow
    {
        public int Length => 4;

        public ObliviousSliceWindow Slice(int start, int length) => null;
    }
#nullable enable
    public sealed class NullableItems
    {
        public Enumerator GetEnumerator() => new Enumerator();

        public struct Enumerator
        {
            private int index;

            public bool MoveNext() => index++ < 1;

            public string? Current => null;
        }
    }

    public struct NullableEnumerator
    {
        private int index;

        public bool MoveNext() => index++ < 1;

        public string? Current => null;
    }

    public sealed class NullableAsyncItems
    {
        public AsyncEnumerator GetAsyncEnumerator() => new AsyncEnumerator();

        public struct AsyncEnumerator
        {
            private int index;

            public System.Threading.Tasks.ValueTask<bool> MoveNextAsync()
                => new System.Threading.Tasks.ValueTask<bool>(index++ < 1);

            public string? Current => null;
        }
    }

    public sealed class NullableAwaitable
    {
        public Awaiter GetAwaiter() => new Awaiter();

        public readonly struct Awaiter : System.Runtime.CompilerServices.INotifyCompletion
        {
            public bool IsCompleted => true;

            public string? GetResult() => null;

            public void OnCompleted(System.Action continuation) => continuation();
        }
    }
}`

        private func AssertNullableStringRejected(source string) {
            using let fixture = CSharpFixture(Contract)
            let result = EmittedOracle.Evaluate(
                []string{source},
                EmittedOracleOptions{IsLibrary: true, References: []string{fixture.AssemblyPath}}
            )
            Assert.Contains(
                result.Diagnostics,
                (diagnostic Diagnostic) -> diagnostic.Message.Contains("string?", StringComparison.Ordinal)
            )
        }
    }
}
