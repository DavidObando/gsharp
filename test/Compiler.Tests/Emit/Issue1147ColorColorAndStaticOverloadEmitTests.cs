// <copyright file="Issue1147ColorColorAndStaticOverloadEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1147: end-to-end emit + runtime validation that unified instance +
/// static (<c>shared</c>) overload resolution selects — and runs — the correct
/// overload for both facets:
///
/// <list type="bullet">
/// <item><description>
/// Facet A — the "Color Color" rule: a member-access receiver naming both a
/// value and a same-named type binds the INSTANCE overload when applicable.
/// </description></item>
/// <item><description>
/// Facet B — a bare unqualified call inside an instance method resolves against
/// the combined instance + static overload set and dispatches the STATIC
/// overload when that is the applicable one.
/// </description></item>
/// </list>
///
/// Each body returns a distinguishable sentinel so the runtime result proves
/// which overload was selected.
/// </summary>
public class Issue1147ColorColorAndStaticOverloadEmitTests
{
    [Fact]
    public void FacetA_ColorColor_SelectsInstanceOverload_AtRuntime()
    {
        var source = """
            package p
            import System
            class Tag { }
            class AppleListBox {
                func GetTagString(name string) string? { return "instance:" + name }
                shared {
                    func GetTagString(tagBox Tag?) string? { return "static" }
                }
            }
            class Owner {
                prop AppleListBox AppleListBox {
                    get { return AppleListBox() }
                }
                func Title() string? {
                    return AppleListBox.GetTagString("title")
                }
            }
            var o = Owner()
            Console.WriteLine(o.Title())
            """;

        Assert.Equal("instance:title\n", CompileAndRun(source));
    }

    [Fact]
    public void FacetA_ColorColor_SelectsStaticOverload_AtRuntime()
    {
        // Passing a `Tag?` makes the static overload the only applicable one, so
        // the static body must run even though the receiver is the property value.
        var source = """
            package p
            import System
            class Tag { }
            class AppleListBox {
                func GetTagString(name string) string? { return "instance:" + name }
                shared {
                    func GetTagString(tagBox Tag?) string? { return "static" }
                }
            }
            class Owner {
                prop AppleListBox AppleListBox {
                    get { return AppleListBox() }
                }
                func MakeTag() Tag? { return nil }
                func Title() string? {
                    return AppleListBox.GetTagString(MakeTag())
                }
            }
            var o = Owner()
            Console.WriteLine(o.Title())
            """;

        Assert.Equal("static\n", CompileAndRun(source));
    }

    [Fact]
    public void FacetB_UnqualifiedCall_SelectsStaticOverload_AtRuntime()
    {
        // The instance `GetTagString(string)` body calls the bare unqualified
        // `GetTagString(...)` with a `Tag?`; unified resolution must pick the
        // static overload, so the static sentinel is returned at runtime.
        var source = """
            package p
            import System
            class Tag { }
            class Box {
                func GetTagString(name string) string? {
                    return GetTagString(GetTagBox(name))
                }
                func GetTagBox(name string) Tag? { return nil }
                shared {
                    func GetTagString(tagBox Tag?) string? { return "static-overload" }
                }
            }
            var b = Box()
            Console.WriteLine(b.GetTagString("x"))
            """;

        Assert.Equal("static-overload\n", CompileAndRun(source));
    }

    [Fact]
    public void FacetB_UnqualifiedCall_SelectsInstanceOverload_AtRuntime()
    {
        // The same combined group with a `string` argument must run the INSTANCE
        // overload.
        var source = """
            package p
            import System
            class Tag { }
            class Box {
                func Probe() string? {
                    return GetTagString("name")
                }
                func GetTagString(name string) string? { return "instance:" + name }
                shared {
                    func GetTagString(tagBox Tag?) string? { return "static" }
                }
            }
            var b = Box()
            Console.WriteLine(b.Probe())
            """;

        Assert.Equal("instance:name\n", CompileAndRun(source));
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue1147_").FullName;
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

            using var proc = Process.Start(psi);
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
