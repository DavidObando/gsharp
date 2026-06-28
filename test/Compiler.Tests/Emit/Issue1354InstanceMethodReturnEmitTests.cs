// <copyright file="Issue1354InstanceMethodReturnEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1354 follow-up: imported INSTANCE method-call return types must honor
/// the reference-type nullability rule (oblivious/unannotated → <c>T?</c>,
/// explicit <c>[Nullable(1)]</c> → non-null) via
/// <see cref="GSharp.Core.CodeAnalysis.Symbols.ClrNullability"/>.
///
/// Before the follow-up fix, the non-generic instance-method fallback chain in
/// <c>ExpressionBinder.Calls</c> landed on a bare
/// <c>TypeSymbol.FromClrType(method.ReturnType)</c> that ignored nullability, so
/// an oblivious/annotated-nullable instance return was treated as NON-null and a
/// <c>... == nil</c> comparison was rejected with <c>GS0129</c>.
///
/// These tests build a G# library (whose emitter stamps complete nullability
/// metadata — a type-level <c>[NullableContext(1)]</c> plus per-member
/// <c>[Nullable]</c>), then compile a consumer that imports it and compares an
/// instance method's result to <c>nil</c>. The annotated-nullable return must
/// re-import as nullable (compare-to-nil compiles); the annotated-non-null
/// return must stay non-null (compare-to-nil is <c>GS0129</c>). The genuine
/// "oblivious external assembly" case (no nullability metadata at all) is
/// covered by the manual repro in the PR (gsc cannot emit an oblivious member).
/// </summary>
public class Issue1354InstanceMethodReturnEmitTests
{
    private const string LibrarySource = """
        package Lib

        class Widget {
        }

        class Factory {
            func MakeNonNull() Widget {
                return Widget()
            }

            func MakeMaybe() Widget? {
                return nil
            }
        }
        """;

    [Fact]
    public void AnnotatedNullableInstanceReturn_ComparesToNil_Compiles()
    {
        // `MakeMaybe` returns `Widget?` → re-imported as nullable → `== nil` is
        // allowed. Before the fix this fallback ignored the [Nullable(2)]
        // annotation and reported GS0129.
        var consumer = """
            package App
            import Lib

            class C {
                func F(f Factory) bool {
                    return f.MakeMaybe() == nil
                }
            }
            """;

        var (exit, stdout, stderr) = CompileConsumerAgainstLibrary(consumer);
        Assert.True(
            exit == 0,
            $"expected compile success but failed (exit {exit}).\nstdout:\n{stdout}\nstderr:\n{stderr}");
    }

    [Fact]
    public void AnnotatedNonNullInstanceReturn_ComparesToNil_IsRejected()
    {
        // `MakeNonNull` returns a non-null `Widget` (the emitter stamps
        // [NullableContext(1)]) → re-imported as non-null → `== nil` is a
        // never-null comparison and must be rejected with GS0129.
        var consumer = """
            package App
            import Lib

            class C {
                func F(f Factory) bool {
                    return f.MakeNonNull() == nil
                }
            }
            """;

        var (exit, stdout, stderr) = CompileConsumerAgainstLibrary(consumer);
        Assert.True(exit != 0, $"expected compile failure but succeeded.\nstdout:\n{stdout}\nstderr:\n{stderr}");
        Assert.Contains("GS0129", stdout + stderr);
    }

    private static (int Exit, string Stdout, string Stderr) CompileConsumerAgainstLibrary(string consumerSource)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_1354_inst_").FullName;
        try
        {
            var libSrc = Path.Combine(tempDir, "lib.gs");
            var libDll = Path.Combine(tempDir, "Lib.dll");
            File.WriteAllText(libSrc, LibrarySource);

            var libArgs = new List<string>
            {
                "/out:" + libDll,
                "/target:library",
                "/targetframework:net10.0",
                libSrc,
            };
            var (libExit, libOut, libErr) = RunCompiler(libArgs.ToArray());
            Assert.True(libExit == 0, $"library compile failed:\nstdout:\n{libOut}\nstderr:\n{libErr}");
            IlVerifier.Verify(libDll);

            var consumerSrc = Path.Combine(tempDir, "consumer.gs");
            var consumerDll = Path.Combine(tempDir, "consumer.dll");
            File.WriteAllText(consumerSrc, consumerSource);

            var args = new List<string>
            {
                "/out:" + consumerDll,
                "/target:library",
                "/targetframework:net10.0",
            };

            foreach (var reference in TrustedPlatformAssemblies())
            {
                args.Add("/reference:" + reference);
            }

            args.Add("/reference:" + libDll);
            args.Add("/nowarn:GS9100");
            args.Add(consumerSrc);

            return RunCompiler(args.ToArray());
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }

    private static (int Exit, string Stdout, string Stderr) RunCompiler(string[] args)
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

        return (compileExit, stdoutWriter.ToString(), stderrWriter.ToString());
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
