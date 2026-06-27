// <copyright file="Issue1256ElementWiseTupleConversionEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1256: an element-wise implicit tuple conversion <c>(T1, …, Tn) -> (U1, …, Un)</c>
/// (each <c>Ti -> Ui</c> implicit) must bind AND emit. The source and target
/// <c>ValueTuple&lt;…&gt;</c> are different CLR instantiations, so a direct reinterpret
/// is not verifiable IL; the binder rebuilds the destination tuple from per-element
/// converted accesses. These tests prove the rebuilt tuple round-trips the original
/// element objects (identity preserved through a reference upcast) and that mixed
/// conversions (reference upcast + numeric widening) produce the correct values.
/// </summary>
public class Issue1256ElementWiseTupleConversionEmitTests
{
    [Fact]
    public void DerivedElementUpcast_AsArgument_PreservesIdentity()
    {
        var source = """
            package Test
            import System

            class A { func Name() string { return "A!" } }
            open class Base { func Tag() int32 { return 5 } }
            class Derived : Base { func Extra() int32 { return 9 } }

            func Take(t (A, Base)) string {
                return t.Item1.Name() + ":" + t.Item2.Tag().ToString()
            }

            let a A = A()
            let d Derived = Derived()
            Console.WriteLine(Take((a, d)))
            """;

        var output = CompileAndRun(source);
        Assert.Equal("A!:5\n", output);
    }

    [Fact]
    public void DerivedElementUpcast_LetTarget_PreservesIdentity()
    {
        var source = """
            package Test
            import System

            open class Base { func Tag() int32 { return 5 } }
            class Derived : Base { func Extra() int32 { return 9 } }

            let d Derived = Derived()
            let t (Base, int32) = (d, 3)
            Console.WriteLine(t.Item1.Tag().ToString() + "," + t.Item2.ToString())
            """;

        var output = CompileAndRun(source);
        Assert.Equal("5,3\n", output);
    }

    [Fact]
    public void ConcreteElementToInterface_AsArgument_RoundTrips()
    {
        var source = """
            package Test
            import System

            interface IShape { func Area() int32; }
            class Square : IShape { func Area() int32 { return 16 } }
            class A { func N() int32 { return 1 } }

            func Take(t (A, IShape)) int32 { return t.Item1.N() + t.Item2.Area() }

            let a A = A()
            let sq Square = Square()
            Console.WriteLine(Take((a, sq)))
            """;

        var output = CompileAndRun(source);
        Assert.Equal("17\n", output);
    }

    [Fact]
    public void ThreeElementMixed_UpcastAndWidening_ProducesCorrectValues()
    {
        var source = """
            package Test
            import System

            class A { func N() int32 { return 1 } }
            open class Base { func Tag() int32 { return 5 } }
            class Derived : Base {}

            func Take(t (A, Base, int64)) string {
                return t.Item1.N().ToString() + ":" + t.Item2.Tag().ToString() + ":" + t.Item3.ToString()
            }

            let a A = A()
            let d Derived = Derived()
            let small int32 = 7
            Console.WriteLine(Take((a, d, small)))
            """;

        var output = CompileAndRun(source);
        Assert.Equal("1:5:7\n", output);
    }

    [Fact]
    public void NullableDerivedElement_To_NullableBaseElement_RoundTrips()
    {
        var source = """
            package Test
            import System

            class A {}
            open class Base { func Tag() int32 { return 5 } }
            class Derived : Base {}

            func Read(t (A, Base?)) int32 {
                let b Base? = t.Item2
                if b != nil {
                    return b.Tag()
                }
                return -1
            }

            let a A = A()
            let dn Derived? = Derived()
            Console.WriteLine(Read((a, dn)))
            """;

        var output = CompileAndRun(source);
        Assert.Equal("5\n", output);
    }

    [Fact]
    public void DerivedElementUpcast_ReturnPosition_PreservesIdentity()
    {
        var source = """
            package Test
            import System

            class A { func Name() string { return "A!" } }
            open class Base { func Tag() int32 { return 5 } }
            class Derived : Base {}

            func Make(a A, d Derived) (A, Base) {
                return (a, d)
            }

            let a A = A()
            let d Derived = Derived()
            let t (A, Base) = Make(a, d)
            Console.WriteLine(t.Item1.Name() + ":" + t.Item2.Tag().ToString())
            """;

        var output = CompileAndRun(source);
        Assert.Equal("A!:5\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var (exitCode, stdout, stderr) = CompileAndRunRaw(source);
        Assert.True(
            exitCode == 0,
            $"gsc failed (exit {exitCode}):\nstdout:\n{stdout}\nstderr:\n{stderr}");
        return stdout;
    }

    private static (int ExitCode, string Stdout, string Stderr) CompileAndRunRaw(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue1256_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            var args = new List<string>
            {
                "/out:" + outPath,
                "/target:exe",
                "/targetframework:net10.0",
            };

            foreach (var reference in TrustedPlatformAssemblies())
            {
                args.Add("/reference:" + reference);
            }

            args.Add("/nowarn:GS9100");
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

            if (compileExit != 0)
            {
                return (compileExit, compileOut.ToString(), compileErr.ToString());
            }

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

            return (proc.ExitCode, stdout.Replace("\r\n", "\n"), stderr.Replace("\r\n", "\n"));
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }

    private static IEnumerable<string> TrustedPlatformAssemblies()
    {
        var tpa = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string;
        if (string.IsNullOrEmpty(tpa))
        {
            yield break;
        }

        foreach (var path in tpa.Split(Path.PathSeparator))
        {
            if (!string.IsNullOrWhiteSpace(path) && File.Exists(path))
            {
                yield return path;
            }
        }
    }
}
