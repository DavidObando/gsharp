// <copyright file="Issue3076GenericStaticClrStoreEmittedSessionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.IO;
using Xunit;

namespace GSharp.Interpreter.Tests;

public sealed class Issue3076GenericStaticClrStoreEmittedSessionTests
{
    [Theory]
    [InlineData(false, "301\n302\n311\n312\n321\n322\n331\n332\n341\n342\n351\n352\n")]
    [InlineData(true, "201\n202\n211\n212\n121\n122\n221\n222\n231\n232\n241\n242\n")]
    public void GenericStaticClrStoresInterpret(bool throughTypeParameter, string expected)
    {
        using var outWriter = new StringWriter();
        var previousOut = System.Console.Out;
        System.Console.SetOut(outWriter);
        try
        {
            var repl = new GSharpRepl();
            repl.EvaluateSubmission(Source(throughTypeParameter));
        }
        finally
        {
            System.Console.SetOut(previousOut);
        }

        Assert.Equal(expected, outWriter.ToString().ReplaceLineEndings(Environment.NewLine));
    }

    private static string Source(bool throughTypeParameter)
    {
        if (!throughTypeParameter)
        {
            return """
                import GSharp.Interpreter.Tests.Issue3076Probe
                import System

                GenericStaticSlot[int32].Property = 301
                GenericStaticSlot[int32].Field = 302
                GenericStaticSlot[string].Property = 311
                GenericStaticSlot[string].Field = 312
                GenericStaticSlot[object].Property = 321
                GenericStaticSlot[object].Field = 322
                GenericStaticSlot[GenericBox[int32]].Property = 331
                GenericStaticSlot[GenericBox[int32]].Field = 332
                GenericPairSlot[int32, string].Property = 341
                GenericPairSlot[int32, string].Field = 342
                PlainStaticSlot.Property = 351
                PlainStaticSlot.Field = 352

                Console.WriteLine(GenericStaticSlot[int32].Property)
                Console.WriteLine(GenericStaticSlot[int32].Field)
                Console.WriteLine(GenericStaticSlot[string].Property)
                Console.WriteLine(GenericStaticSlot[string].Field)
                Console.WriteLine(GenericStaticSlot[object].Property)
                Console.WriteLine(GenericStaticSlot[object].Field)
                Console.WriteLine(GenericStaticSlot[GenericBox[int32]].Property)
                Console.WriteLine(GenericStaticSlot[GenericBox[int32]].Field)
                Console.WriteLine(GenericPairSlot[int32, string].Property)
                Console.WriteLine(GenericPairSlot[int32, string].Field)
                Console.WriteLine(PlainStaticSlot.Property)
                Console.WriteLine(PlainStaticSlot.Field)
                """;
        }

        return """
            import GSharp.Interpreter.Tests.Issue3076Probe
            import System

            func Store[T](propertyValue int32, fieldValue int32) {
                GenericStaticSlot[T].Property = propertyValue
                GenericStaticSlot[T].Field = fieldValue
            }

            func StorePropertyAndRead[T](value int32) int32 {
                GenericStaticSlot[T].Property = value
                return GenericStaticSlot[T].Property
            }

            func StoreFieldAndRead[T](value int32) int32 {
                GenericStaticSlot[T].Field = value
                return GenericStaticSlot[T].Field
            }

            func ReadProperty[T]() int32 {
                return GenericStaticSlot[T].Property
            }

            func ReadField[T]() int32 {
                return GenericStaticSlot[T].Field
            }

            func StoreNested[T](propertyValue int32, fieldValue int32) {
                GenericStaticSlot[GenericBox[T]].Property = propertyValue
                GenericStaticSlot[GenericBox[T]].Field = fieldValue
            }

            func StorePair[TFirst, TSecond](propertyValue int32, fieldValue int32) {
                GenericPairSlot[TFirst, TSecond].Property = propertyValue
                GenericPairSlot[TFirst, TSecond].Field = fieldValue
            }

            GenericStaticSlot[int32].Property = 101
            GenericStaticSlot[int32].Field = 102
            GenericStaticSlot[string].Property = 111
            GenericStaticSlot[string].Field = 112
            GenericStaticSlot[object].Property = 121
            GenericStaticSlot[object].Field = 122
            GenericStaticSlot[GenericBox[int32]].Property = 131
            GenericStaticSlot[GenericBox[int32]].Field = 132
            GenericPairSlot[int32, string].Property = 141
            GenericPairSlot[int32, string].Field = 142

            var intProperty = StorePropertyAndRead[int32](201)
            var intField = StoreFieldAndRead[int32](202)
            Store[string](211, 212)
            StoreNested[int32](221, 222)
            StorePair[int32, string](231, 232)
            PlainStaticSlot.Property = 241
            PlainStaticSlot.Field = 242

            Console.WriteLine(intProperty)
            Console.WriteLine(intField)
            Console.WriteLine(ReadProperty[string]())
            Console.WriteLine(ReadField[string]())
            Console.WriteLine(GenericStaticSlot[object].Property)
            Console.WriteLine(GenericStaticSlot[object].Field)
            Console.WriteLine(GenericStaticSlot[GenericBox[int32]].ReadProperty())
            Console.WriteLine(GenericStaticSlot[GenericBox[int32]].ReadField())
            Console.WriteLine(GenericPairSlot[int32, string].Property)
            Console.WriteLine(GenericPairSlot[int32, string].Field)
            Console.WriteLine(PlainStaticSlot.Property)
            Console.WriteLine(PlainStaticSlot.Field)
            """;
    }
}
