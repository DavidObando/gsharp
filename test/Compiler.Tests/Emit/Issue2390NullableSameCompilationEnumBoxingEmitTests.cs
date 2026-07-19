// <copyright file="Issue2390NullableSameCompilationEnumBoxingEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Runtime.Loader;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #2390: a nullable value type whose underlying enum is emitted in the
/// same compilation has the CLR shape <c>Nullable&lt;E&gt;</c>, even though
/// neither the enum nor the constructed nullable has a reflection
/// <see cref="Type"/> during binding. Boxing conversion classification must
/// preserve that effective value-type shape, and emission must consume the
/// existing symbolic <c>Nullable&lt;E&gt;</c> TypeSpec token rather than the
/// underlying enum token.
/// </summary>
public class Issue2390NullableSameCompilationEnumBoxingEmitTests
{
    [Fact]
    public void DirectCallReturnObjectAndInterfaceConversions_RunAndVerify()
    {
        const string source = """
            package i2390
            import System

            enum Color2390 { Red, Green, Blue }
            struct Point2390(X int32) { }

            interface ISource2390[T struct] {
                func Find() T?;
            }

            class Source2390 : ISource2390[Color2390] {
                func Find() Color2390? -> Color2390.Blue
            }

            func Identity(value object) object -> value
            func ReturnObject(value Color2390?) object -> value
            func ReturnComparable(value Color2390?) IComparable -> value

            func main() {
                let present Color2390? = Color2390.Green
                let missing Color2390? = nil
                let point Point2390? = Point2390(7)

                let direct object = present
                Console.WriteLine(direct.GetType().Name)
                let boxedPoint object = point
                Console.WriteLine(boxedPoint.GetType().Name)
                Console.WriteLine(Identity(present).GetType().Name)
                Console.WriteLine(ReturnObject(present).GetType().Name)
                Console.WriteLine(ReturnObject(missing))
                Console.WriteLine(ReturnComparable(present).CompareTo(Color2390.Green))

                let source ISource2390[Color2390] = Source2390{}
                Console.WriteLine(source.Find())
            }

            main()
            """;

        Assert.Equal(
            "Color2390\nPoint2390\nColor2390\nColor2390\n\n0\nBlue\n",
            CompileAndRun(source));
    }

    [Fact]
    public void ImportedGenericInterfaceCall_NullableEnumReturn_BoxesAndVerifies()
    {
        const string csSource = """
            namespace Issue2390Ref;

            public interface ISource<T>
                where T : struct
            {
                T? Find();
            }
            """;

        const string source = """
            package i2390imported
            import System
            import Issue2390Ref

            enum Color2390Imported { Red, Green, Blue }

            class Source2390Imported : ISource[Color2390Imported] {
                func Find() Color2390Imported? -> Color2390Imported.Blue
            }

            func main() {
                let source ISource[Color2390Imported] = Source2390Imported{}
                Console.WriteLine(source.Find())
            }

            main()
            """;

        var reference = CompileCsReference(csSource, "Issue2390Ref");
        try
        {
            Assert.Equal("Blue\n", CompileAndRun(source, reference));
        }
        finally
        {
            TryDeleteDirectory(Path.GetDirectoryName(reference));
        }
    }

    [Fact]
    public void ReflectionInvoke_BoxMethod_PreservesNullableBoxingSemantics()
    {
        const string source = """
            package i2390reflection

            enum Color2390Reflection { Red, Green, Blue }

            class Boxer2390 {
                func Box(value Color2390Reflection?) object -> value
            }
            """;

        var dllPath = CompileLibrary(source);
        var loadContext = new AssemblyLoadContext("Issue2390Reflection", isCollectible: true);
        try
        {
            var assembly = loadContext.LoadFromAssemblyPath(dllPath);
            var colorType = assembly.GetType("i2390reflection.Color2390Reflection")
                ?? throw new InvalidOperationException("Color2390Reflection type not found.");
            var boxerType = assembly.GetType("i2390reflection.Boxer2390")
                ?? throw new InvalidOperationException("Boxer2390 type not found.");
            var box = boxerType.GetMethod("Box", BindingFlags.Public | BindingFlags.Instance)
                ?? throw new InvalidOperationException("Box method not found.");
            var boxer = Activator.CreateInstance(boxerType)
                ?? throw new InvalidOperationException("Could not create Boxer2390.");

            var green = Enum.ToObject(colorType, 1);
            var boxed = box.Invoke(boxer, new[] { green });
            Assert.NotNull(boxed);
            Assert.Equal(colorType, boxed.GetType());
            Assert.Equal("Green", boxed.ToString());
            Assert.Null(box.Invoke(boxer, new object[] { null }));
        }
        finally
        {
            loadContext.Unload();
            TryDeleteDirectory(Path.GetDirectoryName(dllPath));
        }
    }

    private static string CompileAndRun(string source, string additionalReference = null)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_2390_exe_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var dllPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            var args = new List<string>
            {
                "/out:" + dllPath,
                "/target:exe",
                "/targetframework:net10.0",
            };
            if (additionalReference != null)
            {
                args.Add("/reference:" + additionalReference);
            }

            args.Add(srcPath);
            Compile(args);

            IlVerifier.Verify(
                dllPath,
                additionalReferences: additionalReference == null ? null : new[] { additionalReference });

            if (additionalReference != null)
            {
                File.Copy(additionalReference, Path.Combine(tempDir, Path.GetFileName(additionalReference)), overwrite: true);
            }

            var psi = new ProcessStartInfo("dotnet")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = tempDir,
            };
            psi.ArgumentList.Add("exec");
            psi.ArgumentList.Add("--runtimeconfig");
            psi.ArgumentList.Add(Path.ChangeExtension(dllPath, ".runtimeconfig.json"));
            psi.ArgumentList.Add(dllPath);

            using var process = Process.Start(psi)
                ?? throw new InvalidOperationException("Failed to start dotnet exec.");
            var stdout = process.StandardOutput.ReadToEnd();
            var stderr = process.StandardError.ReadToEnd();
            Assert.True(process.WaitForExit(30_000), "dotnet exec timed out.");
            Assert.True(
                process.ExitCode == 0,
                $"exited {process.ExitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");

            return stdout.Replace("\r\n", "\n");
        }
        finally
        {
            TryDeleteDirectory(tempDir);
        }
    }

    private static string CompileLibrary(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_2390_lib_").FullName;
        var srcPath = Path.Combine(tempDir, "test.gs");
        var dllPath = Path.Combine(tempDir, "test.dll");
        File.WriteAllText(srcPath, source);
        Compile(new List<string>
        {
            "/out:" + dllPath,
            "/target:library",
            "/targetframework:net10.0",
            srcPath,
        });
        IlVerifier.Verify(dllPath);
        return dllPath;
    }

    private static void Compile(List<string> args)
    {
        using var stdoutWriter = new StringWriter();
        using var stderrWriter = new StringWriter();
        var prevOut = Console.Out;
        var prevErr = Console.Error;
        Console.SetOut(stdoutWriter);
        Console.SetError(stderrWriter);
        int compileExit;
        try
        {
            compileExit = Program.Main(args.ToArray());
        }
        finally
        {
            Console.SetOut(prevOut);
            Console.SetError(prevErr);
        }

        Assert.True(
            compileExit == 0,
            $"gsc failed:\nstdout:\n{stdoutWriter}\nstderr:\n{stderrWriter}");
    }

    private static string CompileCsReference(string source, string assemblyName)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_2390_ref_").FullName;
        File.WriteAllText(Path.Combine(tempDir, "Lib.cs"), source);
        File.WriteAllText(Path.Combine(tempDir, "Lib.csproj"), $"""
            <Project Sdk="Microsoft.NET.Sdk">
              <PropertyGroup>
                <TargetFramework>net10.0</TargetFramework>
                <AssemblyName>{assemblyName}</AssemblyName>
              </PropertyGroup>
            </Project>
            """);

        RunDotnet(tempDir, "restore");
        RunDotnet(tempDir, "build", "-c", "Release", "--nologo", "--no-restore");

        var dllPath = Path.Combine(tempDir, "bin", "Release", "net10.0", assemblyName + ".dll");
        Assert.True(File.Exists(dllPath), $"Reference assembly not found at {dllPath}.");
        return dllPath;
    }

    private static void RunDotnet(string workingDirectory, params string[] args)
    {
        var psi = new ProcessStartInfo("dotnet")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            WorkingDirectory = workingDirectory,
        };
        foreach (var arg in args)
        {
            psi.ArgumentList.Add(arg);
        }

        using var process = Process.Start(psi)
            ?? throw new InvalidOperationException($"Failed to start dotnet {string.Join(" ", args)}.");
        var stdout = process.StandardOutput.ReadToEnd();
        var stderr = process.StandardError.ReadToEnd();
        Assert.True(process.WaitForExit(120_000), $"dotnet {args[0]} timed out.");
        Assert.True(
            process.ExitCode == 0,
            $"dotnet {string.Join(" ", args)} failed ({process.ExitCode}).\nstdout:\n{stdout}\nstderr:\n{stderr}");
    }

    private static void TryDeleteDirectory(string directory)
    {
        try
        {
            if (directory != null && Directory.Exists(directory))
            {
                Directory.Delete(directory, recursive: true);
            }
        }
        catch
        {
        }
    }
}
