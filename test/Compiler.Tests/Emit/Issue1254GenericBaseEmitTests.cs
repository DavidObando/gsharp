// <copyright file="Issue1254GenericBaseEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1254: calling a member that is INHERITED from a generic base class
/// through a derived receiver must emit a metadata token whose containing type
/// is the CONSTRUCTED base instantiation (e.g. <c>Base`1&lt;int32&gt;</c>), not the
/// open generic definition (<c>Base`1</c>). Emitting against the open definition
/// produces IL that statically verifies but throws at runtime:
/// <c>InvalidOperationException: ... not fully instantiated</c>.
/// <para>
/// Every test both statically verifies the emitted assembly via
/// <see cref="IlVerifier.Verify"/> AND executes it, asserting the printed
/// result, so a token bound to the open definition is caught either way.
/// </para>
/// </summary>
public class Issue1254GenericBaseEmitTests
{
    [Fact]
    public void InheritedMethod_IgnoringTypeParam_ViaDerivedReceiver_EmitsAndRuns()
    {
        // The minimal repro from #1254: the inherited method's signature does
        // not mention T, so the only unresolved thing is the containing-type
        // instantiation.
        var source = """
            package P
            import System

            open class Base[T] {
                func Hello() int32 { return 42 }
            }

            class Derived : Base[int32] {
            }

            let d = Derived()
            Console.WriteLine(d.Hello())
            """;

        Assert.Equal("42\n", CompileAndRun(source));
    }

    [Fact]
    public void InheritedMethod_UsingTypeParam_ViaDerivedReceiver_EmitsAndRuns()
    {
        // The inherited method's parameter and return both use T, which is
        // substituted to int32 by the constructed base.
        var source = """
            package P
            import System

            open class Base[T] {
                func Echo(x T) T { return x }
            }

            class Derived : Base[int32] {
            }

            let d = Derived()
            Console.WriteLine(d.Echo(7))
            """;

        Assert.Equal("7\n", CompileAndRun(source));
    }

    [Fact]
    public void InheritedField_ViaDerivedReceiver_EmitsAndRuns()
    {
        var source = """
            package P
            import System

            open class Base[T] {
                let Value int32 = 99
            }

            class Derived : Base[int32] {
            }

            let d = Derived()
            Console.WriteLine(d.Value)
            """;

        Assert.Equal("99\n", CompileAndRun(source));
    }

    [Fact]
    public void InheritedAutoProperty_GetAndSet_ViaDerivedReceiver_EmitsAndRuns()
    {
        var source = """
            package P
            import System

            open class Base[T] {
                prop Item T
            }

            class Derived : Base[int32] {
            }

            let d = Derived()
            d.Item = 8
            Console.WriteLine(d.Item)
            """;

        Assert.Equal("8\n", CompileAndRun(source));
    }

    [Fact]
    public void InheritedProperty_Get_ViaDerivedReceiver_EmitsAndRuns()
    {
        var source = """
            package P
            import System

            open class Base[T] {
                var backing T
                prop Item T {
                    get { return this.backing }
                }
            }

            class Derived : Base[int32] {
            }

            let d = Derived()
            Console.WriteLine(d.Item)
            """;

        Assert.Equal("0\n", CompileAndRun(source));
    }

    [Fact]
    public void InheritedMethod_MultiLevelGenericBaseChain_EmitsAndRuns()
    {
        // Derived : Mid[int32] : Base[T] — the type argument must be threaded
        // through each hop of the base chain.
        var source = """
            package P
            import System

            open class Base[T] {
                func Hello() int32 { return 42 }
            }

            open class Mid[T] : Base[T] {
            }

            class Derived : Mid[int32] {
            }

            let d = Derived()
            Console.WriteLine(d.Hello())
            """;

        Assert.Equal("42\n", CompileAndRun(source));
    }

    [Fact]
    public void InheritedMethod_UsingTypeParam_MultiLevelChain_EmitsAndRuns()
    {
        var source = """
            package P
            import System

            open class Base[T] {
                func Pick(a T, b T) T { return a }
            }

            open class Mid[T] : Base[T] {
            }

            class Derived : Mid[int32] {
            }

            let d = Derived()
            Console.WriteLine(d.Pick(9, 4))
            """;

        Assert.Equal("9\n", CompileAndRun(source));
    }

    [Fact]
    public void BaseDotMethod_IntoGenericBase_FromNonGenericDerived_EmitsAndRuns()
    {
        var source = """
            package P
            import System

            open class Base[T] {
                open func Hello() int32 { return 42 }
            }

            class Derived : Base[int32] {
                func Call() int32 { return base.Hello() }
            }

            let d = Derived()
            Console.WriteLine(d.Call())
            """;

        Assert.Equal("42\n", CompileAndRun(source));
    }

    [Fact]
    public void BaseDotProperty_IntoGenericBase_FromNonGenericDerived_EmitsAndRuns()
    {
        var source = """
            package P
            import System

            open class Base[T] {
                open prop Tag int32 {
                    get { return 13 }
                }
            }

            class Derived : Base[int32] {
                func Read() int32 { return base.Tag }
            }

            let d = Derived()
            Console.WriteLine(d.Read())
            """;

        Assert.Equal("13\n", CompileAndRun(source));
    }

    [Fact]
    public void BaseConstructorChaining_IntoGenericBasePrimaryCtor_EmitsAndRuns()
    {
        var source = """
            package P
            import System

            open class Base[T](stored T) {
            }

            class Derived : Base[int32] {
                init() : base(66) {
                }
            }

            let d = Derived()
            Console.WriteLine(d.stored)
            """;

        Assert.Equal("66\n", CompileAndRun(source));
    }

    [Fact]
    public void InheritedMethod_GenericDerived_EmitsAndRuns()
    {
        // Derived[U] : Base[U] — the derived type is itself generic and forwards
        // its own type parameter to the base.
        var source = """
            package P
            import System

            open class Base[T] {
                func Hello() int32 { return 42 }
            }

            class Derived[U] : Base[U] {
            }

            let d = Derived[int32]()
            Console.WriteLine(d.Hello())
            """;

        Assert.Equal("42\n", CompileAndRun(source));
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue1254_emit_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            var args = new System.Collections.Generic.List<string>
            {
                "/out:" + outPath,
                "/target:exe",
                "/targetframework:net10.0",
                "/nowarn:GS9100",
                srcPath,
            };

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

            // (a) Static verification: the emitted IL must be valid.
            IlVerifier.Verify(outPath);

            // (b) Dynamic verification: the emitted code must execute. This is
            // what catches a token bound to the open generic definition, which
            // verifies statically but throws "not fully instantiated" at run.
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
