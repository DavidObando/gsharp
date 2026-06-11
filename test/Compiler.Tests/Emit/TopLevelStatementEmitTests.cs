// <copyright file="TopLevelStatementEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// End-to-end emit coverage for the top-level statement (TLS) mechanics
/// codified by ADR-0066. The single-file test exercises the basic
/// synthesized-entry-point path (rules §1 and §3); the multi-file test
/// exercises rule §1 (multiple files in the same package may both
/// contribute TLS) and rule §2 (the binder concatenates per-file TLS in
/// the order the compilation receives the syntax trees).
/// </summary>
public class TopLevelStatementEmitTests
{
    [Fact]
    public void SingleFile_TopLevel_Statements_Emit_And_Run()
    {
        var source = """
            package TopLevelSingle
            import System

            Console.WriteLine("tls-single-file-marker")
            """;

        var result = CompileAndRun(("Program.gs", source));

        Assert.Equal("tls-single-file-marker\n", result.Stdout);

        // ADR-0066 §3: the synthesized entry-point method must be named
        // <Main>$ on the emitted assembly.
        Assert.Contains("<Main>$", result.MethodNames);
    }

    [Fact]
    public void TwoFiles_SamePackage_TopLevel_Statements_Concatenate_In_Path_Sorted_Order()
    {
        // ADR-0066 §1: multiple .gs files in the same package may each
        // contribute TLS. ADR-0066 §2 / D7: the binder sorts contributing
        // files by source path (ordinal) before concatenating, so cross-
        // file TLS ordering is identical regardless of how the build tool
        // populated @(Compile) or how callers permute the input order.
        // Pass files in REVERSED name order to prove the sort is what
        // chooses the output, not the caller's argument order.
        var fileA = """
            package TopLevelMulti
            import System

            Console.WriteLine("first")
            """;

        var fileB = """
            package TopLevelMulti
            import System

            Console.WriteLine("second")
            """;

        var result = CompileAndRun(("B.gs", fileB), ("A.gs", fileA));

        Assert.Equal("first\nsecond\n", result.Stdout);
    }

    [Fact]
    public void Library_With_TLS_Fails_Compilation_With_GS0285()
    {
        // ADR-0066 deferred decision D4 (mirrors C# CS8805): top-level
        // statements in a library compilation are a hard error. The driver
        // must surface GS0285 on stderr and exit non-zero so the SDK build
        // fails rather than silently emitting a never-invoked <Main>$ into
        // the .dll.
        var source = """
            package TopLevelLibrary
            import System

            Console.WriteLine("should-never-run")
            """;

        var result = CompileForLibrary(("Program.gs", source));

        Assert.NotEqual(0, result.ExitCode);
        Assert.Contains("GS0285", result.Stderr + result.Stdout);
    }

    private static CompileResult CompileAndRun(params (string FileName, string Source)[] files)
    {
        var compile = Compile(target: "exe", files);
        Assert.True(
            compile.ExitCode == 0,
            $"gsc failed:\nstdout:\n{compile.Stdout}\nstderr:\n{compile.Stderr}");
        IlVerifier.Verify(compile.OutPath);

        var methodNames = ReadMethodNames(compile.OutPath);

        var psi = new ProcessStartInfo("dotnet")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            WorkingDirectory = compile.TempDir,
        };
        psi.ArgumentList.Add("exec");
        psi.ArgumentList.Add("--runtimeconfig");
        psi.ArgumentList.Add(Path.ChangeExtension(compile.OutPath, ".runtimeconfig.json"));
        psi.ArgumentList.Add(compile.OutPath);

        try
        {
            using var proc = Process.Start(psi);
            var stdout = proc.StandardOutput.ReadToEnd();
            var stderr = proc.StandardError.ReadToEnd();
            Assert.True(proc.WaitForExit(30_000), "dotnet exec timed out");
            Assert.True(
                proc.ExitCode == 0,
                $"exited {proc.ExitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");

            return new CompileResult(stdout.Replace("\r\n", "\n"), methodNames);
        }
        finally
        {
            try { Directory.Delete(compile.TempDir, recursive: true); } catch { }
        }
    }

    private static CompileExecutionResult CompileForLibrary(params (string FileName, string Source)[] files)
    {
        var compile = Compile(target: "library", files);
        try
        {
            return new CompileExecutionResult(compile.ExitCode, compile.Stdout, compile.Stderr);
        }
        finally
        {
            try { Directory.Delete(compile.TempDir, recursive: true); } catch { }
        }
    }

    private static CompileInvocation Compile(string target, (string FileName, string Source)[] files)
    {
        Assert.NotEmpty(files);

        var tempDir = Directory.CreateTempSubdirectory("gs_tls_emit_").FullName;
        var outPath = Path.Combine(tempDir, "test.dll");
        var args = new List<string>
        {
            "/out:" + outPath,
            "/target:" + target,
            "/targetframework:net10.0",
        };

        foreach (var (fileName, source) in files)
        {
            var srcPath = Path.Combine(tempDir, fileName);
            File.WriteAllText(srcPath, source);
            args.Add(srcPath);
        }

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

        return new CompileInvocation(tempDir, outPath, compileExit, compileOut.ToString(), compileErr.ToString());
    }

    private static List<string> ReadMethodNames(string assemblyPath)
    {
        using var stream = File.OpenRead(assemblyPath);
        using var peReader = new PEReader(stream);
        var reader = peReader.GetMetadataReader();
        var names = new List<string>();
        foreach (var handle in reader.MethodDefinitions)
        {
            var method = reader.GetMethodDefinition(handle);
            names.Add(reader.GetString(method.Name));
        }

        return names;
    }

    private sealed record CompileResult(string Stdout, IReadOnlyList<string> MethodNames);

    private sealed record CompileExecutionResult(int ExitCode, string Stdout, string Stderr);

    private sealed record CompileInvocation(string TempDir, string OutPath, int ExitCode, string Stdout, string Stderr);
}
