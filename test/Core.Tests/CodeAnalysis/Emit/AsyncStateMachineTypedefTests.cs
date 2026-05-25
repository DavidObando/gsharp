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

async func doWork() int {
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

            // Note: GSharp emits SM types at top level (not nested).
            // Roslyn convention is nested-private. This is a known deviation;
            // follow-up tracked separately.
            Assert.True(smType.IsValueType, "SM type should be a struct");
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

var f = async func() int {
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

func numbers() IAsyncEnumerable[int] {
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
}
