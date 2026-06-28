// <copyright file="Issue1341GenericMemberOrderTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1341: member lookup on a constructed-generic <em>user</em> type
/// <c>G[X]</c> must not depend on the order in which source files are presented
/// to the compiler. The using-file may legitimately precede the file that
/// declares the generic type <c>G</c> (the cs2gs pipeline topologically sorts by
/// base-class edges only), so a constructed instance can be materialized — and
/// cached — before the generic definition's body, and therefore its members,
/// has been bound. The constructed instance must still surface the definition's
/// methods, instance fields, and properties once they are bound.
/// </summary>
public class Issue1341GenericMemberOrderTests
{
    private const string BaseFile = """
        package q
        open class FrameFilterBase[TInput]() {
            var Value int32 = 0
            prop Count int32 { get { return Value } }
            open func SetCancellationToken(t int32) {}
            func Get() int32 { return Value }
        }
        """;

    private const string UserFile = """
        package r
        import q
        class User {
            func F(filter FrameFilterBase[int32]) int32 {
                filter.SetCancellationToken(0)
                return filter.Value + filter.Count + filter.Get()
            }
        }
        """;

    [Fact]
    public void MethodLookup_UserBeforeBase_Compiles()
    {
        // The regression: with the using-file first, the constructed
        // FrameFilterBase[int32] is materialized while binding User.F's
        // signature, before FrameFilterBase's body (and methods) are bound.
        var (exit, output) = CompileLibrary(
            ("u.gs", UserFile),
            ("b.gs", BaseFile));

        Assert.True(exit == 0, $"user-before-base compile failed ({exit}):\n{output}");
    }

    [Fact]
    public void MethodLookup_BaseBeforeUser_Compiles()
    {
        // The historically-working order, kept as a control.
        var (exit, output) = CompileLibrary(
            ("b.gs", BaseFile),
            ("u.gs", UserFile));

        Assert.True(exit == 0, $"base-before-user compile failed ({exit}):\n{output}");
    }

    [Fact]
    public void MemberLookup_UserBeforeBase_EmitsAndRuns()
    {
        // End-to-end: compile an executable in user-before-base order, verify
        // the IL, and run it. Confirms the constructed instance's method,
        // instance field, and property all bind and emit correctly regardless
        // of file order.
        var main = """
            package r
            import q
            import System

            func Run() int32 {
                var f = FrameFilterBase[int32]{ Value: 7 }
                f.SetCancellationToken(0)
                return f.Value + f.Count + f.Get()
            }

            Console.WriteLine(Run())
            """;

        // 7 (Value) + 7 (Count) + 7 (Get) == 21.
        Assert.Equal("21\n", CompileAndRunExe(("m.gs", main), ("b.gs", BaseFile)));
    }

    private static (int Exit, string Output) CompileLibrary(params (string Name, string Content)[] files)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue1341_lib_").FullName;
        try
        {
            var outPath = Path.Combine(tempDir, "out.dll");
            var args = new List<string>
            {
                "/out:" + outPath,
                "/target:library",
                "/targetframework:net10.0",
                "/nowarn:GS9100",
            };

            foreach (var (name, content) in files)
            {
                var path = Path.Combine(tempDir, name);
                File.WriteAllText(path, content);
                args.Add(path);
            }

            using var compileOut = new StringWriter();
            using var compileErr = new StringWriter();
            var prevOut = Console.Out;
            var prevErr = Console.Error;
            Console.SetOut(compileOut);
            Console.SetError(compileErr);
            int exit;
            try
            {
                exit = Program.Main(args.ToArray());
            }
            finally
            {
                Console.SetOut(prevOut);
                Console.SetError(prevErr);
            }

            return (exit, compileOut.ToString() + compileErr.ToString());
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }

    private static string CompileAndRunExe(params (string Name, string Content)[] files)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue1341_emit_").FullName;
        try
        {
            var outPath = Path.Combine(tempDir, "test.dll");
            var args = new List<string>
            {
                "/out:" + outPath,
                "/target:exe",
                "/targetframework:net10.0",
                "/nowarn:GS9100",
            };

            foreach (var (name, content) in files)
            {
                var path = Path.Combine(tempDir, name);
                File.WriteAllText(path, content);
                args.Add(path);
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

            Assert.True(compileExit == 0, $"compile failed ({compileExit}): {compileOut}{compileErr}");

            IlVerifier.Verify(outPath);

            var runtimeConfigPath = Path.ChangeExtension(outPath, "runtimeconfig.json");
            File.WriteAllText(runtimeConfigPath, """
                {
                  "runtimeOptions": {
                    "tfm": "net10.0",
                    "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
                  }
                }
                """);

            var psi = new ProcessStartInfo("dotnet", "exec \"" + outPath + "\"")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
            };
            using var proc = Process.Start(psi)!;
            string stdout = proc.StandardOutput.ReadToEnd();
            string stderr = proc.StandardError.ReadToEnd();
            proc.WaitForExit();
            if (proc.ExitCode != 0)
            {
                throw new Xunit.Sdk.XunitException("exited " + proc.ExitCode + "\nstdout:\n" + stdout + "\nstderr:\n" + stderr);
            }

            return stdout.Replace("\r\n", "\n");
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }
}
