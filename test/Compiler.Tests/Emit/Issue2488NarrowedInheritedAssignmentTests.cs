// <copyright file="Issue2488NarrowedInheritedAssignmentTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #2488: assignment binding must use the effective narrowed receiver
/// type, just like the read path, while the underlying variable keeps its
/// declared nullable storage type.
/// </summary>
public class Issue2488NarrowedInheritedAssignmentTests
{
    private const string ImportedTypes = """
        #nullable enable
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
        }
        """;

    [Fact]
    public void SourceInheritedMembers_NarrowedWritesRunReflectAndVerify()
    {
        const string source = """
            package Issue2488.Source

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
            }
            """;

        var assembly = CompileToAssembly(source);
        var derived = assembly.GetType("Issue2488.Source.Derived2488", throwOnError: true)!;
        Assert.NotNull(derived.GetField("FieldValue"));
        Assert.NotNull(derived.GetProperty("Value"));
        Assert.NotNull(derived.GetEvent("Changed"));
        Assert.NotNull(derived.GetProperty("Item"));

        InvokeEntryPoint(assembly);

        var program = assembly.GetTypes().Single(t => t.Name == "<Program>");
        Assert.Equal(1, ReadStaticInt(program, "FactoryCalls"));
        Assert.Equal(4, ReadStaticInt(program, "FieldResult"));
        Assert.Equal(22, ReadStaticInt(program, "PropertyResult"));
        Assert.Equal(24, ReadStaticInt(program, "IndexResult"));
        Assert.Equal(1, ReadStaticInt(program, "AddResult"));
        Assert.Equal(1, ReadStaticInt(program, "RemoveResult"));
    }

    [Fact]
    public void ImportedInheritedMembers_NarrowedWritesRunOnceAndVerify()
    {
        const string source = """
            package Issue2488.Imported
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
            Console.WriteLine(ValueCalls)
            """;

        Assert.Equal("3\n9\n16\n1\n1\n1\n1\n1\n", CompileAndRun(source, ImportedTypes));
    }

    [Fact]
    public void UnguardedNullableReceivers_RemainInvalidForEveryWriteKind()
    {
        const string source = """
            package Issue2488.Negative

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
            item[0] = 3
            """;

        var (exitCode, diagnostics) = CompileExpectingFailure(source);

        Assert.NotEqual(0, exitCode);
        Assert.Contains("GS0158", diagnostics);
        Assert.Contains("GS0116", diagnostics);
    }

    [Fact]
    public void Narrowing_DoesNotBypassInheritedPrivateAccessChecks()
    {
        const string source = """
            package Issue2488.Access

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
            }
            """;

        var (exitCode, diagnostics) = CompileExpectingFailure(source);

        Assert.NotEqual(0, exitCode);
        Assert.Contains("GS0472", diagnostics);
        Assert.Contains("Secret", diagnostics);
    }

    [Fact]
    public void ImportedUnguardedNullableReceiver_RemainsInvalid()
    {
        const string source = """
            package Issue2488.ImportedNegative
            import Issue2488.CSharp

            let item = Factory.Get()
            item.Field = 1
            item.Value = 2
            item.Changed += func() void { }
            item[0] = 3
            """;

        var (exitCode, diagnostics) = CompileExpectingFailure(source, ImportedTypes);

        Assert.NotEqual(0, exitCode);
        Assert.Contains("GS0158", diagnostics);
        Assert.Contains("GS0116", diagnostics);
    }

    private static Assembly CompileToAssembly(string source)
    {
        var workDir = Directory.CreateTempSubdirectory("gs_issue2488_reflection_").FullName;
        try
        {
            var (exitCode, diagnostics, outPath, references) = Compile(workDir, source, "exe", csharpSource: null);
            Assert.True(exitCode == 0, diagnostics);
            IlVerifier.Verify(outPath, additionalReferences: references);
            return Assembly.Load(File.ReadAllBytes(outPath));
        }
        finally
        {
            TryDelete(workDir);
        }
    }

    private static string CompileAndRun(string source, string csharpSource)
    {
        var workDir = Directory.CreateTempSubdirectory("gs_issue2488_run_").FullName;
        try
        {
            var (exitCode, diagnostics, outPath, references) = Compile(workDir, source, "exe", csharpSource);
            Assert.True(exitCode == 0, diagnostics);
            IlVerifier.Verify(outPath, additionalReferences: references);

            var runtimeConfig = Path.ChangeExtension(outPath, ".runtimeconfig.json");
            if (!File.Exists(runtimeConfig))
            {
                File.WriteAllText(runtimeConfig, """
                    {
                      "runtimeOptions": {
                        "tfm": "net10.0",
                        "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
                      }
                    }
                    """);
            }

            var startInfo = new ProcessStartInfo("dotnet")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = workDir,
            };
            startInfo.ArgumentList.Add("exec");
            startInfo.ArgumentList.Add("--runtimeconfig");
            startInfo.ArgumentList.Add(runtimeConfig);
            startInfo.ArgumentList.Add(outPath);

            using var process = Process.Start(startInfo)
                ?? throw new InvalidOperationException("Failed to start dotnet exec.");
            var stdout = process.StandardOutput.ReadToEnd();
            var stderr = process.StandardError.ReadToEnd();
            Assert.True(process.WaitForExit(30_000), "dotnet exec timed out.");
            Assert.True(
                process.ExitCode == 0,
                $"dotnet exec failed ({process.ExitCode})\nstdout:\n{stdout}\nstderr:\n{stderr}");
            return stdout.Replace("\r\n", "\n");
        }
        finally
        {
            TryDelete(workDir);
        }
    }

    private static (int ExitCode, string Diagnostics) CompileExpectingFailure(
        string source,
        string csharpSource = null)
    {
        var workDir = Directory.CreateTempSubdirectory("gs_issue2488_error_").FullName;
        try
        {
            var (exitCode, diagnostics, _, _) = Compile(workDir, source, "library", csharpSource);
            return (exitCode, diagnostics);
        }
        finally
        {
            TryDelete(workDir);
        }
    }

    private static (int ExitCode, string Diagnostics, string OutPath, string[] References) Compile(
        string workDir,
        string source,
        string target,
        string csharpSource)
    {
        var sourcePath = Path.Combine(workDir, "test.gs");
        var outputPath = Path.Combine(workDir, "test.dll");
        File.WriteAllText(sourcePath, source);

        var references = csharpSource == null
            ? Array.Empty<string>()
            : new[] { EmitCSharpLibrary(workDir, csharpSource) };

        var arguments = new List<string>
        {
            "/out:" + outputPath,
            "/target:" + target,
            "/targetframework:net10.0",
            "/nowarn:GS9100",
        };
        foreach (var reference in references)
        {
            arguments.Add("/reference:" + reference);
        }

        arguments.Add(sourcePath);

        using var stdout = new StringWriter();
        using var stderr = new StringWriter();
        var previousOut = Console.Out;
        var previousError = Console.Error;
        Console.SetOut(stdout);
        Console.SetError(stderr);
        try
        {
            var exitCode = Program.Main(arguments.ToArray());
            return (exitCode, stdout.ToString() + stderr, outputPath, references);
        }
        finally
        {
            Console.SetOut(previousOut);
            Console.SetError(previousError);
        }
    }

    private static string EmitCSharpLibrary(string workDir, string source)
    {
        var outputPath = Path.Combine(workDir, "Issue2488.CSharp.dll");
        var syntaxTree = CSharpSyntaxTree.ParseText(source);
        var references = TrustedPlatformAssemblies().Select(path => MetadataReference.CreateFromFile(path));
        var compilation = CSharpCompilation.Create(
            "Issue2488.CSharp",
            new[] { syntaxTree },
            references,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));

        using var stream = File.Create(outputPath);
        var result = compilation.Emit(stream);
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
        return outputPath;
    }

    private static void InvokeEntryPoint(Assembly assembly)
    {
        var entryPoint = assembly.EntryPoint!;
        entryPoint.Invoke(
            null,
            entryPoint.GetParameters().Length == 0 ? null : new object[] { Array.Empty<string>() });
    }

    private static int ReadStaticInt(Type program, string fieldName)
    {
        return (int)program.GetField(fieldName, BindingFlags.Public | BindingFlags.Static)!.GetValue(null)!;
    }

    private static IEnumerable<string> TrustedPlatformAssemblies()
    {
        var value = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string;
        Assert.False(string.IsNullOrWhiteSpace(value));
        return value!.Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries);
    }

    private static void TryDelete(string path)
    {
        try
        {
            Directory.Delete(path, recursive: true);
        }
        catch
        {
        }
    }
}
