// <copyright file="Issue2443ExternalClrOverrideEmitTests.cs" company="GSharp">
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
/// Issue #2443: overrides can target virtual members inherited from imported
/// CLR base classes instead of only members represented by a G# BaseClass.
/// </summary>
public sealed class Issue2443ExternalClrOverrideEmitTests
{
    private static readonly Lazy<string> ExternalBaseAssembly = new(EmitExternalBaseAssembly);

    [Fact]
    public void ImplicitObjectOverrides_SourceChainsAndGenericClasses_DispatchAndReflectBaseSlots()
    {
        const string Source = """
            package Issue2486
            import System

            open class Root[T] {
            }

            class Derived : Root[int32] {
                override func ToString() string -> "derived"
                override func GetHashCode() int32 -> 2486
                override func Equals(value object) bool -> true
            }

            open class OpenImplicit {
                override func ToString() string -> "open"
            }

            class Generic[T] {
                override func ToString() string -> "generic"
            }

            func Main() {
                let value object = Derived()
                Console.WriteLine(value.ToString())
                Console.WriteLine(value.GetHashCode())
                Console.WriteLine(value.Equals(Derived()))
            }
            """;

        var result = Compile(Source, target: "exe");
        try
        {
            Assert.Equal("derived\n2486\nTrue\n", Run(result.OutputPath));
            IlVerifier.Verify(result.OutputPath);

            var assembly = Assembly.LoadFrom(result.OutputPath);
            var derived = assembly.GetType("Issue2486.Derived")!;
            AssertOverrideSlot(
                derived.GetMethod("ToString", BindingFlags.Instance | BindingFlags.Public | BindingFlags.DeclaredOnly)!,
                typeof(object).GetMethod("ToString")!);
            AssertOverrideSlot(
                derived.GetMethod("GetHashCode", BindingFlags.Instance | BindingFlags.Public | BindingFlags.DeclaredOnly)!,
                typeof(object).GetMethod("GetHashCode")!);
            AssertOverrideSlot(
                derived.GetMethod("Equals", BindingFlags.Instance | BindingFlags.Public | BindingFlags.DeclaredOnly)!,
                typeof(object).GetMethod("Equals", new[] { typeof(object) })!);

            var openImplicit = assembly.GetType("Issue2486.OpenImplicit")!;
            Assert.False(openImplicit.IsSealed);
            AssertOverrideSlot(openImplicit.GetMethod("ToString")!, typeof(object).GetMethod("ToString")!);

            var generic = assembly.GetType("Issue2486.Generic`1")!;
            Assert.True(generic.IsSealed);
            AssertOverrideSlot(generic.GetMethod("ToString")!, typeof(object).GetMethod("ToString")!);

            var consumerPath = EmitImplicitObjectConsumer(result.DirectoryPath, result.OutputPath);
            Assert.Equal("derived\n2486\nTrue\ngeneric\n", Run(consumerPath));
        }
        finally
        {
            result.Dispose();
        }
    }

    [Fact]
    public void MatchingImplicitObjectVirtualWithoutOverride_RemainsAnAcceptedShadow()
    {
        const string Source = """
            package Issue2486

            class Shadow {
                func ToString() string -> "shadow"
            }
            """;

        var result = Compile(Source, target: "library");
        try
        {
            IlVerifier.Verify(result.OutputPath);

            var assembly = Assembly.LoadFrom(result.OutputPath);
            var type = assembly.GetType("Issue2486.Shadow")!;
            var instance = Activator.CreateInstance(type);
            var shadow = type.GetMethod("ToString", BindingFlags.Instance | BindingFlags.Public | BindingFlags.DeclaredOnly)!;

            Assert.True((shadow.Attributes & MethodAttributes.NewSlot) != 0);
            Assert.Equal("shadow", shadow.Invoke(instance, null));
            Assert.Equal("Issue2486.Shadow", typeof(object).GetMethod("ToString")!.Invoke(instance, null));
        }
        finally
        {
            result.Dispose();
        }
    }

    [Theory]
    [InlineData("""
        package Issue2486
        class Bad {
            override func ToString(value int32) string -> "bad"
        }
        """, "GS0185")]
    [InlineData("""
        package Issue2486
        class Bad {
            protected override func MemberwiseClone() object -> this
        }
        """, "GS0184")]
    [InlineData("""
        package Issue2486
        class Bad {
            override func Missing() string -> "bad"
        }
        """, "GS0183")]
    [InlineData("""
        package Issue2486
        struct Bad {
            override func ToString() string -> "bad"
        }
        """, "GS0183")]
    public void ImplicitObjectOverride_InvalidShapesRetainSpecificDiagnostics(string source, string diagnosticId)
    {
        var result = TryCompile(source, "library");
        try
        {
            Assert.NotEqual(0, result.ExitCode);
            Assert.Contains(diagnosticId, result.Stdout + result.Stderr, StringComparison.Ordinal);
        }
        finally
        {
            result.Dispose();
        }
    }

    [Fact]
    public void BclObjectOverride_DispatchesAndReflectsBaseSlot()
    {
        const string Source = """
            package Issue2443
            import System

            class Derived : Object {
                override func ToString() string -> "derived"
            }

            func Main() {
                let value object = Derived()
                Console.WriteLine(value.ToString())
            }
            """;

        var result = Compile(Source, target: "exe");
        try
        {
            Assert.Equal("derived\n", Run(result.OutputPath));
            IlVerifier.Verify(result.OutputPath);

            var assembly = Assembly.LoadFrom(result.OutputPath);
            var method = assembly.GetType("Issue2443.Derived")!.GetMethod(
                "ToString",
                BindingFlags.Instance | BindingFlags.Public | BindingFlags.DeclaredOnly)!;

            Assert.True(method.IsVirtual);
            Assert.True(method.IsFinal);
            Assert.False((method.Attributes & MethodAttributes.NewSlot) != 0);
            Assert.Equal(typeof(object).GetMethod("ToString"), method.GetBaseDefinition());
        }
        finally
        {
            result.Dispose();
        }
    }

    [Fact]
    public void SiblingAssemblyOverrides_MethodsPropertiesEventsGenericsAndCovariance_WorkForCSharpConsumer()
    {
        const string Source = """
            package Issue2443
            import System
            import Issue2443Base

            open class Derived : ExternalBase[int32] {
                override func Echo(value int32) string -> "echo:" + value.ToString()
                override func Identity[U](value U) U -> value
                override func Covariant() Marker -> Marker()
                override prop Value int32 { get { return 7 } }
                override prop this[index int32] int32 { get { return index + 10 } }
                override event Changed EventHandler {
                    add { }
                    remove { }
                }
                protected override func ProtectedCore(value int32) int32 -> value + 1
                override func AbstractName() string -> "abstract"
            }

            open class AbstractDerived : ExternalBase[int32] {
                open override func AbstractName() string;
            }

            open class GenericDerived[T] : ExternalBase[T] {
                override func Echo(value T) string -> "generic"
                override func AbstractName() string -> "generic-abstract"
            }
            """;

        var result = Compile(Source, target: "library", ExternalBaseAssembly.Value);
        try
        {
            IlVerifier.Verify(result.OutputPath, additionalReferences: new[] { ExternalBaseAssembly.Value });

            var baseAssembly = Assembly.LoadFrom(ExternalBaseAssembly.Value);
            var derivedAssembly = Assembly.LoadFrom(result.OutputPath);
            var derived = derivedAssembly.GetType("Issue2443.Derived")!;
            var closedBase = baseAssembly.GetType("Issue2443Base.ExternalBase`1")!.MakeGenericType(typeof(int));

            AssertOverrideSlot(derived.GetMethod("Echo")!, closedBase.GetMethod("Echo")!);
            AssertOverrideSlot(derived.GetMethod("Identity")!, closedBase.GetMethod("Identity")!);
            AssertVirtualReuseSlot(derived.GetMethod("Covariant")!);
            AssertOverrideSlot(derived.GetProperty("Value")!.GetMethod!, closedBase.GetProperty("Value")!.GetMethod!);
            AssertOverrideSlot(
                derived.GetProperty("Item")!.GetMethod!,
                closedBase.GetProperty("Item")!.GetMethod!);
            AssertOverrideSlot(
                derived.GetEvent("Changed")!.AddMethod!,
                closedBase.GetEvent("Changed")!.AddMethod!);

            Assert.Equal(
                baseAssembly.GetType("Issue2443Base.Marker"),
                derived.GetMethod("Covariant")!.ReturnType);

            var abstractDerived = derivedAssembly.GetType("Issue2443.AbstractDerived")!;
            Assert.True(abstractDerived.IsAbstract);
            Assert.True(abstractDerived.GetMethod("AbstractName")!.IsAbstract);
            AssertOverrideSlot(
                abstractDerived.GetMethod("AbstractName")!,
                closedBase.GetMethod("AbstractName")!);

            var genericDerived = derivedAssembly.GetType("Issue2443.GenericDerived`1")!;
            Assert.True(genericDerived.BaseType!.IsGenericType);
            Assert.Equal(
                genericDerived.GetGenericArguments()[0],
                genericDerived.BaseType.GetGenericArguments()[0]);

            var consumerPath = EmitCSharpConsumer(result.DirectoryPath, result.OutputPath, ExternalBaseAssembly.Value);
            Assert.Equal(
                "echo:4\nid\nMarker\n7\n13\n5\nabstract\ngeneric\ngeneric-abstract\n",
                Run(consumerPath));
        }
        finally
        {
            result.Dispose();
        }
    }

    [Fact]
    public void MatchingExternalVirtualWithoutOverride_RemainsAnAcceptedShadow()
    {
        const string Source = """
            package Issue2443
            import Issue2443Base

            class ShadowingDerived : ExternalBase[int32] {
                func Echo(value int32) string -> "shadow"
                override func AbstractName() string -> "abstract"
            }
            """;

        var result = Compile(Source, target: "library", ExternalBaseAssembly.Value);
        try
        {
            var baseAssembly = Assembly.LoadFrom(ExternalBaseAssembly.Value);
            var derivedAssembly = Assembly.LoadFrom(result.OutputPath);
            var derivedType = derivedAssembly.GetType("Issue2443.ShadowingDerived")!;
            var instance = Activator.CreateInstance(derivedType);
            var closedBase = baseAssembly.GetType("Issue2443Base.ExternalBase`1")!.MakeGenericType(typeof(int));
            var shadow = derivedType.GetMethod("Echo", BindingFlags.Instance | BindingFlags.Public | BindingFlags.DeclaredOnly)!;

            Assert.True((shadow.Attributes & MethodAttributes.NewSlot) != 0);
            Assert.Equal("shadow", shadow.Invoke(instance, new object[] { 1 }));
            Assert.Equal("base", closedBase.GetMethod("Echo")!.Invoke(instance, new object[] { 1 }));
        }
        finally
        {
            result.Dispose();
        }
    }

    [Theory]
    [InlineData("""
        package Issue2443
        import Issue2443Base
        class Bad : SealedBase {
            override func ToString() string -> "bad"
        }
        """, "GS0184")]
    [InlineData("""
        package Issue2443
        import Issue2443Base
        class Bad : ExternalBase[int32] {
            override func Echo(value string) string -> value
            override func AbstractName() string -> "abstract"
        }
        """, "GS0185")]
    public void InvalidExplicitExternalOverrideShapes_Report(string source, string diagnosticId)
    {
        var result = TryCompile(source, "library", ExternalBaseAssembly.Value);
        try
        {
            Assert.NotEqual(0, result.ExitCode);
            Assert.Contains(diagnosticId, result.Stdout + result.Stderr, StringComparison.Ordinal);
        }
        finally
        {
            result.Dispose();
        }
    }

    private static void AssertOverrideSlot(MethodInfo implementation, MethodInfo declaration)
    {
        AssertVirtualReuseSlot(implementation);
        Assert.Equal(declaration.GetBaseDefinition().MetadataToken, implementation.GetBaseDefinition().MetadataToken);
        Assert.Equal(declaration.GetBaseDefinition().Module, implementation.GetBaseDefinition().Module);
    }

    private static void AssertVirtualReuseSlot(MethodInfo implementation)
    {
        Assert.True(implementation.IsVirtual);
        Assert.False((implementation.Attributes & MethodAttributes.NewSlot) != 0);
    }

    private static CompilationResult Compile(string source, string target, params string[] references)
    {
        var result = TryCompile(source, target, references);
        Assert.True(
            result.ExitCode == 0,
            $"gsc failed ({result.ExitCode}):\nstdout:\n{result.Stdout}\nstderr:\n{result.Stderr}");
        return result;
    }

    private static CompilationResult TryCompile(string source, string target, params string[] references)
    {
        var directory = Directory.CreateTempSubdirectory("gs_issue2443_").FullName;
        var sourcePath = Path.Combine(directory, "test.gs");
        var assemblyName = "Issue2443Derived_" + Guid.NewGuid().ToString("N");
        var outputPath = Path.Combine(directory, assemblyName + ".dll");
        File.WriteAllText(sourcePath, source);

        var args = new List<string>
        {
            "/out:" + outputPath,
            "/assemblyname:" + assemblyName,
            "/target:" + target,
            "/targetframework:net10.0",
            "/nowarn:GS9100",
        };
        foreach (var reference in references)
        {
            args.Add("/r:" + reference);
        }

        foreach (var reference in BclReferences.Value)
        {
            args.Add("/r:" + reference);
        }

        args.Add(sourcePath);

        using var stdout = new StringWriter();
        using var stderr = new StringWriter();
        var previousOut = Console.Out;
        var previousError = Console.Error;
        Console.SetOut(stdout);
        Console.SetError(stderr);
        int exitCode;
        try
        {
            exitCode = Program.Main(args.ToArray());
        }
        finally
        {
            Console.SetOut(previousOut);
            Console.SetError(previousError);
        }

        if (File.Exists(ExternalBaseAssembly.Value))
        {
            File.Copy(
                ExternalBaseAssembly.Value,
                Path.Combine(directory, Path.GetFileName(ExternalBaseAssembly.Value)),
                overwrite: true);
        }

        return new CompilationResult(directory, outputPath, exitCode, stdout.ToString(), stderr.ToString());
    }

    private static string EmitExternalBaseAssembly()
    {
        var directory = Path.Combine(AppContext.BaseDirectory, "Issue2443ExternalBase");
        Directory.CreateDirectory(directory);
        var path = Path.Combine(directory, "Issue2443Base.dll");
        const string Source = """
            using System;

            namespace Issue2443Base;

            public sealed class Marker
            {
            }

            public abstract class ExternalBase<T>
            {
                public virtual int Value => -1;

                public virtual T this[int index] => default!;

                public virtual event EventHandler Changed
                {
                    add { }
                    remove { }
                }

                public virtual string Echo(T value) => "base";

                public virtual U Identity<U>(U value) => value;

                public virtual object Covariant() => new object();

                public abstract string AbstractName();

                public int CallProtected(int value) => ProtectedCore(value);

                protected virtual int ProtectedCore(int value) => -1;
            }

            public class SealedBase
            {
                public sealed override string ToString() => "sealed";
            }
            """;

        EmitCSharpAssembly(path, "Issue2443Base", Source, OutputKind.DynamicallyLinkedLibrary);
        return path;
    }

    private static string EmitCSharpConsumer(string directory, string gsharpAssembly, string baseAssembly)
    {
        var outputPath = Path.Combine(directory, "Issue2443Consumer.dll");
        const string Source = """
            using System;
            using Issue2443;
            using Issue2443Base;

            internal static class Program
            {
                private static void Main()
                {
                    ExternalBase<int> value = new Derived();
                    value.Changed += (_, _) => { };
                    Console.WriteLine(value.Echo(4));
                    Console.WriteLine(value.Identity("id"));
                    Console.WriteLine(value.Covariant().GetType().Name);
                    Console.WriteLine(value.Value);
                    Console.WriteLine(value[3]);
                    Console.WriteLine(value.CallProtected(4));
                    Console.WriteLine(value.AbstractName());

                    ExternalBase<int> generic = new GenericDerived<int>();
                    Console.WriteLine(generic.Echo(4));
                    Console.WriteLine(generic.AbstractName());
                }
            }
            """;

        EmitCSharpAssembly(
            outputPath,
            "Issue2443Consumer",
            Source,
            OutputKind.ConsoleApplication,
            gsharpAssembly,
            baseAssembly);
        return outputPath;
    }

    private static string EmitImplicitObjectConsumer(string directory, string gsharpAssembly)
    {
        var outputPath = Path.Combine(directory, "Issue2486Consumer.dll");
        const string Source = """
            using System;
            using Issue2486;

            internal static class Program
            {
                private static void Main()
                {
                    object value = new Derived();
                    Console.WriteLine(value.ToString());
                    Console.WriteLine(value.GetHashCode());
                    Console.WriteLine(value.Equals(new Derived()));

                    object generic = new Generic<string>();
                    Console.WriteLine(generic.ToString());
                }
            }
            """;

        EmitCSharpAssembly(
            outputPath,
            "Issue2486Consumer",
            Source,
            OutputKind.ConsoleApplication,
            gsharpAssembly);
        return outputPath;
    }

    private static void EmitCSharpAssembly(
        string outputPath,
        string assemblyName,
        string source,
        OutputKind outputKind,
        params string[] additionalReferences)
    {
        var references = TrustedPlatformReferences()
            .Concat(additionalReferences.Select(path => MetadataReference.CreateFromFile(path)))
            .ToArray();
        var compilation = CSharpCompilation.Create(
            assemblyName,
            new[] { CSharpSyntaxTree.ParseText(source, new CSharpParseOptions(LanguageVersion.Latest)) },
            references,
            new CSharpCompilationOptions(outputKind));

        using var peStream = File.Create(outputPath);
        var emitResult = compilation.Emit(peStream);
        Assert.True(emitResult.Success, string.Join(Environment.NewLine, emitResult.Diagnostics));
    }

    private static string Run(string assemblyPath)
    {
        var runtimeConfigPath = Path.ChangeExtension(assemblyPath, "runtimeconfig.json");
        File.WriteAllText(runtimeConfigPath, """
            {
              "runtimeOptions": {
                "tfm": "net10.0",
                "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
              }
            }
            """);

        var startInfo = new ProcessStartInfo("dotnet", "exec \"" + assemblyPath + "\"")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };
        using var process = Process.Start(startInfo)!;
        var stdout = process.StandardOutput.ReadToEnd();
        var stderr = process.StandardError.ReadToEnd();
        process.WaitForExit();
        Assert.True(process.ExitCode == 0, $"exit {process.ExitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");
        return stdout.Replace("\r\n", "\n", StringComparison.Ordinal);
    }

    private static IEnumerable<MetadataReference> TrustedPlatformReferences()
        => ((AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string)
            ?.Split(Path.PathSeparator)
            ?? Array.Empty<string>())
            .Where(File.Exists)
            .Select(path => MetadataReference.CreateFromFile(path));

    private static readonly Lazy<IReadOnlyList<string>> BclReferences = new(() =>
    {
        var runtimeDirectory = Path.GetDirectoryName(typeof(object).Assembly.Location);
        if (string.IsNullOrEmpty(runtimeDirectory) || !Directory.Exists(runtimeDirectory))
        {
            return Array.Empty<string>();
        }

        return Directory.EnumerateFiles(runtimeDirectory, "*.dll", SearchOption.TopDirectoryOnly)
            .Where(path =>
            {
                var name = Path.GetFileName(path);
                return name.StartsWith("System.", StringComparison.OrdinalIgnoreCase)
                    || string.Equals(name, "mscorlib.dll", StringComparison.OrdinalIgnoreCase)
                    || string.Equals(name, "netstandard.dll", StringComparison.OrdinalIgnoreCase);
            })
            .ToArray();
    });

    private sealed class CompilationResult : IDisposable
    {
        public CompilationResult(
            string directoryPath,
            string outputPath,
            int exitCode,
            string stdout,
            string stderr)
        {
            DirectoryPath = directoryPath;
            OutputPath = outputPath;
            ExitCode = exitCode;
            Stdout = stdout;
            Stderr = stderr;
        }

        public string DirectoryPath { get; }

        public string OutputPath { get; }

        public int ExitCode { get; }

        public string Stdout { get; }

        public string Stderr { get; }

        public void Dispose()
        {
            try
            {
                Directory.Delete(DirectoryPath, recursive: true);
            }
            catch
            {
            }
        }
    }
}
