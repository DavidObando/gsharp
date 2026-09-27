// <copyright file="Issue4384GenericStructFieldWriteEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using Xunit;

namespace GSharp.Compiler.Tests.Emit;

public sealed class Issue4384GenericStructFieldWriteEmitTests
{
    [Fact]
    public void CapturedConstructedGenericStruct_NestedFieldWritePersists()
    {
        const string source = """
            package i4384local
            import System

            struct Cell[T] {
                var N int32
                var Tag T
            }

            struct Wrap[T] {
                var C Cell[T]
            }

            func Main() {
                var w = Wrap[string]{}
                let f = func() {
                    w.C.N = 2
                }
                f()
                Console.WriteLine(w.C.N)
            }
            """;

        AssertVerifiedOutput(source, "issue4384local", "2\n");
    }

    [Fact]
    public void CapturedClassRoot_ConstructedGenericNestedFieldWritePersists()
    {
        const string source = """
            package i4384class
            import System

            struct Cell[T] {
                var N int32
                var Tag T
            }

            struct Wrap[T] {
                var C Cell[T]
            }

            class Box {
                var W Wrap[string]
            }

            func Main() {
                var b = Box()
                let f = func() {
                    b.W.C.N = 2
                    b.W.C.N = b.W.C.N + 3
                }
                f()
                Console.WriteLine(b.W.C.N)
            }
            """;

        AssertVerifiedOutput(source, "issue4384class", "5\n");
    }

    private static void AssertVerifiedOutput(string source, string name, string expected)
    {
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var assembly = fixture.Compile(source, name, executable: true);
        IlVerifier.Verify(assembly);
        Assert.Equal(expected, fixture.Run(assembly));
    }
}
