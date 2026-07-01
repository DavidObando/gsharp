// <copyright file="Issue1535NullCompareReferenceTypesEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1535 — gsc did not define <c>== nil</c> / <c>!= nil</c> for several
/// reference-typed shapes (arrays / slices, user classes, user and imported
/// interfaces, <c>object</c>, imported reference types), reporting GS0129 even
/// though the comparison was already allowed for nullable wrappers, function
/// types, delegates, and sequences. C# permits <c>x == null</c> for any
/// reference or array type. <see cref="GSharp.Core.CodeAnalysis.Binding"/>'s
/// <c>IsNullCompare</c> now returns true for any reference-shaped type
/// (structural shapes plus any type whose CLR representation is a managed
/// reference), while value types (<c>int32</c>, user <c>struct</c>,
/// <c>DateTime</c>, enums) still reject the comparison.
/// <para>
/// Each case obtains a genuine <c>nil</c> value through a <c>List[T]</c> whose
/// indexer returns the NON-nullable element type <c>T</c>, so the comparison is
/// bound through the newly-enabled reference path (it would not compile on
/// current main). Every case is ilverify-clean (emit falls through to the
/// generic <c>ldnull; ceq</c> path) and evaluated at runtime for both a
/// non-null and a null element with both <c>==</c> and <c>!=</c>. Each test
/// uses a UNIQUE package/type name.
/// </para>
/// </summary>
public class Issue1535NullCompareReferenceTypesEmitTests
{
    [Fact]
    public void EndToEnd_SliceReference_NullAndNonNull_Runs()
    {
        const string source = """
            package i1535slice
            import System
            import System.Collections.Generic

            func Main() {
                var xs = List[[]int32]()
                xs.Add([]int32{1, 2})
                xs.Add(nil)
                Console.WriteLine(xs[0] == nil)
                Console.WriteLine(xs[0] != nil)
                Console.WriteLine(xs[1] == nil)
                Console.WriteLine(xs[1] != nil)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("False\nTrue\nTrue\nFalse\n", output);
    }

    [Fact]
    public void EndToEnd_NullableElementSlice_NullAndNonNull_Runs()
    {
        const string source = """
            package i1535nelemslice
            import System
            import System.Collections.Generic

            func Main() {
                var xs = List[[]int32?]()
                xs.Add([]int32?{1, 2})
                xs.Add(nil)
                Console.WriteLine(xs[0] == nil)
                Console.WriteLine(xs[0] != nil)
                Console.WriteLine(xs[1] == nil)
                Console.WriteLine(xs[1] != nil)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("False\nTrue\nTrue\nFalse\n", output);
    }

    [Fact]
    public void EndToEnd_UserClassReference_NullAndNonNull_Runs()
    {
        const string source = """
            package i1535class
            import System
            import System.Collections.Generic

            class K1535 { }

            func Main() {
                var xs = List[K1535]()
                xs.Add(K1535())
                xs.Add(nil)
                Console.WriteLine(xs[0] == nil)
                Console.WriteLine(xs[0] != nil)
                Console.WriteLine(xs[1] == nil)
                Console.WriteLine(xs[1] != nil)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("False\nTrue\nTrue\nFalse\n", output);
    }

    [Fact]
    public void EndToEnd_UserInterfaceReference_NullAndNonNull_Runs()
    {
        const string source = """
            package i1535iface
            import System
            import System.Collections.Generic

            interface IShape1535 { }
            class Square1535 : IShape1535 { }

            func Main() {
                var xs = List[IShape1535]()
                xs.Add(Square1535())
                xs.Add(nil)
                Console.WriteLine(xs[0] == nil)
                Console.WriteLine(xs[0] != nil)
                Console.WriteLine(xs[1] == nil)
                Console.WriteLine(xs[1] != nil)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("False\nTrue\nTrue\nFalse\n", output);
    }

    [Fact]
    public void EndToEnd_ImportedInterfaceReference_NullAndNonNull_Runs()
    {
        const string source = """
            package i1535seq
            import System
            import System.Collections.Generic

            func Main() {
                var xs = List[IEnumerable[int32]]()
                xs.Add(List[int32]())
                xs.Add(nil)
                Console.WriteLine(xs[0] == nil)
                Console.WriteLine(xs[0] != nil)
                Console.WriteLine(xs[1] == nil)
                Console.WriteLine(xs[1] != nil)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("False\nTrue\nTrue\nFalse\n", output);
    }

    [Fact]
    public void EndToEnd_ObjectReference_NullAndNonNull_Runs()
    {
        const string source = """
            package i1535object
            import System
            import System.Collections.Generic

            func Main() {
                var xs = List[object]()
                xs.Add("hi")
                xs.Add(nil)
                Console.WriteLine(xs[0] == nil)
                Console.WriteLine(xs[0] != nil)
                Console.WriteLine(xs[1] == nil)
                Console.WriteLine(xs[1] != nil)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("False\nTrue\nTrue\nFalse\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_1535_exe_").FullName;
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
