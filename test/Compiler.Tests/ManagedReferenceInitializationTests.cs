// <copyright file="ManagedReferenceInitializationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using Gsharp.Values;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Tests;
using Xunit;

namespace GSharp.Compiler.Tests;

public sealed class ManagedReferenceInitializationTests
{
    private const string Source = """
        package ManagedInitializers
        import System
        open class Base[T](Saved readonlyManaged[T]) { }
        class Holder[T](Value T) : Base[T](readonlyManaged(Value)) {
            var Other readonlyManaged[T] = readonlyManaged(Value)
            var Reader () -> T = func () T { return Value }
            var Local managed[int32] = {
                const initial = 2
                var local = initial
                let ref early = local
                let pointer = managed(local)
                early = 7
                pointer
            }
            func Same() bool { return this.Saved.SameLocation(this.Other) }
        }
        interface Shared {
            shared {
                var Value managed[int32] = {
                    var local = 9
                    managed(local)
                }
            }
        }
        interface GenericShared[T] {
            shared {
                var Value readonlyManaged[T] = {
                    var local T = default
                    readonlyManaged(local)
                }
            }
        }
        class Probe {
            shared {
                func Run() int32 {
                    var original = 41
                    let holder = Holder[int32](original)
                    original = 99
                    if !holder.Same() { return -1 }
                    if holder.Reader() != 41 { return -2 }
                    return *holder.Other + *holder.Local + *Shared.Value + *GenericShared[int32].Value
                }
            }
        }
        """;

    [Theory]
    [InlineData(false, false)]
    [InlineData(true, false)]
    [InlineData(false, true)]
    public void SameCompilationEmitsTwiceWithoutMutatingInitializers(bool firstRefout, bool secondRefout)
    {
        using var references = ReferenceResolver.WithRuntimeReferences(new[] { typeof(ManagedRef<>).Assembly.Location });
        var compilation = new Compilation(references, SyntaxTree.Parse(Source)) { IsLibrary = true };
        var bound = compilation.BoundProgram;
        Assert.Empty(bound.Diagnostics.Where(d => d.IsError));
        var holder = Assert.Single(bound.Structs, type => type.Name == "Holder");
        var original = holder.InstanceFieldInitializers;
        var originalBase = holder.BaseConstructorInitializer;
        foreach (var refout in new[] { firstRefout, secondRefout })
        {
            using var pe = new MemoryStream();
            using var reference = new MemoryStream();
            var result = compilation.Emit(pe, null, refout ? reference : null);
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
            Assert.Same(original, holder.InstanceFieldInitializers);
            Assert.Same(originalBase, holder.BaseConstructorInitializer);
            var assembly = EmittedFixture.Load(pe.ToArray());
            Assert.Equal(57, assembly.GetType("ManagedInitializers.Probe").GetMethod("Run").Invoke(null, null));
            if (refout)
            {
                Assert.True(reference.Length > 0);
            }
        }
    }

    [Fact]
    public void InitializerOwnersVerifyThroughRealDriver()
    {
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var dll = fixture.Compile(Source + "\nfunc Main() { Console.WriteLine(Probe.Run()) }\n", "ManagedInitializers", true);
        IlVerifier.Verify(dll);
        Assert.Equal("57\n", fixture.Run(dll));
    }

    [Fact]
    public void NamedConstructorOrderingAndExplicitParameterIdentityRemainUnchanged()
    {
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var dll = fixture.Compile(
            """
            package ManagedConstructorOrder
            import System
            class Trace {
                shared {
                    var Text string = ""
                    func Mark(text string) int32 {
                        Text += text
                        return 0
                    }
                }
            }
            open class Parent {
                var Saved readonlyManaged[int32]
                init(saved readonlyManaged[int32], marker int32) {
                    this.Saved = saved
                    Trace.Mark("B")
                }
            }
            class Child : Parent {
                var Other readonlyManaged[int32]
                var Marker int32 = Trace.Mark("F")
                init(value int32) : Parent(readonlyManaged(value), Trace.Mark("A")) {
                    this.Other = readonlyManaged(value)
                    Trace.Mark("C")
                }
            }
            func Main() {
                let child = Child(42)
                Console.WriteLine(Trace.Text)
                Console.WriteLine(child.Saved.SameLocation(child.Other))
                Console.WriteLine(*child.Other)
            }
            """, "ManagedConstructorOrder", true);
        IlVerifier.Verify(dll);
        Assert.Equal("ABFC\nTrue\n42\n", fixture.Run(dll));
    }

    [Theory]
    [InlineData("interface Bad { shared { var Value managed[int32] } }")]
    [InlineData("open class Base(Value managed[int32]) { }\nclass Bad : Base { init(scoped p managed[int32]) : Base(p) { } }")]
    [InlineData("class Bad { shared { var Value int32 = 1\nvar Pointer managed[int32] = managed(Value) } }")]
    public void OutOfBodyContractsRejectEscapesAndUninitializedStorage(string declaration)
    {
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var (code, output) = fixture.TryCompile("package ManagedInitializerReject\n" + declaration, "bad", false);
        Assert.NotEqual(0, code);
        Assert.True(output.Contains("error GS0604:", StringComparison.Ordinal), output);
    }
}
