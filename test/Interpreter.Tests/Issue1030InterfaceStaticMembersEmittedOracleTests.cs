// <copyright file="Issue1030InterfaceStaticMembersEmittedOracleTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Tests;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Issue #1030: Emitted-oracle coverage for interface static members.
/// Traceability: ADR-0089; issue #1019.
/// </summary>
public class Issue1030InterfaceStaticMembersEmittedOracleTests
{
    [Fact]
    public void InterfaceStaticState_ReadWrite_And_Const_AreSharedState()
    {
        var source = """
            import System

            interface ICounter {
                shared {
                    var Count int32
                    const Max int32 = 100
                }
            }

            ICounter.Count = ICounter.Count + 7
            Console.WriteLine(ICounter.Count)
            Console.WriteLine(ICounter.Max)
            """;

        Assert.Equal($"7{Environment.NewLine}100{Environment.NewLine}", Evaluate(source));
    }

    [Fact]
    public void InterfaceStaticState_SharedAcrossConstraintDispatch()
    {
        var source = """
            import System

            sealed interface ICounter {
                shared {
                    var Count int32
                    func Bump() {
                        Count = Count + 1
                    }
                    func Get() int32 {
                        return Count
                    }
                }
            }

            struct C : ICounter {
            }

            func Run[T ICounter](witness T) int32 {
                T.Bump()
                T.Bump()
                return T.Get()
            }

            Console.WriteLine(Run(C{}))
            Console.WriteLine(ICounter.Count)
            """;

        Assert.Equal($"2{Environment.NewLine}2{Environment.NewLine}", Evaluate(source));
    }

    [Fact]
    public void DefaultBodiedStaticProperty_UsesInterfaceDefault()
    {
        var source = """
            import System

            sealed interface IData {
                shared {
                    prop Name string { get { return "default-name" } }
                }
            }

            struct Apple : IData {
            }

            func Describe[T IData](witness T) string {
                return T.Name
            }

            Console.WriteLine(Describe(Apple{}))
            """;

        Assert.Equal($"default-name{Environment.NewLine}", Evaluate(source));
    }

    [Fact]
    public void GenericInterfaceStaticState_IndependentStoragePerConstruction()
    {
        // Issue #1030 (deferred work): a generic interface owns one set of
        // static fields per closed construction, so IBox[int32] and IBox[string]
        // have independent storage. const reads are inlined.
        var source = """
            import System

            interface IBox[T] {
                shared {
                    var Count int32
                    const Max int32 = 50
                }
            }

            IBox[int32].Count = IBox[int32].Count + 7
            IBox[string].Count = IBox[string].Count + 100
            Console.WriteLine(IBox[int32].Count)
            Console.WriteLine(IBox[string].Count)
            Console.WriteLine(IBox[int32].Max)
            """;

        Assert.Equal($"7{Environment.NewLine}100{Environment.NewLine}50{Environment.NewLine}", Evaluate(source));
    }

    [Fact]
    public void GenericInterfaceStaticState_CompoundAssignment()
    {
        // Issue #1030 (deferred work): compound assignment on a generic
        // interface static field, per construction.
        var source = """
            import System

            interface IBox[T] {
                shared {
                    var Count int32
                }
            }

            IBox[int32].Count += 7
            IBox[int32].Count -= 2
            IBox[string].Count += 1
            Console.WriteLine(IBox[int32].Count)
            Console.WriteLine(IBox[string].Count)
            """;

        Assert.Equal($"5{Environment.NewLine}1{Environment.NewLine}", Evaluate(source));
    }

    [Fact]
    public void InterfaceStaticField_CompoundAssignment()
    {
        // Issue #1030 (deferred work): compound `+=` / `-=` on a non-generic
        // interface static field.
        var source = """
            import System

            interface ICounter {
                shared {
                    var Count int32
                }
            }

            ICounter.Count += 9
            ICounter.Count -= 4
            Console.WriteLine(ICounter.Count)
            """;

        Assert.Equal($"5{Environment.NewLine}", Evaluate(source));
    }

    private static string Evaluate(string source)
    {
        var result = EmittedOracle.Evaluate(source);

        var errors = result.Diagnostics.Where(d => d.IsError).ToList();
        Assert.True(
            errors.Count == 0,
            "evaluation failed:\n" + string.Join("\n", errors.Select(d => d.ToString())));
        return result.Output.ReplaceLineEndings(Environment.NewLine);
    }
}
