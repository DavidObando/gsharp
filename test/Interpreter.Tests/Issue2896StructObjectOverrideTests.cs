// <copyright file="Issue2896StructObjectOverrideTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Issue #2896: plain structs may override Object virtual methods, including
/// calls dispatched through an object-typed receiver.
/// </summary>
public class Issue2896StructObjectOverrideTests
{
    [Theory]
    [InlineData("""
        package Issue2896.TopLevel
        import System

        struct Value {
            var Number int32
            override func ToString() string -> "OVERRIDDEN-11"
            override func Equals(value object) bool -> false
            override func GetHashCode() int32 -> 289611
        }

        let direct = Value{Number: 7}
        let peer object = Value{Number: 7}
        let boxed object = direct
        Console.WriteLine(direct.ToString())
        Console.WriteLine(boxed.ToString())
        Console.WriteLine(direct.Equals(peer))
        Console.WriteLine(boxed.Equals(peer))
        Console.WriteLine(direct.GetHashCode())
        Console.WriteLine(boxed.GetHashCode())
        """)]
    [InlineData("""
        package Issue2896.Function
        import System

        struct Value {
            var Number int32
            override func ToString() string -> "OVERRIDDEN-11"
            override func Equals(value object) bool -> false
            override func GetHashCode() int32 -> 289611
        }

        func Run() {
            let direct = Value{Number: 7}
            let peer object = Value{Number: 7}
            let boxed object = direct
            Console.WriteLine(direct.ToString())
            Console.WriteLine(boxed.ToString())
            Console.WriteLine(direct.Equals(peer))
            Console.WriteLine(boxed.Equals(peer))
            Console.WriteLine(direct.GetHashCode())
            Console.WriteLine(boxed.GetHashCode())
        }

        Run()
        """)]
    public void AllObjectOverrides_DirectAndBoxed_DispatchAtTopLevelAndInsideFunction(string source)
    {
        Assert.Equal(
            "OVERRIDDEN-11\nOVERRIDDEN-11\nFalse\nFalse\n289611\n289611\n",
            Evaluate(source));
    }

    [Fact]
    public void GenericInterfaceOperatorNestedAndSharedShapes_DispatchOverrides()
    {
        const string Source = """
            package Issue2896.Shapes
            import System

            interface IMarker {
                func Marker() string;
            }

            struct GenericValue[T any] {
                var Item T
                override func ToString() string -> "GENERIC-OVERRIDDEN-23"
            }

            struct InterfaceValue : IMarker {
                var Number int32
                func Marker() string -> "MARKER-31"
                override func ToString() string -> "INTERFACE-OVERRIDDEN-31"
            }

            struct OperatorValue : IEquatable[OperatorValue] {
                var Number int32
                func Equals(other OperatorValue) bool -> Number == other.Number
                override func Equals(value object) bool -> false
                override func GetHashCode() int32 -> 289637
            }

            func (left OperatorValue) operator ==(right OperatorValue) bool ->
                left.Number == right.Number

            func (left OperatorValue) operator !=(right OperatorValue) bool ->
                left.Number != right.Number

            class Container {
                struct NestedValue {
                    var Number int32
                    override func ToString() string -> "NESTED-OVERRIDDEN-41"
                }
            }

            struct SharedValue {
                var Number int32
                shared {
                    func Label() string -> "SHARED-43"
                }
                override func ToString() string -> "SHARED-OVERRIDDEN-43"
            }

            func PrintGeneric[T any](value T) {
                Console.WriteLine(value.ToString())
            }

            let genericValue = GenericValue[int32]{Item: 7}
            Console.WriteLine(genericValue.ToString())
            PrintGeneric(genericValue)

            let interfaceValue = InterfaceValue{Number: 7}
            let boxedInterface object = interfaceValue
            Console.WriteLine(interfaceValue.Marker())
            Console.WriteLine(interfaceValue.ToString())
            Console.WriteLine(boxedInterface.ToString())

            let operatorLeft = OperatorValue{Number: 7}
            let operatorRight = OperatorValue{Number: 7}
            let boxedOperator object = operatorLeft
            Console.WriteLine(operatorLeft == operatorRight)
            Console.WriteLine(operatorLeft.Equals(operatorRight))
            Console.WriteLine(boxedOperator.Equals(operatorRight))
            Console.WriteLine(boxedOperator.GetHashCode())

            let nestedValue = Container.NestedValue{Number: 7}
            let boxedNested object = nestedValue
            Console.WriteLine(nestedValue.ToString())
            Console.WriteLine(boxedNested.ToString())

            let sharedValue = SharedValue{Number: 7}
            let boxedShared object = sharedValue
            Console.WriteLine(SharedValue.Label())
            Console.WriteLine(sharedValue.ToString())
            Console.WriteLine(boxedShared.ToString())
            """;

        Assert.Equal(
            """
            GENERIC-OVERRIDDEN-23
            GENERIC-OVERRIDDEN-23
            MARKER-31
            INTERFACE-OVERRIDDEN-31
            INTERFACE-OVERRIDDEN-31
            True
            True
            False
            289637
            NESTED-OVERRIDDEN-41
            NESTED-OVERRIDDEN-41
            SHARED-43
            SHARED-OVERRIDDEN-43
            SHARED-OVERRIDDEN-43
            """.Replace("\r\n", "\n", StringComparison.Ordinal) + "\n",
            Evaluate(Source));
    }

    [Fact]
    public void DataAndDefaultStructBehavior_RemainsUnchanged()
    {
        const string Source = """
            package Issue2896.Controls
            import System

            data struct DataValue {
                var Number int32
            }

            struct DefaultValue {
                var Number int32
            }

            let dataValue = DataValue{Number: 7}
            let boxedData object = dataValue
            Console.WriteLine(dataValue.ToString())
            Console.WriteLine(boxedData.ToString())

            let defaultValue = DefaultValue{Number: 7}
            let boxedDefault object = defaultValue
            Console.WriteLine(defaultValue.ToString())
            Console.WriteLine(boxedDefault.ToString())
            """;

        Assert.Equal(
            "DataValue(Number=7)\nDataValue(Number=7)\n"
                + "DefaultValue(Number=7)\nDefaultValue(Number=7)\n",
            Evaluate(Source));
    }

    private static string Evaluate(string source)
    {
        var compilation = new Compilation(SyntaxTree.Parse(source));

        using var outWriter = new StringWriter();
        var previousOut = Console.Out;
        Console.SetOut(outWriter);
        try
        {
            var result = compilation.Evaluate(new Dictionary<VariableSymbol, object>());
            var errors = result.Diagnostics.Where(diagnostic => diagnostic.IsError).ToArray();
            Assert.True(
                errors.Length == 0,
                "evaluation failed:\n" + string.Join("\n", errors.Select(diagnostic => diagnostic.ToString())));
        }
        finally
        {
            Console.SetOut(previousOut);
        }

        return outWriter.ToString().Replace("\r\n", "\n", StringComparison.Ordinal);
    }
}
