// <copyright file="AsyncStateMachineTypedefTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using System.Runtime.CompilerServices;
using System.Runtime.Loader;
using System.Threading.Tasks;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Emit;

/// <summary>
/// Validates the synthesized state-machine typedef structure:
/// interface implementations, visibility, and method attributes.
/// </summary>
public class AsyncStateMachineTypedefTests
{
    [Fact]
    public void AsyncMethod_StateMachine_ImplementsIAsyncStateMachine_AndIsNestedPrivate()
    {
        const string Source = @"package SmTypedefTest
import System
import System.Threading.Tasks

async func doWork() int32 {
    return 7
}

var t = doWork()
t.Wait()
Console.WriteLine(t.Result)
";
        using var peStream = new MemoryStream();
        var tree = SyntaxTree.Parse(SourceText.From(Source));
        var compilation = new Compilation(tree);
        var result = compilation.Emit(peStream);
        Assert.True(result.Success, "Compilation failed: " + string.Join("; ", result.Diagnostics.Select(d => d.Message)));

        peStream.Position = 0;
        var loadContext = new AssemblyLoadContext(nameof(AsyncMethod_StateMachine_ImplementsIAsyncStateMachine_AndIsNestedPrivate), isCollectible: true);
        try
        {
            var asm = loadContext.LoadFromStream(peStream);
            var smType = asm.GetTypes().FirstOrDefault(t => t.Name.Contains("<doWork>d__"));
            Assert.NotNull(smType);

            // Implements IAsyncStateMachine
            Assert.Contains(typeof(IAsyncStateMachine), smType!.GetInterfaces());

            // Has MoveNext and SetStateMachine
            var moveNext = smType.GetMethod("MoveNext", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance);
            Assert.NotNull(moveNext);
            var setStateMachine = smType.GetMethod("SetStateMachine", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance);
            Assert.NotNull(setStateMachine);

            // Roslyn convention: SM types are nested-private inside declaring type.
            Assert.True(smType.IsNested, "SM type should be nested");
            Assert.True(smType.IsNestedPrivate, "SM type should be nested-private");
            Assert.True(smType.IsValueType, "SM type should be a struct");

            // Declaring type is the per-package <Program> class.
            Assert.NotNull(smType.DeclaringType);
            Assert.Equal("<Program>", smType.DeclaringType!.Name);
        }
        finally
        {
            loadContext.Unload();
        }
    }

    [Fact]
    public void AsyncLambda_StateMachine_ImplementsIAsyncStateMachine()
    {
        const string Source = @"package SmLambdaTypedefTest
import System
import System.Threading.Tasks

var f = async func() int32 {
    await Task.CompletedTask
    return 99
}

var t = f()
t.Wait()
Console.WriteLine(t.Result)
";
        using var peStream = new MemoryStream();
        var tree = SyntaxTree.Parse(SourceText.From(Source));
        var compilation = new Compilation(tree);
        var result = compilation.Emit(peStream);
        Assert.True(result.Success, "Compilation failed: " + string.Join("; ", result.Diagnostics.Select(d => d.Message)));

        peStream.Position = 0;
        var loadContext = new AssemblyLoadContext(nameof(AsyncLambda_StateMachine_ImplementsIAsyncStateMachine), isCollectible: true);
        try
        {
            var asm = loadContext.LoadFromStream(peStream);

            // Async lambda state machines have a generated name with "d__" pattern
            var smTypes = asm.GetTypes().Where(t => t.GetInterfaces().Contains(typeof(IAsyncStateMachine))).ToList();
            Assert.NotEmpty(smTypes);

            var smType = smTypes[0];
            var moveNext = smType.GetMethod("MoveNext", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance);
            Assert.NotNull(moveNext);

            // No-capture async lambda SM nests inside <Program>.
            Assert.True(smType.IsNested, "SM type should be nested");
            Assert.True(smType.IsNestedPrivate, "SM type should be nested-private");
            Assert.NotNull(smType.DeclaringType);
            Assert.Equal("<Program>", smType.DeclaringType!.Name);
        }
        finally
        {
            loadContext.Unload();
        }
    }

    [Fact]
    public void AsyncIterator_StateMachine_ImplementsExpectedInterfaces()
    {
        const string Source = @"package SmIterTypedefTest
import System
import System.Collections.Generic
import System.Threading.Tasks

func numbers() IAsyncEnumerable[int32] {
    yield 1
    yield 2
}
";
        using var peStream = new MemoryStream();
        var tree = SyntaxTree.Parse(SourceText.From(Source));
        var compilation = new Compilation(tree);
        var result = compilation.Emit(peStream);
        Assert.True(result.Success, "Compilation failed: " + string.Join("; ", result.Diagnostics.Select(d => d.Message)));

        peStream.Position = 0;
        var loadContext = new AssemblyLoadContext(nameof(AsyncIterator_StateMachine_ImplementsExpectedInterfaces), isCollectible: true);
        try
        {
            var asm = loadContext.LoadFromStream(peStream);

            // Find the state machine type for the async iterator
            var smType = asm.GetTypes().FirstOrDefault(t => t.Name.Contains("<numbers>d__"));
            Assert.NotNull(smType);

            var interfaces = smType!.GetInterfaces().Select(i => i.IsGenericType ? i.GetGenericTypeDefinition().FullName : i.FullName).ToHashSet();

            // Async iterators implement IAsyncEnumerable<T> and IAsyncEnumerator<T>
            Assert.Contains("System.Collections.Generic.IAsyncEnumerable`1", interfaces);
            Assert.Contains("System.Collections.Generic.IAsyncEnumerator`1", interfaces);
            Assert.Contains("System.IAsyncDisposable", interfaces);

            // Async iterator SM is nested-private inside <Program>.
            Assert.True(smType.IsNested, "Async iterator SM should be nested");
            Assert.True(smType.IsNestedPrivate, "Async iterator SM should be nested-private");
            Assert.NotNull(smType.DeclaringType);
            Assert.Equal("<Program>", smType.DeclaringType!.Name);
        }
        finally
        {
            loadContext.Unload();
        }
    }

    [Fact]
    public void AsyncTaskOfString_ReferenceTypeT_Emits_And_Runs()
    {
        const string Source = @"package AsyncStringTest
import System
import System.Threading.Tasks

async func greet() string {
    await Task.CompletedTask
    return ""hello world""
}

var t = greet()
t.Wait()
Console.WriteLine(t.Result)
";
        using var peStream = new MemoryStream();
        var tree = SyntaxTree.Parse(SourceText.From(Source));
        var compilation = new Compilation(tree);
        var result = compilation.Emit(peStream);
        Assert.True(result.Success, "Compilation failed: " + string.Join("; ", result.Diagnostics.Select(d => d.Message)));

        peStream.Position = 0;
        var loadContext = new AssemblyLoadContext(nameof(AsyncTaskOfString_ReferenceTypeT_Emits_And_Runs), isCollectible: true);
        try
        {
            var asm = loadContext.LoadFromStream(peStream);
            var programType = asm.GetTypes().FirstOrDefault(t => t.Name == "<Program>");
            Assert.NotNull(programType);
            var entry = programType!.GetMethod("<Main>$", BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic);
            Assert.NotNull(entry);

            var stdout = Console.Out;
            var captured = new StringWriter();
            Console.SetOut(captured);
            try
            {
                entry!.Invoke(null, parameters: null);
            }
            finally
            {
                Console.SetOut(stdout);
            }

            Assert.Contains("hello world", captured.ToString());
        }
        finally
        {
            loadContext.Unload();
        }
    }

    [Fact]
    public void AsyncLambdaWithCapture_StateMachine_NestsInsideClosureClass()
    {
        // Issue #523: globals are read live via static fields and are not
        // captured into a closure class. Use a function-scoped local so this
        // test exercises the closure-class nesting it's designed to check.
        const string Source = @"package SmClosureNestTest
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
";
        using var peStream = new MemoryStream();
        var tree = SyntaxTree.Parse(SourceText.From(Source));
        var compilation = new Compilation(tree);
        var result = compilation.Emit(peStream);
        Assert.True(result.Success, "Compilation failed: " + string.Join("; ", result.Diagnostics.Select(d => d.Message)));

        peStream.Position = 0;
        var loadContext = new AssemblyLoadContext(nameof(AsyncLambdaWithCapture_StateMachine_NestsInsideClosureClass), isCollectible: true);
        try
        {
            var asm = loadContext.LoadFromStream(peStream);

            var smType = asm.GetTypes().FirstOrDefault(t => t.GetInterfaces().Contains(typeof(IAsyncStateMachine)));
            Assert.NotNull(smType);

            // Capture-bearing async lambda SM nests inside its closure class.
            Assert.True(smType!.IsNested, "SM type should be nested");
            Assert.True(smType.IsNestedPrivate, "SM type should be nested-private");
            Assert.NotNull(smType.DeclaringType);

            // The declaring type should be the closure class (not <Program>).
            Assert.NotEqual("<Program>", smType.DeclaringType!.Name);
            Assert.True(smType.DeclaringType.IsClass, "Declaring type should be a class (the closure)");
        }
        finally
        {
            loadContext.Unload();
        }
    }

    [Fact]
    public void SyncIterator_StateMachine_IsNestedPrivate()
    {
        const string Source = @"package SmSyncIterTest
import System
import System.Collections.Generic

func items() IEnumerable[int32] {
    yield 1
    yield 2
    yield 3
}
";
        using var peStream = new MemoryStream();
        var tree = SyntaxTree.Parse(SourceText.From(Source));
        var compilation = new Compilation(tree);
        var result = compilation.Emit(peStream);
        Assert.True(result.Success, "Compilation failed: " + string.Join("; ", result.Diagnostics.Select(d => d.Message)));

        peStream.Position = 0;
        var loadContext = new AssemblyLoadContext(nameof(SyncIterator_StateMachine_IsNestedPrivate), isCollectible: true);
        try
        {
            var asm = loadContext.LoadFromStream(peStream);
            var smType = asm.GetTypes().FirstOrDefault(t => t.Name.Contains("<items>d__"));
            Assert.NotNull(smType);

            // Sync iterator SM is nested-private inside <Program>.
            Assert.True(smType!.IsNested, "Sync iterator SM should be nested");
            Assert.True(smType.IsNestedPrivate, "Sync iterator SM should be nested-private");
            Assert.NotNull(smType.DeclaringType);
            Assert.Equal("<Program>", smType.DeclaringType!.Name);
        }
        finally
        {
            loadContext.Unload();
        }
    }

    [Fact]
    public void AsyncMethod_NestedSm_RoundTrips_EmitAndInvoke()
    {
        // Runtime behavior test: ensures nesting doesn't break member resolution.
        const string Source = @"package SmRoundTripTest
import System
import System.Threading.Tasks

async func compute() int32 {
    await Task.CompletedTask
    return 100 + 23
}

var t = compute()
t.Wait()
Console.WriteLine(t.Result)
";
        using var peStream = new MemoryStream();
        var tree = SyntaxTree.Parse(SourceText.From(Source));
        var compilation = new Compilation(tree);
        var result = compilation.Emit(peStream);
        Assert.True(result.Success, "Compilation failed: " + string.Join("; ", result.Diagnostics.Select(d => d.Message)));

        peStream.Position = 0;
        var loadContext = new AssemblyLoadContext(nameof(AsyncMethod_NestedSm_RoundTrips_EmitAndInvoke), isCollectible: true);
        try
        {
            var asm = loadContext.LoadFromStream(peStream);
            var programType = asm.GetTypes().FirstOrDefault(t => t.Name == "<Program>");
            Assert.NotNull(programType);
            var entry = programType!.GetMethod("<Main>$", BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic);
            Assert.NotNull(entry);

            var stdout = Console.Out;
            var captured = new StringWriter();
            Console.SetOut(captured);
            try
            {
                entry!.Invoke(null, parameters: null);
            }
            finally
            {
                Console.SetOut(stdout);
            }

            Assert.Contains("123", captured.ToString());
        }
        finally
        {
            loadContext.Unload();
        }
    }
}
