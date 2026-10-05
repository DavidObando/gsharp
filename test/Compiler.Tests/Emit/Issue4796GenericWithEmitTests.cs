// <copyright file="Issue4796GenericWithEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Reflection;
using System.Text;
using System.Linq;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Text;
using GSharp.Core.Tests;
using GSharp.Tests;
using Microsoft.CodeAnalysis;
using Xunit;
using GsCompilation = GSharp.Core.CodeAnalysis.Compilation.Compilation;
using GsSyntaxTree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>Issue #4796: with/copy uses the actual data-class clone, not a default constructor.</summary>
public sealed class Issue4796GenericWithEmitTests
{
    [Theory]
    [InlineData("int32", "int", "42", true)]
    [InlineData("string", "string", "\"payload\"", true)]
    [InlineData("int32", "int", "42", false)]
    [InlineData("string", "string", "\"payload\"", false)]
    public void SourceBase_WithAndCopy_PreserveStateAndLexicalEvaluation(
        string gsharpType, string csharpType, string payload, bool generic)
    {
        using var native = new CSharpFixture("""
            #nullable enable
            namespace Native {
                public static class Trace {
                    public static int Initializations;
                    public static int Bases;
                    public static string Events = "";
                    public static object Identity() { Initializations++; return new object(); }
                    public static int Base(int value) { Bases++; return value; }
                    public static void Receive() { Events += "R;"; }
                    public static int Update(int value) { Events += value + ";"; return value; }
                }
            }
            """);
        var parameter = generic ? "[T any]" : "";
        var argument = generic ? "[T]" : "";
        var memberType = generic ? "T" : gsharpType;
        var source = $$"""
            package WithRecords
            import Native
            import System.Threading.Tasks

            public open data class Root{{parameter}}(BaseValue int32) {
                public var State int32
                public var Payload {{memberType}}
                public let Anchor object = Trace.Identity()
                public func CopyRoot(value int32) Root{{argument}} {
                    return this with { State = value }
                }
            }
            public open class Middle{{parameter}}(Value int32) : Root{{argument}}(Value) {
                public var MiddleState int32
            }
            public data class Leaf{{parameter}}(Extra int32, Other int32) : Middle{{argument}}(Trace.Base(0)) {
                private func Receiver() Leaf{{argument}} {
                    Trace.Receive()
                    return this
                }
                public func Copy(value int32) Leaf{{argument}} {
                    return this.Receiver() with { Other = Trace.Update(21), Extra = Trace.Update(value) }
                }
                public func Sugar(value int32) Leaf{{argument}} {
                    return this.Receiver().copy(Other: Trace.Update(21), Extra: Trace.Update(value))
                }
                public async func CopyAsync(value int32) Leaf{{argument}} {
                    await Task.Yield()
                    return this.Receiver() with { Other = Trace.Update(21), Extra = Trace.Update(value) }
                }
                public func Empty() Leaf{{argument}} -> this with { }
            }
            """;
        var library = Compile(native.DirectoryPath, source, native.AssemblyPath);
        IlVerifier.Verify(native.AssemblyPath);
        IlVerifier.Verify(library, new[] { native.AssemblyPath });

        var constructed = generic ? "<" + csharpType + ">" : "";
        using var caller = new CSharpFixture($$"""
            #nullable enable
            using Native;
            using WithRecords;
            public static class Probe {
                private static void Check(bool condition) {
                    if (!condition) throw new System.Exception("copy contract");
                }
                public static string Run() {
                    var original = new Leaf{{constructed}}(7, 8) {
                        State = 31, MiddleState = 41, Payload = {{payload}}, BaseValue = 51
                    };
                    var anchor = original.Anchor;
                    var operations = new System.Func<Leaf{{constructed}}> [] {
                        () => original.Copy(13), () => original.Sugar(13),
                        () => original.CopyAsync(13).GetAwaiter().GetResult(),
                        () => original with { Other = Trace.Update(21), Extra = Trace.Update(13) }
                    };
                    for (var index = 0; index < operations.Length; index++) {
                        Trace.Events = "";
                        var copy = operations[index]();
                        Check(copy.GetType() == typeof(Leaf{{constructed}}));
                        Check(!object.ReferenceEquals(copy, original));
                        Check(copy.Extra == 13 && copy.Other == 21 && original.Extra == 7 && original.Other == 8);
                        Check(copy.State == 31 && copy.MiddleState == 41 && copy.BaseValue == 51);
                        Check(original.State == 31 && original.MiddleState == 41 && original.BaseValue == 51);
                        Check(object.Equals(copy.Payload, original.Payload));
                        Check(typeof({{csharpType}}).IsValueType || object.ReferenceEquals(copy.Payload, original.Payload));
                        Check(object.ReferenceEquals(copy.Anchor, anchor));
                        Check(Trace.Events == (index == 3 ? "21;13;" : "R;21;13;"));
                        Check(Trace.Initializations == 1 && Trace.Bases == 1);
                    }
                    var fromBase = original.CopyRoot(61);
                    Check(fromBase.GetType() == typeof(Leaf{{constructed}}) && !object.ReferenceEquals(original, fromBase));
                    var leaf = (Leaf{{constructed}})fromBase;
                    Check(leaf.Extra == 7 && leaf.Other == 8 && leaf.State == 61 && original.State == 31);
                    Check(leaf.MiddleState == 41 && leaf.BaseValue == 51 && object.ReferenceEquals(leaf.Anchor, anchor));
                    Check(Trace.Initializations == 1 && Trace.Bases == 1);
                    var empty = original.Empty();
                    Check(!object.ReferenceEquals(empty, original) && empty.GetType() == original.GetType());
                    Check(empty.Extra == 7 && empty.Other == 8 && empty.State == 31 && empty.MiddleState == 41 && empty.BaseValue == 51);
                    Check(object.ReferenceEquals(empty.Anchor, anchor));
                    Check(Trace.Initializations == 1 && Trace.Bases == 1);
                    return "distinct|state|identity|once|order|runtime-type";
                }
            }
            """, new[] { MetadataReference.CreateFromFile(native.AssemblyPath), MetadataReference.CreateFromFile(library) });
        IlVerifier.Verify(caller.AssemblyPath, new[] { library, native.AssemblyPath });
        var assemblies = EmittedFixture.LoadTogether(
            native.DirectoryPath,
            File.ReadAllBytes(native.AssemblyPath),
            File.ReadAllBytes(library),
            File.ReadAllBytes(caller.AssemblyPath));
        var probe = assemblies[2].GetType("Probe", throwOnError: true)
            ?? throw new InvalidOperationException("Missing native caller");
        var run = probe.GetMethod("Run", BindingFlags.Public | BindingFlags.Static)
            ?? throw new InvalidOperationException("Missing native oracle");
        Assert.Equal("distinct|state|identity|once|order|runtime-type", run.Invoke(null, null));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void ObjectRootAndImportedNativeRecord_CopyWithoutReinitializing(bool imported)
    {
        using var native = new CSharpFixture("""
            #nullable enable
            namespace Native {
                public static class Trace {
                    public static int Count;
                    public static object Identity() { Count++; return new object(); }
                }
                public record Row<T>(T Value, int Extra) {
                    public object Anchor { get; } = Trace.Identity();
                }
            }
            """);
        var source = imported ? """
            package WithRecords
            import Native
            public class Caller {
                public func Copy(value Row[string]) Row[string] -> value with { Extra = 13 }
            }
            """ : """
            package WithRecords
            import Native
            public data class Row[T any](Value T, Extra int32) {
                public let Anchor object = Trace.Identity()
            }
            public class Caller[A any, B any] {
                public func Copy(value Row[B]) Row[B] -> value with { Extra = 13 }
            }
            """;
        var library = Compile(native.DirectoryPath, source, native.AssemblyPath);
        IlVerifier.Verify(native.AssemblyPath);
        IlVerifier.Verify(library, new[] { native.AssemblyPath });
        var rowNamespace = imported ? "Native" : "WithRecords";
        var construction = imported ? "Caller" : "Caller<int, string>";
        using var caller = new CSharpFixture($$"""
            #nullable enable
            public static class Probe {
                public static string Run() {
                    var original = new {{rowNamespace}}.Row<string>("payload", 7);
                    var copy = new WithRecords.{{construction}}().Copy(original);
                    if (copy.GetType() != original.GetType() || object.ReferenceEquals(copy, original)
                        || !object.ReferenceEquals(copy.Value, original.Value)
                        || !object.ReferenceEquals(copy.Anchor, original.Anchor)
                        || copy.Extra != 13 || original.Extra != 7 || Native.Trace.Count != 1)
                        throw new System.Exception("object-root clone contract");
                    return "distinct|readonly|once";
                }
            }
            """, new[] { MetadataReference.CreateFromFile(native.AssemblyPath), MetadataReference.CreateFromFile(library) });
        IlVerifier.Verify(caller.AssemblyPath, new[] { library, native.AssemblyPath });
        var assemblies = EmittedFixture.LoadTogether(native.DirectoryPath,
            File.ReadAllBytes(native.AssemblyPath), File.ReadAllBytes(library), File.ReadAllBytes(caller.AssemblyPath));
        var method = assemblies[2].GetType("Probe")?.GetMethod("Run")
            ?? throw new InvalidOperationException("Missing native oracle");
        Assert.Equal("distinct|readonly|once", method.Invoke(null, null));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void ImportedMarkerWithoutAccessibleClone_ReportsLocatedDiagnosticAndNoOutput(bool privateClone)
    {
        using var native = new CSharpFixture("""
            [assembly: System.Reflection.AssemblyMetadata("GSharp.TypeSemantics", "33554434|class|1|")]
            namespace Native {
                public class Broken {
                    public int Value;
                    private Broken Clone___() => this;
                }
            }
            """);
        if (privateClone)
        {
            // C# cannot spell the reserved CLR clone name. Rename only its
            // equal-length heap entry, retaining Roslyn's private method body.
            var imageBytes = File.ReadAllBytes(native.AssemblyPath);
            var oldName = Encoding.UTF8.GetBytes("Clone___\0");
            var offset = imageBytes.AsSpan().IndexOf(oldName);
            Assert.True(offset >= 0);
            Assert.Equal(offset, imageBytes.AsSpan().LastIndexOf(oldName));
            Encoding.UTF8.GetBytes("<Clone>$\0").CopyTo(imageBytes, offset);
            File.WriteAllBytes(native.AssemblyPath, imageBytes);
            var clone = native.Load().GetType("Native.Broken")?.GetMethod("<Clone>$", BindingFlags.Instance | BindingFlags.NonPublic);
            Assert.NotNull(clone);
            Assert.True(clone.IsPrivate);
        }

        const string source = """
            package WithRecords
            import Native
            public func Copy(value Broken) Broken -> value with { Value = 1 }
            """;
        using var references = native.RuntimeReferences();
        var compilation = new GsCompilation(references, GsSyntaxTree.Parse(SourceText.From(source)))
        {
            IsLibrary = true,
        };
        using var image = new MemoryStream();
        var result = compilation.Emit(image, pdbStream: null, refStream: null, assemblyName: "BrokenConsumer");
        Assert.False(result.Success);
        Assert.Equal(0, image.Length);
        var diagnostic = Assert.Single(result.Diagnostics.Where(d => d.Message.Contains("<Clone>$", StringComparison.Ordinal)));
        Assert.Equal("GS0158", diagnostic.Id);
        Assert.Equal("with", source.Substring(diagnostic.Location.Span.Start, diagnostic.Location.Span.Length));
    }

    private static string Compile(string directory, string source, params string[] references)
    {
        var sourcePath = Path.Combine(directory, "Records.gs");
        var output = Path.Combine(directory, "Records.dll");
        File.WriteAllText(sourcePath, source);
        var arguments = new System.Collections.Generic.List<string>
        {
            "/target:library", "/targetframework:net10.0", "/assemblyname:Records", "/out:" + output,
        };
        foreach (var reference in references)
        {
            arguments.Add("/r:" + reference);
        }

        arguments.Add(sourcePath);
        using var stdout = new StringWriter();
        using var stderr = new StringWriter();
        var previousOut = Console.Out;
        var previousError = Console.Error;
        try
        {
            Console.SetOut(stdout);
            Console.SetError(stderr);
            var exit = Program.Main(arguments.ToArray());
            Assert.True(exit == 0, $"gsc exited {exit}\n{stdout}\n{stderr}");
        }
        finally
        {
            Console.SetOut(previousOut);
            Console.SetError(previousError);
        }

        Assert.True(File.Exists(output), stdout + Environment.NewLine + stderr);
        return output;
    }
}
