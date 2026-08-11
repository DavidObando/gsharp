// <copyright file="Issue2915ImplicitInterfaceIndexerEmittedSessionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Issue #2915: Emitted-session coverage for implicit interface indexer.
/// Traceability: issues #2954 and #2960.
/// </summary>
public class Issue2915ImplicitInterfaceIndexerEmittedSessionTests
{
    [Fact]
    public void ImplicitIndexers_DispatchForPlainAndConstructedClassesAndStructs()
    {
        const string source = """
            import System

            interface IPlainClassGet {
                prop this[key string] int32 { get; }
            }
            class PlainClassGet : IPlainClassGet {
                prop this[key string] int32 -> key.Length + 8
            }

            interface IPlainClassSet {
                prop this[index int32] int32 { get; set; }
            }
            class PlainClassSet : IPlainClassSet {
                var Stored int32
                prop this[index int32] int32 {
                    get { return Stored + index }
                    set { Stored = value - index }
                }
            }

            interface IConstructedGet[T] {
                prop this[key string] T { get; }
            }
            class ConstructedGet : IConstructedGet[int32] {
                prop this[key string] int32 -> 17
            }
            class GenericGet[T] : IConstructedGet[T] {
                let Stored T
                init(value T) { Stored = value }
                prop this[key string] T -> Stored
            }

            interface IConstructedSet[T] {
                prop this[index int32] T { get; set; }
            }
            class ConstructedSet : IConstructedSet[int32] {
                var Stored int32
                prop this[index int32] int32 {
                    get { return Stored + index }
                    set { Stored = value - index }
                }
            }

            interface IPlainStructGet {
                prop this[index int32] int32 { get; }
            }
            struct PlainStructGet(Base int32) : IPlainStructGet {
                prop this[index int32] int32 -> Base + index
            }

            interface IPlainStructSet {
                prop this[index int32] int32 { get; set; }
            }
            class Cell {
                var Stored int32
                func Set(value int32) { Stored = value }
            }
            struct PlainStructSet(Cell Cell) : IPlainStructSet {
                prop this[index int32] int32 {
                    get { return Cell.Stored + index }
                    set { Cell.Set(value - index) }
                }
            }

            interface IConstructedStructGet[T] {
                prop this[index int32] T { get; }
            }
            struct ConstructedStructGet(Base int32) : IConstructedStructGet[int32] {
                prop this[index int32] int32 -> Base + index
            }

            interface IConstructedStructSet[T] {
                prop this[index int32] T { get; set; }
            }
            struct ConstructedStructSet(Cell Cell) : IConstructedStructSet[int32] {
                prop this[index int32] int32 {
                    get { return Cell.Stored + index }
                    set { Cell.Set(value - index) }
                }
            }

            var plainClassGet IPlainClassGet = PlainClassGet()
            Console.WriteLine(plainClassGet["abc"])

            var plainClassSet IPlainClassSet = PlainClassSet()
            plainClassSet[2] = 42
            Console.WriteLine(plainClassSet[2])

            var constructedGet IConstructedGet[int32] = ConstructedGet()
            Console.WriteLine(constructedGet["value"])

            var constructedSet IConstructedSet[int32] = ConstructedSet()
            constructedSet[3] = 43
            Console.WriteLine(constructedSet[3])

            var genericGet IConstructedGet[int32] = GenericGet[int32](19)
            Console.WriteLine(genericGet["value"])

            var plainStructGet IPlainStructGet = PlainStructGet(30)
            Console.WriteLine(plainStructGet[5])

            var plainStructSet IPlainStructSet = PlainStructSet(Cell())
            plainStructSet[4] = 44
            Console.WriteLine(plainStructSet[4])

            var constructedStructGet IConstructedStructGet[int32] = ConstructedStructGet(40)
            Console.WriteLine(constructedStructGet[6])

            var constructedStructSet IConstructedStructSet[int32] = ConstructedStructSet(Cell())
            constructedStructSet[7] = 47
            Console.WriteLine(constructedStructSet[7])
            """;

        Assert.Equal($"11{Environment.NewLine}42{Environment.NewLine}17{Environment.NewLine}43{Environment.NewLine}19{Environment.NewLine}35{Environment.NewLine}44{Environment.NewLine}46{Environment.NewLine}47{Environment.NewLine}", RunSubmission(source));
    }

    [Fact]
    public void ExplicitIndexers_DispatchToQualifiedClassAndStructAccessors()
    {
        const string source = """
            import System

            interface IPlain {
                prop this[index int32] int32 { get; }
            }
            class Plain : IPlain {
                prop this[index int32] int32 -> 1
                private prop (IPlain) this[index int32] int32 -> 2
            }

            interface IGeneric[T] {
                prop this[index int32] T { get; }
            }
            class Generic : IGeneric[int32] {
                private prop (IGeneric[int32]) this[index int32] int32 -> 4
            }

            struct Value(Base int32) : IPlain {
                private prop (IPlain) this[index int32] int32 -> Base + index
            }

            var plain = Plain()
            var plainInterface IPlain = plain
            Console.WriteLine(plainInterface[0])
            Console.WriteLine(plain[0])

            var genericInterface IGeneric[int32] = Generic()
            Console.WriteLine(genericInterface[0])

            var value IPlain = Value(5)
            Console.WriteLine(value[7])
            """;

        Assert.Equal($"2{Environment.NewLine}1{Environment.NewLine}4{Environment.NewLine}12{Environment.NewLine}", RunSubmission(source));
    }

    [Fact]
    public void NullableSequenceInterfaceProperty_DispatchesAndPreservesNil()
    {
        const string source = """
            import System

            interface IBox {
                prop Vals sequence[int32?] { get; }
            }

            func values() sequence[int32?] {
                yield 5
                yield nil
            }

            struct Box : IBox {
                prop Vals sequence[int32?] -> values()
            }

            var box IBox = Box{}
            for value in box.Vals {
                Console.WriteLine(value == nil ? "nil" : value.ToString())
            }
            """;

        Assert.Equal($"5{Environment.NewLine}nil{Environment.NewLine}", RunSubmission(source));
    }

    [Fact]
    public void ImportedBaseIndexer_DispatchesThroughConstructedInterface()
    {
        const string source = """
            import System
            import System.Collections.Generic

            interface IStore[T] {
                prop this[index int32] T { get; set; }
            }

            class Store : List[int32], IStore[int32] { }

            var store = Store()
            store.Add(7)
            var value IStore[int32] = store
            Console.WriteLine(value[0])
            value[0] = 9
            Console.WriteLine(value[0])
            """;

        Assert.Equal($"7{Environment.NewLine}9{Environment.NewLine}", RunSubmission(source));
    }

    private static string RunSubmission(string text)
    {
        using var output = new StringWriter();
        var previousOutput = Console.Out;
        Console.SetOut(output);
        try
        {
            var repl = new GSharpRepl();
            repl.EvaluateSubmission(text);
        }
        finally
        {
            Console.SetOut(previousOutput);
        }

        return output.ToString().ReplaceLineEndings(Environment.NewLine);
    }
}
