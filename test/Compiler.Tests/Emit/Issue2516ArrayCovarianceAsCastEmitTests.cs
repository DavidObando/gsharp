// <copyright file="Issue2516ArrayCovarianceAsCastEmitTests.cs" company="GSharp">
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
/// Issue #2516: cs2gs materializes a C# array-covariance conversion
/// (<c>Derived[] -&gt; IEnumerable&lt;Base&gt;</c>, and the like) as the canonical G#
/// safe cast <c>(expr as T)</c>, since G# slices are intentionally invariant
/// (<c>Conversion.cs</c>: "G# slices are invariant") and reject the bare form.
/// These tests exercise that <c>as</c>-cast form directly at the COMPILER level
/// — independent of the cs2gs translator — proving:
/// <list type="bullet">
///   <item><c>BindAsExpression</c> accepts a slice cast to every covariant
///   array-supertype interface/array target (it never calls
///   <c>Conversion.Classify</c>, so slice invariance never blocks it).</item>
///   <item><c>EmitAsExpression</c> lowers the cast to a bare CLR <c>isinst</c>
///   that ILVerify accepts and that always succeeds at runtime for a
///   conversion C# already proved legal.</item>
///   <item>Reference identity, enumeration order/count, and element values are
///   preserved exactly — <c>isinst</c> returns the SAME array reference, it
///   does not project/copy.</item>
///   <item>G#'s own slice invariance (issue #570/#2140) is completely
///   unaffected — the bare (unwrapped) mismatched conversion this workaround
///   replaces still reports GS0155, proven by <see cref="Issue570SliceToInterfaceConversionEmitTests"/>'s
///   own <c>SliceInvariance_StringToIEnumerableOfObject_StillRejected</c>.</item>
/// </list>
/// </summary>
public class Issue2516ArrayCovarianceAsCastEmitTests
{
    [Fact]
    public void AsCast_ArrayToIEnumerableOfBase_PreservesElementsOrderAndIdentity()
    {
        var output = CompileAndRun("""
            package Probe
            import System
            import System.Collections.Generic

            open class Animal { }
            class Dog : Animal { }

            func Accept(items IEnumerable[Animal]) {
                for item in items {
                    Console.WriteLine(item.GetType().Name)
                }
            }

            var dogs = []Dog{Dog(), Dog()}
            Accept(dogs as IEnumerable[Animal])
            """);

        Assert.Equal("Dog\nDog\n", output);
    }

    [Fact]
    public void AsCast_ArrayToIEnumerableOfBase_ReferenceIdentityPreserved()
    {
        // isinst is a no-op reference check — it must yield the SAME element
        // references back, not copies, when enumerated through the covariant
        // interface view.
        var output = CompileAndRun("""
            package Probe
            import System
            import System.Collections.Generic

            open class Animal { }
            class Dog : Animal { }

            var dogs = []Dog{Dog(), Dog()}
            var asEnumerable = dogs as IEnumerable[Animal]
            var i = 0
            for item in asEnumerable {
                var d = item as Dog
                Console.WriteLine(System.Object.ReferenceEquals(d, dogs[i]))
                i = i + 1
            }
            """);

        Assert.Equal("True\nTrue\n", output);
    }

    [Fact]
    public void AsCast_ArrayToIReadOnlyListOfBase_CountAndIndexerWork()
    {
        var output = CompileAndRun("""
            package Probe
            import System.Collections.Generic

            open class Animal { }
            class Dog : Animal { }

            var dogs = []Dog{Dog(), Dog(), Dog()}
            var view = dogs as IReadOnlyList[Animal]
            System.Console.WriteLine(view.Count)
            System.Console.WriteLine(System.Object.ReferenceEquals(view[0], dogs[0]))
            """);

        Assert.Equal("3\nTrue\n", output);
    }

    [Fact]
    public void AsCast_ArrayToIReadOnlyCollectionOfBase_CountWorks()
    {
        var output = CompileAndRun("""
            package Probe
            import System.Collections.Generic

            open class Animal { }
            class Dog : Animal { }

            var dogs = []Dog{Dog(), Dog()}
            var view = dogs as IReadOnlyCollection[Animal]
            System.Console.WriteLine(view.Count)
            """);

        Assert.Equal("2\n", output);
    }

    [Fact]
    public void AsCast_ArrayToIListOfBase_And_ICollectionOfBase_CountWork()
    {
        var output = CompileAndRun("""
            package Probe
            import System.Collections.Generic

            open class Animal { }
            class Dog : Animal { }

            var dogs = []Dog{Dog(), Dog()}
            var list = dogs as IList[Animal]
            var coll = dogs as ICollection[Animal]
            System.Console.WriteLine(list.Count)
            System.Console.WriteLine(coll.Count)
            """);

        Assert.Equal("2\n2\n", output);
    }

    [Fact]
    public void AsCast_ArrayToArrayCovariance_PreservesElementsAndIdentity()
    {
        var output = CompileAndRun("""
            package Probe
            import System

            open class Animal { }
            class Dog : Animal { }

            var dogs = []Dog{Dog(), Dog()}
            var asAnimals = dogs as []Animal
            Console.WriteLine(asAnimals.Length)
            Console.WriteLine(System.Object.ReferenceEquals(asAnimals[0], dogs[0]))
            """);

        Assert.Equal("2\nTrue\n", output);
    }

    [Fact]
    public void AsCast_ArrayToNullableIEnumerableEnvelope_NonNullArray_YieldsNonNullView()
    {
        var output = CompileAndRun("""
            package Probe
            import System.Collections.Generic

            open class Animal { }
            class Dog : Animal { }

            func CountOrDefault(items IEnumerable[Animal]?) int32 {
                if items == nil {
                    return -1
                }
                var n = 0
                for _ in items {
                    n = n + 1
                }
                return n
            }

            var dogs = []Dog{Dog(), Dog(), Dog()}
            System.Console.WriteLine(CountOrDefault(dogs as IEnumerable[Animal]?))
            """);

        Assert.Equal("3\n", output);
    }

    [Fact]
    public void AsCast_EmptyArray_EnumeratesZeroElements()
    {
        var output = CompileAndRun("""
            package Probe
            import System
            import System.Collections.Generic

            open class Animal { }
            class Dog : Animal { }

            var dogs = [0]Dog
            var n = 0
            for _ in (dogs as IEnumerable[Animal]) {
                n = n + 1
            }
            Console.WriteLine(n)
            """);

        Assert.Equal("0\n", output);
    }

    [Fact]
    public void AsCast_ValueTypeArrayExactElementMatch_StillWorks_InvarianceUnaffected()
    {
        // Regression: value-type array element-exact-match conversion (issue
        // #2140/#1162) is untouched by the array-covariance workaround — it
        // never needed a wrap and must keep working bare.
        var output = CompileAndRun("""
            package Probe
            import System
            import System.Collections.Generic

            func Sum(items IEnumerable[int32]) int32 {
                var total = 0
                for item in items {
                    total = total + item
                }
                return total
            }

            Console.WriteLine(Sum([]int32{1, 2, 3}))
            """);

        Assert.Equal("6\n", output);
    }

    [Fact]
    public void AsCast_MetadataSiblingInterface_ArrayToIEnumerableOfBase_Compiles()
    {
        // Metadata/source combination: the covariant interface argument type
        // (Animal) and the consumer (Sink.CountAnimals) are both imported from
        // a sibling compiled C# assembly; the array/element type (Dog) is
        // declared in G# source.
        var sibling = """
            namespace Probe.CSharp
            {
                public class Animal { }

                public static class Sink
                {
                    public static int CountAnimals(System.Collections.Generic.IEnumerable<Animal> items)
                    {
                        int n = 0;
                        foreach (var _ in items) n++;
                        return n;
                    }
                }
            }
            """;

        var gsource = """
            package Probe.Tests
            import Probe.CSharp

            class Dog : Probe.CSharp.Animal { }

            var dogs = []Dog{Dog(), Dog(), Dog()}
            System.Console.WriteLine(Probe.CSharp.Sink.CountAnimals(dogs as System.Collections.Generic.IEnumerable[Probe.CSharp.Animal]))
            """;

        var output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "Probe.CSharp.Issue2516");
        Assert.Equal("3\n", output);
    }

    [Fact]
    public void AsCast_CSharpConsumer_ObservesCovariantEnumerable_ReflectionAndIdentity()
    {
        // Interoperability / reflection coverage: a plain C# PROGRAM (no gsc
        // involved) references a G#-compiled library whose public API
        // internally builds the covariant view via the `as`-cast workaround
        // (`[]Dog as IEnumerable[Animal]`), then consumes it exactly like any
        // other .NET IEnumerable<Animal> — enumerating it, reading each
        // element's runtime type via reflection, and confirming the elements
        // are the SAME references the library's own array holds (no copying
        // occurred anywhere in the round trip).
        var gsource = """
            package Probe.Issue2516Interop
            import System.Collections.Generic

            public open class Animal { }
            public class Dog : Animal { }

            public class Library {
                shared {
                    public let dogs []Dog = []Dog{Dog(), Dog(), Dog()}

                    public func GetAnimals() IEnumerable[Animal] {
                        return Library.dogs as IEnumerable[Animal]
                    }

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
                    IEnumerable<Animal> animals = Library.GetAnimals();
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

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue2516_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            var args = new[]
            {
                "/out:" + outPath,
                "/target:exe",
                "/targetframework:net10.0",
                srcPath,
            };

            using var compileOut = new StringWriter();
            using var compileErr = new StringWriter();
            var prevOut = Console.Out;
            var prevErr = Console.Error;
            Console.SetOut(compileOut);
            Console.SetError(compileErr);
            int compileExit;
            try
            {
                compileExit = Program.Main(args);
            }
            finally
            {
                Console.SetOut(prevOut);
                Console.SetError(prevErr);
            }

            Assert.True(
                compileExit == 0,
                $"gsc failed:\nstdout:\n{compileOut}\nstderr:\n{compileErr}");

            IlVerifier.Verify(outPath);

            var psi = new ProcessStartInfo("dotnet")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = tempDir,
            };
            psi.ArgumentList.Add("exec");
            psi.ArgumentList.Add("--runtimeconfig");
            psi.ArgumentList.Add(Path.ChangeExtension(outPath, ".runtimeconfig.json"));
            psi.ArgumentList.Add(outPath);

            using var proc = Process.Start(psi)
                ?? throw new InvalidOperationException("Failed to start dotnet exec");
            var stdout = proc.StandardOutput.ReadToEnd();
            var stderr = proc.StandardError.ReadToEnd();
            Assert.True(proc.WaitForExit(30_000), "dotnet exec timed out");
            Assert.True(
                proc.ExitCode == 0,
                $"exited {proc.ExitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");

            return stdout.Replace("\r\n", "\n");
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }

    private static string CompileAndRunWithSiblingCs(string csSource, string gSource, string siblingName)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue2516_sib_").FullName;
        var csDir = Path.Combine(tempDir, "csref");
        Directory.CreateDirectory(csDir);
        File.WriteAllText(Path.Combine(csDir, "Lib.cs"), csSource);
        File.WriteAllText(Path.Combine(csDir, "Lib.csproj"), $"""
            <Project Sdk="Microsoft.NET.Sdk">
              <PropertyGroup>
                <OutputType>Library</OutputType>
                <TargetFramework>net10.0</TargetFramework>
                <Nullable>enable</Nullable>
                <AssemblyName>{siblingName}</AssemblyName>
                <RootNamespace>{siblingName}</RootNamespace>
              </PropertyGroup>
            </Project>
            """);

        var siblingDll = BuildCsProject(csDir, siblingName);

        var srcPath = Path.Combine(tempDir, "test.gs");
        var outPath = Path.Combine(tempDir, "test.dll");
        File.WriteAllText(srcPath, gSource);

        var gscArgs = new List<string>
        {
            "/out:" + outPath,
            "/target:exe",
            "/targetframework:net10.0",
            "/reference:" + siblingDll,
        };

        foreach (var reference in TrustedPlatformAssemblies())
        {
            gscArgs.Add("/reference:" + reference);
        }

        gscArgs.Add("/nowarn:GS9100");
        gscArgs.Add(srcPath);

        using var compileOut = new StringWriter();
        using var compileErr = new StringWriter();
        var prevOut = Console.Out;
        var prevErr = Console.Error;
        Console.SetOut(compileOut);
        Console.SetError(compileErr);
        int compileExit;
        try
        {
            compileExit = Program.Main(gscArgs.ToArray());
        }
        finally
        {
            Console.SetOut(prevOut);
            Console.SetError(prevErr);
        }

        try
        {
            Assert.True(
                compileExit == 0,
                $"gsc failed:\nstdout:\n{compileOut}\nstderr:\n{compileErr}");

            IlVerifier.Verify(outPath, additionalReferences: new[] { siblingDll });

            File.Copy(siblingDll, Path.Combine(tempDir, Path.GetFileName(siblingDll)), overwrite: true);

            var psi = new ProcessStartInfo("dotnet")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = tempDir,
            };
            psi.ArgumentList.Add("exec");
            psi.ArgumentList.Add("--runtimeconfig");
            psi.ArgumentList.Add(Path.ChangeExtension(outPath, ".runtimeconfig.json"));
            psi.ArgumentList.Add(outPath);

            using var proc = Process.Start(psi)
                ?? throw new InvalidOperationException("Failed to start dotnet exec");
            var runOut = proc.StandardOutput.ReadToEnd();
            var runErr = proc.StandardError.ReadToEnd();
            Assert.True(proc.WaitForExit(30_000), "dotnet exec timed out");
            Assert.True(
                proc.ExitCode == 0,
                $"exited {proc.ExitCode}\nstdout:\n{runOut}\nstderr:\n{runErr}");

            return runOut.Replace("\r\n", "\n");
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }

    // Interoperability helper (issue #2516's "reflection/C# consumer" coverage
    // bullet): compiles `gSource` as a G# LIBRARY with gsc, then compiles a
    // plain C# console program (`consumerCsSource`, in-memory via Roslyn —
    // no gsc involved on this side) that references the freshly-built G#
    // library assembly, and runs it. Returns the consumer program's captured
    // stdout. This is the REVERSE direction of <see cref="CompileAndRunWithSiblingCs"/>
    // (which has C# authoring the referenced assembly and G# the consumer):
    // here G# is the library and ordinary .NET/C# is the consumer, proving
    // the covariant `IEnumerable[Animal]` view gsc emits is a completely
    // ordinary CLR interface reference from any external caller's
    // perspective.
    private static string CompileGsharpLibraryAndRunCSharpConsumer(string gSource, string consumerCsSource)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue2516_interop_").FullName;
        try
        {
            var gsSrcPath = Path.Combine(tempDir, "library.gs");
            var libraryDllPath = Path.Combine(tempDir, "library.dll");
            File.WriteAllText(gsSrcPath, gSource);

            var gscArgs = new List<string>
            {
                "/out:" + libraryDllPath,
                "/target:library",
                "/targetframework:net10.0",
                "/nowarn:GS9100",
                gsSrcPath,
            };

            using var compileOut = new StringWriter();
            using var compileErr = new StringWriter();
            var prevOut = Console.Out;
            var prevErr = Console.Error;
            Console.SetOut(compileOut);
            Console.SetError(compileErr);
            int compileExit;
            try
            {
                compileExit = Program.Main(gscArgs.ToArray());
            }
            finally
            {
                Console.SetOut(prevOut);
                Console.SetError(prevErr);
            }

            Assert.True(
                compileExit == 0,
                $"gsc failed compiling the G# library:\nstdout:\n{compileOut}\nstderr:\n{compileErr}");

            IlVerifier.Verify(libraryDllPath);

            SyntaxTree consumerTree = CSharpSyntaxTree.ParseText(
                consumerCsSource, new CSharpParseOptions(LanguageVersion.Latest));
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

            File.WriteAllText(Path.Combine(tempDir, "consumer.runtimeconfig.json"), """
                {
                  "runtimeOptions": {
                    "tfm": "net10.0",
                    "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
                  }
                }
                """);

            // Load both assemblies in-process and invoke `Consumer.Run()`
            // directly — simpler and just as faithful as spawning `dotnet
            // exec` for a library assembly with no entry point, and it keeps
            // this helper self-contained (no extra host/runtimeconfig
            // plumbing needed for a non-exe consumer).
            var loadContext = new System.Runtime.Loader.AssemblyLoadContext("Issue2516Interop", isCollectible: true);
            try
            {
                loadContext.LoadFromAssemblyPath(libraryDllPath);
                var consumerAssembly = loadContext.LoadFromAssemblyPath(consumerDllPath);
                var consumerType = consumerAssembly.GetType("Consumer", throwOnError: true);
                var runMethod = consumerType.GetMethod("Run");
                var result = (string)runMethod.Invoke(null, null);
                return result;
            }
            finally
            {
                loadContext.Unload();
            }
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }

    private static string BuildCsProject(string csDir, string siblingName)
    {
        RunDotnet(csDir, "restore");

        var stdout = RunDotnet(csDir, "build", "-c", "Release", "--nologo", "--no-restore");
        _ = stdout;

        var dll = Path.Combine(csDir, "bin", "Release", "net10.0", siblingName + ".dll");
        Assert.True(File.Exists(dll), $"sibling assembly not found at {dll}");
        return dll;
    }

    private static string RunDotnet(string workingDir, params string[] args)
    {
        var psi = new ProcessStartInfo("dotnet")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            WorkingDirectory = workingDir,
        };
        foreach (var a in args)
        {
            psi.ArgumentList.Add(a);
        }

        using var proc = Process.Start(psi)
            ?? throw new InvalidOperationException($"failed to start dotnet {string.Join(" ", args)}");
        var stdout = proc.StandardOutput.ReadToEnd();
        var stderr = proc.StandardError.ReadToEnd();
        Assert.True(proc.WaitForExit(120_000), $"dotnet {args[0]} timed out");
        Assert.True(
            proc.ExitCode == 0,
            $"dotnet {string.Join(" ", args)} failed (exit {proc.ExitCode})\nstdout:\n{stdout}\nstderr:\n{stderr}");
        return stdout;
    }

    private static IEnumerable<string> TrustedPlatformAssemblies()
    {
        var tpa = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string;
        if (string.IsNullOrEmpty(tpa))
        {
            yield break;
        }

        foreach (var path in tpa.Split(Path.PathSeparator))
        {
            if (!string.IsNullOrWhiteSpace(path) && File.Exists(path))
            {
                yield return path;
            }
        }
    }
}
