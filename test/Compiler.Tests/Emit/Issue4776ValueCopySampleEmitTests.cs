// <copyright file="Issue4776ValueCopySampleEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Reflection.Emit;
using GSharp.Core.Tests;
using GSharp.Tests;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

public sealed class Issue4776ValueCopySampleEmitTests
{
    [Theory]
    [InlineData("DataStructErgonomics", 1)]
    [InlineData("WebsiteSwift", 2)]
    public void ActualSample_CopiesStorageWithoutAdditionalConstruction(string sample, int freshConstructions)
    {
        var root = FindRepositoryRoot();
        using var native = new CSharpFixture(sample == "DataStructErgonomics" ? """
            using System;
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
            }
            """ : """
            using System;
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
            }
            """);
        var image = Path.Combine(native.DirectoryPath, sample + ".dll");
        using (var output = new StringWriter())
        using (var error = new StringWriter())
        {
            var previousOutput = Console.Out;
            var previousError = Console.Error;
            try
            {
                Console.SetOut(output);
                Console.SetError(error);
                var exit = Program.Main(new[]
                {
                    "/target:exe", "/targetframework:net10.0",
                    "/assemblyname:" + sample, "/out:" + image,
                    "/refout:" + Path.ChangeExtension(image, ".ref.dll"),
                    Path.Combine(root, "samples", sample + ".gs"),
                });
                Assert.True(exit == 0, $"gsc exited {exit}\n{output}\n{error}");
            }
            finally
            {
                Console.SetOut(previousOutput);
                Console.SetError(previousError);
            }
        }

        IlVerifier.Verify(native.AssemblyPath);
        IlVerifier.Verify(image);
        var assemblies = EmittedFixture.LoadTogether(native.DirectoryPath,
            File.ReadAllBytes(native.AssemblyPath), File.ReadAllBytes(image));
        var sampleNamespace = sample == "DataStructErgonomics"
            ? "GSharp.Example.DataStructErgonomics" : "Examples.Swift";
        var nativeMain = assemblies[0].GetType(sampleNamespace + ".Driver", throwOnError: true).GetMethod("Main");
        var emittedMain = assemblies[1].EntryPoint;
        Assert.NotNull(nativeMain);
        Assert.NotNull(emittedMain);
        var expected = (sample == "DataStructErgonomics"
            ? "True\nTrue\n10\n20\n7\n30\n" : "3, 0\nno position\nTrue\n").ReplaceLineEndings(Environment.NewLine);
        foreach (var main in new[] { nativeMain, emittedMain })
        {
            using var output = new StringWriter();
            var previous = Console.Out;
            try
            {
                Console.SetOut(output);
                main.Invoke(null, main.GetParameters().Length == 0 ? null : new object[] { Array.Empty<string>() });
            }
            finally
            {
                Console.SetOut(previous);
            }

            Assert.Equal(expected, output.ToString());
            var point = main.Module.Assembly.GetType(sampleNamespace + ".Point", throwOnError: true);
            if (sample == "DataStructErgonomics")
            {
                AssertPoint(main, point, "p", "x", "y", 3, 4);
                AssertPoint(main, point, "same", "x", "y", 3, 4);
                AssertPoint(main, point, "movedX", "x", "y", 10, 4);
                AssertPoint(main, point, "movedBoth", "x", "y", 10, 20);
                AssertPoint(main, point, "viaWith", "x", "y", 10, 4);
            }
            else
            {
                AssertPoint(main, point, "origin", "X", "Y", 0, 0);
                AssertPoint(main, point, "moved", "X", "Y", 3, 0);
            }

            var body = main.GetMethodBody();
            Assert.NotNull(body);
            var il = body.GetILAsByteArray();
            Assert.NotNull(il);
            var instructions = IlInstructionReader.Read(il);
            Assert.NotEmpty(instructions);
            var constructions = instructions.Count(instruction =>
                instruction.OpCode == OpCodes.Initobj
                && main.Module.ResolveType(BitConverter.ToInt32(il, instruction.Offset + instruction.OpCode.Size)) == point);
            Assert.True(constructions == freshConstructions,
                $"{sample}: storage copy reconstructed Point; expected {freshConstructions} fresh constructions, actual {constructions}");
        }
    }

    private static void AssertPoint(MethodInfo main, Type point, string variable, string x, string y, int expectedX, int expectedY)
    {
        const BindingFlags flags = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static;
        var storage = main.DeclaringType.GetField(variable, flags);
        Assert.NotNull(storage);
        var value = storage.GetValue(null);
        Assert.IsType(point, value);
        const BindingFlags members = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance;
        var xField = point.GetField(x, members);
        var yField = point.GetField(y, members);
        Assert.NotNull(xField);
        Assert.NotNull(yField);
        Assert.Equal(expectedX, xField.GetValue(value));
        Assert.Equal(expectedY, yField.GetValue(value));
    }

    private static string FindRepositoryRoot()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory != null)
        {
            if (File.Exists(Path.Combine(directory.FullName, "GSharp.sln")))
            {
                return directory.FullName;
            }

            directory = directory.Parent;
        }

        throw new InvalidOperationException("Could not locate repository root.");
    }
}
