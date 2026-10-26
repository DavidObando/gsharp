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

    shared {
        private const Contract string = `#nullable enable
namespace Adr0193Contracts
{
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
