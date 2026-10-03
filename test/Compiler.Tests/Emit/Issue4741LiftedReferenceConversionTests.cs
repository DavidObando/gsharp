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

    private static void RunPair(string gsharpConversion, string csharpConversion)
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
            Assert.Equal("101,110,18,10,11,10", expected);

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
            int exit;
            Console.SetOut(stdout);
            Console.SetError(stderr);
            try
            {
                exit = Program.Main(arguments.ToArray());
            }
            finally
            {
                Console.SetOut(previousOut);
                Console.SetError(previousErr);
            }

            Assert.True(exit == 0, stdout.ToString() + stderr);
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
