// <copyright file="Issue4741LiftedReferenceConversionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using GSharp.Tests;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

public sealed class Issue4741LiftedReferenceConversionTests
{
    [Theory]
    [InlineData("ExplicitToken", "Box(value)", "(Box)value")]
    [InlineData("ExplicitToken", "Box?(value)", "(Box?)value")]
    [InlineData("ImplicitToken", "value", "value")]
    [InlineData("GenericToken[int32]", "Box(value)", "(Box)value", "GenericToken<int>")]
    [InlineData("ExplicitToken", "checked(Box(value))", "checked((Box)value)")]
    [InlineData("ExplicitToken", "unchecked(Box(value))", "unchecked((Box)value)")]
    public void ImportedConversion_SkipsNullAndEvaluatesPresentOnce(
        string token,
        string cast,
        string csharpCast,
        string csharpToken = null)
    {
        RunPair(
            $$"""
            func Convert(present bool) Box? {
                return {{cast.Replace("value", $"Probe.Read[{token}](present)", StringComparison.Ordinal)}}
            }
            """,
            $$"""
            static Box? Convert(bool present) {
                return {{csharpCast.Replace("value", $"Probe.Read<{csharpToken ?? token}>(present)", StringComparison.Ordinal)}};
            }
            """);
    }

    [Theory]
    [InlineData("initializer")]
    [InlineData("assignment")]
    [InlineData("argument")]
    [InlineData("tuple")]
    public void ContextualImplicitConversion_UsesTheSameNullBypass(string sink)
    {
        var bodies = sink switch
        {
            "initializer" => ("let result Box? = value\nreturn result", "Box? result = value; return result;"),
            "assignment" => ("var result Box? = nil\nresult = value\nreturn result", "Box? result = null; result = value; return result;"),
            "argument" => ("return Accept(value)", "return Accept(value);"),
            "tuple" => ("let row (Value Box?, Code int32) = (value, 7)\nreturn row.Value", "(Box? Value, int Code) row = (value, 7); return row.Value;"),
            _ => throw new ArgumentOutOfRangeException(nameof(sink)),
        };
        RunPair(
            $$"""
            func Accept(value Box?) Box? -> value
            func Convert(present bool) Box? {
                let value ImplicitToken? = Probe.Read[ImplicitToken](present)
                {{bodies.Item1}}
            }
            """,
            $$"""
            static Box? Accept(Box? value) => value;
            static Box? Convert(bool present) {
                ImplicitToken? value = Probe.Read<ImplicitToken>(present);
                {{bodies.Item2}}
            }
            """);
    }

    [Theory]
    [InlineData("return", false)]
    [InlineData("initializer", false)]
    [InlineData("assignment", false)]
    [InlineData("argument", false)]
    [InlineData("tuple", false)]
    [InlineData("return", true)]
    [InlineData("initializer", true)]
    [InlineData("assignment", true)]
    [InlineData("argument", true)]
    [InlineData("tuple", true)]
    public void ContextualImplicitConversion_RejectsNonNullableSinks(string sink, bool sourceOwned)
    {
        var token = sourceOwned ? "LocalImplicit" : "ImplicitToken";
        var gsharpDeclaration = sourceOwned
            ? "struct LocalImplicit {}\nfunc operator implicit(value LocalImplicit) Box { Probe.Calls += 1\nreturn Box() }"
            : string.Empty;
        var csharpDeclaration = sourceOwned
            ? "public struct LocalImplicit { public static implicit operator Box(LocalImplicit value) { Probe.Calls++; return new Box(); } }"
            : string.Empty;
        var bodies = sink switch
        {
            "initializer" => ("let result Box = value\nreturn result", "Box result = value; return result;"),
            "assignment" => ("var result Box = Box()\nresult = value\nreturn result", "Box result = new Box(); result = value; return result;"),
            "argument" => ("return Accept(value)", "return Accept(value);"),
            "tuple" => ("let row (Value Box, Code int32) = (value, 7)\nreturn row.Value", "(Box Value, int Code) row = (value, 7); return row.Value;"),
            "return" => ("return value", "return value;"),
            _ => throw new ArgumentOutOfRangeException(nameof(sink)),
        };
        var name = sink == "return" ? "Raw" : "Convert";
        var result = sink == "return" ? "Box" : "Box?";
        RunPair(
            $$"""
            {{gsharpDeclaration}}
            func Accept(value Box) Box? -> value
            func {{name}}(present bool) {{result}} {
                let value {{token}}? = Probe.Read[{{token}}](present)
                {{bodies.Item1}}
            }
            {{(sink == "return" ? "func Convert(present bool) Box? -> Raw(present)" : string.Empty)}}
            """,
            $$"""
            {{csharpDeclaration}}
            static Box? Accept(Box value) => value;
            static {{result}} {{name}}(bool present) {
                {{token}}? value = Probe.Read<{{token}}>(present);
                {{bodies.Item2}}
            }
            {{(sink == "return" ? "static Box? Convert(bool present) => Raw(present);" : string.Empty)}}
            """,
            expectedDiagnostic: sink == "argument" ? "GS0154" : "GS0155");
    }

    [Theory]
    [InlineData("DualBox")]
    [InlineData("DualBox?")]
    public void ExactNullableOperandOperator_TakesPrecedenceOverTheLift(string result)
    {
        RunPair(
            $$"""
            struct DualToken {}
            class DualBox {
                shared {
                    func operator implicit(value DualToken) DualBox {
                        Probe.Calls += 1
                        return DualBox()
                    }
                    func operator implicit(value DualToken?) DualBox {
                        Probe.Calls += 1
                        return DualBox()
                    }
                }
            }
            func Raw(present bool) {{result}} -> Probe.Read[DualToken](present)
            func Convert(present bool) DualBox? -> Raw(present)
            """,
            $$"""
            public struct DualToken {}
            public sealed class DualBox {
                public static implicit operator DualBox(DualToken value) { Probe.Calls++; return new DualBox(); }
                public static implicit operator DualBox(DualToken? value) { Probe.Calls++; return new DualBox(); }
            }
            static {{result}} Raw(bool present) => Probe.Read<DualToken>(present);
            static DualBox? Convert(bool present) => Raw(present);
            """,
            expectedOutput: "110,110,18,10,11,10");
    }

    [Theory]
    [InlineData("explicit", "Box(value)")]
    [InlineData("implicit", "value")]
    public void SourceConversion_LiftsOnlyTheNonNullableValueOperand(string kind, string cast)
    {
        RunPair(
            $$"""
            struct LocalToken {}
            func operator {{kind}}(value LocalToken) Box {
                Probe.Calls += 1
                return Box()
            }
            func Convert(present bool) Box? {
                return {{cast.Replace("value", "Probe.Read[LocalToken](present)", StringComparison.Ordinal)}}
            }
            """,
            $$"""
            public struct LocalToken {
                public static {{kind}} operator Box(LocalToken value) {
                    Probe.Calls++;
                    return new Box();
                }
            }
            static Box? Convert(bool present) {
                return {{(kind == "explicit" ? "(Box)Probe.Read<LocalToken>(present)" : "Probe.Read<LocalToken>(present)")}};
            }
            """);
    }

    [Fact]
    public void ReferenceConstrainedResult_PreservesTheLiftAndOperatorReturn()
    {
        RunPair(
            """
            struct RefWrapper[T class] {
                shared {
                    func operator explicit(value RefWrapper[T]) T {
                        Probe.Calls += 1
                        return T(object(Box()))
                    }
                }
            }
            func OpenConvert[T class](value RefWrapper[T]?) T? -> T?(value)
            func Convert(present bool) Box? -> OpenConvert[Box](Probe.Read[RefWrapper[Box]](present))
            """,
            """
            public struct RefWrapper<T> where T : class {
                public static explicit operator T(RefWrapper<T> value) {
                    Probe.Calls++;
                    return (T)(object)new Box();
                }
            }
            static T? OpenConvert<T>(RefWrapper<T>? value) where T : class => (T?)value;
            static Box? Convert(bool present) => OpenConvert(Probe.Read<RefWrapper<Box>>(present));
            """);
    }

    [Fact]
    public void UnconstrainedNullableResult_IsNotMisclassifiedAsAReferenceLift()
    {
        const string result = "T?";
        var directory = Path.Combine(AppContext.BaseDirectory, "issue4741-fixtures", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            var fixturePath = Path.Combine(directory, "Unknown4741.dll");
            EmitCSharp(
                $$"""
                #nullable enable
                using System;
                public struct Wrapper<T> {
                    public T Value;
                    public static explicit operator T(Wrapper<T> value) {
                        Oracle.Calls++;
                        return value.Value;
                    }
                }
                public static class Oracle {
                    public static int Calls;
                    static {{result}} Convert<T>(Wrapper<T>? value) => ({{result}})value;
                    public static string Run() {
                        Calls = 0;
                        try { Convert<int>(null); return "did not unwrap"; }
                        catch (InvalidOperationException) {}
                        var missing = 100 + 10 * Calls;
                        Calls = 0;
                        var present = Convert<int>(new Wrapper<int> { Value = 7 });
                        return $"{missing},{present + 10 * Calls}";
                    }
                }
                """,
                fixturePath);
            var oracle = EmittedFixture.Load(fixturePath).GetType("Oracle", throwOnError: true)
                ?? throw new InvalidOperationException("Roslyn oracle type missing.");
            Assert.Equal("100,17", oracle.GetMethod("Run")?.Invoke(null, null));

            var sourcePath = Path.Combine(directory, "Unknown.gs");
            var assemblyPath = Path.Combine(directory, "Unknown.dll");
            File.WriteAllText(
                sourcePath,
                $$"""
                package Unknown4741
                struct Wrapper[T] {
                    var Value T
                    shared {
                        func operator explicit(value Wrapper[T]) T -> value.Value
                    }
                }
                func Convert[T](value Wrapper[T]?) {{result}} -> {{result}}(value)
                """);
            var compilation = CompileGSharp(sourcePath, assemblyPath, fixturePath);
            Assert.NotEqual(0, compilation.Exit);
            var errors = compilation.Diagnostics.Split('\n')
                .Where(line => line.Contains(": error ", StringComparison.Ordinal)).ToArray();
            Assert.NotEmpty(errors);
            Assert.All(errors, error => Assert.Contains("GS0155", error, StringComparison.Ordinal));
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    private static void RunPair(
        string gsharpConversion,
        string csharpConversion,
        string expectedOutput = "101,110,18,10,11,10",
        string expectedDiagnostic = null)
    {
        var directory = Path.Combine(AppContext.BaseDirectory, "issue4741-fixtures", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            var fixturePath = Path.Combine(directory, "Fixture4741.dll");
            var fixtureSource = $$"""
                #nullable enable
                namespace Fixture4741;
                public sealed class Box {}
                public struct ExplicitToken {
                    public static explicit operator Box(ExplicitToken value) { Probe.Calls++; return new Box(); }
                }
                public struct ImplicitToken {
                    public static implicit operator Box(ImplicitToken value) { Probe.Calls++; return new Box(); }
                }
                public struct GenericToken<T> {
                    public static explicit operator Box(GenericToken<T> value) { Probe.Calls++; return new Box(); }
                }
                public struct NumericToken {
                    public static explicit operator int(NumericToken value) { Probe.Calls++; return 7; }
                }
                public struct NullResultToken {
                    public static explicit operator Box?(NullResultToken value) { Probe.Calls++; return null; }
                }
                public sealed class OrdinaryToken {
                    public static explicit operator Box(OrdinaryToken? value) { Probe.Calls++; return new Box(); }
                }
                public static class Probe {
                    public static int Calls;
                    public static int Reads;
                    public static T? Read<T>(bool present) where T : struct {
                        Reads++;
                        return present ? new T() : null;
                    }
                    public static void Reset() { Calls = 0; Reads = 0; }
                }
                public static class Oracle {
                    {{csharpConversion}}
                    public struct NullAwareLocal {}
                    public sealed class AwareBox {
                        public static explicit operator AwareBox(NullAwareLocal? value) {
                            Probe.Calls++;
                            return new AwareBox();
                        }
                    }
                    public static string Run() {
                        Probe.Reset();
                        var missing = Convert(false);
                        var a = (missing == null ? 1 : 0) + 10 * Probe.Calls + 100 * Probe.Reads;
                        Probe.Reset();
                        var present = Convert(true);
                        var b = (present == null ? 1 : 0) + 10 * Probe.Calls + 100 * Probe.Reads;
                        Probe.Reset();
                        NumericToken? absentNumber = null;
                        NumericToken? liveNumber = new NumericToken();
                        var x = (int?)absentNumber;
                        var y = (int?)liveNumber;
                        var c = (x == null ? 1 : 0) + y.GetValueOrDefault() + 10 * Probe.Calls;
                        Probe.Reset();
                        OrdinaryToken? ordinary = null;
                        var z = (Box)ordinary;
                        var d = (z == null ? 1 : 0) + 10 * Probe.Calls;
                        Probe.Reset();
                        NullResultToken? liveNullResult = new NullResultToken();
                        var n = (Box?)liveNullResult;
                        var e = (n == null ? 1 : 0) + 10 * Probe.Calls;
                        Probe.Reset();
                        NullAwareLocal? emptyAware = null;
                        var aware = (AwareBox)emptyAware;
                        var f = (aware == null ? 1 : 0) + 10 * Probe.Calls;
                        return $"{a},{b},{c},{d},{e},{f}";
                    }
                }
                """;
            EmitCSharp(fixtureSource, fixturePath);
            var oracle = EmittedFixture.Load(fixturePath).GetType("Fixture4741.Oracle", throwOnError: true)
                ?? throw new InvalidOperationException("Roslyn oracle type missing.");
            var expected = oracle.GetMethod("Run", BindingFlags.Public | BindingFlags.Static)?.Invoke(null, null);
            Assert.Equal(expectedOutput, expected);

            var source = $$"""
                package Test4741
                import System
                import Fixture4741
                {{gsharpConversion}}
                struct NullAwareLocal {}
                class AwareBox {
                    shared {
                        func operator explicit(value NullAwareLocal?) AwareBox {
                            Probe.Calls += 1
                            return AwareBox()
                        }
                    }
                }
                func Run() string {
                    Probe.Reset()
                    let missing = Convert(false)
                    let a = (if missing == nil { 1 } else { 0 }) + 10 * Probe.Calls + 100 * Probe.Reads
                    Probe.Reset()
                    let present = Convert(true)
                    let b = (if present == nil { 1 } else { 0 }) + 10 * Probe.Calls + 100 * Probe.Reads
                    Probe.Reset()
                    let absentNumber NumericToken? = nil
                    let liveNumber NumericToken? = NumericToken()
                    let x = int32?(absentNumber)
                    let y = int32?(liveNumber)
                    let c = (if x == nil { 1 } else { 0 }) + (y ?? 0) + 10 * Probe.Calls
                    Probe.Reset()
                    let ordinary OrdinaryToken? = nil
                    let z = Box(ordinary)
                    let d = (if z == nil { 1 } else { 0 }) + 10 * Probe.Calls
                    Probe.Reset()
                    let liveNullResult NullResultToken? = NullResultToken()
                    let n = Box?(liveNullResult)
                    let e = (if n == nil { 1 } else { 0 }) + 10 * Probe.Calls
                    Probe.Reset()
                    let emptyAware NullAwareLocal? = nil
                    let aware = AwareBox(emptyAware)
                    let f = (if aware == nil { 1 } else { 0 }) + 10 * Probe.Calls
                    return a.ToString() + "," + b.ToString() + "," + c.ToString() + "," + d.ToString() + "," + e.ToString() + "," + f.ToString()
                }
                """;
            var sourcePath = Path.Combine(directory, "App.gs");
            var assemblyPath = Path.Combine(directory, "App.dll");
            File.WriteAllText(sourcePath, source);
            var compilation = CompileGSharp(sourcePath, assemblyPath, fixturePath);
            if (expectedDiagnostic != null)
            {
                Assert.NotEqual(0, compilation.Exit);
                Assert.True(compilation.Diagnostics.Contains(expectedDiagnostic, StringComparison.Ordinal), compilation.Diagnostics);
                return;
            }

            Assert.True(compilation.Exit == 0, compilation.Diagnostics);
            var assembly = EmittedFixture.Load(assemblyPath);
            var program = assembly.GetTypes().Single(type => type.GetMethod("Run", BindingFlags.Public | BindingFlags.Static) != null);
            var actual = program.GetMethod("Run", BindingFlags.Public | BindingFlags.Static)?.Invoke(null, null);
            Assert.Equal(expected, actual);
            IlVerifier.Verify(assemblyPath, new[] { fixturePath });
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    private static (int Exit, string Diagnostics) CompileGSharp(string sourcePath, string assemblyPath, string fixturePath)
    {
        var arguments = new List<string>
        {
            "/target:library",
            "/targetframework:net10.0",
            "/out:" + assemblyPath,
            "/reference:" + fixturePath,
            sourcePath,
        };
        using var stdout = new StringWriter();
        using var stderr = new StringWriter();
        var previousOut = Console.Out;
        var previousErr = Console.Error;
        Console.SetOut(stdout);
        Console.SetError(stderr);
        try
        {
            return (Program.Main(arguments.ToArray()), stdout.ToString() + stderr);
        }
        finally
        {
            Console.SetOut(previousOut);
            Console.SetError(previousErr);
        }
    }

    private static void EmitCSharp(string source, string path)
    {
        var tpa = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string
            ?? throw new InvalidOperationException("Framework references missing.");
        var references = tpa.Split(Path.PathSeparator)
            .Select(reference => MetadataReference.CreateFromFile(reference));
        var compilation = CSharpCompilation.Create(
            Path.GetFileNameWithoutExtension(path),
            new[] { CSharpSyntaxTree.ParseText(source) },
            references,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
        var result = compilation.Emit(path);
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
    }
}
