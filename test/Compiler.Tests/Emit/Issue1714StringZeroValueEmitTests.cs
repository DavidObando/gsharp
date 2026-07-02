// <copyright file="Issue1714StringZeroValueEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text.RegularExpressions;
using GSharp.Compiler;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1714: the interpreter's <c>Evaluator.DefaultValue</c> gives
/// <c>string</c> Go-style value semantics — its zero value is <c>""</c>, not
/// the CLR reference-type default <c>null</c>. Before this fix the emitted
/// IL diverged and produced <c>null</c> for a missing map value, an
/// uninitialized struct/class string field, and an unset <c>string</c>
/// auto-property. These end-to-end tests compile-and-run each scenario and
/// assert the emitted program agrees with the chosen (interpreter) zero-value
/// semantics: <c>""</c>, never <c>nil</c>. Each uses a UNIQUE package/type
/// name because the in-process <c>FunctionTypeSymbol</c> cache is name-keyed.
/// </summary>
public class Issue1714StringZeroValueEmitTests
{
    [Fact]
    public void EndToEnd_MapStringStringMiss_YieldsEmptyString()
    {
        const string source = """
            package i1714mapmiss
            import System

            func Main() {
                var m = map[string,string]{}
                let v = m["missing"]
                System.Console.WriteLine(v == "")
                System.Console.WriteLine(v == nil)
                System.Console.WriteLine("[${v}]")
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("True\nFalse\n[]\n", output);
        Assert.Equal(RunInterpreter(source), output);
    }

    [Fact]
    public void EndToEnd_StructStringField_DefaultsToEmptyString()
    {
        const string source = """
            package i1714structfield
            import System

            struct Point { var Label string var X int32 }

            func Main() {
                let p = Point{X: 5}
                System.Console.WriteLine(p.Label == "")
                System.Console.WriteLine(p.Label == nil)
                System.Console.WriteLine(p.X)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("True\nFalse\n5\n", output);

        // Not asserting interpreter parity here: a struct-literal with an
        // omitted field is constant-folded at bind time
        // (ExpressionBinder.Literals), a separate code path from
        // Evaluator.DefaultValue that pre-dates and is out of scope for this
        // fix — see EndToEnd_NestedStructStringField_DefaultDefaultsToEmptyString
        // for the `default(T)` recursion path parity IS asserted for.
    }

    [Fact]
    public void EndToEnd_ClassStringField_DefaultsToEmptyString()
    {
        const string source = """
            package i1714classfield
            import System

            class Widget { var Name string }

            func Main() {
                let w = Widget{}
                System.Console.WriteLine(w.Name == "")
                System.Console.WriteLine(w.Name == nil)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("True\nFalse\n", output);
        Assert.Equal(RunInterpreter(source), output);
    }

    [Fact]
    public void EndToEnd_ClassStringAutoProperty_DefaultsToEmptyString()
    {
        const string source = """
            package i1714autoprop
            import System

            class Widget { prop Name string { get; set; } }

            func Main() {
                let w = Widget{}
                System.Console.WriteLine(w.Name == "")
                System.Console.WriteLine(w.Name == nil)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("True\nFalse\n", output);
        Assert.Equal(RunInterpreter(source), output);
    }

    [Fact]
    public void EndToEnd_DefaultStringExpression_IsEmptyString()
    {
        const string source = """
            package i1714defaultexpr
            import System

            func Main() {
                let s string = default(string)
                System.Console.WriteLine(s == "")
                System.Console.WriteLine(s == nil)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("True\nFalse\n", output);

        // Not asserting interpreter parity here: Evaluator.EvaluateDefaultExpression
        // returns `nil` for any reference-type `default(T)` ahead of ever
        // calling DefaultValue (ADR-0100) — a separate, pre-existing code
        // path from the recursive struct-field defaulting this fix targets,
        // and out of scope for the nested-struct-field gap closed here.
    }

    [Fact]
    public void EndToEnd_NestedStructStringField_DefaultDefaultsToEmptyString()
    {
        // Reviewer follow-up gap: `Evaluator.DefaultValue(StructSymbol)`
        // recursively defaults every field, so a `string` field nested
        // INSIDE a struct-typed field also becomes `""`. The emitter's
        // post-`initobj` fixup previously patched only directly-declared
        // string fields on the outer struct — a struct-typed field's own
        // string sub-field stayed `null` after `initobj` zeroed its bytes.
        // `Inner2` adds a third nesting level to prove the fix generalizes
        // beyond one specific Outer/Inner shape.
        const string source = """
            package i1714nestedstruct
            import System

            struct Inner2 { var Str string var Tag int32 }
            struct Inner { var Str string var Deep Inner2 }
            struct Outer { var Inner Inner var Code int32 }

            func Main() {
                let o = default(Outer)
                System.Console.WriteLine(o.Inner.Str == "")
                System.Console.WriteLine(o.Inner.Str == nil)
                System.Console.WriteLine(o.Inner.Deep.Str == "")
                System.Console.WriteLine(o.Inner.Deep.Str == nil)
                System.Console.WriteLine("[${o.Inner.Str}][${o.Inner.Deep.Str}]")
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("True\nFalse\nTrue\nFalse\n[][]\n", output);
        Assert.Equal(RunInterpreter(source), output);
    }

    /// <summary>
    /// Runs <paramref name="source"/> through the interpreter (<see
    /// cref="Compilation.Evaluate"/>) instead of the emitter, capturing
    /// real <c>System.Console.WriteLine</c> output the same way the emitted
    /// executable's stdout is captured in <see cref="CompileAndRun"/>. Used
    /// to assert interpreter/emit parity so future interpreter changes to
    /// <c>Evaluator.DefaultValue</c> can't silently re-diverge from emit.
    /// </summary>
    private static string RunInterpreter(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(ToScriptSource(source)));
        var compilation = new Compilation(tree);

        using var outWriter = new StringWriter();
        var prevOut = Console.Out;
        Console.SetOut(outWriter);
        try
        {
            var result = compilation.Evaluate(new Dictionary<VariableSymbol, object>());
            Assert.Empty(result.Diagnostics);
        }
        finally
        {
            Console.SetOut(prevOut);
        }

        return outWriter.ToString().Replace("\r\n", "\n");
    }

    /// <summary>
    /// Interpreter evaluation (<see cref="Compilation.Evaluate"/>) runs the
    /// SCRIPT-mode top-level statement list, not a <c>package</c>/<c>func
    /// Main()</c> entry point (that convention is compiler/emit-only). This
    /// rewrites one of this file's `package`+`func Main()` sources into the
    /// equivalent script — same struct/import declarations, `func Main`'s
    /// body unwrapped to bare top-level statements — so <see
    /// cref="RunInterpreter"/> can run the SAME source through both paths.
    /// </summary>
    private static string ToScriptSource(string source)
    {
        var withoutPackage = Regex.Replace(source, @"(?m)^\s*package\s+\S+\r?\n", string.Empty);
        var mainIndex = withoutPackage.IndexOf("func Main() {", StringComparison.Ordinal);
        Assert.True(mainIndex >= 0, "Expected a `func Main() { ... }` entry point in the test source.");

        var braceStart = withoutPackage.IndexOf('{', mainIndex);
        var depth = 0;
        var i = braceStart;
        for (; i < withoutPackage.Length; i++)
        {
            if (withoutPackage[i] == '{')
            {
                depth++;
            }
            else if (withoutPackage[i] == '}')
            {
                depth--;
                if (depth == 0)
                {
                    break;
                }
            }
        }

        var preamble = withoutPackage.Substring(0, mainIndex);
        var body = withoutPackage.Substring(braceStart + 1, i - braceStart - 1);
        return preamble + body;
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_1714_exe_").FullName;
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
