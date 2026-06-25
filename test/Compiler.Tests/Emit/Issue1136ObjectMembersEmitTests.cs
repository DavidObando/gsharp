// <copyright file="Issue1136ObjectMembersEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1136: the inherited <see cref="object"/> instance members
/// (<c>GetType</c>, <c>ToString</c>, <c>GetHashCode</c>, <c>Equals(object)</c>)
/// were not callable on a user <c>class</c>/<c>struct</c> instance that does not
/// declare its own override — <c>recv.GetType()</c> / <c>this.ToString()</c>
/// failed with <c>GS0159</c> and a bare implicit-<c>this</c> <c>GetType()</c>
/// with <c>GS0130</c>. Every .NET type inherits these from
/// <see cref="object"/> (value types via <see cref="ValueType"/>), so the binder
/// now resolves the call against <see cref="object"/> when no user method
/// matches. The bound call is a (virtual) <c>callvirt</c>, so a user-declared
/// override still wins at runtime and value-type receivers are boxed by the
/// emitter. These tests compile, IL-verify, and run the shapes end-to-end.
/// </summary>
public class Issue1136ObjectMembersEmitTests
{
    [Fact]
    public void GetTypeName_OnUserClassInstance_ReturnsTypeName()
    {
        var source = """
            package P
            import System

            class C { }

            var c = C()
            Console.WriteLine(c.GetType().Name)
            """;

        Assert.Equal("C\n", CompileAndRun(source));
    }

    [Fact]
    public void DefaultToString_OnUserClassInstance_ReturnsFullTypeName()
    {
        var source = """
            package P
            import System

            class C { }

            var c = C()
            Console.WriteLine(c.ToString())
            """;

        Assert.Equal("P.C\n", CompileAndRun(source));
    }

    [Fact]
    public void UserToStringOverride_IsDispatchedAtRuntime()
    {
        // A user-declared ToString() override is found earlier (via the user
        // method bucket) and must win over the inherited Object member.
        var source = """
            package P
            import System

            class C {
                func ToString() string { return "custom" }
            }

            var c = C()
            Console.WriteLine(c.ToString())
            """;

        Assert.Equal("custom\n", CompileAndRun(source));
    }

    [Fact]
    public void ImplicitThis_InheritedObjectMembers_AreCallable()
    {
        // `this.GetHashCode()`, `this.ToString()`, `this.GetType()`,
        // `this.Equals(this)`, and a bare implicit-`this` `GetType()`.
        var source = """
            package P
            import System

            class C {
                func TypeName() string { return GetType().Name }
                func F() string {
                    let h = this.GetHashCode()
                    let s = this.ToString()
                    let t = this.GetType()
                    let e = this.Equals(this)
                    if e {
                        return t.Name
                    }
                    return "no"
                }
            }

            var c = C()
            Console.WriteLine(c.F())
            Console.WriteLine(c.TypeName())
            """;

        Assert.Equal("C\nC\n", CompileAndRun(source));
    }

    [Fact]
    public void Equals_OnUserClassInstances_UsesReferenceEquality()
    {
        var source = """
            package P
            import System

            class C { }

            var a = C()
            var b = C()
            Console.WriteLine(a.Equals(a))
            Console.WriteLine(a.Equals(b))
            """;

        Assert.Equal("True\nFalse\n", CompileAndRun(source));
    }

    [Fact]
    public void GetHashCode_OnUserClassInstance_IsStable()
    {
        var source = """
            package P
            import System

            class C { }

            var c = C()
            Console.WriteLine(c.GetHashCode() == c.GetHashCode())
            """;

        Assert.Equal("True\n", CompileAndRun(source));
    }

    [Fact]
    public void InheritedObjectMembers_OnValueTypeStruct_AreCallable()
    {
        // A value-type receiver invoking an inherited reference-type Object
        // member must be boxed; the emitter handles this for the bound call.
        var source = """
            package P
            import System

            struct S {
                var x int32
                func Describe() string { return this.GetType().Name }
            }

            var s = S{ x: 3 }
            Console.WriteLine(s.GetType().Name)
            Console.WriteLine(s.Describe())
            Console.WriteLine(s.Equals(s))
            """;

        Assert.Equal("S\nS\nTrue\n", CompileAndRun(source));
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue1136_emit_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            using var compileOut = new StringWriter();
            using var compileErr = new StringWriter();
            var prevOut = Console.Out;
            var prevErr = Console.Error;
            Console.SetOut(compileOut);
            Console.SetError(compileErr);
            int compileExit;
            try
            {
                compileExit = Program.Main(new[]
                {
                    "/out:" + outPath,
                    "/target:exe",
                    "/targetframework:net10.0",
                    srcPath,
                });
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
            try
            {
                Directory.Delete(tempDir, recursive: true);
            }
            catch
            {
            }
        }
    }
}
