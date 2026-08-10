// <copyright file="Issue3329CrossAssemblyStructLiteralEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #3329 — a struct literal (<c>S{}</c>) for a struct type declared in
/// ANOTHER (already-compiled) assembly lost its ADR-0159 "sound zero value"
/// instance-field initializer for a magic-collection-typed field (map/slice/
/// fixed array/sequence), leaving the field at its raw CLR default (a null
/// reference for a reference-backed collection) and NREing at runtime the
/// first time the field is used. The REPL hits this identically on a
/// cross-cell struct, since each submission is a distinct assembly (ADR-0156)
/// — these tests exercise the SAME code paths (<c>ImportedTypeSymbol.
/// BuildSemanticAggregate</c> for a <c>data struct</c>/primary-ctor struct,
/// <c>ExpressionBinder.BindImportedTypeObjectInitializer</c> for a plain
/// struct) through ordinary cross-assembly `gsc` compilation plus ILVerify,
/// which is more convenient to drive from a test than a REPL session and
/// confirms the fix is not REPL-specific.
/// </summary>
public class Issue3329CrossAssemblyStructLiteralEmitTests
{
    [Fact]
    public void PlainStruct_EmptyLiteral_SliceField_ZeroInitializesToEmptyNotNull()
    {
        const string library = """
            package i3329lib1

            struct S {
                public var Items []int32
            }
            """;

        const string source = """
            package i3329a
            import i3329lib1

            func Main() {
                let s = S{}
                System.Console.WriteLine(s.Items.Length)
            }
            """;

        Assert.Equal($"0{Environment.NewLine}", CompileAndRun(source, library, "i3329lib1"));
    }

    [Fact]
    public void DataStruct_EmptyLiteral_SliceField_ZeroInitializesToEmptyNotNull()
    {
        const string library = """
            package i3329lib2

            data struct S {
                public var Items []int32
            }
            """;

        const string source = """
            package i3329b
            import i3329lib2

            func Main() {
                let s = S{}
                System.Console.WriteLine(s.Items.Length)
            }
            """;

        Assert.Equal($"0{Environment.NewLine}", CompileAndRun(source, library, "i3329lib2"));
    }

    [Fact]
    public void PlainStruct_EmptyLiteral_MapField_ZeroInitializesToEmptyNotNull()
    {
        const string library = """
            package i3329lib3

            struct S {
                public var M map[string, int32]
            }
            """;

        const string source = """
            package i3329c
            import i3329lib3

            func Main() {
                let s = S{}
                System.Console.WriteLine(s.M.Count)
            }
            """;

        Assert.Equal($"0{Environment.NewLine}", CompileAndRun(source, library, "i3329lib3"));
    }

    [Fact]
    public void PlainStruct_EmptyLiteral_SequenceField_ZeroInitializesToEmptyNotNull()
    {
        const string library = """
            package i3329lib4

            struct S {
                public var Seq sequence[int32]
            }
            """;

        const string source = """
            package i3329d
            import i3329lib4

            func Main() {
                let s = S{}
                var n = 0
                for x in s.Seq {
                    n = n + 1
                }
                System.Console.WriteLine(n)
            }
            """;

        Assert.Equal($"0{Environment.NewLine}", CompileAndRun(source, library, "i3329lib4"));
    }

    [Fact]
    public void PlainStruct_EmptyLiteral_FixedArrayField_ZeroInitializesToDeclaredLength()
    {
        const string library = """
            package i3329lib5

            struct S {
                public var Buf [4]int32
            }
            """;

        const string source = """
            package i3329e
            import i3329lib5

            func Main() {
                let s = S{}
                System.Console.WriteLine(s.Buf.Length)
            }
            """;

        Assert.Equal($"4{Environment.NewLine}", CompileAndRun(source, library, "i3329lib5"));
    }

    [Fact]
    public void PlainStruct_LiteralWithExplicitFieldInitializer_MagicCollectionFieldStillZeroInits()
    {
        // The literal explicitly sets ONE field; the OTHER (magic-collection)
        // field is left unset and must still get its sound zero value.
        const string library = """
            package i3329lib6

            struct S {
                public var X int32
                public var Items []int32
            }
            """;

        const string source = """
            package i3329f
            import i3329lib6

            func Main() {
                let s = S{X: 7}
                System.Console.WriteLine(s.X.ToString() + "," + s.Items.Length.ToString())
            }
            """;

        Assert.Equal($"7,0{Environment.NewLine}", CompileAndRun(source, library, "i3329lib6"));
    }

    [Fact]
    public void NestedStructInStruct_BothDeclaredInLibrary_OuterLiteralWithExplicitInnerWorks()
    {
        // Issue #3329 scope note: recursing an OUTER struct literal's own
        // zero-value synthesis INTO an inner struct-typed field that itself
        // needs a magic-collection zero value is issue #3319 (same-assembly
        // recursion — reproduces identically with no library reference at
        // all, confirmed unrelated to #3329's cross-assembly token gap and
        // deliberately left out of this issue's scope). This test instead
        // pins the shape #3329 IS responsible for: an outer struct literal
        // for a type whose nested-struct field is ALSO declared in another
        // assembly, explicitly initialized (not recursively zero-valued).
        const string library = """
            package i3329lib7

            struct Inner {
                public var X int32
            }

            struct Outer {
                public var I Inner
            }
            """;

        const string source = """
            package i3329g
            import i3329lib7

            func Main() {
                let o = Outer{I: Inner{X: 5}}
                System.Console.WriteLine(o.I.X)
            }
            """;

        Assert.Equal($"5{Environment.NewLine}", CompileAndRun(source, library, "i3329lib7"));
    }

    [Fact]
    public void NestedStructInStruct_BothDeclaredInLibrary_OuterLiteralZeroInitsInnerMagicField()
    {
        // Issue #3329 x #3330 composition: PR #3330 (issue #3319) added
        // SAME-ASSEMBLY recursion so an outer struct literal's own
        // zero-value synthesis walks INTO an inner struct-typed field that
        // itself needs a magic-collection zero value. #3330 postdates this
        // PR's original design (which explicitly scoped that case OUT, see
        // the test above), so this pins the case the two fixes need to get
        // right TOGETHER: `Outer{}` constructed from ANOTHER (consumer)
        // assembly, where `Outer.I Inner` is left unset and `Inner` itself
        // has an unset magic-collection field — the composed zero value must
        // reach all the way through the cross-assembly reconstruction AND
        // the nested-struct recursion.
        const string library = """
            package i3329lib8

            struct Inner {
                public var Items []int32
            }

            struct Outer {
                public var I Inner
            }
            """;

        const string source = """
            package i3329i
            import i3329lib8

            func Main() {
                let o = Outer{}
                System.Console.WriteLine(o.I.Items.Length)
            }
            """;

        Assert.Equal($"0{Environment.NewLine}", CompileAndRun(source, library, "i3329lib8"));
    }

    [Fact]
    public void DataStructNestedInStruct_BothDeclaredInLibrary_OuterLiteralZeroInitsInnerMagicField()
    {
        // Same composed shape as above, but the INNER struct is a `data
        // struct` (routes through ImportedTypeSymbol.BuildSemanticAggregate
        // on reconstruction, rather than ExpressionBinder.
        // BindImportedTypeObjectInitializer's plain-struct fallback) —
        // confirms the composition holds on both cross-assembly
        // reconstruction paths, not just the plain-struct one.
        const string library = """
            package i3329lib9

            data struct Inner {
                public var Items []int32
            }

            struct Outer {
                public var I Inner
            }
            """;

        const string source = """
            package i3329j
            import i3329lib9

            func Main() {
                let o = Outer{}
                System.Console.WriteLine(o.I.Items.Length)
            }
            """;

        Assert.Equal($"0{Environment.NewLine}", CompileAndRun(source, library, "i3329lib9"));
    }

    [Fact]
    public void SameAssembly_StructLiteral_SliceField_RegressionPin()
    {
        // Control: a same-compilation struct literal must keep working
        // exactly as before (no library reference at all).
        const string source = """
            package i3329h

            struct S {
                public var Items []int32
            }

            func Main() {
                let s = S{}
                System.Console.WriteLine(s.Items.Length)
            }
            """;

        Assert.Equal($"0{Environment.NewLine}", CompileAndRun(source));
    }

    private static string CompileAndRun(string source, string library = null, string libraryAssemblyName = null)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_3329_").FullName;
        try
        {
            var dllPath = BuildExecutable(tempDir, source, library, libraryAssemblyName, out var libDll);

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

            IlVerifier.Verify(dllPath, libDll != null ? new[] { libDll } : null);

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

            return stdout.ReplaceLineEndings(Environment.NewLine);
        }
        finally
        {
            try
            {
                Directory.Delete(tempDir, recursive: true);
            }
            catch (IOException)
            {
            }
        }
    }

    private static string BuildExecutable(
        string tempDir,
        string source,
        string library,
        string libraryAssemblyName,
        out string libDll)
    {
        libDll = null;
        if (library != null)
        {
            // ilverify resolves `-r` references by FILE NAME, so the library
            // must be written out under its assembly identity.
            var libSrc = Path.Combine(tempDir, libraryAssemblyName + ".gs");
            libDll = Path.Combine(tempDir, libraryAssemblyName + ".dll");
            File.WriteAllText(libSrc, library);
            Compile(new[]
            {
                "/out:" + libDll,
                "/target:library",
                "/targetframework:net10.0",
                libSrc,
            });
            IlVerifier.Verify(libDll);
        }

        var srcPath = Path.Combine(tempDir, "test.gs");
        var dllPath = Path.Combine(tempDir, "test.dll");
        File.WriteAllText(srcPath, source);

        var args = new List<string>
        {
            "/out:" + dllPath,
            "/target:exe",
            "/targetframework:net10.0",
        };
        if (libDll != null)
        {
            args.Add("/r:" + libDll);
        }

        args.Add(srcPath);
        Compile(args.ToArray());
        return dllPath;
    }

    private static void Compile(string[] args)
    {
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
    }
}
