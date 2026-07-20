// <copyright file="Issue2516SliceCovarianceEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #2516: a slice composes its exact CLR array-interface implementation
/// with declaration-site generic covariance. Mutable interfaces and arrays
/// remain invariant.
/// </summary>
public class Issue2516SliceCovarianceEmitTests
{
    [Fact]
    public void BareCovariantInterfaces_PreserveIdentityEnumerationAndExactMutableViews()
    {
        var output = CompileAndRun("""
            package Probe
            import System
            import System.Collections.Generic

            open class Animal { }
            class Dog : Animal { }

            func Count(items IEnumerable[Animal]?) int32 {
                if items == nil {
                    return -1
                }

                var count = 0
                for _ in items {
                    count = count + 1
                }

                return count
            }

            func Widen[T Animal](items []T) IEnumerable[Animal] -> items

            func WidenNested(
                items []IReadOnlyList[Dog]
            ) IEnumerable[IReadOnlyList[Animal]] -> items

            var dogs = []Dog{Dog(), Dog()}
            var enumerable IEnumerable[Animal]? = dogs
            var readOnlyList IReadOnlyList[Animal] = dogs
            var readOnlyCollection IReadOnlyCollection[Animal] = dogs
            var exactList IList[Dog] = dogs
            var exactCollection ICollection[Dog] = dogs

            Console.WriteLine(Object.ReferenceEquals(dogs, enumerable))
            Console.WriteLine(Count(enumerable))
            Console.WriteLine(readOnlyList.Count)
            Console.WriteLine(readOnlyCollection.Count)
            Console.WriteLine(exactList.Count)
            Console.WriteLine(exactCollection.Count)
            Console.WriteLine(Count(Widen[Dog](dogs)))

            var nestedSource = []IReadOnlyList[Dog]{dogs}
            var nested = WidenNested(nestedSource)
            for item in nested {
                Console.WriteLine(item.Count)
            }
            """);

        Assert.Equal("True\n2\n2\n2\n2\n2\n2\n2\n", output);
    }

    [Fact]
    public void BareNullableSlice_ToNullableCovariantInterface_PropagatesNull()
    {
        var output = CompileAndRun("""
            package Probe
            import System
            import System.Collections.Generic

            open class Animal { }
            class Dog : Animal { }

            func Widen(items []?Dog) IEnumerable[Animal]? -> items

            var dogs = []Dog{Dog()}
            Console.WriteLine(Object.ReferenceEquals(dogs, Widen(dogs)))
            Console.WriteLine(Widen(nil) == nil)
            """);

        Assert.Equal("True\nTrue\n", output);
    }

    [Fact]
    public void ExpressionTree_BareSliceCovariance_MatchesCSharpParameterShape()
    {
        var output = CompileAndRun("""
            package Probe
            import System
            import System.Collections.Generic
            import System.Linq.Expressions

            open class Animal { }
            class Dog : Animal { }

            func MakeTree() Expression[Func[[]Dog, IEnumerable[Animal]]] {
                return (items []Dog) -> items
            }

            Console.WriteLine(MakeTree().Body.NodeType)
            """);

        // C# omits representation-preserving reference conversions from an
        // expression tree; translator-generated `as` incorrectly produced TypeAs.
        Assert.Equal("Parameter\n", output);
    }

    [Fact]
    public void SourceAndMetadataElements_ToMetadataCovariantInterface_CompileRunAndIlVerify()
    {
        var sibling = """
            namespace Probe.CSharp
            {
                public class Animal { }
                public sealed class MetadataDog : Animal { }

                public static class Factory
                {
                    public static MetadataDog[] Create() => new[] { new MetadataDog() };
                }

                public static class Sink
                {
                    public static int Count(
                        System.Collections.Generic.IEnumerable<Animal> items)
                    {
                        int count = 0;
                        foreach (var _ in items) count++;
                        return count;
                    }
                }
            }
            """;

        var gsource = """
            package Probe.Tests
            import System
            import System.Collections.Generic
            import Probe.CSharp

            class SourceDog : Animal { }

            var sourceDogs = []SourceDog{SourceDog(), SourceDog()}
            var metadataDogs = []MetadataDog{MetadataDog(), MetadataDog(), MetadataDog()}
            var sourceView IEnumerable[Animal] = sourceDogs
            var metadataView IEnumerable[Animal] = metadataDogs
            var returnedView IEnumerable[Animal] = Factory.Create()

            Console.WriteLine(Object.ReferenceEquals(sourceDogs, sourceView))
            Console.WriteLine(Object.ReferenceEquals(metadataDogs, metadataView))
            Console.WriteLine(Sink.Count(sourceDogs))
            Console.WriteLine(Sink.Count(metadataDogs))
            Console.WriteLine(Sink.Count(returnedView))
            """;

        var output = CompileAndRunWithSiblingCs(
            sibling,
            gsource,
            siblingName: "Probe.CSharp.Issue2516");
        Assert.Equal("True\nTrue\n2\n3\n1\n", output);
    }

    [Theory]
    [InlineData("[]Animal", "[]Dog{Dog()}")]
    [InlineData("IList[Animal]", "[]Dog{Dog()}")]
    [InlineData("ICollection[Animal]", "[]Dog{Dog()}")]
    [InlineData("IEnumerable[object]", "[]int32{1}")]
    public void UnsafeOrValueTypeVariance_RemainsRejected(string targetType, string value)
    {
        string source = $$"""
            package Probe
            import System.Collections.Generic

            open class Animal { }
            class Dog : Animal { }

            var rejected {{targetType}} = {{value}}
            """;

        var (exitCode, diagnostics) = Compile(source);
        Assert.NotEqual(0, exitCode);
        Assert.Contains("GS0155", diagnostics, StringComparison.Ordinal);
        Assert.DoesNotContain("GS9998", diagnostics, StringComparison.Ordinal);
    }

    [Fact]
    public void NullableElementAnnotation_CovariantInterfaceConversion_Compiles()
    {
        // The covariant element conversion composes with a nullable ELEMENT
        // envelope too (`[]Dog? -> IEnumerable[Animal?]`), not just a
        // nullable outer array/interface reference.
        var output = CompileAndRun("""
            package Probe
            import System
            import System.Collections.Generic

            open class Animal { }
            class Dog : Animal { }

            func Widen(items []Dog?) IEnumerable[Animal?] -> items

            var dogs = []Dog?{Dog(), nil, Dog()}
            var widened = Widen(dogs)
            var count = 0
            for item in widened {
                count = count + 1
            }
            Console.WriteLine(count)
            Console.WriteLine(Object.ReferenceEquals(dogs, widened))
            """);

        Assert.Equal("3\nTrue\n", output);
    }

    [Fact]
    public void CSharpConsumer_ObservesCompilerCovariantEnumerable_ReflectionAndIdentity()
    {
        // Interoperability / reflection coverage: a plain C# PROGRAM (no gsc
        // involved) references a G#-compiled library whose public API relies
        // ENTIRELY on the new native slice-to-covariant-interface conversion
        // (no translator-side cast, no compiler-side cast — a bare assignment),
        // then consumes it exactly like any other .NET IEnumerable<Animal>:
        // enumerating it, reading each element's runtime type via reflection,
        // and confirming the elements are the SAME references the library's
        // own array holds.
        var gsource = """
            package Probe.Issue2516Interop
            import System.Collections.Generic

            public open class Animal { }
            public class Dog : Animal { }

            public class Library {
                shared {
                    public let dogs []Dog = []Dog{Dog(), Dog(), Dog()}
                    public let animals IEnumerable[Animal] = Library.dogs

                    public func GetDogAt(i int32) Dog {
                        return Library.dogs[i]
                    }
                }
            }
            """;

        const string consumerSource = """
            using System.Collections.Generic;
            using System.Linq;
            using Probe.Issue2516Interop;

            public static class Consumer
            {
                public static string Run()
                {
                    IEnumerable<Animal> animals = Library.animals;
                    List<Animal> list = animals.ToList();
                    bool allDogs = list.All(a => a.GetType().Name == "Dog");
                    bool allSameRef = System.Object.ReferenceEquals(list[0], Library.GetDogAt(0))
                        && System.Object.ReferenceEquals(list[1], Library.GetDogAt(1))
                        && System.Object.ReferenceEquals(list[2], Library.GetDogAt(2));
                    return list.Count + "," + allDogs + "," + allSameRef;
                }
            }
            """;

        string output = CompileGsharpLibraryAndRunCSharpConsumer(gsource, consumerSource);
        Assert.Equal("3,True,True", output);
    }

    private static string CompileGsharpLibraryAndRunCSharpConsumer(string gSource, string consumerCsSource)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue2516_interop_").FullName;
        try
        {
            var gsSrcPath = Path.Combine(tempDir, "library.gs");
            var libraryDllPath = Path.Combine(tempDir, "library.dll");
            File.WriteAllText(gsSrcPath, gSource);

            int compileExit = RunCompiler(new[]
            {
                "/out:" + libraryDllPath,
                "/target:library",
                "/targetframework:net10.0",
                "/nowarn:GS9100",
                gsSrcPath,
            }, out string diagnostics);
            Assert.True(compileExit == 0, $"gsc failed compiling the G# library:\n{diagnostics}");

            IlVerifier.Verify(libraryDllPath);

            SyntaxTree consumerTree = CSharpSyntaxTree.ParseText(
                consumerCsSource,
                new CSharpParseOptions(LanguageVersion.Latest));
            var references = new List<MetadataReference>(
                TrustedPlatformAssemblies().Select(path => MetadataReference.CreateFromFile(path)))
            {
                MetadataReference.CreateFromFile(libraryDllPath),
            };
            var consumerCompilation = CSharpCompilation.Create(
                "Issue2516.CSharpConsumer",
                new[] { consumerTree },
                references,
                new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));

            var consumerDllPath = Path.Combine(tempDir, "consumer.dll");
            using (var stream = File.Create(consumerDllPath))
            {
                Microsoft.CodeAnalysis.Emit.EmitResult emitResult = consumerCompilation.Emit(stream);
                Assert.True(
                    emitResult.Success,
                    "C# consumer failed to compile against the G# library:\n" +
                        string.Join("\n", emitResult.Diagnostics));
            }

            var loadContext = new System.Runtime.Loader.AssemblyLoadContext("Issue2516Interop", isCollectible: true);
            try
            {
                loadContext.LoadFromAssemblyPath(libraryDllPath);
                var consumerAssembly = loadContext.LoadFromAssemblyPath(consumerDllPath);
                var consumerType = consumerAssembly.GetType("Consumer", throwOnError: true);
                var runMethod = consumerType.GetMethod("Run");
                return (string)runMethod.Invoke(null, null);
            }
            finally
            {
                loadContext.Unload();
            }
        }
        finally
        {
            try
            {
                Directory.Delete(tempDir, recursive: true);
            }
            catch
            {
            }
        }
    }

    private static (int ExitCode, string Diagnostics) Compile(string source)
    {
        var directory = Directory.CreateTempSubdirectory("gs_issue2516_compile_").FullName;
        try
        {
            var sourcePath = Path.Combine(directory, "test.gs");
            var outputPath = Path.Combine(directory, "test.dll");
            File.WriteAllText(sourcePath, source);

            using var stdout = new StringWriter();
            using var stderr = new StringWriter();
            var previousOut = Console.Out;
            var previousError = Console.Error;
            Console.SetOut(stdout);
            Console.SetError(stderr);
            try
            {
                int exitCode = Program.Main(new[]
                {
                    "/out:" + outputPath,
                    "/target:exe",
                    "/targetframework:net10.0",
                    sourcePath,
                });
                return (exitCode, stdout + Environment.NewLine + stderr);
            }
            finally
            {
                Console.SetOut(previousOut);
                Console.SetError(previousError);
            }
        }
        finally
        {
            try
            {
                Directory.Delete(directory, recursive: true);
            }
            catch
            {
            }
        }
    }

    private static string CompileAndRun(string source)
    {
        var directory = Directory.CreateTempSubdirectory("gs_issue2516_").FullName;
        try
        {
            var sourcePath = Path.Combine(directory, "test.gs");
            var outputPath = Path.Combine(directory, "test.dll");
            File.WriteAllText(sourcePath, source);

            int exitCode = RunCompiler(new[]
            {
                "/out:" + outputPath,
                "/target:exe",
                "/targetframework:net10.0",
                sourcePath,
            }, out string diagnostics);
            Assert.True(exitCode == 0, diagnostics);
            IlVerifier.Verify(outputPath);
            return RunAssembly(directory, outputPath);
        }
        finally
        {
            try
            {
                Directory.Delete(directory, recursive: true);
            }
            catch
            {
            }
        }
    }

    private static string CompileAndRunWithSiblingCs(
        string csSource,
        string gSource,
        string siblingName)
    {
        var directory = Directory.CreateTempSubdirectory("gs_issue2516_sibling_").FullName;
        try
        {
            var csDirectory = Path.Combine(directory, "csref");
            Directory.CreateDirectory(csDirectory);
            File.WriteAllText(Path.Combine(csDirectory, "Lib.cs"), csSource);
            File.WriteAllText(Path.Combine(csDirectory, "Lib.csproj"), $"""
                <Project Sdk="Microsoft.NET.Sdk">
                  <PropertyGroup>
                    <OutputType>Library</OutputType>
                    <TargetFramework>net10.0</TargetFramework>
                    <Nullable>enable</Nullable>
                    <AssemblyName>{siblingName}</AssemblyName>
                  </PropertyGroup>
                </Project>
                """);

            RunDotnet(csDirectory, "restore");
            RunDotnet(csDirectory, "build", "-c", "Release", "--nologo", "--no-restore");
            var siblingPath = Path.Combine(
                csDirectory,
                "bin",
                "Release",
                "net10.0",
                siblingName + ".dll");
            Assert.True(File.Exists(siblingPath), $"Missing sibling assembly: {siblingPath}");

            var sourcePath = Path.Combine(directory, "test.gs");
            var outputPath = Path.Combine(directory, "test.dll");
            File.WriteAllText(sourcePath, gSource);

            var arguments = new List<string>
            {
                "/out:" + outputPath,
                "/target:exe",
                "/targetframework:net10.0",
                "/reference:" + siblingPath,
            };
            foreach (var reference in TrustedPlatformAssemblies())
            {
                arguments.Add("/reference:" + reference);
            }

            arguments.Add("/nowarn:GS9100");
            arguments.Add(sourcePath);

            int exitCode = RunCompiler(arguments.ToArray(), out string diagnostics);
            Assert.True(exitCode == 0, diagnostics);
            IlVerifier.Verify(outputPath, additionalReferences: new[] { siblingPath });
            File.Copy(
                siblingPath,
                Path.Combine(directory, Path.GetFileName(siblingPath)),
                overwrite: true);
            return RunAssembly(directory, outputPath);
        }
        finally
        {
            try
            {
                Directory.Delete(directory, recursive: true);
            }
            catch
            {
            }
        }
    }

    private static int RunCompiler(string[] arguments, out string diagnostics)
    {
        using var stdout = new StringWriter();
        using var stderr = new StringWriter();
        var previousOut = Console.Out;
        var previousError = Console.Error;
        Console.SetOut(stdout);
        Console.SetError(stderr);
        try
        {
            int exitCode = Program.Main(arguments);
            diagnostics = $"stdout:\n{stdout}\nstderr:\n{stderr}";
            return exitCode;
        }
        finally
        {
            Console.SetOut(previousOut);
            Console.SetError(previousError);
        }
    }

    private static string RunAssembly(string workingDirectory, string assemblyPath)
    {
        var startInfo = new ProcessStartInfo("dotnet")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            WorkingDirectory = workingDirectory,
        };
        startInfo.ArgumentList.Add("exec");
        startInfo.ArgumentList.Add("--runtimeconfig");
        startInfo.ArgumentList.Add(Path.ChangeExtension(assemblyPath, ".runtimeconfig.json"));
        startInfo.ArgumentList.Add(assemblyPath);

        using var process = Process.Start(startInfo)
            ?? throw new InvalidOperationException("Failed to start dotnet exec.");
        var stdout = process.StandardOutput.ReadToEnd();
        var stderr = process.StandardError.ReadToEnd();
        Assert.True(process.WaitForExit(30_000), "dotnet exec timed out.");
        Assert.True(
            process.ExitCode == 0,
            $"dotnet exec exited {process.ExitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");
        return stdout.Replace("\r\n", "\n", StringComparison.Ordinal);
    }

    private static void RunDotnet(string workingDirectory, params string[] arguments)
    {
        var startInfo = new ProcessStartInfo("dotnet")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            WorkingDirectory = workingDirectory,
        };
        foreach (string argument in arguments)
        {
            startInfo.ArgumentList.Add(argument);
        }

        using var process = Process.Start(startInfo)
            ?? throw new InvalidOperationException($"Failed to start dotnet {arguments[0]}.");
        var stdout = process.StandardOutput.ReadToEnd();
        var stderr = process.StandardError.ReadToEnd();
        Assert.True(process.WaitForExit(120_000), $"dotnet {arguments[0]} timed out.");
        Assert.True(
            process.ExitCode == 0,
            $"dotnet {string.Join(" ", arguments)} exited {process.ExitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");
    }

    private static IEnumerable<string> TrustedPlatformAssemblies()
    {
        var trusted = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string;
        if (string.IsNullOrEmpty(trusted))
        {
            yield break;
        }

        foreach (string path in trusted.Split(Path.PathSeparator))
        {
            if (!string.IsNullOrWhiteSpace(path) && File.Exists(path))
            {
                yield return path;
            }
        }
    }
}
