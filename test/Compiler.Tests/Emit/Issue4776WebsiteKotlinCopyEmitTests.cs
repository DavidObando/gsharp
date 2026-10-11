// <copyright file="Issue4776WebsiteKotlinCopyEmitTests.cs" company="GSharp">
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

public sealed class Issue4776WebsiteKotlinCopyEmitTests
{
    [Fact]
    public void WebsiteKotlin_WithClonesDeveloperOnceBeforeUpdatingYears()
    {
        var root = FindRepositoryRoot();
        var directory = Path.Combine(AppContext.BaseDirectory, "WebsiteKotlin-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            var nativeSource = """
                using System;
                namespace Examples.Kotlin;
                public record Developer(string Name, int Years);
                public static class Driver
                {
                    public static Developer ada;
                    public static Developer next;
                    public static string Label(Developer person) =>
                        person is { } known ? $"{known.Name}: {known.Years}" : "unassigned";
                    public static void Main()
                    {
                        ada = new Developer("Ada", 2);
                        next = ada with { Years = 3 };
                        Console.WriteLine(Label(next));
                        Console.WriteLine(Label(null));
                        Console.WriteLine(ada == new Developer("Ada", 2));
                    }
                }
                """;
            var references = Directory.GetFiles(Path.GetDirectoryName(typeof(object).Assembly.Location), "*.dll");
            var tree = CSharpSyntaxTree.ParseText(nativeSource, path: "NativeWebsiteKotlin.cs", encoding: Encoding.UTF8);
            var native = CSharpCompilation.Create(
                "NativeWebsiteKotlin",
                new[] { tree },
                references.Select(path => MetadataReference.CreateFromFile(path)),
                new CSharpCompilationOptions(OutputKind.ConsoleApplication, deterministic: true));
            var nativePath = Path.Combine(directory, "NativeWebsiteKotlin.dll");
            using (var image = File.Create(nativePath))
            using (var pdb = File.Create(Path.ChangeExtension(nativePath, ".pdb")))
            {
                var emitted = native.Emit(image, pdb,
                    options: new EmitOptions(debugInformationFormat: DebugInformationFormat.PortablePdb));
                Assert.True(emitted.Success, string.Join(Environment.NewLine, emitted.Diagnostics));
            }

            var path = Path.Combine(directory, "WebsiteKotlin.dll");
            using (var output = new StringWriter())
            {
                var previous = Console.Out;
                try
                {
                    Console.SetOut(output);
                    var exit = Program.Main(new[]
                    {
                        "/target:exe", "/targetframework:net10.0",
                        "/assemblyname:WebsiteKotlinContract", "/out:" + path,
                        Path.Combine(root, "samples", "WebsiteKotlin.gs"),
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
            var expected = File.ReadAllText(Path.Combine(root, "samples", "WebsiteKotlin.golden"))
                .ReplaceLineEndings(Environment.NewLine);
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
                var developer = assembly.GetType("Examples.Kotlin.Developer", throwOnError: true);
                var adaField = entry.DeclaringType.GetField("ada", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);
                var nextField = entry.DeclaringType.GetField("next", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);
                Assert.NotNull(adaField);
                Assert.NotNull(nextField);
                var ada = adaField.GetValue(null);
                var next = nextField.GetValue(null);
                Assert.IsType(developer, ada);
                Assert.IsType(developer, next);
                Assert.NotSame(ada, next);
                var name = developer.GetProperty("Name");
                var years = developer.GetProperty("Years");
                Assert.NotNull(name);
                Assert.NotNull(years);
                Assert.Equal("Ada", name.GetValue(ada));
                Assert.Equal("Ada", name.GetValue(next));
                Assert.Same(name.GetValue(ada), name.GetValue(next));
                Assert.Equal(2, years.GetValue(ada));
                Assert.Equal(3, years.GetValue(next));

                var body = entry.GetMethodBody();
                Assert.NotNull(body);
                var instructions = IlInstructionReader.Read(body.GetILAsByteArray());
                var calls = instructions.Where(instruction => instruction.MetadataToken.HasValue)
                    .Select(instruction => (
                        Instruction: instruction,
                        Method: entry.Module.ResolveMethod(instruction.MetadataToken.Value)))
                    .Where(call => call.Method.DeclaringType == developer).ToArray();
                var clone = Assert.Single(calls, call => call.Method.Name == "<Clone>$");
                Assert.Equal(OpCodes.Callvirt, clone.Instruction.OpCode);
                var cloneMethod = Assert.IsAssignableFrom<MethodInfo>(clone.Method);
                Assert.Equal(developer, cloneMethod.ReturnType);
                Assert.Empty(cloneMethod.GetParameters());
                var update = Assert.Single(calls, call => call.Method.Name == "set_Years");
                Assert.True(clone.Instruction.Offset < update.Instruction.Offset);
                Assert.DoesNotContain(calls, call => call.Method.Name == "set_Name");
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
            if (RepositoryRootMarker.IsRoot(directory.FullName))
            {
                return directory.FullName;
            }

            directory = directory.Parent;
        }

        throw new InvalidOperationException("Could not locate repository root.");
    }
}
