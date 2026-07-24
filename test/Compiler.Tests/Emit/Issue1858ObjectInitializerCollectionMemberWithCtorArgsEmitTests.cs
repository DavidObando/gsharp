// <copyright file="Issue1858ObjectInitializerCollectionMemberWithCtorArgsEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1858 — the construction-with-initializer-suffix form
/// (<c>Target(args) { Name = value, ... }</c>, gsc issue #522) now carries the
/// same target-less member collection-initializer carve-out already supported
/// by the colon struct-literal form (issue #1567): a braced member value
/// (<c>Items = { 1, 2 }</c>) populates a get-only collection member via
/// <c>Add(...)</c> calls, composing with constructor arguments AND ordinary
/// scalar members in the same construct. This closes the cs2gs-reported gap
/// where <c>new Foo(x) { Items = { a, b }, Bar = 2 }</c> had no canonical G#
/// form (see <c>Cs2Gs.Tests.Issue1858ObjectInitializerCtorArgsPlusCollectionMemberTranslationTests</c>
/// for the translator-fidelity side). This file proves the emitted form is
/// not just syntactically valid but semantically correct at runtime.
/// </summary>
public class Issue1858ObjectInitializerCollectionMemberWithCtorArgsEmitTests
{
    [Fact]
    public void CtorArgPlusCollectionMemberPlusScalarMember_PopulatesAll()
    {
        const string source = """
            package i1858mixed
            import System
            import System.Collections.Generic

            class Foo {
                prop X int32 { get; init; }
                prop Bar int32 { get; set; }
                prop Items IList[int32] { get; init; }
                init(x int32) {
                    X = x
                    Items = List[int32]()
                }
            }

            func Main() {
                let f = Foo(10) { Items = { 1, 2 }, Bar = 3 }
                System.Console.WriteLine(f.X)
                System.Console.WriteLine(f.Bar)
                System.Console.WriteLine(f.Items.Count)
                System.Console.WriteLine(f.Items[0])
                System.Console.WriteLine(f.Items[1])
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("10\n3\n2\n1\n2\n", output);
    }

    [Fact]
    public void CtorArgPlusOnlyCollectionMember_PopulatesCollection()
    {
        const string source = """
            package i1858onlycoll
            import System
            import System.Collections.Generic

            class Foo {
                prop X int32 { get; init; }
                prop Items IList[int32] { get; init; }
                init(x int32) {
                    X = x
                    Items = List[int32]()
                }
            }

            func Main() {
                let f = Foo(7) { Items = { 42 } }
                System.Console.WriteLine(f.X)
                System.Console.WriteLine(f.Items.Count)
                System.Console.WriteLine(f.Items[0])
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("7\n1\n42\n", output);
    }

    [Fact]
    public void CtorArgPlusNestedObjectMember_PopulatesExistingObject()
    {
        const string source = """
            package i1858nestedobject
            import System

            class Profile {
                prop Width int32 { get; set; }
                prop Height int32 { get; set; }
            }

            class Foo {
                prop X int32 { get; init; }
                prop Profile Profile { get; init; }
                init(x int32) {
                    X = x
                    Profile = Profile()
                }
            }

            func Main() {
                let f = Foo(7) { Profile = { Width = 80, Height = 30 } }
                System.Console.WriteLine(f.X)
                System.Console.WriteLine(f.Profile.Width)
                System.Console.WriteLine(f.Profile.Height)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("7\n80\n30\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_1858_exe_").FullName;
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

            IlVerifier.Verify(dllPath);

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
}
