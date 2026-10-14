// <copyright file="Issue4776WebsiteKotlinCopyEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import System
import System.IO
import System.Linq
import System.Reflection
import System.Reflection.Emit
import System.Text
import GSharp.Tests
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import Microsoft.CodeAnalysis.Emit
import Xunit
import GSharp.Compiler
import GSharp.Compiler.Tests

class Issue4776WebsiteKotlinCopyEmitTests {
    @Fact
    func WebsiteKotlin_WithClonesDeveloperOnceBeforeUpdatingYears() {
        let root = FindRepositoryRoot()
        let directory = Path.Combine(AppContext.BaseDirectory, "WebsiteKotlin-" + Guid.NewGuid().ToString("N"))
        Directory.CreateDirectory(directory)
        try {
            let nativeSource = `using System;
namespace Examples.Kotlin;
public record Developer(string Name, int Years);
public static class Driver
{
    public static Developer ada;
    public static Developer next;
    public static string Label(Developer person) =>
        person is { } known ? $"{known.Name}: {known.Years}" : "unassigned";
    public static void Main()
    {
        ada = new Developer("Ada", 2);
        next = ada with { Years = 3 };
        Console.WriteLine(Label(next));
        Console.WriteLine(Label(null));
        Console.WriteLine(ada == new Developer("Ada", 2));
    }
}`
            let references = Directory.GetFiles(Path.GetDirectoryName(typeof(object).Assembly.Location)!!, "*.dll")
            let tree = CSharpSyntaxTree.ParseText(nativeSource, path: "NativeWebsiteKotlin.cs", encoding: Encoding.UTF8)
            let native = CSharpCompilation.Create(
                "NativeWebsiteKotlin",
                []SyntaxTree{tree},
                references.Select((path string) -> MetadataReference.CreateFromFile(path)),
                CSharpCompilationOptions(OutputKind.ConsoleApplication, deterministic: true)
            )
            let nativePath = Path.Combine(directory, "NativeWebsiteKotlin.dll")
            {
                using let image = File.Create(nativePath)
                {
                    using let pdb = File.Create(Path.ChangeExtension(nativePath, ".pdb"))
                    let emitted = native.Emit(
                        image,
                        pdb,
                        options: EmitOptions(debugInformationFormat: DebugInformationFormat.PortablePdb)
                    )
                    Assert.True(emitted.Success, string.Join(Environment.NewLine, emitted.Diagnostics))
                }
            }
            let path = Path.Combine(directory, "WebsiteKotlin.dll")
            {
                using let output = StringWriter()
                let previous = Console.Out
                try {
                    Console.SetOut(output)
                    let exit = Program.Main(
                        []string{
                            "/target:exe",
                            "/targetframework:net10.0",
                            "/assemblyname:WebsiteKotlinContract",
                            "/out:" + path,
                            Path.Combine(root, "samples", "WebsiteKotlin.gs")
                        }
                    )
                    Assert.True(exit == 0, output.ToString())
                } finally {
                    Console.SetOut(previous)
                }
            }
            IlVerifier.Verify(nativePath)
            IlVerifier.Verify(path)
            let assemblies = EmittedFixture.LoadTogether(nativePath, path)
            let expected = File.ReadAllText(Path.Combine(root, "samples", "WebsiteKotlin.golden")).ReplaceLineEndings(
                Environment.NewLine
            )
            for assembly in assemblies {
                let entry MethodInfo? = assembly.EntryPoint
                Assert.NotNull(entry)
                using let output = StringWriter()
                let previous = Console.Out
                try {
                    Console.SetOut(output)
                    entry!!.Invoke(
                        nil,
                        if entry!!.GetParameters().Length == 0 {
                            default([]?object)
                        } else {
                            []object{Array.Empty[string]()}
                        }
                    )
                } finally {
                    Console.SetOut(previous)
                }
                Assert.Equal(expected, output.ToString())
                let developer Type? = assembly.GetType("Examples.Kotlin.Developer", throwOnError: true)
                let adaField FieldInfo? = entry!!.DeclaringType!!.GetField(
                    "ada",
                    BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static
                )
                let nextField FieldInfo? = entry!!.DeclaringType!!.GetField(
                    "next",
                    BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static
                )
                Assert.NotNull(adaField)
                Assert.NotNull(nextField)
                let ada object? = adaField!!.GetValue(nil)
                let next object? = nextField!!.GetValue(nil)
                Assert.IsType(developer!!, ada)
                Assert.IsType(developer!!, next)
                Assert.NotSame(ada, next)
                let name PropertyInfo? = developer!!.GetProperty("Name")
                let years PropertyInfo? = developer!!.GetProperty("Years")
                Assert.NotNull(name)
                Assert.NotNull(years)
                Assert.Equal("Ada", name!!.GetValue(ada))
                Assert.Equal("Ada", name!!.GetValue(next))
                Assert.Same(name!!.GetValue(ada), name!!.GetValue(next))
                Assert.Equal(2, years!!.GetValue(ada))
                Assert.Equal(3, years!!.GetValue(next))
                let body MethodBody? = entry!!.GetMethodBody()
                Assert.NotNull(body)
                let instructions = IlInstructionReader.Read(body!!.GetILAsByteArray())
                let calls = instructions
                    .Where((instruction IlInstruction) -> (instruction.MetadataToken != nil))
                    .Select(
                    (instruction IlInstruction) -> (
                        Instruction: instruction,
                        Method: entry!!.Module.ResolveMethod(instruction.MetadataToken!!)
                    )
                )
                    .Where(
                    (call(Instruction IlInstruction, Method MethodBase)) -> call.Item2.DeclaringType == developer
                )
                    .ToArray()
                let clone = Assert.Single(
                    calls,
                    (call(Instruction IlInstruction, Method MethodBase)) -> call.Item2.Name == "<Clone>$$"
                )
                Assert.Equal(OpCodes.Callvirt, clone.Item1.OpCode)
                let cloneMethod = Assert.IsAssignableFrom[MethodInfo](clone.Item2)
                Assert.Equal(developer, cloneMethod.ReturnType)
                Assert.Empty(cloneMethod.GetParameters())
                let update = Assert.Single(
                    calls,
                    (call(Instruction IlInstruction, Method MethodBase)) -> call.Item2.Name == "set_Years"
                )
                Assert.True(clone.Item1.Offset < update.Item1.Offset)
                Assert.DoesNotContain(
                    calls,
                    (call(Instruction IlInstruction, Method MethodBase)) -> call.Item2.Name == "set_Name"
                )
                Assert.DoesNotContain(
                    calls,
                    (call(Instruction IlInstruction, Method MethodBase)) -> call
                        .Item1
                        .OpCode == OpCodes.Newobj &&
                        call
                        .Item2
                        .GetParameters()
                        .Length == 0
                )
            }
        } finally {
            Directory.Delete(directory, recursive: true)
        }
    }

    shared {
        private func FindRepositoryRoot() string {
            var directory DirectoryInfo? = DirectoryInfo(AppContext.BaseDirectory)
            while directory != nil {
                if RepositoryRootMarker.IsRoot(directory.FullName) {
                    return directory.FullName
                }
                directory = directory.Parent
            }
            throw InvalidOperationException("Could not locate repository root.")
        }
    }
}
