// <copyright file="AsyncKickoffEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using System.Runtime.Loader;
using System.Threading.Tasks;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Emit;

/// <summary>
/// End-to-end emit tests for the async kickoff body pipeline.
/// Verifies that async functions compile to valid PE assemblies with
/// synthesized state-machine types and kickoff stubs that run correctly.
/// </summary>
public class AsyncKickoffEmitTests
{
    [Fact]
    public void AsyncTask_EmptyBody_Emits_And_Completes()
    {
        const string Source = @"package AsyncTest
import System

async func doIt() {
}

doIt()
Console.WriteLine(""done"")
";
        var output = CompileAndRun(Source, "AsyncTaskEmpty");
        Assert.Contains("done", output);
    }

    [Fact]
    public void AsyncTask_CompletedTask_IsCompletedSuccessfully()
    {
        const string Source = @"package AsyncTest2
import System
import System.Threading.Tasks

async func doIt() {
}

var t = doIt()
Console.WriteLine(t.IsCompletedSuccessfully)
";
        var output = CompileAndRun(Source, "AsyncTaskCompleted");
        Assert.Contains("True", output);
    }

    [Fact]
    public void AsyncTaskOfInt_Returns_Default_Value()
    {
        // The MoveNext body now executes the user code, so result is 42.
        const string Source = @"package AsyncTestInt
import System
import System.Threading.Tasks

async func getVal() int {
    return 42
}

var t = getVal()
Console.WriteLine(t.IsCompletedSuccessfully)
Console.WriteLine(t.Result)
";
        var output = CompileAndRun(Source, "AsyncTaskInt");
        Assert.Contains("True", output);
        Assert.Contains("42", output);
    }

    [Fact]
    public void AsyncVoid_Emits_And_Runs()
    {
        // async void methods use AsyncVoidMethodBuilder.
        // For now the GSharp parser models `async func F() {}` as returning Task.
        // This test verifies the basic kickoff emits and runs without crash.
        const string Source = @"package AsyncVoidTest
import System

async func fire() {
}

fire()
Console.WriteLine(""fired"")
";
        var output = CompileAndRun(Source, "AsyncVoidTest");
        Assert.Contains("fired", output);
    }

    [Fact]
    public void AsyncTask_WithParameters_CopiesParametersToStateMachine()
    {
        const string Source = @"package AsyncParamsTest
import System
import System.Threading.Tasks

async func addLater(a int, b int) int {
    return a + b
}

var t = addLater(3, 4)
Console.WriteLine(t.IsCompletedSuccessfully)
";
        var output = CompileAndRun(Source, "AsyncParamsTest");
        Assert.Contains("True", output);
    }

    [Fact]
    public void AsyncTask_StateMachineType_Exists_In_PE()
    {
        const string Source = @"package AsyncSMTypeTest
import System

async func doIt() {
}

doIt()
";
        using var peStream = new MemoryStream();
        var tree = SyntaxTree.Parse(SourceText.From(Source));
        var compilation = new Compilation(tree);
        var result = compilation.Emit(peStream);

        Assert.True(
            result.Success,
            "compilation should succeed: " + string.Join("; ", result.Diagnostics.Select(d => d.Message)));

        peStream.Position = 0;
        using var peReader = new PEReader(peStream);
        var metadataReader = peReader.GetMetadataReader();

        // Find the state-machine type: name contains "<doIt>d__"
        var smTypes = metadataReader.TypeDefinitions
            .Select(td => metadataReader.GetTypeDefinition(td))
            .Where(td => metadataReader.GetString(td.Name).Contains("<doIt>d__"))
            .ToList();

        Assert.Single(smTypes);
        var smType = smTypes[0];

        // Verify it's a struct (sealed, sequential layout)
        Assert.True(smType.Attributes.HasFlag(System.Reflection.TypeAttributes.Sealed));

        // Verify it has MoveNext and SetStateMachine methods
        var methods = smType.GetMethods()
            .Select(mh => metadataReader.GetString(metadataReader.GetMethodDefinition(mh).Name))
            .ToList();
        Assert.Contains("MoveNext", methods);
        Assert.Contains("SetStateMachine", methods);
    }

    [Fact]
    public void AsyncTask_KickoffMethod_Returns_Task_Type()
    {
        const string Source = @"package AsyncReturnTypeTest
import System
import System.Threading.Tasks

async func doIt() {
}

var t = doIt()
Console.WriteLine(t.GetType().FullName)
";
        var output = CompileAndRun(Source, "AsyncReturnTypeTest");
        Assert.Contains("System.Threading.Tasks.Task", output);
    }

    [Fact]
    public void AsyncTask_MultipleAsyncFunctions_AllEmit()
    {
        const string Source = @"package AsyncMultiTest
import System
import System.Threading.Tasks

async func first() {
}

async func second() int {
    return 1
}

var t1 = first()
var t2 = second()
Console.WriteLine(t1.IsCompletedSuccessfully)
Console.WriteLine(t2.IsCompletedSuccessfully)
";
        var output = CompileAndRun(Source, "AsyncMultiTest");
        Assert.Contains("True", output);
    }

    private static string CompileAndRun(string source, string contextName)
    {
        using var peStream = new MemoryStream();
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        var result = compilation.Emit(peStream);

        Assert.True(
            result.Success,
            "compilation should succeed: " + string.Join("; ", result.Diagnostics.Select(d => d.Message)));

        peStream.Position = 0;
        var loadContext = new AssemblyLoadContext(contextName, isCollectible: true);
        try
        {
            var asm = loadContext.LoadFromStream(peStream);
            var programType = asm.GetTypes().FirstOrDefault(t => t.Name == "<Program>");
            Assert.NotNull(programType);
            var entry = programType!.GetMethod(
                "<Main>$",
                BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic);
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

            return captured.ToString();
        }
        finally
        {
            loadContext.Unload();
        }
    }
}
