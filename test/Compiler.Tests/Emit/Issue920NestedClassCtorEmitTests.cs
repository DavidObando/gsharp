// <copyright file="Issue920NestedClassCtorEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #920 / ADR-0110: a nested (user-declared, nested-inside-another-type)
/// class that declares an <c>init()</c> constructor — or whose ctor body is
/// emitted later in the emission pass than a construction site — must have its
/// ctor handle pre-registered so <c>newobj</c> sites resolve it. Before the fix
/// the emitter threw "Type '…' has no emitted primary ctor." because the
/// enclosing class's method bodies are emitted strictly before the unified
/// nested-type pass that records nested ctors.
/// <para>
/// IMPORTANT: every same-compilation user type gets a UNIQUE name per test
/// method, because <c>FunctionTypeSymbol.Cache</c> aliases by type-name string
/// and would otherwise surface stale symbols across tests.
/// </para>
/// </summary>
public class Issue920NestedClassCtorEmitTests
{
    [Fact]
    public void NestedClassWithInitCtor_ConstructedFromEnclosingMethod_Runs()
    {
        var output = CompileAndRun("""
            package P

            import System

            class Outer920A {
                class Inner920A {
                    prop X int32
                    init() {
                        X = 5
                    }
                    func Get() int32 {
                        return X
                    }
                }

                func Make() int32 {
                    let i = Inner920A()
                    return i.Get()
                }
            }

            let o = Outer920A()
            Console.WriteLine(o.Make())
            """);

        Assert.Equal("5\n", output);
    }

    [Fact]
    public void NestedClassWithInitCtor_ObjectInitializerConstruction_Runs()
    {
        // The exact issue #920 reproduction: a nested class implementing an
        // interface, with an init() that sets defaults, constructed with an
        // object-initializer that overrides one property.
        var output = CompileAndRun("""
            package P

            import System

            interface IBroker920B {
                func Answer() string;
            }

            class Outer920B {
                class CBRecordingBroker920B : IBroker920B {
                    prop MfaAnswer string
                    prop CvfAnswer string
                    prop MfaCalls int32

                    init() {
                        MfaAnswer = "000000"
                        CvfAnswer = "0000"
                        MfaCalls = 0
                    }

                    func Answer() string {
                        return MfaAnswer
                    }
                }

                func Make() string {
                    var bb = CBRecordingBroker920B() { MfaAnswer = "987654" }
                    return bb.Answer()
                }
            }

            let o = Outer920B()
            Console.WriteLine(o.Make())
            """);

        Assert.Equal("987654\n", output);
    }

    [Fact]
    public void NestedClassWithInitCtor_DispatchedThroughInterface_Runs()
    {
        // Construct the nested class, upcast it to the nested-implemented
        // interface, and dispatch through the interface.
        var output = CompileAndRun("""
            package P

            import System

            interface IBroker920C {
                func Answer() string;
            }

            class Outer920C {
                class Broker920C : IBroker920C {
                    prop Value string
                    init() {
                        Value = "from-init"
                    }
                    func Answer() string {
                        return Value
                    }
                }

                func Make() string {
                    var i IBroker920C = Broker920C()
                    return i.Answer()
                }
            }

            let o = Outer920C()
            Console.WriteLine(o.Make())
            """);

        Assert.Equal("from-init\n", output);
    }

    [Fact]
    public void TopLevelClass_ConstructsLaterDeclaredInitCtorClass_Runs()
    {
        // The same root cause also affected two TOP-LEVEL classes when the
        // constructing class is declared before the constructed (explicit-ctor)
        // class. Pre-registration fixes both shapes.
        var output = CompileAndRun("""
            package P

            import System

            class Builder920D {
                func Make() int32 {
                    let w = Widget920D()
                    return w.Get()
                }
            }

            class Widget920D {
                prop X int32
                init() {
                    X = 9
                }
                func Get() int32 {
                    return X
                }
            }

            let b = Builder920D()
            Console.WriteLine(b.Make())
            """);

        Assert.Equal("9\n", output);
    }

    [Fact]
    public void NestedClassWithInitCtor_ConstructedFromTopLevelCode_Runs()
    {
        // A nested class constructed directly from top-level program code (not
        // only from an enclosing method) must also resolve its ctor.
        var output = CompileAndRun("""
            package P

            import System

            class Outer920E {
                class Inner920E {
                    prop N int32
                    init() {
                        N = 42
                    }
                    func Get() int32 {
                        return N
                    }
                }
            }

            let i = Inner920E()
            Console.WriteLine(i.Get())
            """);

        Assert.Equal("42\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue920_emit_").FullName;
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

            Assert.True(compileExit == 0, $"compile failed ({compileExit}):\nstdout:\n{compileOut}\nstderr:\n{compileErr}");
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
}
