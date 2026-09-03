// <copyright file="Adr0174SuspendCrossAssemblyTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;
using GSharp.Compiler;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace GSharp.Compiler.Tests;

/// <summary>
/// ADR-0174 D4 across an assembly boundary: a <c>suspend func</c> compiled
/// into a library is a <c>ValueTask&lt;R&gt;</c> method carrying
/// <c>[Suspending]</c>; a G# consumer reads that from metadata, sees the
/// logical <c>R</c>, awaits implicitly inside a suspending caller, and blocks
/// through the root bridge (GS0558) inside a plain function — with no analysis
/// of the library re-run.
/// </summary>
/// <remarks>
/// Discrimination witness (ADR-0154): a mutant that ignores the attribute on
/// import breaks <see cref="SuspendFunc_InALibrary_IsAwaitedImplicitly_ByAConsumer"/>
/// — the consumer then sees <c>ValueTask[int32]</c> where it expects
/// <c>int32</c> and fails to compile.
/// </remarks>
public class Adr0174SuspendCrossAssemblyTests
{
    private const string Library = """
        package Lib

        public suspend func take(ch chan[int32]) int32 {
            return <-ch
        }

        public suspend func put(ch chan[int32], v int32) {
            ch <- v
        }
        """;

    [Fact]
    public void SuspendFunc_InALibrary_IsAwaitedImplicitly_ByAConsumer()
    {
        var (exit, output, compileLog) = CompileAndRun("""
            package App
            import System
            import Lib

            suspend func twice(ch chan[int32]) int32 {
                return take(ch) + take(ch)
            }

            let ch = chan[int32](2)
            put(ch, 2)
            put(ch, 4)
            Console.WriteLine(twice(ch))
            """);

        Assert.True(exit == 0, compileLog);
        Assert.DoesNotContain("GS0558", compileLog);
        Assert.Equal("6", output.Trim());
    }

    [Fact]
    public void SuspendFunc_InALibrary_CalledFromAPlainFunction_IsInferred_NoWarning()
    {
        // A plain caller of an imported suspending function becomes suspending
        // by inference (D4), so no bridge and no GS0558 remain.
        var (exit, output, compileLog) = CompileAndRun("""
            package App
            import System
            import Lib

            func plain(ch chan[int32]) int32 {
                return take(ch) * 10
            }

            let ch = chan[int32](1)
            put(ch, 3)
            Console.WriteLine(plain(ch))
            """);

        Assert.True(exit == 0, compileLog);
        Assert.DoesNotContain("GS0558", compileLog);
        Assert.Equal("30", output.Trim());
    }

    [Fact]
    public void SuspendFunc_InALibrary_CalledFromAnOverridableMethod_BlocksAndWarns()
    {
        // An `open` method is an inference boundary: the call blocks through
        // the root bridge and GS0558 says so.
        var (exit, output, compileLog) = CompileAndRun("""
            package App
            import System
            import Lib

            open class Reader {
                open func Read(ch chan[int32]) int32 {
                    return take(ch) * 10
                }
            }

            let ch = chan[int32](1)
            put(ch, 3)
            Console.WriteLine(Reader().Read(ch))
            """);

        Assert.True(exit == 0, compileLog);
        Assert.Contains("GS0558", compileLog);
        Assert.Equal("30", output.Trim());
    }

    private const string ClassLibrary = """
        package Lib
        public class Reader {
            public func Take(ch in chan[int32]) int32 {
                return <-ch
            }

            public func Fill(ch out chan[int32], n int32) {
                for i in 1 ... n + 1 {
                    ch <- i
                }
            }
        }
        """;

    [Fact]
    public void HiddenContext_IsTheLastParameter_OptionalWithANullDefault()
    {
        // The ABI contract every foreign caller depends on: the context D7
        // threads is appended, not inserted, and it is optional — so a caller
        // written against the declared signature still binds.
        var tempDir = Directory.CreateTempSubdirectory("gs_0174_abi_").FullName;
        try
        {
            var libPath = Path.Combine(tempDir, "Lib.dll");
            var log = Compile(tempDir, "Lib.gs", ClassLibrary, libPath, "/target:library");
            Assert.True(File.Exists(libPath), "library compile failed:\n" + log);

            using var stream = File.OpenRead(libPath);
            using var peReader = new PEReader(stream);
            var metadata = peReader.GetMetadataReader();
            var take = metadata.MethodDefinitions
                .Select(metadata.GetMethodDefinition)
                .Single(m => metadata.GetString(m.Name) == "Take");

            var parameters = take.GetParameters().Select(metadata.GetParameter).OrderBy(p => p.SequenceNumber).ToList();
            var hidden = parameters[^1];
            Assert.Equal("<>ctx", metadata.GetString(hidden.Name));
            Assert.True(hidden.Attributes.HasFlag(System.Reflection.ParameterAttributes.Optional));
            Assert.True(hidden.Attributes.HasFlag(System.Reflection.ParameterAttributes.HasDefault));
            Assert.False(hidden.GetDefaultValue().IsNil);
        }
        finally
        {
            Directory.Delete(tempDir, recursive: true);
        }
    }

    [Fact]
    public void CSharpConsumer_CallsTheDeclaredSignature_AndMayPassAContext()
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_0174_csharp_").FullName;
        try
        {
            var libPath = Path.Combine(tempDir, "Lib.dll");
            var log = Compile(tempDir, "Lib.gs", ClassLibrary, libPath, "/target:library");
            Assert.True(File.Exists(libPath), "library compile failed:\n" + log);

            const string ConsumerSource = """
                using System;
                using System.Threading.Tasks;
                using Gsharp.Concurrency;
                using Lib;

                public static class Consumer
                {
                    public static async Task<int> Main()
                    {
                        var ch = new Chan<int>(4);
                        var reader = new Reader();

                        // Exactly the signatures the G# source declares: the
                        // hidden context is optional, so C# omits it.
                        await reader.Fill(ch, 3);
                        Console.WriteLine("first=" + await reader.Take(ch));

                        // ... and a C# caller that wants cancellation passes one.
                        using var ctx = Context.None.WithCancel();
                        Console.WriteLine("second=" + await reader.Take(ch, ctx));
                        return 0;
                    }
                }
                """;

            var references = TrustedPlatformAssemblies()
                .Concat(new[] { libPath, Path.Combine(tempDir, "Gsharp.Runtime.Channels.dll") })
                .Where(File.Exists)
                .Select(path => (MetadataReference)MetadataReference.CreateFromFile(path))
                .ToList();

            var compilation = CSharpCompilation.Create(
                "Consumer",
                new[] { CSharpSyntaxTree.ParseText(ConsumerSource) },
                references,
                new CSharpCompilationOptions(OutputKind.ConsoleApplication));

            var consumerPath = Path.Combine(tempDir, "Consumer.dll");
            var result = compilation.Emit(consumerPath);
            Assert.True(
                result.Success,
                "C# consumer must compile against the G# signatures:\n"
                    + string.Join("\n", result.Diagnostics.Where(d => d.Severity == DiagnosticSeverity.Error)));

            var runtimeConfig = "{\"runtimeOptions\":{\"tfm\":\"net10.0\",\"framework\":"
                + "{\"name\":\"Microsoft.NETCore.App\",\"version\":\"" + Environment.Version.ToString(3) + "\"}}}";
            File.WriteAllText(Path.Combine(tempDir, "Consumer.runtimeconfig.json"), runtimeConfig);

            var (exit, output) = RunDotnet(consumerPath);
            Assert.Equal(0, exit);
            Assert.Contains("first=1", output, StringComparison.Ordinal);
            Assert.Contains("second=2", output, StringComparison.Ordinal);
        }
        finally
        {
            Directory.Delete(tempDir, recursive: true);
        }
    }

    private static (int Exit, string Output, string CompileLog) CompileAndRun(string appSource)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_0174_xasm_").FullName;
        try
        {
            var libPath = Path.Combine(tempDir, "Lib.dll");
            var libLog = Compile(tempDir, "Lib.gs", Library, libPath, "/target:library");
            Assert.True(File.Exists(libPath), "library compile failed:\n" + libLog);

            var appPath = Path.Combine(tempDir, "App.dll");
            var appLog = Compile(tempDir, "App.gs", appSource, appPath, "/target:exe", "/reference:" + libPath);
            if (!File.Exists(appPath))
            {
                return (-1, string.Empty, appLog);
            }

            var (exit, output) = RunDotnet(appPath);
            return (exit, output, appLog);
        }
        finally
        {
            Directory.Delete(tempDir, recursive: true);
        }
    }

    private static string Compile(string dir, string fileName, string source, string outPath, params string[] extra)
    {
        var srcPath = Path.Combine(dir, fileName);
        File.WriteAllText(srcPath, source);
        var args = new List<string> { "/out:" + outPath, "/targetframework:net10.0" };
        args.AddRange(extra);
        foreach (var reference in TrustedPlatformAssemblies())
        {
            args.Add("/reference:" + reference);
        }

        args.Add(srcPath);

        using var compileOut = new StringWriter();
        using var compileErr = new StringWriter();
        var prevOut = Console.Out;
        var prevErr = Console.Error;
        Console.SetOut(compileOut);
        Console.SetError(compileErr);
        try
        {
            Program.Main(args.ToArray());
        }
        finally
        {
            Console.SetOut(prevOut);
            Console.SetError(prevErr);
        }

        return compileOut.ToString() + compileErr;
    }

    private static (int Exit, string Output) RunDotnet(string assemblyPath)
    {
        var psi = new ProcessStartInfo("dotnet", $"\"{assemblyPath}\"")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            WorkingDirectory = Path.GetDirectoryName(assemblyPath) ?? ".",
        };

        using var process = Process.Start(psi)
            ?? throw new InvalidOperationException("could not start dotnet");
        var output = new StringBuilder();
        output.Append(process.StandardOutput.ReadToEnd());
        output.Append(process.StandardError.ReadToEnd());
        process.WaitForExit();
        return (process.ExitCode, output.ToString());
    }

    private static IEnumerable<string> TrustedPlatformAssemblies()
    {
        var tpa = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string;
        if (string.IsNullOrEmpty(tpa))
        {
            return Enumerable.Empty<string>();
        }

        return tpa.Split(Path.PathSeparator).Where(File.Exists);
    }
}
