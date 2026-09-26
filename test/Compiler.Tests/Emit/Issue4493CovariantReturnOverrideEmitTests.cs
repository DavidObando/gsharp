// <copyright file="Issue4493CovariantReturnOverrideEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using Xunit;

namespace GSharp.Compiler.Tests.Emit;

public sealed class Issue4493CovariantReturnOverrideEmitTests
{
    [Fact]
    public void SourcePropertyCovariantReturn_LoadsAndDispatchesThroughBaseSlot()
    {
        const string source = """
            package i4493
            import System

            open class Symbol { }
            class PropertySymbol : Symbol { }

            open class Base {
                open prop Property Symbol {
                    get;
                }
            }

            class Derived : Base {
                private var value PropertySymbol = PropertySymbol()
                override prop Property PropertySymbol -> this.value
            }

            func Main() {
                let value Base = Derived()
                Console.WriteLine(value.Property.GetType().Name)
            }
            """;

        using var fixture = new NativeSliceLanguageTests.Fixture();
        var assembly = fixture.Compile(source, "issue4493", executable: true);
        IlVerifier.Verify(assembly);
        Assert.Equal("PropertySymbol\n", fixture.Run(assembly));
    }
}
