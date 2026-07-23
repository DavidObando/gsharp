// <copyright file="Issue1714StringZeroValueEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
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
/// Issue #1714: language zero values and CLR storage defaults are distinct.
/// Map misses retain the language's empty-string zero value, while fields and
/// auto-property backing fields retain the CLR default for their storage type.
/// Each source uses unique package/type names because the in-process
/// <c>FunctionTypeSymbol</c> cache is name-keyed.
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
    public void EndToEnd_StructStringField_DefaultsToNull()
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
        Assert.Equal("False\nTrue\n5\n", output);
        Assert.Equal(RunInterpreter(source), output);
    }

    [Fact]
    public void EndToEnd_ClassStringField_DefaultsToNull()
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
        Assert.Equal("False\nTrue\n", output);
        Assert.Equal(RunInterpreter(source), output);
    }

    [Fact]
    public void EndToEnd_ClassStringAutoProperty_DefaultsToNull()
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
        Assert.Equal("False\nTrue\n", output);
        Assert.Equal(RunInterpreter(source), output);
    }

    [Fact]
    public void EndToEnd_DefaultStringExpression_IsNull()
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
        Assert.Equal("False\nTrue\n", output);
        Assert.Equal(RunInterpreter(source), output);
    }

    [Fact]
    public void EndToEnd_NestedStructStringFields_DefaultToNull()
    {
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
        Assert.Equal("False\nTrue\nFalse\nTrue\n[][]\n", output);
        Assert.Equal(RunInterpreter(source), output);
    }

    [Fact]
    public void EndToEnd_InstanceAndStaticReferenceFields_MatchClrDefaults()
    {
        const string source = """
            package i1714references
            import System

            class Child {}

            struct StructHolder {
                var Empty string = ""
            }

            class Holder {
                var Text string
                var MaybeText string?
                var Value object
                var Items []int32
                var ChildValue Child
                var Empty string = ""

                func InstanceDefaultsAreCorrect() bool {
                    return Text == nil && MaybeText == nil && ChildValue == nil && Empty == ""
                }

                shared {
                    var SharedText string
                    var SharedValue object
                    var SharedItems []int32
                    var SharedChild Child?

                    func DefaultsAreCorrect() bool {
                        return SharedText == nil && SharedChild == nil
                    }
                }
            }

            func Main() {
                Console.WriteLine(Holder{}.InstanceDefaultsAreCorrect())
                Console.WriteLine(Holder.DefaultsAreCorrect())
                Console.WriteLine(StructHolder{}.Empty == "")
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("True\nTrue\nTrue\n", output);
        Assert.Equal(RunInterpreter(source), output);
    }

    [Fact]
    public void Reflection_ReferenceFields_UseClrNullAndPreserveAnnotationsAndInitializer()
    {
        const string source = """
            package i1714reflection

            class Child {}

            class ClassFields {
                public var Text string
                public var MaybeText string?
                public var Value object
                public var Items []int32
                public var ChildValue Child
                public var Empty string = ""
                shared {
                    public var SharedText string
                    public var SharedValue object
                    public var SharedItems []int32
                    public var SharedChild Child?
                }
            }

            struct StructFields {
                public var Text string
                public var MaybeText string?
                public var Value object
                public var Items []int32
                public var ChildValue Child
            }
            """;

        var assembly = CompileToAssembly(source);
        var classType = assembly.GetTypes().Single(t => t.Name == "ClassFields");
        var classValue = Activator.CreateInstance(classType);
        var structType = assembly.GetTypes().Single(t => t.Name == "StructFields");
        var structValue = Activator.CreateInstance(structType);

        foreach (var name in new[] { "Text", "MaybeText", "Value", "Items", "ChildValue" })
        {
            Assert.Null(classType.GetField(name)!.GetValue(classValue));
            Assert.Null(structType.GetField(name)!.GetValue(structValue));
        }

        Assert.Null(classType.GetField("SharedText")!.GetValue(null));
        Assert.Null(classType.GetField("SharedValue")!.GetValue(null));
        Assert.Null(classType.GetField("SharedItems")!.GetValue(null));
        Assert.Null(classType.GetField("SharedChild")!.GetValue(null));
        Assert.Equal(string.Empty, classType.GetField("Empty")!.GetValue(classValue));

        var nullability = new NullabilityInfoContext();
        Assert.Equal(NullabilityState.NotNull, nullability.Create(classType.GetField("Text")!).ReadState);
        Assert.Equal(NullabilityState.Nullable, nullability.Create(classType.GetField("MaybeText")!).ReadState);
        Assert.Equal(NullabilityState.NotNull, nullability.Create(classType.GetField("Value")!).ReadState);
        Assert.Equal(NullabilityState.NotNull, nullability.Create(classType.GetField("Items")!).ReadState);
        Assert.Equal(NullabilityState.NotNull, nullability.Create(classType.GetField("ChildValue")!).ReadState);
        Assert.Equal(NullabilityState.NotNull, nullability.Create(classType.GetField("SharedText")!).ReadState);
        Assert.Equal(NullabilityState.NotNull, nullability.Create(classType.GetField("SharedValue")!).ReadState);
        Assert.Equal(NullabilityState.NotNull, nullability.Create(classType.GetField("SharedItems")!).ReadState);
        Assert.Equal(NullabilityState.Nullable, nullability.Create(classType.GetField("SharedChild")!).ReadState);
        Assert.Equal(NullabilityState.NotNull, nullability.Create(structType.GetField("Text")!).ReadState);
        Assert.Equal(NullabilityState.Nullable, nullability.Create(structType.GetField("MaybeText")!).ReadState);
    }

    [Fact]
    public void FieldDefaults_DoNotChangeDefiniteAssignmentDiagnostics()
    {
        const string fields = """
            package i1714fielddiagnostics
            class Child {}
            class Box {
                var Text string
                var ChildValue Child
            }
            """;
        var fieldsResult = Evaluate(fields);
        Assert.Empty(fieldsResult.Diagnostics);

        const string unassignedOut = """
            package i1714outdiagnostics
            func bad(out value string) {
                return
            }
            """;
        var outResult = Evaluate(unassignedOut);
        Assert.Contains(outResult.Diagnostics, d => d.Id == "GS0238");
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

    private static EvaluationResult Evaluate(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        return new Compilation(tree).Evaluate(new Dictionary<VariableSymbol, object>());
    }

    private static Assembly CompileToAssembly(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_1714_reflection_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var dllPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            var exitCode = Program.Main(new[]
            {
                "/out:" + dllPath,
                "/target:library",
                "/targetframework:net10.0",
                srcPath,
            });
            Assert.Equal(0, exitCode);
            IlVerifier.Verify(dllPath);
            return Assembly.Load(File.ReadAllBytes(dllPath));
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
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
