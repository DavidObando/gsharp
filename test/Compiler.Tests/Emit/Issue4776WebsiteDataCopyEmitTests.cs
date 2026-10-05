// <copyright file="Issue4776WebsiteDataCopyEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Reflection.Emit;
using System.Text;
using GSharp.Tests;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.Emit;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

public sealed class Issue4776WebsiteDataCopyEmitTests
{
    [Fact]
    public void WebsiteData_WithCallsTypedCloneOnceAndPreservesOriginal()
    {
        var root = FindRepositoryRoot();
        var directory = Path.Combine(AppContext.BaseDirectory, "WebsiteData-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            var nativeSource = """
                using System;
                namespace Website.Data;
                public record Point(int X, int Y);
                public static class Driver
                {
                    public static Point origin;
                    public static Point moved;
                    public static void Main()
                    {
                        origin = new Point(0, 0);
                        moved = origin with { X = 3 };
                        Console.WriteLine($"({moved.X}, {moved.Y})");
                        Console.WriteLine(origin == new Point(0, 0));
                    }
                }
                """;
            var references = Directory.GetFiles(Path.GetDirectoryName(typeof(object).Assembly.Location), "*.dll");
            var tree = CSharpSyntaxTree.ParseText(nativeSource, path: "NativeWebsiteData.cs", encoding: Encoding.UTF8);
            var compilation = CSharpCompilation.Create(
                "NativeWebsiteData",
                new[] { tree },
                references.Select(path => MetadataReference.CreateFromFile(path)),
                new CSharpCompilationOptions(OutputKind.ConsoleApplication, deterministic: true));
            var nativePath = Path.Combine(directory, "NativeWebsiteData.dll");
            using (var image = File.Create(nativePath))
            using (var pdb = File.Create(Path.ChangeExtension(nativePath, ".pdb")))
            {
                var emitted = compilation.Emit(image, pdb,
                    options: new EmitOptions(debugInformationFormat: DebugInformationFormat.PortablePdb));
                Assert.True(emitted.Success, string.Join(Environment.NewLine, emitted.Diagnostics));
            }

            var path = Path.Combine(directory, "WebsiteData.dll");
            using (var output = new StringWriter())
            {
                var previous = Console.Out;
                try
                {
                    Console.SetOut(output);
                    var exit = Program.Main(new[]
                    {
                        "/target:exe", "/targetframework:net10.0",
                        "/assemblyname:WebsiteDataContract", "/out:" + path,
                        Path.Combine(root, "samples", "WebsiteData.gs"),
                    });
                    Assert.True(exit == 0, output.ToString());
                }
                finally
                {
                    Console.SetOut(previous);
                }
            }

            IlVerifier.Verify(nativePath);
            IlVerifier.Verify(path);
            var assemblies = EmittedFixture.LoadTogether(nativePath, path);
            var expected = File.ReadAllText(Path.Combine(root, "samples", "WebsiteData.golden")).ReplaceLineEndings(Environment.NewLine);
            foreach (var assembly in assemblies)
            {
                var entry = assembly.EntryPoint;
                Assert.NotNull(entry);
                using var output = new StringWriter();
                var previous = Console.Out;
                try
                {
                    Console.SetOut(output);
                    entry.Invoke(null, entry.GetParameters().Length == 0 ? null : new object[] { Array.Empty<string>() });
                }
                finally
                {
                    Console.SetOut(previous);
                }

                Assert.Equal(expected, output.ToString());
                var point = assembly.GetType("Website.Data.Point", throwOnError: true);
                var originalField = entry.DeclaringType.GetField("origin", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);
                var movedField = entry.DeclaringType.GetField("moved", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);
                Assert.NotNull(originalField);
                Assert.NotNull(movedField);
                var original = originalField.GetValue(null);
                var moved = movedField.GetValue(null);
                Assert.IsType(point, original);
                Assert.IsType(point, moved);
                Assert.NotSame(original, moved);
                Assert.Equal(0, point.GetProperty("X").GetValue(original));
                Assert.Equal(0, point.GetProperty("Y").GetValue(original));
                Assert.Equal(3, point.GetProperty("X").GetValue(moved));
                Assert.Equal(0, point.GetProperty("Y").GetValue(moved));

                var body = entry.GetMethodBody();
                Assert.NotNull(body);
                var instructions = IlInstructionReader.Read(body.GetILAsByteArray());
                var calls = instructions.Where(instruction => instruction.MetadataToken.HasValue)
                    .Select(instruction => (
                        Instruction: instruction,
                        Method: entry.Module.ResolveMethod(instruction.MetadataToken.Value)))
                    .Where(call => call.Method.DeclaringType == point).ToArray();
                var clone = Assert.Single(calls, call => call.Method.Name == "<Clone>$");
                Assert.Equal(OpCodes.Callvirt, clone.Instruction.OpCode);
                var cloneMethod = Assert.IsAssignableFrom<MethodInfo>(clone.Method);
                Assert.Equal(point, cloneMethod.ReturnType);
                Assert.Empty(cloneMethod.GetParameters());
                var update = Assert.Single(calls, call => call.Method.Name == "set_X");
                Assert.True(clone.Instruction.Offset < update.Instruction.Offset);
                Assert.DoesNotContain(calls, call => call.Method.Name == "set_Y");
                Assert.DoesNotContain(calls, call =>
                    call.Instruction.OpCode == OpCodes.Newobj && call.Method.GetParameters().Length == 0);
            }
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
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
