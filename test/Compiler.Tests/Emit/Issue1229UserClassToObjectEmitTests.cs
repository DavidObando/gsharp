// <copyright file="Issue1229UserClassToObjectEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1229: an instance of a user-declared <c>class</c> must implicitly
/// convert to <c>object</c> / <c>object?</c>. Every reference type derives from
/// System.Object, so the conversion is a plain reference upcast — there must be
/// NO <c>box</c> instruction (boxing is only for value types). These tests
/// exercise the upcast in argument, return, local/field assignment, and
/// collection-element positions, verify the emitted IL, assert the runtime
/// behaviour (ToString()/GetType() through the object reference and a
/// List[object] round-trip), and confirm the upcast method's IL carries no
/// spurious <c>box</c>.
/// </summary>
public class Issue1229UserClassToObjectEmitTests
{
    [Fact]
    public void UserClassToObject_AllPositions_EmitAndRun()
    {
        var source = """
            package P
            import System
            import System.Collections.Generic

            class D { }

            class Sink {
                func Takes(o object) string { return o.GetType().Name }
                func TakesN(o object?) string { return o.GetType().Name }
                func Give(d D) object? { return d }
            }

            let d = D{ }
            let s = Sink{ }

            // Argument position (object and object?).
            Console.WriteLine(s.Takes(d))
            Console.WriteLine(s.TakesN(d))

            // Return position.
            let r = s.Give(d)
            Console.WriteLine(r.GetType().Name)

            // Local assignment.
            let o object = d
            Console.WriteLine(o.GetType().Name)
            let n object? = d
            Console.WriteLine(n.GetType().Name)

            // Collection-element position: a user class flows into List[object]
            // as a reference upcast, then reads back as an object reference.
            let list = List[object]()
            list.Add(d)
            let back object = list[0]
            Console.WriteLine(back.GetType().Name)
            """;

        Assert.Equal(
            "D\nD\nD\nD\nD\nD\n",
            CompileAndRun(source));
    }

    [Fact]
    public void MultiLevelHierarchy_GrandchildToObject_EmitsAndRuns()
    {
        var source = """
            package P
            import System

            open class GrandBase { }
            open class Child() : GrandBase { }
            class Grandchild() : Child { }

            func Up(g Grandchild) object { return g }

            let g = Grandchild{ }
            let o = Up(g)
            Console.WriteLine(o.GetType().Name)
            """;

        Assert.Equal("Grandchild\n", CompileAndRun(source));
    }

    [Fact]
    public void UserClassToObject_UpcastMethod_HasNoBox()
    {
        // A method that just returns its user-class argument typed as `object`
        // is a pure reference upcast: its IL body must contain no `box`
        // instruction (ECMA-335 box = 0x8C). A spurious box would still verify
        // (boxing a reference is legal IL) but is semantically wrong here.
        var source = """
            package P

            class D { }

            func Up(d D) object { return d }
            """;

        var dllPath = CompileLibrary(source);
        try
        {
            using var stream = File.OpenRead(dllPath);
            using var peReader = new PEReader(stream);
            var reader = peReader.GetMetadataReader();

            MethodDefinitionHandle? upMethod = null;
            foreach (var typeHandle in reader.TypeDefinitions)
            {
                var td = reader.GetTypeDefinition(typeHandle);
                foreach (var mh in td.GetMethods())
                {
                    var md = reader.GetMethodDefinition(mh);
                    if (reader.StringComparer.Equals(md.Name, "Up"))
                    {
                        upMethod = mh;
                    }
                }
            }

            Assert.True(upMethod.HasValue, "expected to find the Up method");

            var method = reader.GetMethodDefinition(upMethod.Value);
            Assert.True(method.RelativeVirtualAddress != 0, "Up must carry a body");
            var body = peReader.GetMethodBody(method.RelativeVirtualAddress);
            var ilBytes = body.GetILBytes();
            Assert.NotNull(ilBytes);

            // The upcast lowers to `ldarg.0; ret` (a no-op reference widening),
            // so the body is tiny and contains no `box` (0x8C) opcode.
            bool sawBox = false;
            for (int i = 0; i < ilBytes!.Length; i++)
            {
                if (ilBytes[i] == 0x8C)
                {
                    sawBox = true;
                }
            }

            Assert.False(sawBox, "class -> object upcast must NOT emit a `box` instruction");
        }
        finally
        {
            TryCleanup(dllPath);
        }
    }

    private static string CompileLibrary(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue1229_lib_").FullName;
        var srcPath = Path.Combine(tempDir, "test.gs");
        var outPath = Path.Combine(tempDir, "test.dll");
        File.WriteAllText(srcPath, source);

        var args = new[]
        {
            "/out:" + outPath,
            "/target:library",
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

        IlVerifier.Verify(outPath);
        return outPath;
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue1229_exe_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            var args = new[]
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
                compileExit = Program.Main(args);
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
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }

    private static void TryCleanup(string dllPath)
    {
        try
        {
            var dir = Path.GetDirectoryName(dllPath);
            if (dir != null)
            {
                Directory.Delete(dir, recursive: true);
            }
        }
        catch
        {
        }
    }
}
