// <copyright file="NamedTupleMetadataEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.ObjectModel;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using GSharp.Tests;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// ADR-0172 Phase B: gsc synthesizes
/// <c>[System.Runtime.CompilerServices.TupleElementNamesAttribute]</c> on
/// tuple-typed parameters, returns, fields, and properties (the C# flattened
/// pre-order encoding), and decodes it when importing referenced assemblies,
/// so element names survive the CLR boundary in both directions. The blob's
/// C#-compatibility witness is the cross-assembly round trip: a consumer
/// compiled against the emitted metadata resolves <c>pos.line</c> — before
/// Phase B that access was GS0158 and the attribute rows did not exist.
/// </summary>
public class NamedTupleMetadataEmitTests
{
    [Fact]
    public void ReturnAndParameter_CarryTupleElementNames()
    {
        var assembly = CompileToAssembly("""
            package P

            class Locator {
                shared {
                    func Find() (line int32, column int32) {
                        return 3, 5
                    }

                    func Sum(pos (line int32, column int32)) int32 {
                        return pos.line + pos.column
                    }
                }
            }
            """);

        var locator = assembly.GetTypes().Single(t => t.Name == "Locator");
        var find = locator.GetMethod("Find")!;
        Assert.Equal(new[] { "line", "column" }, ReadNames(find.ReturnParameter));

        var sum = locator.GetMethod("Sum")!;
        Assert.Equal(new[] { "line", "column" }, ReadNames(sum.GetParameters()[0]));
    }

    [Fact]
    public void UnnamedTuple_OmitsAttribute()
    {
        var assembly = CompileToAssembly("""
            package P

            class Plain {
                shared {
                    func Pair() (int32, int32) {
                        return 1, 2
                    }
                }
            }
            """);

        var pair = assembly.GetTypes().Single(t => t.Name == "Plain").GetMethod("Pair")!;
        Assert.Null(FindAttribute(pair.ReturnParameter));
    }

    [Fact]
    public void NestedGenericAndPartialNames_FlattenedPreOrder()
    {
        var assembly = CompileToAssembly("""
            package P
            import System.Collections.Generic

            class Store {
                shared {
                    func All() List[(line int32, string)] {
                        return List[(line int32, string)]()
                    }
                }
            }
            """);

        var all = assembly.GetTypes().Single(t => t.Name == "Store").GetMethod("All")!;

        // The List itself contributes no entries; the tuple argument
        // contributes its two logical positions, null where unnamed.
        Assert.Equal(new[] { "line", null }, ReadNames(all.ReturnParameter));
    }

    [Fact]
    public void ArityNine_LogicalElementsOnly_TRestInvisible()
    {
        var assembly = CompileToAssembly("""
            package P

            class Big {
                shared {
                    func Make() (a int32, b int32, c int32, d int32, e int32, f int32, g int32, h int32, i int32) {
                        return 1, 2, 3, 4, 5, 6, 7, 8, 9
                    }
                }
            }
            """);

        var make = assembly.GetTypes().Single(t => t.Name == "Big").GetMethod("Make")!;
        Assert.Equal(new[] { "a", "b", "c", "d", "e", "f", "g", "h", "i" }, ReadNames(make.ReturnParameter));
    }

    [Fact]
    public void FieldAndProperty_CarryTupleElementNames()
    {
        var assembly = CompileToAssembly("""
            package P

            class Holder {
                var Position (line int32, column int32)
                prop Origin (x int32, y int32) -> (0, 0)
            }
            """);

        var holder = assembly.GetTypes().Single(t => t.Name == "Holder");
        var field = holder.GetField("Position", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance);
        if (field != null)
        {
            Assert.Equal(new[] { "line", "column" }, ReadNames(field));
        }

        var property = holder.GetProperty("Origin")!;
        Assert.Equal(new[] { "x", "y" }, ReadNames(property));
    }

    [Fact]
    public void GsToGsRoundTrip_NameAccessAcrossAssemblies()
    {
        // The full loop: names emitted by gsc, read back by gsc's importer.
        var libSource = """
            package NamedLib
            import System.Collections.Generic

            class Locator {
                shared {
                    func Find() (line int32, column int32) {
                        return 3, 5
                    }

                    func FindAll() List[(line int32, column int32)] {
                        let all = List[(line int32, column int32)]()
                        all.Add((1, 2))
                        all.Add((3, 4))
                        return all
                    }
                }
            }
            """;
        var appSource = """
            package App
            import System
            import NamedLib

            let pos = Locator.Find()
            Console.WriteLine(pos.line)
            Console.WriteLine(pos.column)
            Console.WriteLine(Locator.FindAll()[1].line)
            """;

        var output = CompileAndRunWithLibrary(libSource, appSource);
        Assert.Equal($"3{Environment.NewLine}5{Environment.NewLine}3{Environment.NewLine}", output);
    }

    [Fact]
    public void GsToGsRoundTrip_AwaitedTaskOfNamedTuple_KeepsNames()
    {
        // The imported awaitable arrives wrapped in nullability metadata
        // (NullabilityAnnotatedTypeSymbol); the await element derivation must
        // unwrap to the symbolic Task so `t.line` still binds — and the
        // nullable named tuple (`(line int32, gitRef string?)?`) must survive
        // an if-let unwrap of the awaited value.
        var libSource = """
            package NamedAsyncLib
            import System.Threading.Tasks

            class Fetcher {
                shared {
                    async func Find() (line int32, column int32) {
                        await Task.Delay(1)
                        return (3, 5)
                    }

                    async func TryFind(ok bool) (line int32, gitRef string?)? {
                        await Task.Delay(1)
                        if ok {
                            return (7, "main")
                        }

                        return nil
                    }
                }
            }
            """;
        var appSource = """
            package App
            import System
            import NamedAsyncLib

            async func run() {
                let t = await Fetcher.Find()
                Console.WriteLine(t.line)
                if let r = await Fetcher.TryFind(true) {
                    Console.WriteLine(r.line)
                    Console.WriteLine(r.gitRef)
                }
            }

            run().Wait()
            """;

        var output = CompileAndRunWithLibrary(libSource, appSource, libraryName: "NamedAsyncLib");
        Assert.Equal($"3{Environment.NewLine}7{Environment.NewLine}main{Environment.NewLine}", output);
    }

    private static string[] ReadNames(ICustomAttributeProvider provider)
    {
        var data = FindAttribute(provider);
        Assert.NotNull(data);
        var arg = Assert.Single(data.ConstructorArguments);
        return ((ReadOnlyCollection<CustomAttributeTypedArgument>)arg.Value)
            .Select(v => (string)v.Value)
            .ToArray();
    }

    private static CustomAttributeData FindAttribute(ICustomAttributeProvider provider)
    {
        var attrs = provider switch
        {
            MemberInfo member => member.GetCustomAttributesData(),
            ParameterInfo parameter => parameter.GetCustomAttributesData(),
            _ => throw new InvalidOperationException("unexpected provider"),
        };
        return attrs.FirstOrDefault(d => d.AttributeType.FullName == "System.Runtime.CompilerServices.TupleElementNamesAttribute");
    }

    private static Assembly CompileToAssembly(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_ntuple_emit_").FullName;
        var srcPath = Path.Combine(tempDir, "test.gs");
        var outPath = Path.Combine(tempDir, "test.dll");
        File.WriteAllText(srcPath, source);
        RunGsc(new[] { "/out:" + outPath, "/target:library", "/targetframework:net10.0", srcPath });
        IlVerifier.Verify(outPath);
        return EmittedFixture.Load(outPath);
    }

    private static string CompileAndRunWithLibrary(string libSource, string appSource, string libraryName = "namedlib")
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_ntuple_rt_").FullName;
        try
        {
            var libSrc = Path.Combine(tempDir, "lib.gs");
            var libDll = Path.Combine(tempDir, libraryName + ".dll");
            var appSrc = Path.Combine(tempDir, "app.gs");
            var appDll = Path.Combine(tempDir, "app.dll");
            File.WriteAllText(libSrc, libSource);
            File.WriteAllText(appSrc, appSource);

            RunGsc(new[] { "/out:" + libDll, "/target:library", "/targetframework:net10.0", libSrc });
            IlVerifier.Verify(libDll);
            RunGsc(new[] { "/out:" + appDll, "/target:exe", "/targetframework:net10.0", "/reference:" + libDll, appSrc });
            IlVerifier.Verify(appDll, additionalReferences: new[] { libDll });

            var psi = new ProcessStartInfo("dotnet")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = tempDir,
            };
            psi.ArgumentList.Add("exec");
            psi.ArgumentList.Add("--runtimeconfig");
            psi.ArgumentList.Add(Path.ChangeExtension(appDll, ".runtimeconfig.json"));
            psi.ArgumentList.Add(appDll);

            using var proc = Process.Start(psi)!;
            var stdout = proc.StandardOutput.ReadToEnd();
            var stderr = proc.StandardError.ReadToEnd();
            Assert.True(proc.WaitForExit(30_000), "dotnet exec timed out");
            Assert.True(proc.ExitCode == 0, $"exited {proc.ExitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");
            return stdout.ReplaceLineEndings(Environment.NewLine);
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

    private static void RunGsc(string[] args)
    {
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

        Assert.True(
            compileExit == 0,
            $"gsc failed:\nstdout:\n{compileOut}\nstderr:\n{compileErr}");
    }
}
