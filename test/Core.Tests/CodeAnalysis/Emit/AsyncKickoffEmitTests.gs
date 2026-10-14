// <copyright file="AsyncKickoffEmitTests.cs" company="GSharp">
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

/// End-to-end emit tests for the async kickoff body pipeline.
/// Verifies that async functions compile to valid PE assemblies with
/// synthesized state-machine types and kickoff stubs that run correctly.
open class AsyncKickoffEmitTests {
    @Fact
    func AsyncTask_EmptyBody_Emits_And_Completes() {
        const Source = `package AsyncTest
import System

async func doIt() {
}

doIt()
Console.WriteLine("done")
`
        let output = CompileAndRun(Source, "AsyncTaskEmpty")
        Assert.Contains("done", output)
    }

    @Fact
    func AsyncTask_CompletedTask_IsCompletedSuccessfully() {
        const Source = `package AsyncTest2
import System
import System.Threading.Tasks

async func doIt() {
}

var t = doIt()
Console.WriteLine(t.IsCompletedSuccessfully)
`
        let output = CompileAndRun(Source, "AsyncTaskCompleted")
        Assert.Contains("True", output)
    }

    @Fact
    func AsyncTaskOfInt_Returns_Default_Value() {
        // The MoveNext body now executes the user code, so result is 42.
        const Source = `package AsyncTestInt
import System
import System.Threading.Tasks

async func getVal() int32 {
    return 42
}

var t = getVal()
Console.WriteLine(t.IsCompletedSuccessfully)
Console.WriteLine(t.Result)
`
        let output = CompileAndRun(Source, "AsyncTaskInt")
        Assert.Contains("True", output)
        Assert.Contains("42", output)
    }

    @Fact
    func AsyncTask_OmittedReturn_Emits_And_Runs() {
        const Source = `package AsyncVoidTest
import System

async func fire() {
}

fire()
Console.WriteLine("fired")
`
        let output = CompileAndRun(Source, "AsyncVoidTest")
        Assert.Contains("fired", output)
    }

    @Fact
    func AsyncVoid_ExplicitVoid_ReturnsVoid_AndUsesVoidBuilder() {
        const Source = `package AsyncVoidMetadataTest

async func implicitTask() {
}

async func explicitVoid() void {
}
`
        using let peStream = MemoryStream()
        let tree = SyntaxTree.Parse(SourceText.From(Source))
        let compilation = Compilation(tree)
        let result = compilation.Emit(peStream)
        Assert.True(
            result.Success,
            "compilation should succeed: " + string.Join("; ", result.Diagnostics.Select((d Diagnostic) -> d.Message))
        )
        peStream.Position = 0
        let loadContext = AssemblyLoadContext(
            "AsyncVoid_ExplicitVoid_ReturnsVoid_AndUsesVoidBuilder",
            isCollectible: true
        )
        try {
            let assembly = loadContext.LoadFromStream(peStream)
            let program = assembly.GetTypes().Single((t Type) -> t.Name == "<Program>")
            let implicitTask MethodInfo? = program.GetMethod(
                "implicitTask",
                BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic
            )
            let explicitVoid MethodInfo? = program.GetMethod(
                "explicitVoid",
                BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic
            )
            Assert.Equal(typeof(Task), implicitTask!!.ReturnType)
            Assert.Equal(typeof(Void), explicitVoid!!.ReturnType)
            let stateMachine = assembly.GetTypes().Single((t Type) -> t.Name.Contains("<explicitVoid>d__"))
            Assert.Contains(
                stateMachine.GetFields(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic),
                (field FieldInfo) -> field.FieldType == typeof(AsyncVoidMethodBuilder)
            )
        } finally {
            loadContext.Unload()
        }
    }

    @Fact
    func AsyncVoid_ReturnsAfterIncompleteAwait_ThenResumes() {
        const Source = `package AsyncVoidRuntimeTest
import System
import System.Threading
import System.Threading.Tasks

async func fire() void {
    Console.WriteLine("prefix")
    await Task.Delay(100)
    Console.WriteLine("continued")
}

fire()
Console.WriteLine("returned")
Thread.Sleep(300)
`
        let lines = CompileAndRun(Source, "AsyncVoidRuntime").Split(
            Environment.NewLine,
            StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries
        )
        Assert.Equal([]string{"prefix", "returned", "continued"}, lines)
    }

    @Fact
    func AsyncTask_WithParameters_CopiesParametersToStateMachine() {
        const Source = `package AsyncParamsTest
import System
import System.Threading.Tasks

async func addLater(a int32, b int32) int32 {
    return a + b
}

var t = addLater(3, 4)
Console.WriteLine(t.IsCompletedSuccessfully)
`
        let output = CompileAndRun(Source, "AsyncParamsTest")
        Assert.Contains("True", output)
    }

    @Fact
    func AsyncTask_StateMachineType_Exists_In_PE() {
        const Source = `package AsyncSMTypeTest
import System

async func doIt() {
}

doIt()
`
        using let peStream = MemoryStream()
        let tree = SyntaxTree.Parse(SourceText.From(Source))
        let compilation = Compilation(tree)
        let result = compilation.Emit(peStream)
        Assert.True(
            result.Success,
            "compilation should succeed: " + string.Join("; ", result.Diagnostics.Select((d Diagnostic) -> d.Message))
        )
        peStream.Position = 0
        using let peReader = PEReader(peStream)
        let metadataReader = peReader.GetMetadataReader()
        // Find the state-machine type: name contains "<doIt>d__"
        let smTypes = metadataReader
            .TypeDefinitions
            .Select((td TypeDefinitionHandle) -> metadataReader.GetTypeDefinition(td))
            .Where((td TypeDefinition) -> metadataReader.GetString(td.Name).Contains("<doIt>d__"))
            .ToList()
        Assert.Single(smTypes)
        let smType = smTypes[0]
        // Verify it's a struct (sealed, sequential layout)
        Assert.True(smType.Attributes.HasFlag(TypeAttributes.Sealed))
        // Verify it has MoveNext and SetStateMachine methods
        let methods = smType
            .GetMethods()
            .Select(
            (mh MethodDefinitionHandle) -> metadataReader.GetString(metadataReader.GetMethodDefinition(mh).Name)
        )
            .ToList()
        Assert.Contains("MoveNext", methods)
        Assert.Contains("SetStateMachine", methods)
    }

    @Fact
    func AsyncTask_KickoffMethod_Returns_Task_Type() {
        const Source = `package AsyncReturnTypeTest
import System
import System.Threading.Tasks

async func doIt() {
}

var t = doIt()
Console.WriteLine(t.GetType().FullName)
`
        let output = CompileAndRun(Source, "AsyncReturnTypeTest")
        Assert.Contains("System.Threading.Tasks.Task", output)
    }

    @Fact
    func AsyncTask_MultipleAsyncFunctions_AllEmit() {
        const Source = `package AsyncMultiTest
import System
import System.Threading.Tasks

async func first() {
}

async func second() int32 {
    return 1
}

var t1 = first()
var t2 = second()
Console.WriteLine(t1.IsCompletedSuccessfully)
Console.WriteLine(t2.IsCompletedSuccessfully)
`
        let output = CompileAndRun(Source, "AsyncMultiTest")
        Assert.Contains("True", output)
    }

    shared {
        private func CompileAndRun(source string, contextName string) string {
            using let peStream = MemoryStream()
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let compilation = Compilation(tree)
            let result = compilation.Emit(peStream)
            Assert.True(
                result.Success,
                "compilation should succeed: " + string.Join(
                    "; ",
                    result.Diagnostics.Select((d Diagnostic) -> d.Message)
                )
            )
            peStream.Position = 0
            let loadContext = AssemblyLoadContext(contextName, isCollectible: true)
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
                return captured.ToString()
            } finally {
                loadContext.Unload()
            }
        }
    }
}
