// <copyright file="Issue2502InheritedStaticMembersEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import System.Reflection
import GSharp.Compiler
import GSharp.Tests
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import Xunit
import GSharp.Compiler.Tests

/// Issue #2502 end-to-end coverage for inherited static members.
class Issue2502InheritedStaticMembersEmitTests {
    @Fact
    func SourceGenericBase_AllMemberKinds_VerifyReflectAndWorkFromCSharp() {
        const Source = `package Issue2502Source
import System

open class Base2502[T] {
    public class Nested2502 {
        shared { func Value() int32 -> 9 }
    }
    shared {
        var Field T
        prop Prop T { get -> Field; set { Field = value } }
        event Changed () -> void
        func Echo(value T) T -> value
        func Pick(value T) string -> "generic"
        func Pick(value int32) string -> "int"
    }
}

open class Mid2502[U] : Base2502[U] { }
class Derived2502 : Mid2502[string] { }

class Probe2502 {
    shared {
        func Run() string {
            Derived2502.Field = "field"
            Derived2502.Field += "!"
            Derived2502.Prop = Derived2502.Field
            Derived2502.Prop += "?"
            let handler () -> void = () -> { }
            Derived2502.Changed += handler
            Derived2502.Changed -= handler
            let echo (string) -> string = Derived2502.Echo
            return Derived2502.Prop + "|" + echo("group") + "|" + Derived2502.Pick(1) + "|" + Derived2502.Nested2502.Value().ToString()
        }
    }
}`
        let directory = CreateTestDirectory()
        try {
            let library = CompileGSharp(directory, "Issue2502Source", Source, "library")
            IlVerifier.Verify(library)
            let assembly = EmittedFixture.Load(library)
            let derived = assembly.GetType("Issue2502Source.Derived2502")!!
            let closedBase = assembly.GetType("Issue2502Source.Base2502`1")!!.MakeGenericType(typeof(string))
            Assert.Equal(closedBase, derived.BaseType!!.BaseType)
            Assert.Equal(
                closedBase,
                derived.GetMethod(
                    "Echo",
                    BindingFlags.Public | BindingFlags.Static | BindingFlags.FlattenHierarchy
                )!!.DeclaringType
            )
            Assert.Equal(
                closedBase,
                derived.GetField(
                    "Field",
                    BindingFlags.Public | BindingFlags.Static | BindingFlags.FlattenHierarchy
                )!!.DeclaringType
            )
            Assert.Equal(
                closedBase,
                derived.GetProperty(
                    "Prop",
                    BindingFlags.Public | BindingFlags.Static | BindingFlags.FlattenHierarchy
                )!!.DeclaringType
            )
            Assert.Equal(
                closedBase,
                derived.GetEvent(
                    "Changed",
                    BindingFlags.Public | BindingFlags.Static | BindingFlags.FlattenHierarchy
                )!!.DeclaringType
            )
            let consumer = Path.Combine(directory, "Issue2502Consumer.dll")
            const ConsumerSource = `using System;
using Issue2502Source;

Console.WriteLine(Probe2502.Run());
Derived2502.Field = "cs-field";
Derived2502.Prop = "cs-prop";
Console.WriteLine(Derived2502.Field);
Console.WriteLine(Derived2502.Prop);
Console.WriteLine(Derived2502.Echo("cs-method"));
Func<string, string> echo = Derived2502.Echo;
Console.WriteLine(echo("cs-group"));
Action handler = () => { };
Derived2502.Changed += handler;
Derived2502.Changed -= handler;
Console.WriteLine("event-ok");`
            EmitCSharpAssembly(consumer, "Issue2502Consumer", ConsumerSource, OutputKind.ConsoleApplication, library)
            Assert.Equal(
                "field!?|group|int|9${Environment.NewLine}cs-prop${Environment.NewLine}cs-prop${Environment.NewLine}cs-method${Environment.NewLine}cs-group${Environment.NewLine}event-ok${Environment.NewLine}",
                Run(consumer)
            )
        } finally {
            TryDelete(directory)
        }
    }

    @Fact
    func ImportedClosedGenericBase_AllMemberKinds_VerifyAndRun() {
        let directory = CreateTestDirectory()
        try {
            let importedBase = Path.Combine(directory, "Issue2502ImportedBase.dll")
            const ImportedSource = `using System;

namespace Issue2502ImportedBase;

public class Base<T>
{
    public static T Field = default!;
    public static T Prop { get; set; } = default!;
    public static event Action? Changed;
    public static T Echo(T value) => value;
    public static void Raise() => Changed?.Invoke();

    public class Nested
    {
        public static int Value() => 12;
    }
}`
            EmitCSharpAssembly(
                importedBase,
                "Issue2502ImportedBase",
                ImportedSource,
                OutputKind.DynamicallyLinkedLibrary
            )
            const Source = `package Issue2502Imported
import System
import Issue2502ImportedBase

class Derived2502Imported : Base[string] { }

func Main() {
    Derived2502Imported.Field = "field"
    Console.WriteLine(Derived2502Imported.Field)
    Derived2502Imported.Prop = "prop"
    Console.WriteLine(Derived2502Imported.Prop)
    Console.WriteLine(Derived2502Imported.Echo("method"))
    Derived2502Imported.Changed += () -> Console.WriteLine("event")
    Derived2502Imported.Raise()
    Console.WriteLine(Derived2502Imported.Nested.Value())
}`
            let executable = CompileGSharp(directory, "Issue2502Imported", Source, "exe", importedBase)
            IlVerifier.Verify(executable, additionalReferences: []string{importedBase})
            Assert.Equal(
                "field${Environment.NewLine}prop${Environment.NewLine}method${Environment.NewLine}event${Environment.NewLine}12${Environment.NewLine}",
                Run(executable)
            )
        } finally {
            TryDelete(directory)
        }
    }

    @Fact
    func Issue2636_ImportedDerivedType_InheritedStaticMethodRunsAcrossAssemblies() {
        let directory = CreateTestDirectory()
        try {
            let baseLibrary = Path.Combine(directory, "Issue2636.Base.dll")
            EmitCSharpAssembly(baseLibrary, "Issue2636.Base", `using System.Threading.Tasks;

namespace Issue2636.Base;

public class BookDbContext
{
    public static Task<bool> StartupAsync() => Task.FromResult(true);
}`, OutputKind.DynamicallyLinkedLibrary)
            let derivedLibrary = Path.Combine(directory, "Issue2636.Derived.dll")
            EmitCSharpAssembly(derivedLibrary, "Issue2636.Derived", `using Issue2636.Base;

namespace Issue2636.Derived;

public sealed class BookDbContextLazyLoad : BookDbContext;`, OutputKind.DynamicallyLinkedLibrary, baseLibrary)
            const Source = `package Issue2636.Consumer
import System
import Issue2636.Derived

func Main() {
    Console.WriteLine(BookDbContextLazyLoad.StartupAsync()!!.GetAwaiter().GetResult())
}`
            let executable = CompileGSharp(directory, "Issue2636.Consumer", Source, "exe", baseLibrary, derivedLibrary)
            IlVerifier.Verify(executable, additionalReferences: []string{baseLibrary, derivedLibrary})
            Assert.Equal("True${Environment.NewLine}", Run(executable))
        } finally {
            TryDelete(directory)
        }
    }

    shared {
        private func CompileGSharp(
            directory string,
            assemblyName string,
            source string,
            target string,
            references ...string
        ) string {
            let sourcePath = Path.Combine(directory, assemblyName + ".gs")
            let outputPath = Path.Combine(directory, assemblyName + ".dll")
            File.WriteAllText(sourcePath, source)
            let args = List[string]{
                "/out:" + outputPath,
                "/target:" + target,
                "/targetframework:net10.0",
                "/nowarn:GS9100"
            }
            for reference in references.Concat(BclReferences.Value) {
                args.Add("/r:" + reference)
            }
            args.Add(sourcePath)
            using let stdout = StringWriter()
            using let stderr = StringWriter()
            let previousOut = Console.Out
            let previousError = Console.Error
            Console.SetOut(stdout)
            Console.SetError(stderr)
            var exitCode int32
            try {
                exitCode = Program.Main(args.ToArray())
            } finally {
                Console.SetOut(previousOut)
                Console.SetError(previousError)
            }
            Assert.True(exitCode == 0, (`gsc failed:
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
            return outputPath
        }

        private func EmitCSharpAssembly(
            outputPath string,
            assemblyName string,
            source string,
            outputKind OutputKind,
            additionalReferences ...string
        ) {
            let references = TrustedPlatformReferences().Concat(
                additionalReferences.Select((path string) -> MetadataReference.CreateFromFile(path))
            )
                .ToArray()
            let compilation = CSharpCompilation.Create(
                assemblyName,
                []SyntaxTree{CSharpSyntaxTree.ParseText(source, CSharpParseOptions(LanguageVersion.Latest))},
                references,
                CSharpCompilationOptions(outputKind)
            )
            using let stream = File.Create(outputPath)
            let result = compilation.Emit(stream)
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
        }

        private func Run(assemblyPath string) string {
            File.WriteAllText(Path.ChangeExtension(assemblyPath, ".runtimeconfig.json"), `{
  "runtimeOptions": {
    "tfm": "net10.0",
    "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
  }
}`)
            let startInfo = ProcessStartInfo("dotnet"){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = Path.GetDirectoryName(assemblyPath)!!
            }
            startInfo.ArgumentList.Add("exec")
            startInfo.ArgumentList.Add(assemblyPath)
            using let process = Process.Start(startInfo)!!
            let stdout = process.StandardOutput.ReadToEnd()
            let stderr = process.StandardError.ReadToEnd()
            Assert.True(process.WaitForExit(30_000), "dotnet exec timed out")
            Assert.True(process.ExitCode == 0, (`exit ` + "${process.ExitCode}" + `
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
            return stdout.ReplaceLineEndings(Environment.NewLine)
        }

        private func CreateTestDirectory() string {
            let directory = Path.Combine(AppContext.BaseDirectory, "Issue2502", Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(directory)
            return directory
        }

        private func TryDelete(directory string) {
            try {
                Directory.Delete(directory, recursive: true)
            } catch { }
        }

        private func TrustedPlatformReferences() IEnumerable[MetadataReference] -> (
            (AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string)?.Split(Path.PathSeparator) ??
                Array.Empty[string]()
        )
            .Where(File.Exists).Select((path string) -> MetadataReference.CreateFromFile(path))

        private let BclReferences Lazy[IReadOnlyList[string]] = Lazy[IReadOnlyList[string]](
            func () IReadOnlyList[string] {
                let runtimeDirectory string? = Path.GetDirectoryName(typeof(object).Assembly.Location)
                if string.IsNullOrEmpty(runtimeDirectory) || !Directory.Exists(runtimeDirectory) {
                    return Array.Empty[string]()
                }
                return Directory
                    .EnumerateFiles(runtimeDirectory!!, "*.dll", SearchOption.TopDirectoryOnly)
                    .Where(
                    (path string) -> {
                        let name = Path.GetFileName(path)
                        return name.StartsWith("System.", StringComparison.OrdinalIgnoreCase) || string.Equals(
                            name,
                            "mscorlib.dll",
                            StringComparison.OrdinalIgnoreCase
                        ) ||
                            string.Equals(name, "netstandard.dll", StringComparison.OrdinalIgnoreCase)
                    }
                )
                    .ToArray()
            }
        )
    }
}
