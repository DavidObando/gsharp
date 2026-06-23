// <copyright file="Issue989GenericAutoPropertyEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using GSharp.Compiler.Tests;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #989 regression tests: a generic auto-property (or computed property)
/// whose type mentions the declaring class's type parameter must resolve on a
/// constructed instance with the type argument substituted — exactly like a
/// generic field already did. Previously a read of <c>b.Value</c> where
/// <c>b : Box[int32]</c> reported <c>GS0158</c> "Cannot find member Value"
/// because <see cref="GSharp.Core.CodeAnalysis.Symbols.StructSymbol"/>
/// construction substituted fields but never carried the property table across.
///
/// The tests compile hermetic programs with <c>gsc</c> in-process, IL-verify
/// the produced assembly, and execute it to confirm the substituted accessors
/// round-trip a value at runtime.
/// </summary>
public class Issue989GenericAutoPropertyEmitTests
{
    [Fact]
    public void GenericAutoProperty_ReadOnConstructedType_Compiles()
    {
        // The original repro: reading a generic auto-property on a constructed
        // type must bind (no GS0158) and the access reports the substituted
        // type so it can be returned as int32.
        var source = """
            package T

            class Box[T] {
                prop Value T { get; set; }
            }

            func test(b Box[int32]) int32 {
                return b.Value
            }

            let bx = Box[int32]()
            bx.Value = 5
            System.Console.WriteLine(test(bx).ToString())
            """;

        Assert.Equal("5\n", CompileAndRun(source));
    }

    [Fact]
    public void GenericAutoProperty_WriteThenRead_RoundTripsAtRuntime()
    {
        // End-to-end: write then read a generic auto-property on a constructed
        // type and observe the stored value at runtime.
        var source = """
            package T
            import System

            class Box[T](Value T) {
                prop Stored T { get; set; }
            }

            let b = Box[int32](0)
            b.Stored = 42
            Console.WriteLine(b.Stored.ToString())
            """;

        Assert.Equal("42\n", CompileAndRun(source));
    }

    [Fact]
    public void GenericProperty_ConstructedOverTypeParameter_ResolvesSubstituted()
    {
        // A property whose type is constructed over the class type parameter
        // ([]T) resolves to []int32 on Box[int32] and round-trips. (List[T] is
        // the same shape but currently hits a separate, pre-existing CLR
        // closed-generic substitution gap that also affects fields, so the
        // slice form is used here to isolate the #989 property-substitution
        // behavior.)
        var source = """
            package T
            import System

            class Box[T] {
                prop Items []T { get; set; }
            }

            let b = Box[int32]()
            let arr = []int32{7, 35}
            b.Items = arr
            Console.WriteLine((b.Items[0] + b.Items[1]).ToString())
            """;

        Assert.Equal("42\n", CompileAndRun(source));
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue989_").FullName;
        try
        {
            var outPath = Path.Combine(tempDir, "test.dll");
            var (exit, output) = Compile(source, outPath, tempDir);
            Assert.True(exit == 0, $"gsc failed: {output}");

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
            TryDeleteDirectory(tempDir);
        }
    }

    private static (int Exit, string Output) Compile(string source, string outPath, string tempDir)
    {
        var srcPath = Path.Combine(tempDir, "test.gs");
        File.WriteAllText(srcPath, source);

        var args = new List<string>
        {
            "/out:" + outPath,
            "/target:exe",
            "/targetframework:net10.0",
            "/nowarn:GS9100",
        };

        foreach (var bcl in BclReferences.Value)
        {
            args.Add("/r:" + bcl);
        }

        args.Add(srcPath);

        using var compileOut = new StringWriter();
        using var compileErr = new StringWriter();
        var prevOut = Console.Out;
        var prevErr = Console.Error;
        Console.SetOut(compileOut);
        Console.SetError(compileErr);
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

        return (compileExit, $"stdout:\n{compileOut}\nstderr:\n{compileErr}");
    }

    private static void TryDeleteDirectory(string dir)
    {
        try
        {
            Directory.Delete(dir, recursive: true);
        }
        catch
        {
            // Best-effort cleanup; the OS reclaims scratch directories later.
        }
    }

    private static readonly Lazy<IReadOnlyList<string>> BclReferences = new(() =>
    {
        var runtimeDir = Path.GetDirectoryName(typeof(object).Assembly.Location);
        if (string.IsNullOrEmpty(runtimeDir) || !Directory.Exists(runtimeDir))
        {
            return Array.Empty<string>();
        }

        return Directory.EnumerateFiles(runtimeDir, "*.dll", SearchOption.TopDirectoryOnly)
            .Where(p =>
            {
                var name = Path.GetFileName(p);
                return name.StartsWith("System.", StringComparison.OrdinalIgnoreCase)
                    || string.Equals(name, "mscorlib.dll", StringComparison.OrdinalIgnoreCase)
                    || string.Equals(name, "netstandard.dll", StringComparison.OrdinalIgnoreCase);
            })
            .ToList();
    });
}
