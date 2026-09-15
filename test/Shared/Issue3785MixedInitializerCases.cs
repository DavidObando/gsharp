// <copyright file="Issue3785MixedInitializerCases.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;

namespace GSharp.Tests;

internal static class Issue3785MixedInitializerCases
{
    public const string LexicalOrder = """
        package Issue3785Order
        import System.Collections.Generic

        var trace = List[string]()
        var sources = 0
        var enumerations = 0

        class Bag {
            public prop Before int32 { get; set; }
            public prop After int32 { get; set; }
            public var Items List[int32] = List[int32]()
            init(seed int32) {
                trace.Add("ctor:" + seed.ToString())
            }
            func Add(item int32) {
                trace.Add("add:" + Before.ToString() + ":" + After.ToString() + ":" + item.ToString())
                Items.Add(item)
            }
        }
        func Argument() int32 {
            trace.Add("argument")
            return 7
        }
        func MarkState(value int32) int32 {
            trace.Add("set:" + value.ToString())
            return value
        }
        func Element(value int32) int32 {
            trace.Add("element:" + value.ToString())
            return value
        }
        func Enumerate(label string) sequence[int32] {
            enumerations++
            trace.Add("enumerate:" + label)
            if label == "full" {
                yield 2
                yield 3
            }
        }
        func Source(label string) sequence[int32] {
            sources++
            trace.Add("source:" + label)
            return Enumerate(label)
        }

        let result = Bag(Argument()){
            .Before: MarkState(1),
            Element(1),
            ...Source("full"),
            .After: MarkState(2),
            ...Source("empty"),
            4,
        }
        for entry in trace {
            System.Console.WriteLine(entry)
        }
        System.Console.WriteLine(sources)
        System.Console.WriteLine(enumerations)
        System.Console.WriteLine(result.Items.Count)
        """;

    public static readonly string LexicalOrderOutput = string.Join(Environment.NewLine, new[]
    {
        "argument",
        "ctor:7",
        "set:1",
        "element:1",
        "add:1:0:1",
        "source:full",
        "enumerate:full",
        "add:1:0:2",
        "add:1:0:3",
        "set:2",
        "source:empty",
        "enumerate:empty",
        "add:1:2:4",
        "2",
        "2",
        "4",
    }) + Environment.NewLine;

    public const string DistinctMemberAndKey = """
        import System.Collections.Generic
        let Capacity = "b"
        let pairs = Dictionary[string, int32]{ "a": 1 }
        let values = SortedList[string, int32](){
            ...pairs, Capacity: 2, "c": 3, [Capacity] = 4, .Capacity: 10,
        }
        System.Console.WriteLine(values.Count)
        System.Console.WriteLine(values["b"])
        System.Console.WriteLine(values.Capacity)
        """;

    public static readonly string DistinctMemberAndKeyOutput = $"3{Environment.NewLine}4{Environment.NewLine}10{Environment.NewLine}";
}
