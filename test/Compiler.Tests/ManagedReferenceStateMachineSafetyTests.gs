// <copyright file="ManagedReferenceStateMachineSafetyTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests

import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Tests
import Gsharp.Values
import System
import System.IO
import System.Reflection
import Xunit

class ManagedReferenceStateMachineSafetyTests {
    @Theory
    @InlineData("async func Bad(scoped p managed[int32]) int32 { return *p }")
    @InlineData("async func Bad(scoped p readonly managed[int32]?) int32 { await Task.Delay(1); return *(p!!) }")
    @InlineData("async func Bad[T](scoped p managed[T]) T { await Task.Delay(1); return *p }")
    @InlineData("suspend func Bad(scoped p managed[int32]) int32 { return *p }")
    @InlineData("func Bad(scoped p managed[int32]) sequence[int32] { yield *p }")
    @InlineData("async func Bad(scoped p readonly managed[int32]) async sequence[int32] { yield *p }")
    func ScopedHandleParametersCannotEnterStateMachines(declaration string) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let (code, output) = fixture.TryCompile(`package ScopedStateMachineReject
import System.Threading.Tasks
` + declaration, "ScopedStateMachineReject", executable: false)
        Assert.NotEqual(0, code)
        Assert.Contains("error GS0604:", output, StringComparison.Ordinal)
    }

    @Theory
    @InlineData("async func Bad(p managed[int32]) int32 { let scoped local managed[int32] = p; return *local }")
    @InlineData(
        "func Bad(p readonly managed[int32]) sequence[int32] { let scoped local readonly managed[int32] = p; yield *local }"
    )
    func ScopedHandleLocalsCannotEnterStateMachines(declaration string) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let (code, output) = fixture.TryCompile(
            "package ScopedStateMachineLocalReject\n" + declaration,
            "ScopedStateMachineLocalReject",
            executable: false
        )
        Assert.NotEqual(0, code)
        Assert.Contains("error GS0604:", output, StringComparison.Ordinal)
    }

    @Fact
    func OrdinaryScopedFunctionsAndScalarCopiesRemainValid() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let dll = fixture.Compile(`package ScopedStateMachineControls
import System
import System.Threading.Tasks
func Copy[T](scoped p readonly managed[T]) T {
    let scoped local readonly managed[T] = p
    return *local
}
async func Later(value int32) int32 {
    await Task.Delay(1)
    return value
}
func Main() {
    var value = 42
    Console.WriteLine(Later(Copy(readonly managed(value))).GetAwaiter().GetResult())
}`, "ScopedStateMachineControls", executable: true)
        IlVerifier.Verify(dll)
        Assert.Equal("42\n", fixture.Run(dll))
    }

    @Fact
    func NonScopedHandlesCrossStateMachinesAndReferenceAssemblies() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let reference = Path.Combine(fixture.Directory, "StateMachineHandleApi.ref.dll")
        let api = fixture.Compile(`package StateMachineHandleApi
import System.Threading.Tasks
public class Api {
    shared {
        public async func Read(value managed[int32]) int32 {
            await Task.Delay(1)
            return *value
        }
        public func Values(value readonly managed[int32]) sequence[int32] {
            yield *value
        }
    }
}`, "StateMachineHandleApi", executable: false, "/refout:" + reference)
        IlVerifier.Verify(api)
        let consumer = fixture.CompileCSharp(`using Gsharp.Values;
using StateMachineHandleApi;
public static class Consumer {
    public static int Run() {
        var values = new[] { 21 };
        var handle = ManagedRef<int>.FromArray(values, 0);
        var result = Api.Read(handle).GetAwaiter().GetResult();
        foreach (var item in Api.Values(handle.AsReadOnly()))
            result += item;
        return result;
    }
}`, "StateMachineHandleConsumer", api, reference)
        IlVerifier.Verify(consumer, []string{api})
        let assemblies = EmittedFixture.LoadTogether(api, consumer)
        Assert.Equal(42, assemblies[1].GetType("Consumer")!!.GetMethod("Run")!!.Invoke(nil, nil))
    }

    @Fact
    func NonScopedStateMachineHandlesSurviveRepeatedImplementationAndReferenceEmit() {
        const source = `package RepeatedStateMachineHandle
import System.Threading.Tasks
public async func Read(value managed[int32]) int32 {
    await Task.Delay(1)
    return *value
}`
        using let references = ReferenceResolver.WithRuntimeReferences(
            []string{typeof(ManagedRef[_]).Assembly.Location}
        )
        let compilation = Compilation(references, SyntaxTree.Parse(source)){IsLibrary = true}
        Assert.Empty(compilation.BoundProgram.Diagnostics)
        for var i = 0; i < 2; i++ {
            using let pe = MemoryStream()
            using let reference = MemoryStream()
            let result = compilation.Emit(pe, nil, reference)
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
            Assert.True(pe.Length > int64(0))
            Assert.True(reference.Length > int64(0))
        }
    }
}
