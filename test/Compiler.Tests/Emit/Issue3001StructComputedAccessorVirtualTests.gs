// <copyright file="Issue3001StructComputedAccessorVirtualTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import System
import System.Diagnostics
import System.IO
import System.Linq
import System.Reflection
import System.Reflection.Metadata
import System.Reflection.PortableExecutable
import GSharp.Compiler
import GSharp.Tests
import Xunit
import GSharp.Compiler.Tests

/// Issue #3001: computed struct property accessors that implement interface
/// slots must be emitted virtual.
open class Issue3001StructComputedAccessorVirtualTests {
    @Fact
    func OrdinaryComputedProperty_LoadsAndDispatches() {
        const Source = `package Issue3001Ordinary
import System

interface IName {
    prop Label string { get; }
}

struct S : IName {
    prop Label string -> "hi"
}

var value IName = S{}
Console.WriteLine(value.Label)`
        AssertRuns(Source, "OrdinaryComputedProperty_LoadsAndDispatches", "hi\n")
    }

    @Fact
    func ExplicitComputedIndexer_LoadsAndDispatches() {
        const Source = `package Issue3001Explicit
import System

interface I {
    prop this[key int32] int32 { get; }
}

struct S(Base int32) : I {
    private prop (I) this[key int32] int32 -> Base + key
}

var value I = S(5)
Console.WriteLine(value[7])`
        AssertRuns(Source, "ExplicitComputedIndexer_LoadsAndDispatches", "12\n")
    }

    @Fact
    func NullableSequenceComputedProperty_LoadsAndDispatches() {
        const Source = `package Issue3001Sequence
import System

interface IBox {
    prop Vals sequence[int32?] { get; }
}

func values() sequence[int32?] {
    yield 5
    yield nil
}

struct Box : IBox {
    prop Vals sequence[int32?] -> values()
}

var box IBox = Box{}
for value in box.Vals {
    Console.WriteLine(value == nil ? "nil" : value.ToString())
}`
        AssertRuns(Source, "NullableSequenceComputedProperty_LoadsAndDispatches", `5
nil
`)
    }

    @Fact
    func ComputedGetterAndSetter_LoadAndDispatch() {
        const Source = `package Issue3001GetterSetter
import System

interface IValue {
    prop Value int32 { get; set; }
}

struct ValueBox : IValue {
    var Stored int32
    prop Value int32 {
        get { return Stored }
        set { Stored = value + 11 }
    }
}

var box IValue = ValueBox{}
box.Value = 22
Console.WriteLine(box.Value)`
        AssertRuns(Source, "ComputedGetterAndSetter_LoadAndDispatch", "33\n")
    }

    @Fact
    func AutoPropertyStruct_RemainsLoadable() {
        const Source = `package Issue3001AutoProperty
import System

interface IValue {
    prop Value int32 { get; set; }
}

struct ValueBox : IValue {
    prop Value int32 { get; set; }
}

var box IValue = ValueBox{}
box.Value = 44
Console.WriteLine(box.Value)`
        AssertRuns(Source, "AutoPropertyStruct_RemainsLoadable", "44\n")
    }

    @Fact
    func MismatchedIndexerParameter_DoesNotPromoteOrdinaryAccessor() {
        const Source = `package Issue3001Mismatch

interface ITextIndexer {
    prop this[key string] int32 { get; }
}

struct MixedIndexer : ITextIndexer {
    prop this[key int32] int32 -> 33
    private prop (ITextIndexer) this[key string] int32 -> 22
}`
        let assemblyPath = Compile(
            Source,
            "MismatchedIndexerParameter_DoesNotPromoteOrdinaryAccessor",
            target: "library"
        )
        using let stream = File.OpenRead(assemblyPath)
        using let peReader = PEReader(stream)
        let reader = peReader.GetMetadataReader()
        let type = reader
            .TypeDefinitions
            .Select(reader.GetTypeDefinition)
            .Single((candidate TypeDefinition) -> reader.GetString(candidate.Name) == "MixedIndexer")
        let getter = type
            .GetMethods()
            .Select(reader.GetMethodDefinition)
            .Single((method MethodDefinition) -> reader.GetString(method.Name) == "get_Item")
        Assert.False((getter.Attributes & MethodAttributes.Virtual) != 0)
    }

    shared {
        private func AssertRuns(source string, name string, expected string) {
            let assemblyPath = Compile(source, name, target: "exe")
            let assembly = EmittedFixture.Load(assemblyPath)
            Assert.NotEmpty(assembly.GetTypes())
            IlVerifier.Verify(assemblyPath)
            Assert.Equal(expected, RunBounded(assemblyPath, name))
        }

        private func Compile(source string, name string, target string) string {
            let directory = Path.Combine(AppContext.BaseDirectory, "Issue3001StructComputedAccessorVirtualTests", name)
            Directory.CreateDirectory(directory)
            let sourcePath = Path.Combine(directory, "test.gs")
            let assemblyPath = Path.Combine(directory, name + ".dll")
            File.WriteAllText(sourcePath, source)
            using let stdout = StringWriter()
            using let stderr = StringWriter()
            let previousOut = Console.Out
            let previousErr = Console.Error
            Console.SetOut(stdout)
            Console.SetError(stderr)
            var exitCode int32
            try {
                exitCode = Program.Main(
                    []string{"/out:" + assemblyPath, "/target:" + target, "/targetframework:net10.0", sourcePath}
                )
            } finally {
                Console.SetOut(previousOut)
                Console.SetError(previousErr)
            }
            Assert.True(exitCode == 0, ("$name" + `: gsc failed:
` + "$stdout" + `
` + "$stderr"))
            return assemblyPath
        }

        private func RunBounded(assemblyPath string, name string) string {
            using let process Process? = Process.Start(
                ProcessStartInfo("dotnet"){
                    ArgumentList = {
                        "exec",
                        "--runtimeconfig",
                        Path.ChangeExtension(assemblyPath, ".runtimeconfig.json"),
                        assemblyPath
                    },
                    WorkingDirectory = Path.GetDirectoryName(assemblyPath)!!,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false
                }
            )
            Assert.NotNull(process)
            let outputTask = process!!.StandardOutput.ReadToEndAsync()
            let errorTask = process!!.StandardError.ReadToEndAsync()
            let exited = process!!.WaitForExit(30_000)
            if !exited {
                process!!.Kill(entireProcessTree: true)
                process!!.WaitForExit()
            }
            Assert.True(exited, "$name: emitted program timed out")
            let output = outputTask.GetAwaiter().GetResult()
            let error = errorTask.GetAwaiter().GetResult()
            Assert.True(process!!.ExitCode == 0, ("$name" + `: emitted program failed:
` + "$error"))
            return output.ReplaceLineEndings(Environment.NewLine)
        }
    }
}
