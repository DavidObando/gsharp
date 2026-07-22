// <copyright file="Issue2733GenericInitAccessorMemberRefEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using System.Runtime.Loader;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #2733: init-only setter MemberRefs on constructed generic user types
/// must retain the MethodDef's IsExternalInit modreq identity.
/// </summary>
public sealed class Issue2733GenericInitAccessorMemberRefEmitTests
{
    private const string ExactOahuCliFingerprint = "6e3ec0d0616a";

    [Fact]
    public void ExactOahuCliFingerprint_GenericInitSetterMemberRefs_MatchDefinitionsVerifyAndRun()
    {
        const string Source = """
            package Oahu.Cli.Tui
            import System

            class SelectList[T] {
                private var cursorIndex int32
                private var selected T
                private var mutableIndex int32

                prop CursorIndex int32 {
                    get { return cursorIndex }
                    init { cursorIndex = value }
                }

                prop Selected T {
                    get { return selected }
                    init { selected = value }
                }

                prop MutableIndex int32 {
                    get { return mutableIndex }
                    set { mutableIndex = value }
                }

                init(items []T, cursorIndex int32) {
                    this.CursorIndex = cursorIndex
                    this.Selected = items[cursorIndex]
                    this.MutableIndex = cursorIndex
                }
            }

            let list = SelectList[string]([]string{ "zero", "one", "two" }, 1)
            Console.WriteLine(list.CursorIndex)
            Console.WriteLine(list.Selected)
            Console.WriteLine(list.MutableIndex)
            """;

        var directory = Path.Combine(AppContext.BaseDirectory, "Issue2733Emit", ExactOahuCliFingerprint);
        Directory.CreateDirectory(directory);
        var outputPath = Compile(Source, directory);

        IlVerifier.Verify(outputPath);
        AssertAccessorMemberRefMatchesDefinition(outputPath, "set_CursorIndex", initOnly: true);
        AssertAccessorMemberRefMatchesDefinition(outputPath, "set_Selected", initOnly: true);
        AssertAccessorMemberRefMatchesDefinition(outputPath, "set_MutableIndex", initOnly: false);
        Assert.Equal("1\none\n1\n", Run(outputPath, directory));
    }

    [Fact]
    public void InitOnlyPropertyOnConstructedGeneric_RemainsInitializationOnly()
    {
        var syntax = SyntaxTree.Parse(SourceText.From(
            """
            package Oahu.Cli.Tui.Negative

            class SelectList[T] {
                prop CursorIndex int32 { get; init; }
            }

            let list = SelectList[string]()
            list.CursorIndex = 1
            """));
        var compilation = new Compilation(syntax);

        using var output = new MemoryStream();
        var result = compilation.Emit(output, pdbStream: null, refStream: null, assemblyName: "Issue2733.Negative");

        Assert.False(result.Success);
        Assert.Contains(result.Diagnostics, diagnostic => diagnostic.Id == "GS0372");
    }

    private static string Compile(string source, string directory)
    {
        var sourcePath = Path.Combine(directory, "test.gs");
        var outputPath = Path.Combine(directory, "test.dll");
        File.WriteAllText(sourcePath, source);

        using var stdout = new StringWriter();
        using var stderr = new StringWriter();
        var previousOut = Console.Out;
        var previousError = Console.Error;
        Console.SetOut(stdout);
        Console.SetError(stderr);
        try
        {
            var exitCode = Program.Main(new[]
            {
                "/out:" + outputPath,
                "/target:exe",
                "/targetframework:net10.0",
                sourcePath,
            });
            Assert.True(
                exitCode == 0,
                $"Exact MissingMethod fingerprint {ExactOahuCliFingerprint} must fall from 1 to 0.\n"
                + $"compile failed ({exitCode}):\n{stdout}\n{stderr}");
        }
        finally
        {
            Console.SetOut(previousOut);
            Console.SetError(previousError);
        }

        return outputPath;
    }

    private static void AssertAccessorMemberRefMatchesDefinition(string assemblyPath, string accessorName, bool initOnly)
    {
        using var stream = File.OpenRead(assemblyPath);
        using var peReader = new PEReader(stream);
        var reader = peReader.GetMetadataReader();
        var type = reader.TypeDefinitions
            .Select(reader.GetTypeDefinition)
            .Single(definition => reader.GetString(definition.Name) == "SelectList`1");
        var definition = type.GetMethods()
            .Select(reader.GetMethodDefinition)
            .Single(method => reader.GetString(method.Name) == accessorName);
        var memberRef = reader.MemberReferences
            .Select(reader.GetMemberReference)
            .Single(reference =>
                reference.Parent.Kind == HandleKind.TypeSpecification
                && reader.GetString(reference.Name) == accessorName);

        Assert.Equal(reader.GetBlobBytes(definition.Signature), reader.GetBlobBytes(memberRef.Signature));

        var context = new AssemblyLoadContext("issue2733-reflection-" + accessorName, isCollectible: true);
        try
        {
            var assembly = context.LoadFromAssemblyPath(assemblyPath);
            var reflectedType = assembly.GetType("Oahu.Cli.Tui.SelectList`1", throwOnError: true)!;
            var setter = reflectedType.GetMethods().Single(method => method.Name == accessorName);
            var modifiers = setter.ReturnParameter.GetRequiredCustomModifiers();
            Assert.Equal(
                initOnly,
                modifiers.Any(modifier => modifier.FullName == "System.Runtime.CompilerServices.IsExternalInit"));
        }
        finally
        {
            context.Unload();
        }
    }

    private static string Run(string assemblyPath, string directory)
    {
        using var process = Process.Start(new ProcessStartInfo("dotnet")
        {
            ArgumentList =
            {
                "exec",
                "--runtimeconfig",
                Path.ChangeExtension(assemblyPath, ".runtimeconfig.json"),
                assemblyPath,
            },
            WorkingDirectory = directory,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        });
        var output = process.StandardOutput.ReadToEnd();
        var error = process.StandardError.ReadToEnd();
        Assert.True(process.WaitForExit(30_000), "dotnet exec timed out");
        Assert.True(
            process.ExitCode == 0,
            $"Exact MissingMethod fingerprint {ExactOahuCliFingerprint} still reproduces:\n{error}");
        return output.Replace("\r\n", "\n");
    }
}
