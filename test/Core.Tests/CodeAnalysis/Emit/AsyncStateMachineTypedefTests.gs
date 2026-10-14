// <copyright file="AsyncStateMachineTypedefTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Emit

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.IO
import System.Linq
import System.Reflection
import System.Reflection.Metadata
import System.Reflection.PortableExecutable
import System.Runtime.CompilerServices
import System.Runtime.Loader
import System.Threading.Tasks
import Xunit

/// Validates the synthesized state-machine typedef structure:
/// interface implementations, visibility, and method attributes.
open class AsyncStateMachineTypedefTests {
    @Fact
    func AsyncMethod_StateMachine_ImplementsIAsyncStateMachine_AndIsNestedPrivate() {
        const Source = `package SmTypedefTest
import System
import System.Threading.Tasks

async func doWork() int32 {
    return 7
}

var t = doWork()
t.Wait()
Console.WriteLine(t.Result)
`
        using let peStream = MemoryStream()
        let tree = SyntaxTree.Parse(SourceText.From(Source))
        let compilation = Compilation(tree)
        let result = compilation.Emit(peStream)
        Assert.True(
            result.Success,
            "Compilation failed: " + string.Join("; ", result.Diagnostics.Select((d Diagnostic) -> d.Message))
        )
        peStream.Position = 0
        let loadContext = AssemblyLoadContext(
            "AsyncMethod_StateMachine_ImplementsIAsyncStateMachine_AndIsNestedPrivate",
            isCollectible: true
        )
        try {
            let asm = loadContext.LoadFromStream(peStream)
            let smType Type? = asm.GetTypes().FirstOrDefault((t Type) -> t.Name.Contains("<doWork>d__"))
            Assert.NotNull(smType)
            // Implements IAsyncStateMachine
            Assert.Contains(typeof(IAsyncStateMachine), smType!!.GetInterfaces())
            // Has MoveNext and SetStateMachine
            let moveNext MethodInfo? = smType!!.GetMethod(
                "MoveNext",
                BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance
            )
            Assert.NotNull(moveNext)
            let setStateMachine MethodInfo? = smType!!.GetMethod(
                "SetStateMachine",
                BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance
            )
            Assert.NotNull(setStateMachine)
            // Roslyn convention: SM types are nested-private inside declaring type.
            Assert.True(smType!!.IsNested, "SM type should be nested")
            Assert.True(smType!!.IsNestedPrivate, "SM type should be nested-private")
            Assert.True(smType!!.IsValueType, "SM type should be a struct")
            // Declaring type is the per-package <Program> class.
            Assert.NotNull(smType!!.DeclaringType)
            Assert.Equal("<Program>", smType!!.DeclaringType!!.Name)
        } finally {
            loadContext.Unload()
        }
    }

    @Fact
    func AsyncLambda_StateMachine_ImplementsIAsyncStateMachine() {
        const Source = `package SmLambdaTypedefTest
import System
import System.Threading.Tasks

var f = async func() int32 {
    await Task.CompletedTask
    return 99
}

var t = f()
t.Wait()
Console.WriteLine(t.Result)
`
        using let peStream = MemoryStream()
        let tree = SyntaxTree.Parse(SourceText.From(Source))
        let compilation = Compilation(tree)
        let result = compilation.Emit(peStream)
        Assert.True(
            result.Success,
            "Compilation failed: " + string.Join("; ", result.Diagnostics.Select((d Diagnostic) -> d.Message))
        )
        peStream.Position = 0
        let loadContext = AssemblyLoadContext(
            "AsyncLambda_StateMachine_ImplementsIAsyncStateMachine",
            isCollectible: true
        )
        try {
            let asm = loadContext.LoadFromStream(peStream)
            // Async lambda state machines have a generated name with "d__" pattern
            let smTypes = asm
                .GetTypes()
                .Where((t Type) -> t.GetInterfaces().Contains(typeof(IAsyncStateMachine)))
                .ToList()
            Assert.NotEmpty(smTypes)
            let smType = smTypes[0]
            let moveNext MethodInfo? = smType.GetMethod(
                "MoveNext",
                BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance
            )
            Assert.NotNull(moveNext)
            // No-capture async lambda SM nests inside <Program>.
            Assert.True(smType.IsNested, "SM type should be nested")
            Assert.True(smType.IsNestedPrivate, "SM type should be nested-private")
            Assert.NotNull(smType.DeclaringType)
            Assert.Equal("<Program>", smType.DeclaringType!!.Name)
        } finally {
            loadContext.Unload()
        }
    }

    @Fact
    func AsyncIterator_StateMachine_ImplementsExpectedInterfaces() {
        const Source = `package SmIterTypedefTest
import System
import System.Collections.Generic
import System.Threading.Tasks

func numbers() IAsyncEnumerable[int32] {
    yield 1
    yield 2
}
`
        using let peStream = MemoryStream()
        let tree = SyntaxTree.Parse(SourceText.From(Source))
        let compilation = Compilation(tree)
        let result = compilation.Emit(peStream)
        Assert.True(
            result.Success,
            "Compilation failed: " + string.Join("; ", result.Diagnostics.Select((d Diagnostic) -> d.Message))
        )
        peStream.Position = 0
        let loadContext = AssemblyLoadContext(
            "AsyncIterator_StateMachine_ImplementsExpectedInterfaces",
            isCollectible: true
        )
        try {
            let asm = loadContext.LoadFromStream(peStream)
            // Find the state machine type for the async iterator
            let smType Type? = asm.GetTypes().FirstOrDefault((t Type) -> t.Name.Contains("<numbers>d__"))
            Assert.NotNull(smType)
            let interfaces = smType!!
                .GetInterfaces()
                .Select(
                (i Type) -> if i.IsGenericType {
                    i.GetGenericTypeDefinition().FullName!!
                } else {
                    i.FullName!!
                }
            )
                .ToHashSet()
            // Async iterators implement IAsyncEnumerable<T> and IAsyncEnumerator<T>
            Assert.Contains("System.Collections.Generic.IAsyncEnumerable`1", interfaces)
            Assert.Contains("System.Collections.Generic.IAsyncEnumerator`1", interfaces)
            Assert.Contains("System.IAsyncDisposable", interfaces)
            // Async iterator SM is nested-private inside <Program>.
            Assert.True(smType!!.IsNested, "Async iterator SM should be nested")
            Assert.True(smType!!.IsNestedPrivate, "Async iterator SM should be nested-private")
            Assert.NotNull(smType!!.DeclaringType)
            Assert.Equal("<Program>", smType!!.DeclaringType!!.Name)
        } finally {
            loadContext.Unload()
        }
    }

    @Fact
    func AsyncTaskOfString_ReferenceTypeT_Emits_And_Runs() {
        const Source = `package AsyncStringTest
import System
import System.Threading.Tasks

async func greet() string {
    await Task.CompletedTask
    return "hello world"
}

var t = greet()
t.Wait()
Console.WriteLine(t.Result)
`
        using let peStream = MemoryStream()
        let tree = SyntaxTree.Parse(SourceText.From(Source))
        let compilation = Compilation(tree)
        let result = compilation.Emit(peStream)
        Assert.True(
            result.Success,
            "Compilation failed: " + string.Join("; ", result.Diagnostics.Select((d Diagnostic) -> d.Message))
        )
        peStream.Position = 0
        let loadContext = AssemblyLoadContext("AsyncTaskOfString_ReferenceTypeT_Emits_And_Runs", isCollectible: true)
        try {
            let asm = loadContext.LoadFromStream(peStream)
            let programType Type? = asm.GetTypes().FirstOrDefault((t Type) -> t.Name == "<Program>")
            Assert.NotNull(programType)
            let entry MethodInfo? = programType!!.GetMethod(
                "<Main>$$",
                BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic
            )
            Assert.NotNull(entry)
            let stdout = Console.Out
            let captured = StringWriter()
            Console.SetOut(captured)
            try {
                entry!!.Invoke(
                    nil,
                    if entry!!.GetParameters().Length == 0 {
                        default([]?object)
                    } else {
                        []object{Array.Empty[string]()}
                    }
                )
            } finally {
                Console.SetOut(stdout)
            }
            Assert.Contains("hello world", captured.ToString())
        } finally {
            loadContext.Unload()
        }
    }

    @Fact
    func AsyncLambdaWithCapture_StateMachine_NestsInsideClosureClass() {
        // Issue #523: globals are read live via static fields and are not
        // captured into a closure class. Use a function-scoped local so this
        // test exercises the closure-class nesting it's designed to check.
        const Source = `package SmClosureNestTest
import System
import System.Threading.Tasks

func make() func() Task[int32] {
    var x = 42
    return async func() int32 {
        await Task.CompletedTask
        return x
    }
}

var f = make()
var t = f()
t.Wait()
Console.WriteLine(t.Result)
`
        using let peStream = MemoryStream()
        let tree = SyntaxTree.Parse(SourceText.From(Source))
        let compilation = Compilation(tree)
        let result = compilation.Emit(peStream)
        Assert.True(
            result.Success,
            "Compilation failed: " + string.Join("; ", result.Diagnostics.Select((d Diagnostic) -> d.Message))
        )
        peStream.Position = 0
        let loadContext = AssemblyLoadContext(
            "AsyncLambdaWithCapture_StateMachine_NestsInsideClosureClass",
            isCollectible: true
        )
        try {
            let asm = loadContext.LoadFromStream(peStream)
            let smType Type? = asm.GetTypes().FirstOrDefault(
                (t Type) -> t.GetInterfaces().Contains(typeof(IAsyncStateMachine))
            )
            Assert.NotNull(smType)
            // Capture-bearing async lambda SM nests inside its closure class.
            Assert.True(smType!!.IsNested, "SM type should be nested")
            Assert.True(smType!!.IsNestedPrivate, "SM type should be nested-private")
            Assert.NotNull(smType!!.DeclaringType)
            // The declaring type should be the closure class (not <Program>).
            Assert.NotEqual("<Program>", smType!!.DeclaringType!!.Name)
            Assert.True(smType!!.DeclaringType!!.IsClass, "Declaring type should be a class (the closure)")
        } finally {
            loadContext.Unload()
        }
    }

    @Fact
    func SyncIterator_StateMachine_IsNestedPrivate() {
        const Source = `package SmSyncIterTest
import System
import System.Collections.Generic

func items() IEnumerable[int32] {
    yield 1
    yield 2
    yield 3
}
`
        using let peStream = MemoryStream()
        let tree = SyntaxTree.Parse(SourceText.From(Source))
        let compilation = Compilation(tree)
        let result = compilation.Emit(peStream)
        Assert.True(
            result.Success,
            "Compilation failed: " + string.Join("; ", result.Diagnostics.Select((d Diagnostic) -> d.Message))
        )
        peStream.Position = 0
        let loadContext = AssemblyLoadContext("SyncIterator_StateMachine_IsNestedPrivate", isCollectible: true)
        try {
            let asm = loadContext.LoadFromStream(peStream)
            let smType Type? = asm.GetTypes().FirstOrDefault((t Type) -> t.Name.Contains("<items>d__"))
            Assert.NotNull(smType)
            // Sync iterator SM is nested-private inside <Program>.
            Assert.True(smType!!.IsNested, "Sync iterator SM should be nested")
            Assert.True(smType!!.IsNestedPrivate, "Sync iterator SM should be nested-private")
            Assert.NotNull(smType!!.DeclaringType)
            Assert.Equal("<Program>", smType!!.DeclaringType!!.Name)
        } finally {
            loadContext.Unload()
        }
    }

    @Fact
    func AsyncMethod_NestedSm_RoundTrips_EmitAndInvoke() {
        // Runtime behavior test: ensures nesting doesn't break member resolution.
        const Source = `package SmRoundTripTest
import System
import System.Threading.Tasks

async func compute() int32 {
    await Task.CompletedTask
    return 100 + 23
}

var t = compute()
t.Wait()
Console.WriteLine(t.Result)
`
        using let peStream = MemoryStream()
        let tree = SyntaxTree.Parse(SourceText.From(Source))
        let compilation = Compilation(tree)
        let result = compilation.Emit(peStream)
        Assert.True(
            result.Success,
            "Compilation failed: " + string.Join("; ", result.Diagnostics.Select((d Diagnostic) -> d.Message))
        )
        peStream.Position = 0
        let loadContext = AssemblyLoadContext("AsyncMethod_NestedSm_RoundTrips_EmitAndInvoke", isCollectible: true)
        try {
            let asm = loadContext.LoadFromStream(peStream)
            let programType Type? = asm.GetTypes().FirstOrDefault((t Type) -> t.Name == "<Program>")
            Assert.NotNull(programType)
            let entry MethodInfo? = programType!!.GetMethod(
                "<Main>$$",
                BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic
            )
            Assert.NotNull(entry)
            let stdout = Console.Out
            let captured = StringWriter()
            Console.SetOut(captured)
            try {
                entry!!.Invoke(
                    nil,
                    if entry!!.GetParameters().Length == 0 {
                        default([]?object)
                    } else {
                        []object{Array.Empty[string]()}
                    }
                )
            } finally {
                Console.SetOut(stdout)
            }
            Assert.Contains("123", captured.ToString())
        } finally {
            loadContext.Unload()
        }
    }
}
