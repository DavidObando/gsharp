// <copyright file="Issue2364PrimaryConstructorConversionEmitTests.cs" company="GSharp">
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
/// Issue #2364: the fixed-arity (non-optional-parameter) argument-binding loop
/// in <c>OverloadResolver.BindConstructorCallExpressionCore</c> validated that
/// an argument's conversion to its primary-constructor parameter type was
/// implicit, but never actually bound/emitted it. The compile succeeded and
/// diagnostics were clean, but the emitted IL left the raw (unconverted)
/// argument on the stack where the constructor's signature expected the
/// converted type — producing unverifiable IL
/// (<c>System.Reflection.Metadata.BadImageFormatException</c> /
/// ILVerify <c>StackUnexpected</c>) despite a clean compile.
///
/// These tests compile end-to-end, run <c>ilverify</c> on the emitted
/// assembly, and execute it, for every real-world shape encountered in the
/// Oahu migration corpus (a <c>switch</c> expression returning primary-ctor
/// data-class instances built from <c>int32</c> literals into
/// <c>int32?</c> parameters — the exact <c>ExCodec.ToQuality</c> /
/// <c>AudioQuality</c> shape) plus generalized coverage of nullable-wrap,
/// widening, generic, and user-defined conversions, and control cases for the
/// sibling paths (explicit <c>init(...)</c> ctor, optional-parameter primary
/// ctor, plain function call) that were already correct before the fix.
/// </summary>
public class Issue2364PrimaryConstructorConversionEmitTests
{
    [Fact]
    public void OahuAudioQualityShape_SwitchExpressionOfPrimaryCtorCalls_CompilesVerifiesAndRuns()
    {
        // Exact shape of Oahu.Data's ExCodec.ToQuality / AudioQuality
        // (open data class primary ctor with int32? params, built from int32
        // literals inside a switch-expression arm).
        var source = """
            package AudioQualityShapePkg

            import System

            enum ECodec { Aax2232, Aax2264, Aax4464, Aax44128 }

            open data class AudioQuality(SampleRate int32?, BitRate int32?) {
            }

            class ExCodec {
                shared {
                    func ToQuality(codec ECodec) AudioQuality? {
                        return switch codec {
                            case ECodec.Aax2232: AudioQuality(22050, 32)
                            case ECodec.Aax2264: AudioQuality(22050, 64)
                            case ECodec.Aax4464: AudioQuality(44100, 64)
                            case ECodec.Aax44128: AudioQuality(44100, 128)
                            default: default(AudioQuality?)
                        }
                    }
                }
            }

            let q = ExCodec.ToQuality(ECodec.Aax2232)!!
            Console.WriteLine(q.SampleRate)
            Console.WriteLine(q.BitRate)
            """;

        Assert.Equal("22050\n32\n", CompileAndRun(source));
    }

    [Fact]
    public void ExactArityPrimaryCtor_IntLiteralIntoNullableParams_CompilesVerifiesAndRuns()
    {
        var source = """
            package NullableParamsPkg

            import System

            class Plain(SampleRate int32?, BitRate int32?) {
            }

            let p = Plain(22050, 32)
            Console.WriteLine(p.SampleRate)
            Console.WriteLine(p.BitRate)
            """;

        Assert.Equal("22050\n32\n", CompileAndRun(source));
    }

    [Fact]
    public void ExactArityPrimaryCtor_IntLiteralIntoWideningParams_CompilesVerifiesAndRuns()
    {
        var source = """
            package WideningParamsPkg

            import System

            class Wide(BigNum int64, Frac double) {
            }

            let w = Wide(22050, 32)
            Console.WriteLine(w.BigNum)
            Console.WriteLine(w.Frac)
            """;

        Assert.Equal("22050\n32\n", CompileAndRun(source));
    }

    [Fact]
    public void ExactArityPrimaryCtor_DataClass_CompilesVerifiesAndRuns()
    {
        var source = """
            package DataClassPkg

            import System

            open data class AudioQuality(SampleRate int32?, BitRate int32?) {
            }

            let q = AudioQuality(22050, 32)
            Console.WriteLine(q.SampleRate)
            Console.WriteLine(q.BitRate)
            """;

        Assert.Equal("22050\n32\n", CompileAndRun(source));
    }

    [Fact]
    public void ExactArityPrimaryCtor_NonLiteralVariableArgument_CompilesVerifiesAndRuns()
    {
        var source = """
            package NonLiteralArgPkg

            import System

            class Plain(SampleRate int32?, BitRate int32?) {
            }

            func Make(a int32, b int32) Plain {
                return Plain(a, b)
            }

            let p = Make(22050, 32)
            Console.WriteLine(p.SampleRate)
            Console.WriteLine(p.BitRate)
            """;

        Assert.Equal("22050\n32\n", CompileAndRun(source));
    }

    [Fact]
    public void ExactArityPrimaryCtor_GenericClass_CompilesVerifiesAndRuns()
    {
        var source = """
            package GenericPrimaryCtorPkg

            import System

            class Box[T any](Value T) {
            }

            let b = Box[int64?](22050)
            Console.WriteLine(b.Value)
            """;

        Assert.Equal("22050\n", CompileAndRun(source));
    }

    [Fact]
    public void ExactArityPrimaryCtor_UserDefinedImplicitConversion_CompilesVerifiesAndRuns()
    {
        var source = """
            package UserDefinedConversionPkg

            import System

            struct Meters {
                var V int32
                func operator implicit (v int32) Meters {
                    return Meters{V: v}
                }
            }

            class Holder(Distance Meters) {
            }

            let h = Holder(5)
            Console.WriteLine(h.Distance.V)
            """;

        Assert.Equal("5\n", CompileAndRun(source));
    }

    // --- Control cases: sibling paths that were already correct and must
    // remain unaffected by the fix. ---

    [Fact]
    public void Control_ExplicitInitConstructor_CompilesVerifiesAndRuns()
    {
        var source = """
            package ExplicitCtorControlPkg

            import System

            class Plain {
                var SampleRate int32?
                var BitRate int32?
                init(sampleRate int32?, bitRate int32?) {
                    this.SampleRate = sampleRate
                    this.BitRate = bitRate
                }
            }

            let p = Plain(22050, 32)
            Console.WriteLine(p.SampleRate)
            Console.WriteLine(p.BitRate)
            """;

        Assert.Equal("22050\n32\n", CompileAndRun(source));
    }

    [Fact]
    public void Control_OptionalParameterPrimaryCtor_CompilesVerifiesAndRuns()
    {
        var source = """
            package OptionalParamControlPkg

            import System

            class Plain(SampleRate int32?, BitRate int32? = nil) {
            }

            let p = Plain(22050, 32)
            Console.WriteLine(p.SampleRate)
            Console.WriteLine(p.BitRate)
            """;

        Assert.Equal("22050\n32\n", CompileAndRun(source));
    }

    [Fact]
    public void Control_RegularFunctionCall_CompilesVerifiesAndRuns()
    {
        var source = """
            package RegularCallControlPkg

            import System

            func Foo(x int32?) int32? {
                return x
            }

            Console.WriteLine(Foo(5))
            """;

        Assert.Equal("5\n", CompileAndRun(source));
    }

    private static string CompileAndRun(string source)
    {
        var (exitCode, stdout, stderr) = CompileAndRunRaw(source);
        Assert.True(
            exitCode == 0,
            $"exited {exitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");
        return stdout;
    }

    private static (int ExitCode, string Stdout, string Stderr) CompileAndRunRaw(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue2364_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
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

            Assert.True(
                compileExit == 0,
                $"gsc failed:\nstdout:\n{compileOut}\nstderr:\n{compileErr}");

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
            return (proc.ExitCode, stdout.Replace("\r\n", "\n"), stderr.Replace("\r\n", "\n"));
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
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
