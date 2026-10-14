// <copyright file="Issue2782LambdaOverloadTargetEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import System
import System.IO
import System.Linq
import System.Runtime.Loader
import GsCompilation = GSharp.Core.CodeAnalysis.Compilation.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GsSyntaxTree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree
import GSharp.Core.CodeAnalysis.Text
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import Xunit
import GSharp.Compiler.Tests
import GSharp.Core.CodeAnalysis
import System.Reflection

open class Issue2782LambdaOverloadTargetEmitTests {
    @Fact
    func ExpressionBodiedTaskResults_PreserveExactReturnTypeAcrossCandidateOrder() {
        let libraryPath = EmitCSharpLibrary("Expression")
        let output = CompileAndRun(libraryPath, `package LambdaOverloadTargetExpression
import System
import System.Collections.Generic
import System.Threading.Tasks
import Fixture2782

Api.Register((value string) -> Task.FromResult[object](value))
ApiReverse.Register((value string) -> Task.FromResult[object](value))
Api.Register((value string) -> Task.FromResult[List[string]](List[string]()))`, "Expression")
        Assert.Equal((`delegate:System.Threading.Tasks.Task` + "`" + `1[System.Object]
reverse:System.Threading.Tasks.Task` + "`" + `1[System.Object]
delegate:System.Threading.Tasks.Task` + "`" + `1[System.Collections.Generic.List` + "`" + `1[System.String]]
`), output)
    }

    @Fact
    func AsyncLambda_PreservesExactTaskResult() {
        let libraryPath = EmitCSharpLibrary("Async")
        let output = CompileAndRun(libraryPath, `package LambdaOverloadTargetAsync
import System
import System.Threading.Tasks
import Fixture2782

Api.Register(async (value string) -> await Task.FromResult[object](value))`, "Async")
        Assert.Equal("delegate:System.Threading.Tasks.Task`1[System.Object]${Environment.NewLine}", output)
    }

    @Fact
    func ExpressionBodiedValueTaskResult_PreservesExactGenericResult() {
        let libraryPath = EmitCSharpLibrary("ValueTask")
        let output = CompileAndRun(libraryPath, `package LambdaOverloadTargetValueTask
import System
import System.Threading.Tasks
import Fixture2782

ValueApi.Register((value string) -> ValueTask.FromResult[object](value))`, "ValueTask")
        Assert.Equal("value:System.Threading.Tasks.ValueTask`1[System.Object]${Environment.NewLine}", output)
    }

    @Fact
    func DelegateOnlyControl_MatchesOverloadedReturnShape() {
        let libraryPath = EmitCSharpLibrary("Control")
        let output = CompileAndRun(libraryPath, `package LambdaOverloadTargetControl
import System
import System.Threading.Tasks
import Fixture2782

Api.Register((value string) -> Task.FromResult[object](value))
DelegateOnly.Register((value string) -> Task.FromResult[object](value))`, "Control")
        Assert.Equal((`delegate:System.Threading.Tasks.Task` + "`" + `1[System.Object]
only:System.Threading.Tasks.Task` + "`" + `1[System.Object]
`), output)
    }

    @Fact
    func EquallyApplicableConcreteDelegates_RemainAmbiguous() {
        let libraryPath = EmitCSharpLibrary("Ambiguous")
        using let resolver = ReferenceResolver.WithReferences([]string{libraryPath})
        let compilation = GsCompilation(resolver, GsSyntaxTree.Parse(SourceText.From(`package LambdaOverloadTargetAmbiguous
import System.Threading.Tasks
import Fixture2782

AmbiguousApi.Register((value string) -> Task.FromResult[object](value))`)))
        using let stream = MemoryStream()
        let result = compilation.Emit(stream, pdbStream: nil, refStream: nil, assemblyName: "Consumer2782Ambiguous")
        Assert.False(result.Success)
        Assert.Contains(
            result.Diagnostics,
            (diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> diagnostic.Id == "GS0160"
        )
    }

    shared {
        private func EmitCSharpLibrary(caseName string) string {
            let outputDir = Path.Combine(LibraryDirectory(), caseName)
            Directory.CreateDirectory(outputDir)
            let libraryPath = Path.Combine(outputDir, "Fixture2782.dll")
            const source = `using System;
using System.Threading.Tasks;
namespace Fixture2782;
public delegate Task RequestHandler(string value);
public delegate ValueTask ValueRequestHandler(string value);
public delegate Task<object> FirstHandler(string value);
public delegate Task<object> SecondHandler(string value);
public static class Api
{
    public static void Register(RequestHandler handler) =>
        Console.WriteLine("request:" + handler.Method.ReturnType);
    public static void Register(Delegate handler) =>
        Console.WriteLine("delegate:" + handler.Method.ReturnType);
}
public static class ApiReverse
{
    public static void Register(Delegate handler) =>
        Console.WriteLine("reverse:" + handler.Method.ReturnType);
    public static void Register(RequestHandler handler) =>
        Console.WriteLine("reverse-request:" + handler.Method.ReturnType);
}
public static class ValueApi
{
    public static void Register(ValueRequestHandler handler) =>
        Console.WriteLine("value-request:" + handler.Method.ReturnType);
    public static void Register(Delegate handler) =>
        Console.WriteLine("value:" + handler.Method.ReturnType);
}
public static class DelegateOnly
{
    public static void Register(Delegate handler) =>
        Console.WriteLine("only:" + handler.Method.ReturnType);
}
public static class AmbiguousApi
{
    public static void Register(FirstHandler handler) { }
    public static void Register(SecondHandler handler) { }
}`
            let references = (
                (AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string)?.Split(Path.PathSeparator) ??
                    Array.Empty[string]()
            )
                .Where(File.Exists).Select(
                (path string) -> cast[MetadataReference](MetadataReference.CreateFromFile(path))
            )
            let compilation = CSharpCompilation.Create(
                "Fixture2782",
                []Microsoft
                    .CodeAnalysis
                    .SyntaxTree{CSharpSyntaxTree.ParseText(source, CSharpParseOptions(LanguageVersion.Latest))},
                references,
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
            )
            using let stream = File.Create(libraryPath)
            let result = compilation.Emit(stream)
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
            return libraryPath
        }

        private func CompileAndRun(libraryPath string, source string, caseName string) string {
            using let resolver = ReferenceResolver.WithReferences([]string{libraryPath})
            let outputDir = Path.GetDirectoryName(libraryPath)!!
            let assemblyName = "Consumer2782" + caseName
            let consumerPath = Path.Combine(outputDir, assemblyName + ".dll")
            let compilation = GsCompilation(resolver, GsSyntaxTree.Parse(SourceText.From(source)))
            {
                using let stream = File.Create(consumerPath)
                let result = compilation.Emit(stream, pdbStream: nil, refStream: nil, assemblyName: assemblyName)
                Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
            }
            IlVerifier.Verify(consumerPath, additionalReferences: []string{libraryPath})
            let context = AssemblyLoadContext("Issue2782" + caseName, isCollectible: true)
            context.Resolving += (_ AssemblyLoadContext, name AssemblyName) -> if name.Name == "Fixture2782" {
                context.LoadFromAssemblyPath(libraryPath)
            } else {
                default(Assembly?)
            }
            try {
                let assembly = context.LoadFromAssemblyPath(consumerPath)
                let output = Console.Out
                using let captured = StringWriter()
                Console.SetOut(captured)
                try {
                    let entry = assembly.EntryPoint!!
                    entry.Invoke(
                        nil,
                        if entry.GetParameters().Length == 0 {
                            default([]?object)
                        } else {
                            []object{Array.Empty[string]()}
                        }
                    )
                } finally {
                    Console.SetOut(output)
                }
                return captured.ToString().ReplaceLineEndings(Environment.NewLine)
            } finally {
                context.Unload()
            }
        }

        private func LibraryDirectory() string {
            let path = Path.Combine(AppContext.BaseDirectory, "Issue2782Emit")
            Directory.CreateDirectory(path)
            return path
        }
    }
}
