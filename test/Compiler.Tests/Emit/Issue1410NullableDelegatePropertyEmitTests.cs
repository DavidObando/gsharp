// <copyright file="Issue1410NullableDelegatePropertyEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issues #1410 and #2772: null-conditional delegate invocation must capture
/// the receiver once and skip both argument evaluation and Invoke when null.
/// </summary>
public class Issue1410NullableDelegatePropertyEmitTests
{
    [Fact]
    public void NullableVoidDelegateProperty_NullConditionalInvoke_LoadsGetterAndExecutesWhenPresent()
    {
        var source = """
            package P
            import System

            class C {
                prop H ((int32)->void)? { get; set }

                func Set() {
                    H = (x int32) -> Console.WriteLine(x + 1)
                }

                func Raise(x int32) {
                    H?(x)
                }
            }

            let c = C()
            c.Raise(100)
            c.Set()
            c.Raise(41)
            """;

        Assert.Equal("42\n", CompileAndRun(source));
    }

    [Fact]
    public void NullableValueReturningDelegateProperty_NullConditionalInvoke_ReturnsNullableValue()
    {
        var source = """
            package P
            import System

            class C {
                prop H ((int32)->int32)? { get; set }

                func Set() {
                    H = (x int32) -> x * 2
                }

                func Run(x int32) int32? {
                    return H?(x)
                }
            }

            let empty = C()
            Console.WriteLine(empty.Run(21) == nil)

            let c = C()
            c.Set()
            Console.WriteLine(c.Run(21))
            """;

        Assert.Equal("True\n42\n", CompileAndRun(source));
    }

    [Fact]
    public void QualifiedDelegateProperty_NullConditionalInvoke_EvaluatesGetterAndArgumentsExactlyOnce()
    {
        var source = """
            package P
            import System

            var argumentCalls = 0
            func Argument() int32 {
                argumentCalls = argumentCalls + 1
                return 21
            }

            class Box {
                var reads int32
                var calls int32
                var stored ((int32) -> int32)?

                prop Transform ((int32) -> int32)? {
                    get {
                        reads = reads + 1
                        return stored
                    }
                    set { stored = value }
                }

                func Install() {
                    Transform = (x int32) -> {
                        calls = calls + 1
                        return x * 2
                    }
                }
            }

            let box = Box()
            Console.WriteLine(box.Transform?(Argument()) ?? -1)
            Console.WriteLine("${box.reads}:${argumentCalls}:${box.calls}")

            box.Install()
            Console.WriteLine(box.Transform?(Argument()) ?? -1)
            Console.WriteLine("${box.reads}:${argumentCalls}:${box.calls}")
            """;

        Assert.Equal("-1\n1:0:0\n42\n2:1:1\n", CompileAndRun(source));
    }

    [Fact]
    public void NullableStructuralNamedAndImportedDelegateLocals_ShortCircuitAndInvoke()
    {
        var source = """
            package P
            import System

            type Getter = delegate func() string

            func NamedValue() string -> "named"

            class Box {
                prop Named Getter? { get; set; }
                prop Imported Func[int32]? { get; set; }
            }

            let structuralMissing (() -> int32)? = nil
            let structuralPresent (() -> int32)? = () -> 7
            Console.WriteLine(structuralMissing?() ?? -1)
            Console.WriteLine(structuralPresent?() ?? -1)

            let namedMissing Getter? = nil
            let namedValue Getter = NamedValue
            let namedPresent Getter? = namedValue
            Console.WriteLine(namedMissing?() ?? "missing")
            Console.WriteLine(namedPresent?() ?? "missing")

            let importedMissing Func[int32]? = nil
            let importedPresent Func[int32]? = () -> 9
            Console.WriteLine(importedMissing?() ?? -1)
            Console.WriteLine(importedPresent?() ?? -1)

            let box = Box()
            Console.WriteLine(box.Named?() ?? "property-missing")
            Console.WriteLine(box.Imported?() ?? -1)
            box.Named = namedValue
            box.Imported = () -> 11
            Console.WriteLine(box.Named?() ?? "property-missing")
            Console.WriteLine(box.Imported?() ?? -1)
            """;

        Assert.Equal("-1\n7\nmissing\nnamed\n-1\n9\nproperty-missing\n-1\nnamed\n11\n", CompileAndRun(source));
    }

    [Fact]
    public void NullableVoidAndReferenceReturningDelegateProperties_ShortCircuitAndPlainCallStillThrows()
    {
        var source = """
            package P
            import System

            class Box {
                prop Notify ((string) -> void)? { get; set }
                prop Text (() -> string)? { get; set }
            }

            let empty = Box()
            empty.Notify?("skipped")
            Console.WriteLine(empty.Text?() ?? "fallback")

            let full = Box()
            full.Notify = (value string) -> Console.WriteLine(value)
            full.Text = () -> "value"
            full.Notify?("called")
            Console.WriteLine(full.Text?() ?? "fallback")

            try {
                empty.Text()
            } catch (e NullReferenceException) {
                Console.WriteLine("plain-call-threw")
            }
            """;

        Assert.Equal("fallback\ncalled\nvalue\nplain-call-threw\n", CompileAndRun(source));
    }

    [Fact]
    public void NullableDelegateProperty_InAsyncContext_ShortCircuitsAndInvokes()
    {
        var source = """
            package P
            import System
            import System.Threading.Tasks

            class Options {
                prop ActivityVerb (() -> string)? { get; set; }
            }

            async func Read(options Options) string {
                await Task.Delay(1)
                return options.ActivityVerb?() ?? "idle"
            }

            let empty = Options()
            let full = Options()
            full.ActivityVerb = () -> "busy"
            Console.WriteLine(Read(empty).GetAwaiter().GetResult())
            Console.WriteLine(Read(full).GetAwaiter().GetResult())
            """;

        Assert.Equal("idle\nbusy\n", CompileAndRun(source));
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Path.Combine(AppContext.BaseDirectory, "Issue1410_" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(tempDir);
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            var args = new System.Collections.Generic.List<string>
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
                compileExit = Program.Main(args.ToArray());
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
            var stdout = proc.StandardOutput.ReadToEnd();
            var stderr = proc.StandardError.ReadToEnd();
            proc.WaitForExit();
            if (proc.ExitCode != 0)
            {
                throw new Xunit.Sdk.XunitException("exited " + proc.ExitCode + "\nstdout:\n" + stdout + "\nstderr:\n" + stderr);
            }

            return stdout.Replace("\r\n", "\n");
        }
        finally
        {
            try
            {
                Directory.Delete(tempDir, recursive: true);
            }
            catch
            {
            }
        }
    }
}
