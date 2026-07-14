// <copyright file="Issue2337NestedGenericInheritanceEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #2337 — a nested class that implicitly inherits the generic arity of
/// its enclosing generic type (e.g. <c>class Mid : Base { }</c> nested inside
/// <c>class Outer[T]</c>) carries the enclosing generic's reified
/// <see cref="GSharp.Core.CodeAnalysis.Symbols.StructSymbol.TypeParameters"/>
/// while its own <see cref="GSharp.Core.CodeAnalysis.Symbols.StructSymbol.TypeArguments"/>
/// stays empty. <see cref="GSharp.Core.CodeAnalysis.Emit.TypeDefEmitter"/>'s
/// four <c>extends</c>/base-constructor token gates previously routed a base
/// through the self-instantiation TypeSpec ONLY when <c>TypeArguments</c> was
/// non-empty (issue #1055's explicitly-constructed-base case), so a nested
/// sibling base fell through to the bare open TypeDef/base-ctor MethodDef.
/// ILVerify then rejects the emitted assembly with a
/// <c>found ref Derived&lt;T0&gt;, expected ref Base&lt;T0&gt;</c>
/// <c>StackUnexpected</c> error wherever the mismatched token surfaces on the
/// stack (e.g. a <c>callvirt</c> dispatch through a base-typed reference).
/// <para>
/// The fix widens all four gates to
/// <c>ReflectionMetadataEmitter.IsUserGenericTypeReference(baseClass)</c> — the
/// existing shared predicate (already used elsewhere in
/// <c>TypeDefEmitter</c>/<c>ReflectionMetadataEmitter</c> for the identical
/// "does this reference need a TypeSpec instead of a bare TypeDef" question) —
/// which is <see langword="true"/> when EITHER <c>TypeArguments</c> is
/// non-empty (a constructed base, #1055) OR the base's own
/// <c>TypeParameters</c> is non-empty (an open definition — including a nested
/// sibling reified over its enclosing generic's parameters, #2337). Using one
/// shared predicate at all four sites prevents them drifting out of sync
/// again.
/// </para>
/// Each test uses a UNIQUE package/type name because the in-process
/// <c>FunctionTypeSymbol</c> cache is name-keyed and not cleared between
/// tests.
/// </summary>
public class Issue2337NestedGenericInheritanceEmitTests
{
    [Fact]
    public void EndToEnd_ThreeLevelNestedSiblingInheritance_UnderGenericOuter_VerifiesAndRuns()
    {
        // The exact issue repro shape (Base / Mid : Base / Leaf : Mid, all
        // nested inside a generic Outer[T]), surfaced through a callvirt
        // dispatch on a Base-typed reference — the precise scenario that
        // reported `found ref Leaf<T0>, expected ref Base<T0>` pre-fix.
        var source = """
            package Issue2337ThreeLevel
            import System

            class Outer2337a[T] {
                open class Base2337a {
                    open func Speak() string { return "base" }
                }
                open class Mid2337a : Base2337a { }
                open class Leaf2337a : Mid2337a {
                    override func Speak() string { return "leaf" }
                }

                func MakeLeaf() Base2337a {
                    return Leaf2337a()
                }
            }

            func Main() {
                var o = Outer2337a[int32]()
                var b = o.MakeLeaf()
                Console.WriteLine(b.Speak())
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("leaf\n", output);
    }

    [Fact]
    public void EndToEnd_DirectNestedSiblingBaseCall_SkipsMidLevel_VerifiesAndRuns()
    {
        // Leaf calls `base.Speak()` (its direct base is Mid, which does not
        // declare Speak, so the call resolves up through to Base). The
        // non-virtual `call` instruction's declaring-type token must be the
        // self-instantiation TypeSpec too, not the bare TypeDef.
        var source = """
            package Issue2337DirectCall
            import System

            class Outer2337b[T] {
                open class Base2337b {
                    open func Speak() string { return "base" }
                }
                open class Mid2337b : Base2337b { }
                class Leaf2337b : Mid2337b {
                    override func Speak() string { return "leaf->" + base.Speak() }
                }

                func MakeLeaf() Base2337b {
                    return Leaf2337b()
                }
            }

            func Main() {
                var o = Outer2337b[int32]()
                var b = o.MakeLeaf()
                Console.WriteLine(b.Speak())
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("leaf->base\n", output);
    }

    [Fact]
    public void EndToEnd_NestedSiblingBaseConstructorChaining_UnderGenericOuter_VerifiesAndRuns()
    {
        // Explicit `init(...) : base(...)` chaining across all three nested
        // sibling levels (GetBaseInitializerCtorToken, private helper #4)
        // must also route through the self-instantiation TypeSpec.
        var source = """
            package Issue2337CtorChain
            import System

            class Outer2337c[T] {
                open class Base2337c {
                    var Value int32
                    init(v int32) { Value = v }
                }
                open class Mid2337c : Base2337c {
                    init(v int32) : base(v) { }
                }
                class Leaf2337c : Mid2337c {
                    init(v int32) : base(v) { }
                }

                func MakeLeaf(v int32) Base2337c {
                    return Leaf2337c(v)
                }
            }

            func Main() {
                var o = Outer2337c[int32]()
                var b = o.MakeLeaf(42)
                Console.WriteLine(b.Value)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("42\n", output);
    }

    [Fact]
    public void EndToEnd_ExplicitConstructedBase_Issue1055Control_StillVerifiesAndRuns()
    {
        // Control: issue #1055's ORIGINAL case — a base explicitly constructed
        // with concrete type arguments (TypeArguments non-empty, TypeParameters
        // empty on the reference) — must remain routed through the same
        // self-instantiation/constructed-base TypeSpec helpers after widening
        // the gate to the shared IsUserGenericTypeReference predicate.
        var source = """
            package Issue2337Ctrl1055
            import System

            open class Base2337Ctrl1055[TIn, TOut] {
                open func Transform(x TIn) TOut;
            }
            class Derived2337Ctrl1055 : Base2337Ctrl1055[int32, int32] {
                override func Transform(x int32) int32 { return x + 1 }
            }

            func Main() {
                let b Base2337Ctrl1055[int32, int32] = Derived2337Ctrl1055()
                Console.WriteLine(b.Transform(41))
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("42\n", output);
    }

    [Fact]
    public void EndToEnd_NonGenericNestedSiblingInheritance_ControlStillVerifiesAndRuns()
    {
        // Control: the SAME three-level nested sibling shape, but the
        // enclosing type is NON-generic — neither TypeArguments nor
        // TypeParameters is ever populated on the base reference, so this path
        // was never affected by the bug and must remain clean after the fix.
        var source = """
            package Issue2337NonGenericCtrl
            import System

            class Outer2337Ctrl {
                open class Base2337Ctrl {
                    open func Speak() string { return "base" }
                }
                open class Mid2337Ctrl : Base2337Ctrl { }
                class Leaf2337Ctrl : Mid2337Ctrl {
                    override func Speak() string { return "leaf" }
                }
            }

            func Main() {
                let b Outer2337Ctrl.Base2337Ctrl = Outer2337Ctrl.Leaf2337Ctrl()
                Console.WriteLine(b.Speak())
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("leaf\n", output);
    }

    [Fact]
    public void EndToEnd_OahuTreeDecompositionShape_BaseCustomToStringCustomFormatString_VerifiesAndRuns()
    {
        // The real Oahu occurrence that discovered this bug: a
        // TreeDecomposition[T]-shaped generic outer with a nested
        // Base / CustomToString : Base / CustomFormatString : CustomToString
        // sibling family, where the leaf override calls up through
        // `base.Describe()` and is dispatched through a Base-typed reference.
        var source = """
            package Oahu.Aux.Diagnostics
            import System

            class TreeDecomposition2337[T] {
                open class Base2337Oahu {
                    open func Describe() string { return "base" }
                }
                open class CustomToString2337 : Base2337Oahu {
                    open override func Describe() string { return "custom-to-string" }
                }
                class CustomFormatString2337 : CustomToString2337 {
                    override func Describe() string { return "custom-format-string:" + base.Describe() }
                }

                func MakeFormatString() Base2337Oahu {
                    return CustomFormatString2337()
                }
            }

            func Main() {
                var td = TreeDecomposition2337[int32]()
                var b = td.MakeFormatString()
                System.Console.WriteLine(b.Describe())
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("custom-format-string:custom-to-string\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_2337_exe_").FullName;
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
