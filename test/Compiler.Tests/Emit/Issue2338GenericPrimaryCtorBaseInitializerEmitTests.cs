// <copyright file="Issue2338GenericPrimaryCtorBaseInitializerEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #2338 regression tests: a generic primary-constructor class/data
/// class with an explicit base initializer
/// (<c>class Derived[T](...) : Base(args) { }</c>) previously emitted its
/// own primary-constructor field stores through
/// <c>EmitClassConstructorWithBaseInitializerBodyBytes</c> using a bare,
/// open <c>FieldDef</c> token rather than the self-instantiation-aware
/// <c>ResolveFieldToken(classSym, field)</c> its sibling (no-base-initializer)
/// scaffold already used. ilverify reported <c>StackUnexpected</c>: "found
/// ref Derived&lt;T0&gt;, expected ref Derived" at the constructor's
/// <c>stfld</c> sites — exactly the same generic-self-instantiation drift
/// previously fixed for auto-properties (issue #989) and field-like events
/// (issue #1611), but at this distinct primary-constructor-with-base-
/// initializer call site.
///
/// Reproducing and fixing this exposed a second, independent, non-generic
/// bug in the same code paths: <see cref="GSharp.Core.CodeAnalysis.Emit.DataStructSynthesizer"/>
/// unconditionally marked the synthesized <c>Equals(object)</c>/
/// <c>GetHashCode()</c>/<c>ToString()</c> overrides <c>virtual final</c>,
/// so ANY <c>open data class</c> derived from another <c>open data class</c>
/// (exactly the shape used by the issue's own minimal repro and by Oahu's
/// <c>InteractionMessage[T]</c> shape) threw
/// <c>TypeLoadException: Declaration referenced in a method implementation
/// cannot be a final method</c> at type-load time — a distinct defect from
/// the ilverify field-token drift, uncovered only because these tests
/// exercise the "run" step the issue asked for, not just compile+ilverify.
/// Both fixes are covered here so the exact repro described in the issue
/// compiles, verifies, AND runs end-to-end.
///
/// All programs compile+ilverify+run via an in-process <c>gsc</c> invocation
/// followed by a <c>dotnet exec</c> subprocess, mirroring the issue's ask for
/// "compile + ILVerify + run" coverage. Each test uses a unique package/type
/// name because the in-process <c>FunctionTypeSymbol</c> cache is name-keyed.
/// </summary>
public class Issue2338GenericPrimaryCtorBaseInitializerEmitTests
{
    [Fact]
    public void MinimalRepro_GenericDataClassWithNonGenericBaseInitializer_CompilesVerifiesAndRuns()
    {
        // The issue's exact minimal repro.
        const string source = """
            package Gh2338Minimal
            import System

            open data class Base2338Minimal(Name string) { }
            open data class Derived2338Minimal[T](Name string, Value T) : Base2338Minimal(Name) { }

            func Main() {
                var d = Derived2338Minimal[int32]("hello", 42)
                Console.WriteLine(d.Name)
                Console.WriteLine(d.Value.ToString())
            }
            """;

        Assert.Equal("hello\n42\n", CompileAndRun(source));
    }

    [Fact]
    public void MultipleAndGenericFields_ConstructedOverReferenceTypeArgument_CompilesVerifiesAndRuns()
    {
        // Multiple primary-ctor fields on the derived class, including two
        // distinct type-parameter-typed fields and a field typed over the
        // class's own OTHER field, constructed over a reference type
        // argument (string) rather than a value type.
        const string source = """
            package Gh2338MultiField
            import System

            open data class Base2338MultiField(Id int32, Label string) { }
            open data class Derived2338MultiField[T, U](Id int32, Label string, First T, Second U) : Base2338MultiField(Id, Label) { }

            func Main() {
                var d = Derived2338MultiField[string, int32](7, "widget", "alpha", 99)
                Console.WriteLine(d.Id.ToString())
                Console.WriteLine(d.Label)
                Console.WriteLine(d.First)
                Console.WriteLine(d.Second.ToString())
            }
            """;

        Assert.Equal("7\nwidget\nalpha\n99\n", CompileAndRun(source));
    }

    [Fact]
    public void OahuInteractionMessageShape_GenericOverPayload_CompilesVerifiesAndRuns()
    {
        // Exact Oahu occurrence shape from the issue:
        // InteractionMessage<T>(...) : InteractionMessage(Type, Message).
        const string source = """
            package Gh2338Interaction
            import System

            open data class InteractionMessage(Type string, Message string) { }
            open data class InteractionMessage[T](Type string, Message string, Data T) : InteractionMessage(Type, Message) { }

            func Main() {
                var m = InteractionMessage[int32]("info", "hello", 99)
                Console.WriteLine(m.Type)
                Console.WriteLine(m.Message)
                Console.WriteLine(m.Data.ToString())
                Console.WriteLine(m.ToString())

                var m2 = InteractionMessage[int32]("info", "hello", 99)
                Console.WriteLine((m == m2).ToString())
                Console.WriteLine(m.Equals(m2).ToString())
                Console.WriteLine((m.GetHashCode() == m2.GetHashCode()).ToString())
            }
            """;

        Assert.Equal(
            "info\nhello\n99\n"
            + "InteractionMessage(Type=info, Message=hello, Data=99)\n"
            + "True\nTrue\nTrue\n",
            CompileAndRun(source));
    }

    [Fact]
    public void NonGenericControl_DataClassWithBaseInitializer_CompilesVerifiesAndRuns()
    {
        // Control: the non-generic sibling of the minimal repro must keep
        // working (it already used the bare FieldDef path correctly, since a
        // non-generic type's bare FieldDef and self-instantiation token
        // coincide).
        const string source = """
            package Gh2338NonGenericControl
            import System

            open data class Base2338NonGeneric(Name string) { }
            open data class Derived2338NonGeneric(Name string, Value int32) : Base2338NonGeneric(Name) { }

            func Main() {
                var d = Derived2338NonGeneric("hello", 42)
                Console.WriteLine(d.Name)
                Console.WriteLine(d.Value.ToString())
            }
            """;

        Assert.Equal("hello\n42\n", CompileAndRun(source));
    }

    [Fact]
    public void NoBaseInitializerControl_GenericDataClass_CompilesVerifiesAndRuns()
    {
        // Control: a generic data class primary constructor with NO base
        // initializer already routed through the correctly-fixed sibling
        // scaffold (EmitClassConstructorWithBodyBodyBytes) — pin that this
        // fix didn't disturb it.
        const string source = """
            package Gh2338NoBaseInitControl
            import System

            open data class Standalone2338[T](Name string, Value T) { }

            func Main() {
                var d = Standalone2338[int32]("hello", 42)
                Console.WriteLine(d.Name)
                Console.WriteLine(d.Value.ToString())
            }
            """;

        Assert.Equal("hello\n42\n", CompileAndRun(source));
    }

    [Fact]
    public void NonDataClassControl_GenericClassWithBaseInitializer_CompilesVerifiesAndRuns()
    {
        // Control: a plain (non-data) generic open class with a base
        // initializer never involved DataStructSynthesizer's Equals/GetHashCode/
        // ToString overrides, isolating that the field-token fix alone (with
        // no DataStructSynthesizer involvement) is sufficient for this shape.
        const string source = """
            package Gh2338NonDataControl
            import System

            open class Base2338NonData(Name string) { }
            open class Derived2338NonData[T](Name string, Value T) : Base2338NonData(Name) { }

            func Main() {
                var d = Derived2338NonData[int32]("hello", 42)
                Console.WriteLine(d.Name)
                Console.WriteLine(d.Value.ToString())
            }
            """;

        Assert.Equal("hello\n42\n", CompileAndRun(source));
    }

    [Fact]
    public void DataClassExtendsDataClassControl_NonGeneric_TypeLoadsAndRunsWithoutFinalMethodError()
    {
        // Control isolating the second (independent, non-generic) bug this
        // investigation uncovered: an `open data class` derived from another
        // `open data class` previously threw TypeLoadException
        // ("...cannot be a final method") at load time regardless of
        // generics, because DataStructSynthesizer unconditionally marked
        // Equals(object)/GetHashCode()/ToString() `virtual final`.
        const string source = """
            package Gh2338DataExtendsDataControl
            import System

            open data class Base2338DataExtendsData(Name string) { }
            open data class Derived2338DataExtendsData(Name string, Value int32) : Base2338DataExtendsData(Name) { }

            func Main() {
                var d = Derived2338DataExtendsData("hello", 42)
                Console.WriteLine(d.Name)
                Console.WriteLine(d.Value.ToString())
                Console.WriteLine(d.ToString())
            }
            """;

        Assert.Equal(
            "hello\n42\nDerived2338DataExtendsData(Name=hello, Value=42)\n",
            CompileAndRun(source));
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_2338baseinit_exe_").FullName;
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
