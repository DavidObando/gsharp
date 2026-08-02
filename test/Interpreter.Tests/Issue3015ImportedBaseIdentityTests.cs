// <copyright file="Issue3015ImportedBaseIdentityTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text.RegularExpressions;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Issue #3015: imported-base backing objects must retain the derived G# type
/// identity without breaking inherited CLR member dispatch.
/// </summary>
public class Issue3015ImportedBaseIdentityTests
{
    [Fact]
    public void OrdinaryConstruction_PreservesDerivedTypeIdentity()
    {
        const string Source = """
            package Issue3015.Identity
            import System

            class OrdinarySentinel : EventArgs {
            }

            var value = OrdinarySentinel()
            Console.WriteLine(value.ToString())
            Console.WriteLine(value.GetType().FullName)
            """;

        Assert.Equal(
            "Issue3015.Identity.OrdinarySentinel\nIssue3015.Identity.OrdinarySentinel\n",
            Evaluate(Source));
    }

    [Fact]
    public void LiteralConstruction_PreservesDerivedTypeIdentity()
    {
        const string Source = """
            package Issue3015.Identity
            import System

            class LiteralSentinel : EventArgs {
            }

            var value = LiteralSentinel{}
            Console.WriteLine(value.ToString())
            Console.WriteLine(value.GetType().FullName)
            """;

        Assert.Equal(
            "Issue3015.Identity.LiteralSentinel\nIssue3015.Identity.LiteralSentinel\n",
            Evaluate(Source));
    }

    [Fact]
    public void OrdinaryConstruction_PreservesImportedBaseMemberDispatch()
    {
        const string Source = """
            package Issue3015.Bridge
            import System
            import System.IO

            class OrdinaryBuffer : MemoryStream {
            }

            Console.WriteLine(OrdinaryBuffer().CanRead)
            """;

        Assert.Equal("True\n", Evaluate(Source));
    }

    [Fact]
    public void LiteralConstruction_PreservesImportedBaseMemberDispatch()
    {
        const string Source = """
            package Issue3015.Bridge
            import System
            import System.IO

            class LiteralBuffer : MemoryStream {
            }

            Console.WriteLine(LiteralBuffer{}.CanRead)
            """;

        Assert.Equal("True\n", Evaluate(Source));
    }

    [Fact]
    public void ExplicitImportedBaseConstructor_PreservesStateAndIdentity()
    {
        const string Source = """
            package Issue3015.Constructor
            import System

            class MessageSentinel(message string) : Exception(message) {
            }

            var value = MessageSentinel("explicit-state-3015")
            Console.WriteLine(value.Message)
            Console.WriteLine(value.GetType().FullName)
            """;

        Assert.Equal(
            "explicit-state-3015\nIssue3015.Constructor.MessageSentinel\n",
            Evaluate(Source));
    }

    [Fact]
    public void OverloadedBaseConstructors_ShareOneDerivedRuntimeType()
    {
        const string Source = """
            package Issue3015.Constructor
            import System
            import GSharp.Interpreter.Tests

            class OverloadedSentinel : Issue3015OverloadedBase {
                init() : base() {
                }

                init(label string) : base(label) {
                }
            }

            var first = OverloadedSentinel()
            var second = OverloadedSentinel("explicit-3015")
            Console.WriteLine(first.Label)
            Console.WriteLine(second.Label)
            Console.WriteLine(first.GetType().FullName)
            Console.WriteLine(Object.ReferenceEquals(first.GetType(), second.GetType()))
            """;

        Assert.Equal(
            "default-3015\nexplicit-3015\nIssue3015.Constructor.OverloadedSentinel\nTrue\n",
            Evaluate(Source));
    }

    [Fact]
    public void GenericConstruction_PreservesConstructedTypeIdentity()
    {
        const string Source = """
            package Issue3015.Generic
            import System

            class OrdinaryGenericSentinel[T] : EventArgs {
            }

            class LiteralGenericSentinel[T] : EventArgs {
            }

            Console.WriteLine(OrdinaryGenericSentinel[int32]().ToString())
            Console.WriteLine(LiteralGenericSentinel[string]{}.ToString())
            """;

        Assert.Equal(
            "Issue3015.Generic.OrdinaryGenericSentinel`1[System.Int32]\n"
                + "Issue3015.Generic.LiteralGenericSentinel`1[System.String]\n",
            Evaluate(Source));
    }

    [Fact]
    public void NullableGenericConstruction_PreservesNullableTypeArgument()
    {
        const string Source = """
            package Issue3015.NullableGeneric
            import System

            class Box[T] : EventArgs {
            }

            var value = Box[int32?]()
            Console.WriteLine(value.GetType().FullName)
            """;

        var output = Evaluate(Source);

        Assert.Contains("Issue3015.NullableGeneric.Box`1", output);
        Assert.Contains("System.Nullable`1", output);
    }

    [Fact]
    public void CompilerAndInterpreter_AgreeOnDerivedRuntimeType()
    {
        const string Source = """
            package Issue3015.CompilerParity
            import System

            class Sentinel : EventArgs {
            }

            var value = Sentinel()
            Console.WriteLine(value.GetType().FullName)
            """;

        var interpreterTypeName = Evaluate(Source).Trim();
        var artifactDirectory = Path.Combine(
            GetRepositoryRoot(),
            "out",
            "test-artifacts",
            $"issue3015-{Guid.NewGuid():N}");
        Directory.CreateDirectory(artifactDirectory);
        var sourcePath = Path.Combine(artifactDirectory, "Issue3015.gs");
        var assemblyPath = Path.Combine(artifactDirectory, "Issue3015.dll");

        try
        {
            File.WriteAllText(sourcePath, Source);
            var exit = Program.Main(new[]
            {
                "/out:" + assemblyPath,
                "/target:exe",
                "/targetframework:net10.0",
                sourcePath,
            });

            Assert.Equal(0, exit);
            var assembly = Assembly.Load(File.ReadAllBytes(assemblyPath));
            var emittedType = Assert.Single(
                assembly.GetTypes(),
                static type => type.FullName == "Issue3015.CompilerParity.Sentinel");
            Assert.Equal(emittedType.FullName, interpreterTypeName);
        }
        finally
        {
            Directory.Delete(artifactDirectory, recursive: true);
        }
    }

    [Fact]
    public void NestedConstruction_PreservesContainingTypeIdentity()
    {
        const string Source = """
            package Issue3015.Nested
            import System

            class Outer {
                class OrdinaryNestedSentinel : EventArgs {
                }

                class LiteralNestedSentinel : EventArgs {
                }
            }

            Console.WriteLine(Outer.OrdinaryNestedSentinel().ToString())
            Console.WriteLine(Outer.LiteralNestedSentinel{}.ToString())
            """;

        Assert.Equal(
            "Issue3015.Nested.Outer+OrdinaryNestedSentinel\n"
                + "Issue3015.Nested.Outer+LiteralNestedSentinel\n",
            Evaluate(Source));
    }

    [Fact]
    public void GenericTypeArguments_AgreeAcrossCompilerEmitAndInterpreter()
    {
        const string Source = """
            package Issue3015.GenericParity
            import System

            class Payload {
            }

            class Box[T] : EventArgs {
            }

            Console.WriteLine(Box[Payload]().GetType().FullName)
            Console.WriteLine(Box[string]().GetType().FullName)
            Console.WriteLine(Box[Box[Payload]]().GetType().FullName)
            """;
        const string Expected = """
            Issue3015.GenericParity.Box`1[[Issue3015.GenericParity.Payload]]
            Issue3015.GenericParity.Box`1[[System.String]]
            Issue3015.GenericParity.Box`1[[Issue3015.GenericParity.Box`1[[Issue3015.GenericParity.Payload]]]]

            """;

        var root = Path.Combine(
            GetRepositoryRoot(),
            "out",
            "test-artifacts",
            $"issue3015-generic-parity-{Guid.NewGuid():N}");

        try
        {
            var compilerEvaluation = RunSourceDriver(Path.Combine(root, "gsc-eval"), Source, Program.Main);
            Assert.EndsWith("Success.\n", compilerEvaluation);
            compilerEvaluation = compilerEvaluation[..^"Success.\n".Length];
            var interpreter = RunSourceDriver(Path.Combine(root, "gsi"), Source, GSharp.Repl.Program.Main);
            var emitDirectory = Path.Combine(root, "gsc-emit");
            Directory.CreateDirectory(emitDirectory);
            var emitSourcePath = Path.Combine(emitDirectory, "GenericParity.gs");
            var assemblyPath = Path.Combine(emitDirectory, $"GenericParity-{Guid.NewGuid():N}.dll");
            File.WriteAllText(emitSourcePath, Source);
            _ = CaptureDriver(() => Program.Main(new[]
            {
                "/out:" + assemblyPath,
                "/target:exe",
                "/targetframework:net10.0",
                emitSourcePath,
            }));
            var assembly = Assembly.Load(File.ReadAllBytes(assemblyPath));
            Assert.NotEmpty(assembly.GetTypes());
            var entryPoint = assembly.EntryPoint
                ?? throw new InvalidOperationException("Emitted assembly has no entry point.");
            var emitted = CaptureDriver(() =>
            {
                entryPoint.Invoke(
                    null,
                    entryPoint.GetParameters().Length == 0 ? null : new object[] { Array.Empty<string>() });
                return 0;
            });

            Assert.Equal(Expected, NormalizeGenericTypeNames(compilerEvaluation));
            Assert.Equal(Expected, NormalizeGenericTypeNames(emitted));
            Assert.Equal(Expected, NormalizeGenericTypeNames(interpreter));
        }
        finally
        {
            if (Directory.Exists(root))
            {
                Directory.Delete(root, recursive: true);
            }
        }
    }

    [Fact]
    public void ProtectedParameterizedBaseConstructor_PreservesStateAndIdentity()
    {
        const string Source = """
            package Issue3015.ProtectedConstructor
            import System
            import GSharp.Interpreter.Tests

            class ProtectedSentinel(value int32) : Issue3015ProtectedParameterizedBase(value) {
            }

            var instance = ProtectedSentinel(37)
            Console.WriteLine(instance.Value)
            Console.WriteLine(instance.GetType().FullName)
            """;

        Assert.Equal(
            "37\nIssue3015.ProtectedConstructor.ProtectedSentinel\n",
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
            var errors = result.Diagnostics.Where(d => d.IsError).ToArray();
            Assert.True(
                errors.Length == 0,
                "evaluation failed:\n" + string.Join("\n", errors.Select(d => d.ToString())));
        }
        finally
        {
            Console.SetOut(previousOut);
        }

        return outWriter.ToString().Replace("\r\n", "\n");
    }

    private static string RunSourceDriver(string directory, string source, Func<string[], int> driver)
    {
        Directory.CreateDirectory(directory);
        var sourcePath = Path.Combine(directory, "Probe.gs");
        File.WriteAllText(sourcePath, source);
        return CaptureDriver(() => driver(new[] { sourcePath }));
    }

    private static string CaptureDriver(Func<int> driver)
    {
        using var stdout = new StringWriter();
        using var stderr = new StringWriter();
        var previousOut = Console.Out;
        var previousError = Console.Error;
        Console.SetOut(stdout);
        Console.SetError(stderr);
        int exit;
        try
        {
            exit = driver();
        }
        finally
        {
            Console.SetOut(previousOut);
            Console.SetError(previousError);
        }

        Assert.True(
            exit == 0,
            $"driver failed with exit {exit}\nstdout:\n{stdout}\nstderr:\n{stderr}");
        return stdout.ToString().Replace("\r\n", "\n");
    }

    private static string NormalizeGenericTypeNames(string output)
    {
        return Regex.Replace(
            output,
            @", [^,\[\]]+, Version=[^,\[\]]+, Culture=[^,\[\]]+, PublicKeyToken=[^,\[\]]+",
            string.Empty,
            RegexOptions.CultureInvariant);
    }

    private static string GetRepositoryRoot()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory != null && !File.Exists(Path.Combine(directory.FullName, "GSharp.sln")))
        {
            directory = directory.Parent;
        }

        return directory?.FullName
            ?? throw new InvalidOperationException("Could not locate repository root.");
    }
}

/// <summary>Imported constructor-overload probe for issue #3015.</summary>
public class Issue3015OverloadedBase
{
    /// <summary>Initializes a new instance of the <see cref="Issue3015OverloadedBase"/> class.</summary>
    public Issue3015OverloadedBase()
    {
        Label = "default-3015";
    }

    /// <summary>Initializes a new instance of the <see cref="Issue3015OverloadedBase"/> class.</summary>
    /// <param name="label">Probe label.</param>
    public Issue3015OverloadedBase(string label)
    {
        Label = label;
    }

    /// <summary>Gets constructor probe label.</summary>
    public string Label { get; }
}

/// <summary>Imported protected-constructor probe for issue #3015.</summary>
public class Issue3015ProtectedParameterizedBase
{
    /// <summary>Initializes a new instance of the <see cref="Issue3015ProtectedParameterizedBase"/> class.</summary>
    /// <param name="value">Probe value.</param>
    protected Issue3015ProtectedParameterizedBase(int value)
    {
        Value = value;
    }

    /// <summary>Gets constructor probe value.</summary>
    public int Value { get; }
}
