// <copyright file="Issue4214ClrRuntimeParityTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Emit

import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Emit
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Tests
import System.Collections.Immutable
import System.IO
import System.Reflection
import System.Reflection.Metadata
import System.Reflection.PortableExecutable
import Xunit

open class Issue4214ClrRuntimeParityTests {
    @Fact
    func ScalarGlobalReader_PreservesNullAndItsContract() {
        let method MethodInfo? = typeof(EmittedOracleResult).GetMethod("ReadGlobal")
        Assert.Equal(NullabilityState.Nullable, NullabilityInfoContext().Create(method!!.ReturnParameter).ReadState)
        let result = EmittedOracle.Evaluate("let value string? = nil")
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.ReadGlobal("value"))
        Assert.Null(result.ReadGlobal("missing"))
        Assert.Null(result.ReadGlobal(string.Empty))
        Assert.Null(result.ReadGlobal(nil))
        let failed = EmittedOracle.Evaluate("let value = unknownName")
        Assert.NotEmpty(failed.Diagnostics)
        Assert.Null(failed.ReadGlobal("value"))
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func AssemblyIdentity_UsesDeclaredAssemblyVersionInsteadOfProductVersion(declaredVersion bool) {
        let source = (
            if declaredVersion {
                "@assembly: System.Reflection.AssemblyVersion(\"2.3.0.0\")\n"
            } else {
                string.Empty
            }
        ) +
            "class Identity {}"
        using let stream = MemoryStream()
        let compilation = Compilation(SyntaxTree.Parse(source)){IsLibrary = true}
        let result = compilation.Emit(
            stream,
            pdbStream: nil,
            refStream: nil,
            assemblyName: "Identity",
            assemblyVersion: "2.3.57-beta+abcdef"
        )
        Assert.True(result.Success, string.Join("; ", result.Diagnostics))
        stream.Position = 0
        using let pe = PEReader(stream)
        Assert.Equal(
            if declaredVersion {
                "2.3.0.0"
            } else {
                "2.3.57.0"
            },
            pe.GetMetadataReader().GetAssemblyDefinition().Version.ToString()
        )
    }

    @Fact
    func FunctionType_MetadataRetainsNestedNullableSlots() {
        let nullableString = NullableTypeSymbol.Get(TypeSymbol.String)
        let function = FunctionTypeSymbol.Get(ImmutableArray.Create[TypeSymbol](nullableString), nullableString)
        Assert.Equal([]uint8{1, 2, 2}, NullableFlagsBuilder.Build(function))
        Assert.Equal([]uint8{2, 2, 2}, NullableFlagsBuilder.Build(NullableTypeSymbol.Get(function)))
        let action = FunctionTypeSymbol.Get(ImmutableArray.Create[TypeSymbol](nullableString), TypeSymbol.Void)
        Assert.Equal([]uint8{1, 2}, NullableFlagsBuilder.Build(action))
        let nonNull = FunctionTypeSymbol.Get(ImmutableArray.Create(TypeSymbol.String), TypeSymbol.Bool)
        Assert.Equal([]uint8{1, 1}, NullableFlagsBuilder.Build(nonNull))
        let parameter = TypeParameterSymbol("T", 0, TypeParameterConstraint.Any, TypeParameterVariance.None)
        let symbolic = FunctionTypeSymbol.Get(ImmutableArray.Create[TypeSymbol](parameter), TypeSymbol.Bool)
        Assert.Null(symbolic.ClrType)
        Assert.Equal([]uint8{1}, NullableFlagsBuilder.Build(symbolic))
    }

    @Fact
    func InterpolatedFieldPostIncrement_UsesOriginalValues() {
        let result = EmittedOracle.Evaluate(`class Counter {
    private var ordinal int32
    func Next() string -> "${ordinal++}:${ordinal++}:${ordinal}"
}
Counter().Next()`)
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal("0:1:2", result.Value)
    }

    @Fact
    func NestedAsyncClosure_PreservesCapturedUsingLocal() {
        let result = EmittedOracle.Evaluate(`import System.Threading
import System.Threading.Tasks
async func Run() int32 {
    using let ready = CountdownEvent(1)
    let outer = async func () {
        ready.Signal()
        await Task.Run(() -> ready.Wait())
    }
    await outer()
    return 42
}
Run().GetAwaiter().GetResult()`)
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(42, result.Value)
    }
}
