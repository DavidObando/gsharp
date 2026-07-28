// <copyright file="Issue2834CompoundAssignmentOperatorEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.Loader;
using GsCompilation = GSharp.Core.CodeAnalysis.Compilation.Compilation;
using GsSyntaxTree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree;
using GSharp.Core.CodeAnalysis.Text;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #2834 — real-assembly, reflection-metadata, IL-verification and
/// runtime-execution coverage for user-defined compound-assignment operators.
/// <para>
/// A compound-assignment operator is the ONE operator family that is not
/// emitted as a static <c>op_*</c> method (contrast issue #2377): C# 14
/// defines <c>op_AdditionAssignment</c> and siblings as INSTANCE,
/// <c>specialname</c>, <see langword="void"/>-returning, single-parameter
/// methods that mutate the receiver in place. These tests assert the emitted
/// metadata matches that contract byte for byte, that a REAL C#-authored
/// consumer can drive it with native <c>bag += 5</c> syntax, and that the
/// in-place mutation actually happens at runtime for local, field and
/// getter-only-property receivers.
/// </para>
/// Binder/parser-level coverage lives in
/// <c>Issue2834CompoundAssignmentOperatorTests</c> (Core.Tests).
/// </summary>
public class Issue2834CompoundAssignmentOperatorEmitTests
{
    [Theory]
    [InlineData("+=", "op_AdditionAssignment")]
    [InlineData("-=", "op_SubtractionAssignment")]
    [InlineData("*=", "op_MultiplicationAssignment")]
    [InlineData("/=", "op_DivisionAssignment")]
    [InlineData("%=", "op_ModulusAssignment")]
    [InlineData("&=", "op_BitwiseAndAssignment")]
    [InlineData("|=", "op_BitwiseOrAssignment")]
    [InlineData("^=", "op_ExclusiveOrAssignment")]
    [InlineData("<<=", "op_LeftShiftAssignment")]
    [InlineData(">>=", "op_RightShiftAssignment")]
    [InlineData(">>>=", "op_UnsignedRightShiftAssignment")]
    public void InBodyCompoundOperator_EmitsAsPublicInstanceSpecialNameVoid(string token, string clrName)
    {
        var libraryPath = EmitGSharpLibrary(
            "InBody_" + clrName,
            $$"""
            package Lib

            public class Bag {
                public var Total int32

                public func operator {{token}}(amount int32) {
                    Total = amount
                }
            }
            """);

        var method = LoadDeclaredMethod(libraryPath, "Bag", clrName);

        Assert.False(method.IsStatic);
        Assert.True(method.IsSpecialName);
        Assert.True(method.IsPublic);
        Assert.True(method.IsHideBySig);
        Assert.Equal(typeof(void), method.ReturnType);
        Assert.Single(method.GetParameters());
        Assert.Equal(typeof(int), method.GetParameters()[0].ParameterType);
    }

    [Fact]
    public void ReceiverClauseCompoundOperator_EmitsTheSameInstanceShape()
    {
        // The receiver-clause form is deliberately excluded from the
        // receiver-clause -> static `op_*` rewrite that issue #2377 introduced
        // for binary/unary operators, so both spellings land identically.
        var libraryPath = EmitGSharpLibrary(
            "ReceiverClause",
            """
            package Lib

            public class Bag {
                public var Total int32
            }

            func (b Bag) operator +=(amount int32) {
                b.Total = b.Total + amount
            }
            """);

        var method = LoadDeclaredMethod(libraryPath, "Bag", "op_AdditionAssignment");

        Assert.False(method.IsStatic);
        Assert.True(method.IsSpecialName);
        Assert.Equal(typeof(void), method.ReturnType);

        // The receiver becomes the implicit `this`, NOT a leading parameter.
        Assert.Single(method.GetParameters());
        Assert.Equal(typeof(int), method.GetParameters()[0].ParameterType);
    }

    [Fact]
    public void CSharpConsumer_CanDriveGSharpCompoundOperator_ViaNativeSyntax()
    {
        var libraryPath = EmitGSharpLibrary(
            "CSharpConsumer",
            """
            package Lib

            public class Bag {
                public var Total int32

                public func operator +=(amount int32) {
                    Total = Total + amount
                }

                public func operator -=(amount int32) {
                    Total = Total - amount
                }
            }
            """);

        var consumerPath = EmitCSharpConsumer(
            nameof(CSharpConsumer_CanDriveGSharpCompoundOperator_ViaNativeSyntax),
            """
            using Lib;

            namespace Consumer
            {
                public static class Runner
                {
                    public static int Run()
                    {
                        Bag bag = new Bag();
                        bag += 5;
                        bag += 7;
                        bag -= 2;
                        return bag.Total;
                    }
                }
            }
            """,
            libraryPath);

        var loadContext = new AssemblyLoadContext(
            nameof(CSharpConsumer_CanDriveGSharpCompoundOperator_ViaNativeSyntax),
            isCollectible: true);
        try
        {
            var libraryAsm = loadContext.LoadFromAssemblyPath(libraryPath);
            loadContext.Resolving += (ctx, name) => name.Name == libraryAsm.GetName().Name ? libraryAsm : null;
            var consumerAsm = loadContext.LoadFromAssemblyPath(consumerPath);

            var runner = consumerAsm.GetType("Consumer.Runner")!;
            Assert.Equal(10, runner.GetMethod("Run")!.Invoke(null, null));
        }
        finally
        {
            loadContext.Unload();
        }
    }

    [Fact]
    public void CompoundOperator_MutatesInPlace_ForLocalFieldAndGetterOnlyPropertyReceivers()
    {
        var libraryPath = EmitGSharpLibrary(
            "Runtime",
            """
            package Lib

            public class Bag {
                public var Total int32

                public func operator +=(amount int32) {
                    Total = Total + amount
                }
            }

            public class Holder {
                public var Inner Bag
                public prop Only Bag { get { return Inner } }
            }

            public class Driver {
                shared {
                    public func RunLocal() int32 {
                        var bag = Bag()
                        bag += 5
                        bag += 7
                        return bag!!.Total
                    }

                    public func RunField() int32 {
                        var h = Holder()
                        h!!.Inner = Bag()
                        h!!.Inner += 3
                        return h!!.Inner!!.Total
                    }

                    public func RunGetterOnlyProperty() int32 {
                        var h = Holder()
                        h!!.Inner = Bag()
                        h!!.Only += 4
                        return h!!.Inner!!.Total
                    }
                }
            }
            """);

        var loadContext = new AssemblyLoadContext(
            nameof(CompoundOperator_MutatesInPlace_ForLocalFieldAndGetterOnlyPropertyReceivers),
            isCollectible: true);
        try
        {
            var libraryAsm = loadContext.LoadFromAssemblyPath(libraryPath);
            var driver = libraryAsm.GetTypes().Single(t => t.Name == "Driver");

            Assert.Equal(12, driver.GetMethod("RunLocal", BindingFlags.Public | BindingFlags.Static)!.Invoke(null, null));
            Assert.Equal(3, driver.GetMethod("RunField", BindingFlags.Public | BindingFlags.Static)!.Invoke(null, null));
            Assert.Equal(4, driver.GetMethod("RunGetterOnlyProperty", BindingFlags.Public | BindingFlags.Static)!.Invoke(null, null));
        }
        finally
        {
            loadContext.Unload();
        }
    }

    [Fact]
    public void GSharpConsumer_CanDriveCSharpAuthoredCompoundOperator()
    {
        // The reverse interop direction: a Roslyn-emitted `op_AdditionAssignment`
        // is currently NOT consumable from G# (resolution requires a G#
        // StructSymbol receiver). This test pins the emitted C# shape so the
        // day that lands there is a fixture to point at, and documents that the
        // two compilers agree on the metadata contract.
        var csharpLibraryPath = EmitCSharpLibrary(
            nameof(GSharpConsumer_CanDriveCSharpAuthoredCompoundOperator),
            """
            namespace CsLib
            {
                public class Bag
                {
                    public int Total;

                    public void operator +=(int amount) => Total += amount;
                }
            }
            """);

        var loadContext = new AssemblyLoadContext(
            nameof(GSharpConsumer_CanDriveCSharpAuthoredCompoundOperator),
            isCollectible: true);
        try
        {
            var asm = loadContext.LoadFromAssemblyPath(csharpLibraryPath);
            var bag = asm.GetTypes().Single(t => t.Name == "Bag");
            var op = bag.GetMethod(
                "op_AdditionAssignment",
                BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly)!;

            Assert.False(op.IsStatic);
            Assert.True(op.IsSpecialName);
            Assert.Equal(typeof(void), op.ReturnType);
            Assert.Single(op.GetParameters());
        }
        finally
        {
            loadContext.Unload();
        }
    }

    private static MethodInfo LoadDeclaredMethod(string libraryPath, string typeName, string methodName)
    {
        var loadContext = new AssemblyLoadContext("Probe_" + typeName + "_" + methodName, isCollectible: true);
        try
        {
            var asm = loadContext.LoadFromAssemblyPath(libraryPath);
            var type = asm.GetTypes().Single(t => t.Name == typeName);
            var method = type.GetMethod(
                methodName,
                BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static | BindingFlags.Instance | BindingFlags.DeclaredOnly);
            Assert.NotNull(method);

            // Snapshot the facts before unloading; MethodInfo itself is not
            // usable after the context goes away.
            return method!;
        }
        finally
        {
            // Intentionally NOT unloaded: the returned MethodInfo is inspected
            // by the caller. The collectible context is reclaimed by the GC once
            // the test's references drop.
        }
    }

    private static string EmitGSharpLibrary(string caseName, string gsharpSource)
    {
        var assemblyPath = Path.Combine(LibraryDirectory(), "Issue2834Emit." + caseName + ".dll");
        var compilation = new GsCompilation(GsSyntaxTree.Parse(SourceText.From(gsharpSource))) { IsLibrary = true };

        using (var peStream = File.Create(assemblyPath))
        {
            var result = compilation.Emit(peStream, pdbStream: null, refStream: null, assemblyName: "Issue2834Emit." + caseName);
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
        }

        IlVerifier.Verify(assemblyPath);

        return assemblyPath;
    }

    private static string EmitCSharpConsumer(string caseName, string csharpSource, string libraryPath)
        => EmitCSharpAssembly(caseName, "CSharpConsumer2834", csharpSource, libraryPath);

    private static string EmitCSharpLibrary(string caseName, string csharpSource)
        => EmitCSharpAssembly(caseName, "CSharpLibrary2834", csharpSource, libraryPath: null);

    private static string EmitCSharpAssembly(string caseName, string assemblyName, string csharpSource, string libraryPath)
    {
        var outputDir = Path.Combine(LibraryDirectory(), caseName);
        Directory.CreateDirectory(outputDir);
        var outputPath = Path.Combine(outputDir, assemblyName + ".dll");

        var syntaxTree = CSharpSyntaxTree.ParseText(csharpSource, new CSharpParseOptions(LanguageVersion.Preview));

        var referencePaths = (AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string)
            ?.Split(Path.PathSeparator)
            ?? Array.Empty<string>();

        var references = referencePaths
            .Where(File.Exists)
            .Select(p => (MetadataReference)MetadataReference.CreateFromFile(p))
            .ToList();

        if (libraryPath != null)
        {
            references.Add(MetadataReference.CreateFromFile(libraryPath));
        }

        var compilation = CSharpCompilation.Create(
            assemblyName,
            new[] { syntaxTree },
            references,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));

        using (var peStream = File.Create(outputPath))
        {
            var emitResult = compilation.Emit(peStream);
            Assert.True(emitResult.Success, string.Join(Environment.NewLine, emitResult.Diagnostics));
        }

        return outputPath;
    }

    private static string LibraryDirectory()
    {
        var dir = Path.Combine(AppContext.BaseDirectory, "Issue2834Emit");
        Directory.CreateDirectory(dir);
        return dir;
    }
}
