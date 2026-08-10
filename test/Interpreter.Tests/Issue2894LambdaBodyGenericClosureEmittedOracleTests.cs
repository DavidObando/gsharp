// <copyright file="Issue2894LambdaBodyGenericClosureEmittedOracleTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Tests;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Issue #2894: Emitted-oracle coverage for lambda body generic closure.
/// </summary>
public class Issue2894LambdaBodyGenericClosureEmittedOracleTests
{
    [Fact]
    public void BodyOnlyGenericParameter_TopLevel_Runs()
    {
        const string Source = """
            open class Box { var Value int32 }
            class IntBox : Box {}
            class Descriptor { var Factory (() -> Box)? }
            let Make[TBox Box] = func(input Box) Descriptor {
                return Descriptor{
                    Factory: func() Box {
                        let marker = default(TBox)
                        if marker == nil {
                            return input
                        }
                        return marker
                    },
                }
            }
            let descriptor = Make[IntBox](Box{ Value: 99 })
            let factory = descriptor.Factory!!
            Console.WriteLine(factory().Value)
            """;

        Assert.Equal($"99{Environment.NewLine}", Evaluate(Source));
    }

    [Fact]
    public void BodyOnlyGenericParameter_InsideFunction_Runs()
    {
        const string Source = """
            open class Box { var Value int32 }
            class IntBox : Box {}
            class Descriptor { var Factory (() -> Box)? }
            func Run() int32 {
                let Make[TBox Box] = func(input Box) Descriptor {
                    return Descriptor{
                        Factory: func() Box {
                            let marker = default(TBox)
                            if marker == nil {
                                return input
                            }
                            return marker
                        },
                    }
                }
                let descriptor = Make[IntBox](Box{ Value: 111 })
                let factory = descriptor.Factory!!
                return factory().Value
            }
            Console.WriteLine(Run())
            """;

        Assert.Equal($"111{Environment.NewLine}", Evaluate(Source));
    }

    private static string Evaluate(string source)
    {
        var result = EmittedOracle.Evaluate(source);
        Assert.Empty(result.Diagnostics);
        return result.Output.ReplaceLineEndings(Environment.NewLine);
    }
}
