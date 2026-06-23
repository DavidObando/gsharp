// <copyright file="Issue974GenericInterfaceImplEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #974: a class implementing a generic interface whose method returns
/// (or takes) a <em>constructed generic</em> built from the interface's type
/// parameter — e.g. <c>func Iter() IEnumerator[T]</c> satisfying
/// <c>ISeq[T].Iter() IEnumerator[T]</c> — was rejected with <c>GS0187</c>
/// ("does not implement interface method"). A method returning the plain type
/// parameter <c>T</c> matched, so the defect was specific to constructed
/// generic return / parameter types.
/// <para>
/// Root cause: interface-satisfaction signature matching
/// (<c>DeclarationBinder.SignaturesMatch</c>) compared the interface method's
/// return / parameter types to the class method's by reference identity. The
/// interface method carries the interface's type-parameter symbol
/// (<c>IEnumerator[T_iface]</c>) while the class method carries the class's
/// (<c>IEnumerator[T_class]</c>); these are distinct <c>TypeSymbol</c>
/// instances so the comparison never matched. Two fixes combine: (1)
/// <c>InterfaceSymbol</c> member substitution now recurses into constructed
/// generic (<c>ImportedTypeSymbol</c> / nested <c>InterfaceSymbol</c>) type
/// arguments so the constructed interface exposes <c>IEnumerator[T_class]</c>;
/// (2) signature matching now compares types structurally (definition +
/// ordered type arguments) instead of by reference, because constructed
/// generics are not interned.
/// </para>
/// </summary>
public class Issue974GenericInterfaceImplEmitTests
{
    [Fact]
    public void GenericInterface_MethodReturningConstructedGenericOverT_Compiles_And_Runs()
    {
        // The exact repro from issue #974: ISeq[T].Iter() IEnumerator[T].
        var source = """
            package GapCheck
            import System
            import System.Collections.Generic

            interface ISeq[T] {
                func Iter() IEnumerator[T];
            }

            class Seq[T] : ISeq[T] {
                var items List[T] = List[T]()
                func Push(value T) {
                    items.Add(value)
                }
                func Iter() IEnumerator[T] { return items.GetEnumerator() }
            }

            var s = Seq[int32]()
            s.Push(10)
            s.Push(20)
            s.Push(30)
            var e IEnumerator[int32] = s.Iter()
            while e.MoveNext() {
                Console.WriteLine(e.Current)
            }
            """;

        Assert.Equal("10\n20\n30\n", CompileAndRun(source));
    }

    [Fact]
    public void GenericInterface_MethodReturningPlainT_Control_Compiles_And_Runs()
    {
        // Control that always compiled: the plain type-parameter return path.
        var source = """
            package GapCheck
            import System

            interface IBox[T] { func Get() T; }

            class Box[T] : IBox[T] {
                var item T
                func Set(value T) { item = value }
                func Get() T { return item }
            }

            var b = Box[int32]()
            b.Set(42)
            Console.WriteLine(b.Get())
            """;

        Assert.Equal("42\n", CompileAndRun(source));
    }

    [Fact]
    public void GenericInterface_ImplementedWithConcreteTypeArgument_Compiles_And_Runs()
    {
        // The class supplies a concrete type argument: ISeq[int32] satisfied
        // by func Iter() IEnumerator[int32].
        var source = """
            package GapCheck
            import System
            import System.Collections.Generic

            interface ISeq[T] {
                func Iter() IEnumerator[T];
            }

            class IntSeq : ISeq[int32] {
                var items List[int32] = List[int32]()
                func Push(value int32) {
                    items.Add(value)
                }
                func Iter() IEnumerator[int32] { return items.GetEnumerator() }
            }

            var s = IntSeq()
            s.Push(7)
            s.Push(8)
            var e IEnumerator[int32] = s.Iter()
            while e.MoveNext() {
                Console.WriteLine(e.Current)
            }
            """;

        Assert.Equal("7\n8\n", CompileAndRun(source));
    }

    [Fact]
    public void GenericInterface_MethodTakingConstructedGenericParameter_Compiles_And_Runs()
    {
        // The constructed generic appears in a parameter position
        // (List[T]) as well as in the body, across multiple type
        // parameters and multiple interfaces on one class.
        var source = """
            package GapCheck
            import System
            import System.Collections.Generic

            interface ISink[T] {
                func AddAll(values List[T]) int32;
            }

            interface IPair[K, V] {
                func Make() Dictionary[K, V];
            }

            class Bag[K, V] : ISink[V], IPair[K, V] {
                var items List[V] = List[V]()
                func AddAll(values List[V]) int32 {
                    for v in values {
                        items.Add(v)
                    }
                    return items.Count
                }
                func Make() Dictionary[K, V] { return Dictionary[K, V]() }
            }

            var bag = Bag[string, int32]()
            var xs = List[int32]()
            xs.Add(1)
            xs.Add(2)
            xs.Add(3)
            Console.WriteLine(bag.AddAll(xs))
            """;

        Assert.Equal("3\n", CompileAndRun(source));
    }

    [Fact]
    public void GenericInterface_MismatchedConstructedGenericSignature_StillRejectedGS0187()
    {
        // Negative guard: the matching must stay strict. A class declared
        // Seq[T] : ISeq[T] whose Iter() returns IEnumerator[int32] (not
        // IEnumerator[T]) does NOT satisfy the interface and must still be
        // rejected with GS0187.
        var source = """
            package GapCheck
            import System.Collections.Generic

            interface ISeq[T] {
                func Iter() IEnumerator[T];
            }

            class BadSeq[T] : ISeq[T] {
                var items List[int32] = List[int32]()
                func Iter() IEnumerator[int32] { return items.GetEnumerator() }
            }
            """;

        var diagnostics = CompileExpectingErrors(source);
        Assert.Contains(diagnostics, d => d.Contains("GS0187"));
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue974_emit_").FullName;
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

    private static List<string> CompileExpectingErrors(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue974_neg_").FullName;
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
                    "/target:library",
                    "/targetframework:net10.0",
                    srcPath,
                });
            }
            finally
            {
                Console.SetOut(prevOut);
                Console.SetError(prevErr);
            }

            Assert.True(
                compileExit != 0,
                $"expected gsc to report errors but it succeeded\nstdout:\n{compileOut}\nstderr:\n{compileErr}");

            var combined = compileOut.ToString() + compileErr.ToString();
            return combined.Split('\n').Where(l => !string.IsNullOrWhiteSpace(l)).ToList();
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
