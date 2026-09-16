// <copyright file="Issue4262NullableDelegateArgumentRuntimeTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests;

/// <summary>
/// Runtime-behavior regression for cs2gs issue #4262: a nullable-ENABLED
/// consumer project calling into a nullable-OBLIVIOUS sibling project it
/// references was getting a spurious <c>!!</c> on an intentionally-nullable
/// delegate ARGUMENT (see
/// <c>Cs2Gs.Tests.Issue4262CrossProjectObliviousDelegateArgumentTests</c> for
/// the translator-level fix and regression). These tests exercise the exact
/// runtime mechanism at stake — G#'s <c>!!</c> is not erased like C#'s
/// <c>!</c>, it is a real THROW-ON-NIL check — to confirm the fix's shape
/// (a bare, un-asserted delegate argument) genuinely runs to completion on a
/// legitimate <c>nil</c>, and that the bug's shape (the spurious <c>!!</c>)
/// genuinely crashes, not merely that either one compiles.
/// </summary>
public class Issue4262NullableDelegateArgumentRuntimeTests
{
    private const string ProgramSource = """
        package Issue4262Repro
        import System

        delegate ConvertDelegate(ctx int32);

        func Invoke(ctx int32, convertAction ConvertDelegate?) {
            if convertAction != nil {
                convertAction(ctx)
            }
        }

        func Main() {
            var convertAction ConvertDelegate? = nil
            Invoke(1, __ARG__)
            Console.WriteLine("ok")
        }
        """;

    [Fact]
    public void BareNullableDelegateArgument_NilFlowsThrough_RunsToCompletion()
    {
        // The FIXED cs2gs shape: the nullable local is passed bare into the
        // nullable-declared parameter, exactly as `TranslateArgumentValue`
        // now emits for a cross-project oblivious target proven to accept
        // nil. Must run to completion — the whole point of the fix is that
        // this legitimate nil no longer throws.
        string stdout = CompileAndRun(
            ProgramSource.Replace("__ARG__", "convertAction"), "issue4262bare");
        Assert.Equal($"ok{Environment.NewLine}", stdout);
    }

    [Fact]
    public void AssertedNullableDelegateArgument_NilFlowsThrough_ThrowsAtRuntime()
    {
        // Precision guard / severity proof: `!!` is a REAL runtime throw in
        // G# (unlike C#'s erased `!`), so the BUG's shape — the spurious
        // `!!` cs2gs used to emit here — genuinely crashes on the exact
        // legitimate nil the source passed, confirming this was a runtime
        // correctness bug and not a cosmetic one.
        CompileAndRunExpectingCrash(
            ProgramSource.Replace("__ARG__", "convertAction!!"), "issue4262asserted", "NullReferenceException");
    }

    private static string CompileAndRun(string source, string testName)
    {
        (int exitCode, string stdout, string stderr) = CompileAndExecute(source, testName);
        Assert.True(exitCode == 0, $"exited {exitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");
        return stdout;
    }

    private static void CompileAndRunExpectingCrash(string source, string testName, string expectedInStderr)
    {
        (int exitCode, string stdout, string stderr) = CompileAndExecute(source, testName);
        Assert.True(exitCode != 0, $"expected a runtime crash but exited 0\nstdout:\n{stdout}");
        Assert.Contains(expectedInStderr, stderr);
    }

    private static (int ExitCode, string Stdout, string Stderr) CompileAndExecute(string source, string testName)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_4262_" + testName + "_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var dllPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            var args = new[]
            {
                "/out:" + dllPath,
                "/target:exe",
                "/targetframework:net10.0",
                srcPath,
            };

            using var stdoutWriter = new StringWriter();
            using var stderrWriter = new StringWriter();
            var prevOut = Console.Out;
            var prevErr = Console.Error;
            Console.SetOut(stdoutWriter);
            Console.SetError(stderrWriter);
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
                $"gsc failed:\nstdout:\n{stdoutWriter}\nstderr:\n{stderrWriter}");

            var rtConfig = Path.ChangeExtension(dllPath, ".runtimeconfig.json");
            if (!File.Exists(rtConfig))
            {
                File.WriteAllText(rtConfig, """
                    {
                      "runtimeOptions": {
                        "tfm": "net10.0",
                        "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
                      }
                    }
                    """);
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
            psi.ArgumentList.Add(rtConfig);
            psi.ArgumentList.Add(dllPath);

            using var proc = Process.Start(psi)
                ?? throw new InvalidOperationException("Failed to start dotnet exec");
            var stdout = proc.StandardOutput.ReadToEnd();
            var stderr = proc.StandardError.ReadToEnd();
            Assert.True(proc.WaitForExit(30_000), "dotnet exec timed out");

            return (proc.ExitCode, stdout, stderr);
        }
        finally
        {
            try
            {
                Directory.Delete(tempDir, recursive: true);
            }
            catch (IOException)
            {
                // Best-effort cleanup; a concurrent agent sharing /tmp may
                // still hold a handle.
            }
        }
    }
}
