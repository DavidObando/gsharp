// <copyright file="Issue2488NarrowedInheritedAssignmentTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import System.Reflection
import GSharp.Tests
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import Xunit
import GSharp.Compiler
import GSharp.Compiler.Tests

/// Issue #2488: assignment binding must use the effective narrowed receiver
/// type, just like the read path, while the underlying variable keeps its
/// declared nullable storage type.
open class Issue2488NarrowedInheritedAssignmentTests {
    @Fact
    func SourceInheritedMembers_NarrowedWritesRunReflectAndVerify() {
        const source = `package Issue2488.Source

open class Base2488 {
    public var FieldValue int32
    private var propertyValue int32
    public var AddCalls int32
    public var RemoveCalls int32

    prop Value int32 {
        get { return propertyValue }
        set { propertyValue = value }
    }

    open event Changed () -> void {
        add { AddCalls += 1 }
        remove { RemoveCalls += 1 }
    }

    prop this[index int32] int32 {
        get { return propertyValue + index }
        set { propertyValue = value + index }
    }
}

class Derived2488 : Base2488 {
}

public var FactoryCalls = 0
public var FieldResult = 0
public var PropertyResult = 0
public var IndexResult = 0
public var AddResult = 0
public var RemoveResult = 0

func GetDerived() Derived2488? {
    FactoryCalls += 1
    return Derived2488()
}

if let item = GetDerived() {
    item.FieldValue = 4
    item.Value = 10
    item.Value += 5
    item.Changed += func() void { }
    item.Changed -= func() void { }
    item[2] = 20

    FieldResult = item.FieldValue
    PropertyResult = item.Value
    IndexResult = item[2]
    AddResult = item.AddCalls
    RemoveResult = item.RemoveCalls
}`
        let assembly = CompileToAssembly(source)
        let derived = assembly.GetType("Issue2488.Source.Derived2488", throwOnError: true)!!
        Assert.NotNull(derived.GetField("FieldValue"))
        Assert.NotNull(derived.GetProperty("Value"))
        Assert.NotNull(derived.GetEvent("Changed"))
        Assert.NotNull(derived.GetProperty("Item"))
        InvokeEntryPoint(assembly)
        let program = assembly.GetTypes().Single((t Type) -> t.Name == "<Program>")
        Assert.Equal(1, ReadStaticInt(program, "FactoryCalls"))
        Assert.Equal(4, ReadStaticInt(program, "FieldResult"))
        Assert.Equal(22, ReadStaticInt(program, "PropertyResult"))
        Assert.Equal(24, ReadStaticInt(program, "IndexResult"))
        Assert.Equal(1, ReadStaticInt(program, "AddResult"))
        Assert.Equal(1, ReadStaticInt(program, "RemoveResult"))
    }

    @Fact
    func ImportedInheritedMembers_NarrowedWritesRunOnceAndVerify() {
        const source = `package Issue2488.Imported
import System
import Issue2488.CSharp

var IndexCalls = 0
var ValueCalls = 0

func NextIndex() int32 {
    IndexCalls += 1
    return 1
}

func NextValue() int32 {
    ValueCalls += 1
    return 5
}

if let item = Factory.Get() {
    item.Field = 3
    item.Value = 4
    item.Value += 5
    item.Changed += func() void { }
    item.Changed -= func() void { }
    item[1] = 11
    item[NextIndex()] += NextValue()

    Console.WriteLine(item.Field)
    Console.WriteLine(item.Value)
    Console.WriteLine(item[1])
    Console.WriteLine(item.AddCalls)
    Console.WriteLine(item.RemoveCalls)
}

Console.WriteLine(Factory.Calls)
Console.WriteLine(IndexCalls)
Console.WriteLine(ValueCalls)`
        Assert.Equal(
            "3${Environment.NewLine}9${Environment.NewLine}16${Environment.NewLine}1${Environment.NewLine}1${Environment.NewLine}1${Environment.NewLine}1${Environment.NewLine}1${Environment.NewLine}",
            CompileAndRun(source, ImportedTypes)
        )
    }

    @Fact
    func UnguardedNullableReceivers_RemainInvalidForEveryWriteKind() {
        const source = `package Issue2488.Negative

open class Base2488 {
    var FieldValue int32
    prop Value int32 { get; set; }
    event Changed () -> void { add { } remove { } }
    prop this[index int32] int32 { get { return 0 } set { } }
}

class Derived2488 : Base2488 {
}

func GetDerived() Derived2488? {
    return Derived2488()
}

let item = GetDerived()
item.FieldValue = 1
item.Value = 2
item.Changed += func() void { }
item[0] = 3`
        let (exitCode, diagnostics) = CompileExpectingFailure(source)
        Assert.NotEqual(0, exitCode)
        Assert.Contains("GS0158", diagnostics)
        Assert.Contains("GS0116", diagnostics)
    }

    @Fact
    func Narrowing_DoesNotBypassInheritedPrivateAccessChecks() {
        const source = `package Issue2488.Access

open class Base2488 {
    private var Secret int32
}

class Derived2488 : Base2488 {
}

func GetDerived() Derived2488? {
    return Derived2488()
}

if let item = GetDerived() {
    item.Secret = 1
}`
        let (exitCode, diagnostics) = CompileExpectingFailure(source)
        Assert.NotEqual(0, exitCode)
        Assert.Contains("GS0472", diagnostics)
        Assert.Contains("Secret", diagnostics)
    }

    @Fact
    func ImportedUnguardedNullableReceiver_RemainsInvalid() {
        const source = `package Issue2488.ImportedNegative
import Issue2488.CSharp

let item = Factory.Get()
item.Field = 1
item.Value = 2
item.Changed += func() void { }
item[0] = 3`
        let (exitCode, diagnostics) = CompileExpectingFailure(source, ImportedTypes)
        Assert.NotEqual(0, exitCode)
        Assert.Contains("GS0158", diagnostics)
        Assert.Contains("GS0116", diagnostics)
    }

    shared {
        private const ImportedTypes string = `#nullable enable
using System;

namespace Issue2488.CSharp
{
    public class Base
    {
        private readonly int[] values = new int[2];

        public int Field;
        public int Value { get; set; }
        public int AddCalls { get; private set; }
        public int RemoveCalls { get; private set; }

        public event Action Changed
        {
            add => AddCalls++;
            remove => RemoveCalls++;
        }

        public int this[int index]
        {
            get => values[index];
            set => values[index] = value;
        }
    }

    public sealed class Derived : Base
    {
    }

    public static class Factory
    {
        public static int Calls;

        public static Derived? Get()
        {
            Calls++;
            return new Derived();
        }
    }
}`

        private func CompileToAssembly(source string) Assembly {
            let workDir = Directory.CreateTempSubdirectory("gs_issue2488_reflection_").FullName
            try {
                let (exitCode, diagnostics, outPath, references) = Compile(workDir, source, "exe", csharpSource: nil)
                Assert.True(exitCode == 0, diagnostics)
                IlVerifier.Verify(outPath, additionalReferences: references)
                return EmittedFixture.Load(outPath)
            } finally {
                TryDelete(workDir)
            }
        }

        private func CompileAndRun(source string, csharpSource string) string {
            let workDir = Directory.CreateTempSubdirectory("gs_issue2488_run_").FullName
            try {
                let (exitCode, diagnostics, outPath, references) = Compile(workDir, source, "exe", csharpSource)
                Assert.True(exitCode == 0, diagnostics)
                IlVerifier.Verify(outPath, additionalReferences: references)
                let runtimeConfig = Path.ChangeExtension(outPath, ".runtimeconfig.json")
                if !File.Exists(runtimeConfig) {
                    File.WriteAllText(runtimeConfig, `{
  "runtimeOptions": {
    "tfm": "net10.0",
    "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
  }
}`)
                }
                let startInfo = ProcessStartInfo("dotnet"){
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    WorkingDirectory = workDir
                }
                startInfo.ArgumentList.Add("exec")
                startInfo.ArgumentList.Add("--runtimeconfig")
                startInfo.ArgumentList.Add(runtimeConfig)
                startInfo.ArgumentList.Add(outPath)
                using let process = Process.Start(startInfo) ??
                    throw InvalidOperationException("Failed to start dotnet exec.")
                let stdout = process.StandardOutput.ReadToEnd()
                let stderr = process.StandardError.ReadToEnd()
                Assert.True(process.WaitForExit(30_000), "dotnet exec timed out.")
                Assert.True(process.ExitCode == 0, (`dotnet exec failed (` + "${process.ExitCode}" + `)
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
                return stdout.ReplaceLineEndings(Environment.NewLine)
            } finally {
                TryDelete(workDir)
            }
        }

        private func CompileExpectingFailure(source string, csharpSource string? = nil)(
            ExitCode int32,
            Diagnostics string
        ) {
            let workDir = Directory.CreateTempSubdirectory("gs_issue2488_error_").FullName
            try {
                let (exitCode, diagnostics, _, _) = Compile(workDir, source, "library", csharpSource)
                return (exitCode, diagnostics)
            } finally {
                TryDelete(workDir)
            }
        }

        private func Compile(workDir string, source string, target string, csharpSource string?)(
            ExitCode int32,
            Diagnostics string,
            OutPath string,
            References[]string
        ) {
            let sourcePath = Path.Combine(workDir, "test.gs")
            let outputPath = Path.Combine(workDir, "test.dll")
            File.WriteAllText(sourcePath, source)
            let references = if csharpSource == nil {
                Array.Empty[string]()
            } else {
                []string{EmitCSharpLibrary(workDir, csharpSource)}
            }
            let arguments = List[string]{
                "/out:" + outputPath,
                "/target:" + target,
                "/targetframework:net10.0",
                "/nowarn:GS9100"
            }
            for reference in references {
                arguments.Add("/reference:" + reference)
            }
            arguments.Add(sourcePath)
            using let stdout = StringWriter()
            using let stderr = StringWriter()
            let previousOut = Console.Out
            let previousError = Console.Error
            Console.SetOut(stdout)
            Console.SetError(stderr)
            try {
                let exitCode = Program.Main(arguments.ToArray())
                return (exitCode, stdout.ToString() + stderr.ToString(), outputPath, references)
            } finally {
                Console.SetOut(previousOut)
                Console.SetError(previousError)
            }
        }

        private func EmitCSharpLibrary(workDir string, source string) string {
            let outputPath = Path.Combine(workDir, "Issue2488.CSharp.dll")
            let syntaxTree = CSharpSyntaxTree.ParseText(source)
            let references = TrustedPlatformAssemblies().Select((path string) -> MetadataReference.CreateFromFile(path))
            let compilation = CSharpCompilation.Create(
                "Issue2488.CSharp",
                []SyntaxTree{syntaxTree},
                references,
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
            )
            using let stream = File.Create(outputPath)
            let result = compilation.Emit(stream)
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
            return outputPath
        }

        private func InvokeEntryPoint(assembly Assembly) {
            let entryPoint = assembly.EntryPoint!!
            entryPoint.Invoke(
                nil,
                if entryPoint.GetParameters().Length == 0 {
                    default([]?object)
                } else {
                    []object{Array.Empty[string]()}
                }
            )
        }

        private func ReadStaticInt(program Type, fieldName string) int32 {
            return int32(program.GetField(fieldName, BindingFlags.Public | BindingFlags.Static)!!.GetValue(nil)!!)
        }

        private func TrustedPlatformAssemblies() IEnumerable[string] {
            let value string? = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string
            Assert.False(string.IsNullOrWhiteSpace(value))
            return value!!.Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries)
        }

        private func TryDelete(path string) {
            try {
                Directory.Delete(path, recursive: true)
            } catch { }
        }
    }
}
