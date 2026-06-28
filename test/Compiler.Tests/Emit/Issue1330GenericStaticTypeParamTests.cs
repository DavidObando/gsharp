// <copyright file="Issue1330GenericStaticTypeParamTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1330: a generic static member-access receiver
/// <c>GenericType[TypeArg].StaticMember(...)</c> failed with
/// <c>GS0125: Variable '...' doesn't exist</c> when <c>TypeArg</c> was an
/// in-scope generic <em>type parameter</em> (e.g. <c>Comparer[TResult].Default</c>
/// inside <c>class C[TResult]</c>), even though the identical receiver with a
/// <em>concrete</em> type argument (<c>Comparer[int32].Default</c>) bound and
/// executed cleanly. This residual of #1323 arose because a single simple-name
/// type argument is parsed as an index expression, and the binder's
/// index-then-member fallback only closed the imported generic receiver for a
/// concrete argument — a type-parameter argument has no concrete CLR type, so
/// resolution fell through to binding the receiver name as a (non-existent)
/// variable.
///
/// The fix carries the symbolic constructed receiver
/// (<c>Comparer&lt;!TResult&gt;</c>) alongside the type-erased closed CLR shape
/// (<c>Comparer&lt;object&gt;</c>) so that (a) static member access resolves,
/// (b) the member's result type is the symbolic <c>Comparer[TResult]</c> rather
/// than the erased <c>object</c>, and (c) the emitter parents the static member
/// reference at the constructed <c>Comparer&lt;!TResult&gt;</c> TypeSpec —
/// producing verifiable IL exactly as the concrete-argument receiver does.
/// </summary>
public class Issue1330GenericStaticTypeParamTests
{
    /// <summary>
    /// The headline case: a static property read on a generic type closed over
    /// an in-scope type parameter (<c>Comparer[T].Default</c>) resolves, yields a
    /// usable <c>Comparer[T]</c>, verifies, and executes — comparing values via
    /// the recovered comparer.
    /// </summary>
    [Fact]
    public void StaticProperty_OnTypeParameterReceiver_VerifiesAndExecutes()
    {
        var source = """
            package P
            import System
            import System.Collections.Generic
            class C[T IComparable[T]] {
                func Compare(x T, y T) int32 {
                    var cmp = Comparer[T].Default
                    return cmp.Compare(x, y)
                }
            }
            var c = C[int32]{}
            Console.WriteLine(c.Compare(3, 5))
            Console.WriteLine(c.Compare(7, 2))
            Console.WriteLine(c.Compare(4, 4))
            """;

        Assert.Equal("-1\n1\n0\n", CompileVerifyAndRun(source));
    }

    /// <summary>
    /// The same static-property receiver also works for a reference-type
    /// argument (<c>string</c>), confirming the symbolic receiver is independent
    /// of the element's value/reference kind.
    /// </summary>
    [Fact]
    public void StaticProperty_OnTypeParameterReceiver_ReferenceElement_Executes()
    {
        var source = """
            package P
            import System
            import System.Collections.Generic
            class C[T IComparable[T]] {
                func Sign(x T, y T) int32 {
                    return Comparer[T].Default.Compare(x, y)
                }
            }
            var c = C[string]{}
            Console.WriteLine(c.Sign("apple", "banana"))
            Console.WriteLine(c.Sign("pear", "pear"))
            """;

        Assert.Equal("-1\n0\n", CompileVerifyAndRun(source));
    }

    /// <summary>
    /// The control: the identical static-property receiver with a CONCRETE type
    /// argument (<c>Comparer[int32].Default</c>) continues to verify and run.
    /// </summary>
    [Fact]
    public void StaticProperty_OnConcreteReceiver_StillVerifiesAndExecutes()
    {
        var source = """
            package P
            import System
            import System.Collections.Generic
            class C {
                func Compare(x int32, y int32) int32 {
                    return Comparer[int32].Default.Compare(x, y)
                }
            }
            var c = C{}
            Console.WriteLine(c.Compare(9, 2))
            """;

        Assert.Equal("1\n", CompileVerifyAndRun(source));
    }

    /// <summary>
    /// Issue #1330 root repro: the static factory call
    /// <c>Comparer[TResult].Create((x, y) -&gt; ...)</c> whose type argument is an
    /// in-scope generic type parameter now RESOLVES (binds without GS0125 /
    /// GS0159), exactly like its concrete-argument counterpart. (Full execution
    /// of a lambda whose parameters are an enclosing type parameter additionally
    /// depends on generic-lambda hosting, which is tracked separately; this test
    /// locks the resolution fix that is the subject of #1330.)
    /// </summary>
    [Fact]
    public void StaticFactoryCall_OnTypeParameterReceiver_Resolves()
    {
        var source = """
            package P
            import System.Collections.Generic
            class C[TResult IComparable[TResult]] {
                func F() Comparer[TResult] {
                    return Comparer[TResult].Create((x TResult, y TResult) -> x.CompareTo(y))
                }
            }
            """;

        // Compiles cleanly (no GS0125 "Variable doesn't exist"): the
        // type-parameter static receiver resolves to the constructed generic.
        CompileLibrary(source);
    }

    private static string CompileVerifyAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue1330_emit_").FullName;
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

    private static void CompileLibrary(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue1330_lib_").FullName;
        try
        {
            CompileToDll(tempDir, source, "/target:library");
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

        // Resolve against the host runtime's implementation assemblies (the same
        // assemblies IlVerifier verifies against). The implementation metadata
        // for Comparer<T> exposes its strongly typed Compare(T, T) member, which
        // ordinary member lookup binds in preference to the non-generic
        // IComparer.Compare(object, object) explicit-interface overload.
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
            "System.Collections.dll",
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
