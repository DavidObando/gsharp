// <copyright file="Issue946InitOnlyPropertyEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Runtime.Loader;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #946 regression tests for the first-class <c>init</c> property
/// accessor. The G# property forms <c>{ get; init; }</c> (auto) and
/// <c>init { ... }</c> (computed) are exercised end-to-end:
/// <list type="bullet">
///   <item>an init-only property set through a C#-style object initializer at
///   the creation site is read back at runtime;</item>
///   <item>an init-only property set inside the declaring type's constructor is
///   read back at runtime;</item>
///   <item>assigning an init-only property <em>after</em> construction is a
///   compile error (<c>GS0372</c>);</item>
///   <item>the emitted <c>set_Prop</c> setter carries the
///   <c>System.Runtime.CompilerServices.IsExternalInit</c> modreq on its void
///   return — the standard CLR encoding for init-only setters.</item>
/// </list>
/// The run tests compile a hermetic program with <c>gsc</c> in-process, IL
/// verify the produced assembly, and execute it with <c>dotnet exec</c>.
/// </summary>
public class Issue946InitOnlyPropertyEmitTests
{
    [Fact]
    public void AutoInitProperty_SetViaObjectInitializer_RoundTrips()
    {
        var source = """
            package P
            import System

            class Config {
                prop Host string { get; init; }
                prop Port int32 { get; init; }
            }

            let c = Config() { Host = "localhost", Port = 8080 }
            Console.WriteLine(c.Host)
            Console.WriteLine(c.Port)
            """;

        Assert.Equal("localhost\n8080\n", CompileAndRun(source));
    }

    [Fact]
    public void AutoInitProperty_SetViaConstructor_RoundTrips()
    {
        var source = """
            package P
            import System

            class Person {
                prop Name string { get; init; }
                prop Age int32 { get; init; }

                init(name string) {
                    this.Name = name
                    this.Age = 30
                }
            }

            let a = Person("ctor")
            Console.WriteLine(a.Name)
            Console.WriteLine(a.Age)
            """;

        Assert.Equal("ctor\n30\n", CompileAndRun(source));
    }

    [Fact]
    public void ComputedInitAccessor_WithBody_RunsAtInitialization()
    {
        var source = """
            package P
            import System

            class Box {
                var raw int32
                prop Value int32 {
                    get { return raw }
                    init { raw = value * 2 }
                }
            }

            let x = Box() { Value = 21 }
            Console.WriteLine(x.Value)
            """;

        Assert.Equal("42\n", CompileAndRun(source));
    }

    [Fact]
    public void EmittedInitSetter_CarriesIsExternalInitModReq()
    {
        var source = """
            package P
            import System

            class Config {
                prop Host string { get; init; }
                prop Port int32 { get; set; }
            }

            let c = Config() { Host = "h", Port = 1 }
            Console.WriteLine(c.Host)
            """;

        var tempDir = Directory.CreateTempSubdirectory("gs_issue946_modreq_").FullName;
        try
        {
            var outPath = Path.Combine(tempDir, "test.dll");
            var (exit, output) = Compile(source, outPath, tempDir);
            Assert.True(exit == 0, $"gsc failed: {output}");

            var alc = new AssemblyLoadContext("issue946-modreq", isCollectible: true);
            try
            {
                var asm = alc.LoadFromAssemblyPath(outPath);
                var configType = asm.GetTypes().FirstOrDefault(t => t.Name == "Config")
                    ?? throw new InvalidOperationException("Config type not found");

                // The init-only property's setter return must carry the
                // IsExternalInit modreq; the plain `set;` property must not.
                var initSetter = configType.GetProperty("Host")!.SetMethod!;
                var initMods = initSetter.ReturnParameter.GetRequiredCustomModifiers();
                Assert.Contains(initMods, t => t == typeof(IsExternalInit));

                var plainSetter = configType.GetProperty("Port")!.SetMethod!;
                var plainMods = plainSetter.ReturnParameter.GetRequiredCustomModifiers();
                Assert.DoesNotContain(plainMods, t => t == typeof(IsExternalInit));
            }
            finally
            {
                alc.Unload();
            }
        }
        finally
        {
            TryDeleteDirectory(tempDir);
        }
    }

    [Fact]
    public void AssigningInitOnlyProperty_AfterConstruction_IsCompileError()
    {
        // Negative test: a plain assignment to an init-only G# property outside
        // any object-initialization context must report GS0372.
        var source = """
            package P

            class Person {
                prop Name string { get; init; }
            }

            let a = Person()
            a.Name = "after"
            """;

        var tree = SyntaxTree.Parse(SourceText.From(source, "issue946_negative.gs"));
        var compilation = new Compilation(tree);
        using var peStream = new MemoryStream();
        var result = compilation.Emit(peStream, refStream: null);

        Assert.False(result.Success);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0372");
    }

    [Fact]
    public void DeclaringBothSetAndInit_IsCompileError()
    {
        var source = """
            package P

            class C {
                prop X int32 { get; set; init; }
            }
            """;

        var tree = SyntaxTree.Parse(SourceText.From(source, "issue946_both.gs"));
        var compilation = new Compilation(tree);
        using var peStream = new MemoryStream();
        var result = compilation.Emit(peStream, refStream: null);

        Assert.Contains(result.Diagnostics, d => d.Id == "GS0373");
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue946_").FullName;
        try
        {
            var outPath = Path.Combine(tempDir, "test.dll");
            var (exit, output) = Compile(source, outPath, tempDir);
            Assert.True(exit == 0, $"gsc failed: {output}");

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
            Assert.True(
                proc.ExitCode == 0,
                $"exited {proc.ExitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");

            return stdout.Replace("\r\n", "\n");
        }
        finally
        {
            TryDeleteDirectory(tempDir);
        }
    }

    private static (int Exit, string Output) Compile(string source, string outPath, string tempDir)
    {
        var srcPath = Path.Combine(tempDir, "test.gs");
        File.WriteAllText(srcPath, source);

        var args = new List<string>
        {
            "/out:" + outPath,
            "/target:exe",
            "/targetframework:net10.0",
            "/nowarn:GS9100",
        };

        foreach (var bcl in BclReferences.Value)
        {
            args.Add("/r:" + bcl);
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

        return (compileExit, $"stdout:\n{compileOut}\nstderr:\n{compileErr}");
    }

    private static void TryDeleteDirectory(string dir)
    {
        try
        {
            Directory.Delete(dir, recursive: true);
        }
        catch
        {
            // Best-effort cleanup; the OS reclaims scratch directories later.
        }
    }

    private static readonly Lazy<IReadOnlyList<string>> BclReferences = new(() =>
    {
        var runtimeDir = Path.GetDirectoryName(typeof(object).Assembly.Location);
        if (string.IsNullOrEmpty(runtimeDir) || !Directory.Exists(runtimeDir))
        {
            return Array.Empty<string>();
        }

        return Directory.EnumerateFiles(runtimeDir, "*.dll", SearchOption.TopDirectoryOnly)
            .Where(p =>
            {
                var name = Path.GetFileName(p);
                return name.StartsWith("System.", StringComparison.OrdinalIgnoreCase)
                    || string.Equals(name, "mscorlib.dll", StringComparison.OrdinalIgnoreCase)
                    || string.Equals(name, "netstandard.dll", StringComparison.OrdinalIgnoreCase);
            })
            .ToList();
    });
}
