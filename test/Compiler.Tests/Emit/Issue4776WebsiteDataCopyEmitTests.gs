// <copyright file="Issue4776WebsiteDataCopyEmitTests.cs" company="GSharp">
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

class Issue4776WebsiteDataCopyEmitTests {
    @Fact
    func WebsiteData_WithCallsTypedCloneOnceAndPreservesOriginal() {
        let root = FindRepositoryRoot()
        let directory = Path.Combine(AppContext.BaseDirectory, "WebsiteData-" + Guid.NewGuid().ToString("N"))
        Directory.CreateDirectory(directory)
        try {
            let nativeSource = `using System;
namespace Website.Data;
public record Point(int X, int Y);
public static class Driver
{
    public static Point origin;
    public static Point moved;
    public static void Main()
    {
        origin = new Point(0, 0);
        moved = origin with { X = 3 };
        Console.WriteLine($"({moved.X}, {moved.Y})");
        Console.WriteLine(origin == new Point(0, 0));
    }
}`
            let references = Directory.GetFiles(Path.GetDirectoryName(typeof(object).Assembly.Location)!!, "*.dll")
            let tree = CSharpSyntaxTree.ParseText(nativeSource, path: "NativeWebsiteData.cs", encoding: Encoding.UTF8)
            let compilation = CSharpCompilation.Create(
                "NativeWebsiteData",
                []SyntaxTree{tree},
                references.Select((path string) -> MetadataReference.CreateFromFile(path)),
                CSharpCompilationOptions(OutputKind.ConsoleApplication, deterministic: true)
            )
            let nativePath = Path.Combine(directory, "NativeWebsiteData.dll")
            {
                using let image = File.Create(nativePath)
                {
                    using let pdb = File.Create(Path.ChangeExtension(nativePath, ".pdb"))
                    let emitted = compilation.Emit(
                        image,
                        pdb,
                        options: EmitOptions(debugInformationFormat: DebugInformationFormat.PortablePdb)
                    )
                    Assert.True(emitted.Success, string.Join(Environment.NewLine, emitted.Diagnostics))
                }
            }
            let path = Path.Combine(directory, "WebsiteData.dll")
            {
                using let output = StringWriter()
                let previous = Console.Out
                try {
                    Console.SetOut(output)
                    let exit = Program.Main(
                        []string{
                            "/target:exe",
                            "/targetframework:net10.0",
                            "/assemblyname:WebsiteDataContract",
                            "/out:" + path,
                            Path.Combine(root, "samples", "WebsiteData.gs")
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
            let expected = File.ReadAllText(Path.Combine(root, "samples", "WebsiteData.golden")).ReplaceLineEndings(
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
                let point Type? = assembly.GetType("Website.Data.Point", throwOnError: true)
                let originalField FieldInfo? = entry!!.DeclaringType!!.GetField(
                    "origin",
                    BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static
                )
                let movedField FieldInfo? = entry!!.DeclaringType!!.GetField(
                    "moved",
                    BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static
                )
                Assert.NotNull(originalField)
                Assert.NotNull(movedField)
                let original object? = originalField!!.GetValue(nil)
                let moved object? = movedField!!.GetValue(nil)
                Assert.IsType(point!!, original)
                Assert.IsType(point!!, moved)
                Assert.NotSame(original, moved)
                Assert.Equal(0, point!!.GetProperty("X")!!.GetValue(original))
                Assert.Equal(0, point!!.GetProperty("Y")!!.GetValue(original))
                Assert.Equal(3, point!!.GetProperty("X")!!.GetValue(moved))
                Assert.Equal(0, point!!.GetProperty("Y")!!.GetValue(moved))
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
                    .Where((call(Instruction IlInstruction, Method MethodBase)) -> call.Item2.DeclaringType == point)
                    .ToArray()
                let clone = Assert.Single(
                    calls,
                    (call(Instruction IlInstruction, Method MethodBase)) -> call.Item2.Name == "<Clone>$$"
                )
                Assert.Equal(OpCodes.Callvirt, clone.Item1.OpCode)
                let cloneMethod = Assert.IsAssignableFrom[MethodInfo](clone.Item2)
                Assert.Equal(point, cloneMethod.ReturnType)
                Assert.Empty(cloneMethod.GetParameters())
                let update = Assert.Single(
                    calls,
                    (call(Instruction IlInstruction, Method MethodBase)) -> call.Item2.Name == "set_X"
                )
                Assert.True(clone.Item1.Offset < update.Item1.Offset)
                Assert.DoesNotContain(
                    calls,
                    (call(Instruction IlInstruction, Method MethodBase)) -> call.Item2.Name == "set_Y"
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
