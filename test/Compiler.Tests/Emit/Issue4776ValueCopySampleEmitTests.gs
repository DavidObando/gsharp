// <copyright file="Issue4776ValueCopySampleEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import System
import System.IO
import System.Linq
import System.Reflection
import System.Reflection.Emit
import GSharp.Core.Tests
import GSharp.Tests
import Xunit
import GSharp.Compiler
import GSharp.Compiler.Tests

class Issue4776ValueCopySampleEmitTests {
    @Theory
    @InlineData("DataStructErgonomics", int32(1))
    @InlineData("WebsiteSwift", int32(2))
    func ActualSample_CopiesStorageWithoutAdditionalConstruction(sample string, freshConstructions int32) {
        let root = FindRepositoryRoot()
        using let native = CSharpFixture(
            if sample == "DataStructErgonomics" {
                `using System;
namespace GSharp.Example.DataStructErgonomics;
public record struct Point {
    public int x;
    public int y;
    public void Deconstruct(out int px, out int py) { px = x; py = y; }
}
public static class Driver {
    public static Point p, same, movedX, movedBoth, viaWith;
    public static void Main() {
        p = new Point { x = 3, y = 4 };
        same = p with { };
        movedX = p with { x = 10 };
        movedBoth = p with { x = 10, y = 20 };
        viaWith = p with { x = 10 };
        var (px, py) = p;
        var namedY = movedBoth.y;
        var namedX = movedBoth.x;
        Console.WriteLine(p == same);
        Console.WriteLine(movedX == viaWith);
        Console.WriteLine(movedBoth.x);
        Console.WriteLine(movedBoth.y);
        Console.WriteLine(px + py);
        Console.WriteLine(namedX + namedY);
    }
}`
            } else {
                `using System;
namespace Examples.Swift;
public record struct Point { public int X; public int Y; }
public static class Driver {
    public static Point origin, moved;
    public static string Describe(Point? point) {
        if (point is not { } known) return "no position";
        return $"{known.X}, {known.Y}";
    }
    public static void Main() {
        origin = new Point { X = 0, Y = 0 };
        moved = origin with { X = 3 };
        Console.WriteLine(Describe(moved));
        Console.WriteLine(Describe(null));
        Console.WriteLine(origin == new Point { X = 0, Y = 0 });
    }
}`
            }
        )
        let image = Path.Combine(native.DirectoryPath, sample + ".dll")
        {
            using let output = StringWriter()
            {
                using let error = StringWriter()
                let previousOutput = Console.Out
                let previousError = Console.Error
                try {
                    Console.SetOut(output)
                    Console.SetError(error)
                    let exit = Program.Main(
                        []string{
                            "/target:exe",
                            "/targetframework:net10.0",
                            "/assemblyname:" + sample,
                            "/out:" + image,
                            "/refout:" + Path.ChangeExtension(image, ".ref.dll"),
                            Path.Combine(root, "samples", sample + ".gs")
                        }
                    )
                    Assert.True(exit == 0, (`gsc exited ` + "$exit" + `
` + "$output" + `
` + "$error"))
                } finally {
                    Console.SetOut(previousOutput)
                    Console.SetError(previousError)
                }
            }
        }
        IlVerifier.Verify(native.AssemblyPath)
        IlVerifier.Verify(image)
        let assemblies = EmittedFixture.LoadTogether(
            native.DirectoryPath,
            File.ReadAllBytes(native.AssemblyPath),
            File.ReadAllBytes(image)
        )
        let sampleNamespace = if sample == "DataStructErgonomics" {
            "GSharp.Example.DataStructErgonomics"
        } else {
            "Examples.Swift"
        }
        let nativeMain MethodInfo? = assemblies[0].GetType(sampleNamespace + ".Driver", throwOnError: true)!!.GetMethod(
            "Main"
        )
        let emittedMain MethodInfo? = assemblies[1].EntryPoint
        Assert.NotNull(nativeMain)
        Assert.NotNull(emittedMain)
        let expected = (
            if sample == "DataStructErgonomics" {
                `True
True
10
20
7
30
`
            } else {
                `3, 0
no position
True
`
            }
        ).ReplaceLineEndings(Environment.NewLine)
        for main in[]MethodInfo{nativeMain!!, emittedMain!!} {
            using let output = StringWriter()
            let previous = Console.Out
            try {
                Console.SetOut(output)
                main.Invoke(
                    nil,
                    if main.GetParameters().Length == 0 {
                        default([]?object)
                    } else {
                        []object{Array.Empty[string]()}
                    }
                )
            } finally {
                Console.SetOut(previous)
            }
            Assert.Equal(expected, output.ToString())
            let point Type? = main.Module.Assembly.GetType(sampleNamespace + ".Point", throwOnError: true)
            if sample == "DataStructErgonomics" {
                AssertPoint(main, point, "p", "x", "y", 3, 4)
                AssertPoint(main, point, "same", "x", "y", 3, 4)
                AssertPoint(main, point, "movedX", "x", "y", 10, 4)
                AssertPoint(main, point, "movedBoth", "x", "y", 10, 20)
                AssertPoint(main, point, "viaWith", "x", "y", 10, 4)
            } else {
                AssertPoint(main, point, "origin", "X", "Y", 0, 0)
                AssertPoint(main, point, "moved", "X", "Y", 3, 0)
            }
            let body MethodBody? = main.GetMethodBody()
            Assert.NotNull(body)
            let il[]?uint8 = body!!.GetILAsByteArray()
            Assert.NotNull(il)
            let instructions = IlInstructionReader.Read(il)
            Assert.NotEmpty(instructions)
            let constructions = instructions.Count(
                (instruction IlInstruction) ->
                (
                    instruction.OpCode == OpCodes.Initobj && main.Module.ResolveType(
                        BitConverter.ToInt32(il!!, instruction.Offset + instruction.OpCode.Size)
                    ) == point
                ) ||
                    (
                    instruction.OpCode == OpCodes.Newobj &&
                        main
                        .Module
                        .ResolveMethod(BitConverter.ToInt32(il!!, instruction.Offset + instruction.OpCode.Size))
                        ?.DeclaringType == point
                )
            )
            Assert.True(
                constructions == freshConstructions,
                "$sample: storage copy reconstructed Point; expected $freshConstructions fresh constructions, actual $constructions"
            )
        }
    }

    shared {
        private func AssertPoint(
            main MethodInfo,
            point Type?,
            variable string,
            x string,
            y string,
            expectedX int32,
            expectedY int32
        ) {
            const flags = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static
            let storage FieldInfo? = main.DeclaringType!!.GetField(variable, flags)
            Assert.NotNull(storage)
            let value object? = storage!!.GetValue(nil)
            Assert.IsType(point!!, value)
            const members = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance
            let xField FieldInfo? = point!!.GetField(x, members)
            let yField FieldInfo? = point!!.GetField(y, members)
            Assert.NotNull(xField)
            Assert.NotNull(yField)
            Assert.Equal(expectedX, xField!!.GetValue(value))
            Assert.Equal(expectedY, yField!!.GetValue(value))
        }

        private func FindRepositoryRoot() string {
            var directory DirectoryInfo? = DirectoryInfo(AppContext.BaseDirectory)
            while directory != nil {
                if RepositoryRootMarker.IsRoot(directory.FullName) {
                    return directory.FullName
                }
                directory = directory.Parent
            }
            throw InvalidOperationException("Could not locate repository root.")
        }
    }
}
