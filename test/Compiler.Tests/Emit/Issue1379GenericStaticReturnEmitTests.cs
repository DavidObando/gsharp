// <copyright file="Issue1379GenericStaticReturnEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1379: a <c>shared</c> (static) method on a user-defined generic type
/// whose return type references the type's own type parameter
/// (<c>func Make() Box[T]</c>) must have the receiver's type argument
/// substituted at the call site, so <c>Box[int32].Make()</c> is typed
/// <c>Box[int32]</c> rather than the raw/open <c>Box</c> (which fails the
/// conversion to the closed construction, GS0155). These end-to-end tests lock
/// the parse -> bind -> emit -> verify -> execute chain for the substituted
/// static return (and parameter) types.
/// </summary>
public class Issue1379GenericStaticReturnEmitTests
{
    [Fact]
    public void StaticReturnReferencingT_VerifiesAndExecutes()
    {
        // `Box[int32].Make(5)` returns `Box[int32]`; read its T-typed field.
        var source = """
            package P
            import System
            struct Box[T] {
                var V T
                shared { func Make(v T) Box[T] -> Box[T]{ V: v } }
            }
            var b = Box[int32].Make(5)
            Console.WriteLine(b.V)
            """;

        Assert.Equal("5\n", CompileVerifyAndRun(source));
    }

    [Fact]
    public void StaticReturnReferencingT_StringTypeArg_VerifiesAndExecutes()
    {
        // The substituted return type is independent of the element's
        // value/reference kind (`Box[string]`).
        var source = """
            package P
            import System
            struct Box[T] {
                var V T
                shared { func Make(v T) Box[T] -> Box[T]{ V: v } }
            }
            var b = Box[string].Make("hi")
            Console.WriteLine(b.V)
            """;

        Assert.Equal("hi\n", CompileVerifyAndRun(source));
    }

    [Fact]
    public void StaticReturnNotReferencingT_StillVerifiesAndExecutes()
    {
        // Control: a static method whose return type does NOT reference T keeps
        // emitting and executing unchanged.
        var source = """
            package P
            import System
            struct Box[T] { shared { func Make() int32 -> 41 } }
            Console.WriteLine(Box[int32].Make() + 1)
            """;

        Assert.Equal("42\n", CompileVerifyAndRun(source));
    }

    private static string CompileVerifyAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue1379_emit_").FullName;
        try
        {
            var outPath = CompileToDll(tempDir, source, "/target:exe");
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

    private static string CompileToDll(string tempDir, string source, string target)
    {
        var srcPath = Path.Combine(tempDir, "test.gs");
        var outPath = Path.Combine(tempDir, "test.dll");
        File.WriteAllText(srcPath, source);

        var runtimeDir = Path.GetDirectoryName(typeof(object).Assembly.Location)!;
        var args = new List<string>
        {
            "/out:" + outPath,
            target,
            "/targetframework:net10.0",
            "/lib:" + runtimeDir,
        };
        foreach (var refName in new[]
        {
            "System.Runtime.dll",
            "System.Private.CoreLib.dll",
            "System.Console.dll",
        })
        {
            args.Add("/reference:" + Path.Combine(runtimeDir, refName));
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

        Assert.True(compileExit == 0, $"compile failed ({compileExit}):\nstdout:\n{compileOut}\nstderr:\n{compileErr}");
        return outPath;
    }
}
