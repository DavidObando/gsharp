// <copyright file="Issue2131StaticInitializerBlockTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
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

namespace GSharp.Core.Tests.CodeAnalysis;

/// <summary>
/// ADR-0140 / issue #2131: tests for the <c>shared { init { … } }</c>
/// static-initializer block covering the parser (round-trip), the binder (bare
/// static-field assignment inside <c>init</c> resolves), and emit/semantics
/// (the <c>.cctor</c> runs the block and populates a static field; the type is
/// not <c>beforefieldinit</c>).
/// </summary>
public class Issue2131StaticInitializerBlockTests
{
    // ─────────────────────────────────────────────────────────────────────────
    // 1. Parser
    // ─────────────────────────────────────────────────────────────────────────

    [Fact]
    public void InitBlock_Parses_InsideSharedBlock()
    {
        var source = @"
class Widget {
    shared {
        var Count int32 = 0
        init {
            Count = 41
            Count = Count + 1
        }
    }
}
";
        var tree = SyntaxTree.Parse(SourceText.From(source));
        Assert.Empty(tree.Diagnostics);

        var initBlock = Assert.Single(Descendants(tree.Root).OfType<StaticInitializerBlockSyntax>());
        Assert.Equal(SyntaxKind.StaticInitializerBlock, initBlock.Kind);
        Assert.Equal("init", initBlock.InitKeyword.Text);
        Assert.NotNull(initBlock.Body);
        Assert.Equal(SyntaxKind.BlockStatement, initBlock.Body.Kind);
        Assert.Equal(2, initBlock.Body.Statements.Length);
    }

    [Fact]
    public void MultipleInitBlocks_Parse_InSourceOrder()
    {
        var source = @"
class Widget {
    shared {
        var Count int32 = 0
        init { Count = 1 }
        init { Count = 2 }
    }
}
";
        var tree = SyntaxTree.Parse(SourceText.From(source));
        Assert.Empty(tree.Diagnostics);

        var initBlocks = Descendants(tree.Root).OfType<StaticInitializerBlockSyntax>().ToArray();
        Assert.Equal(2, initBlocks.Length);
    }

    [Fact]
    public void Init_RemainsUsableAsAnOrdinaryIdentifier()
    {
        // `init` is contextual: it is only special as the first token of a
        // shared-block member immediately followed by `{`. A local named `init`
        // must still parse cleanly.
        var source = @"
package Sample
import System
var init = 3
Console.WriteLine(init)
";
        var tree = SyntaxTree.Parse(SourceText.From(source));
        Assert.Empty(tree.Diagnostics);
        Assert.Empty(Descendants(tree.Root).OfType<StaticInitializerBlockSyntax>());
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 2. Binder
    // ─────────────────────────────────────────────────────────────────────────

    [Fact]
    public void InitBlock_BareStaticFieldAssignment_BindsWithoutDiagnostics()
    {
        var source = @"package BindInit
import System

class Widget {
    shared {
        var Count int32 = 0
        let Table []int32 = [4]int32
        init {
            Count = 7
            Table[0] = Count
            Table[1] = Count + 1
        }
    }
}

Console.WriteLine(Widget.Count)
";
        using var peStream = new MemoryStream();
        var result = Compile(source, peStream);
        Assert.True(
            result.Success,
            "binding/emit should succeed: " + string.Join("; ", result.Diagnostics.Select(d => d.Message)));
        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 3. Emit / semantics
    // ─────────────────────────────────────────────────────────────────────────

    [Fact]
    public void InitBlock_Cctor_PopulatesStaticTable_AtLoad()
    {
        // The init block fills a lookup table with index-dependent values in a
        // loop — something a per-field initializer cannot express. Verify via
        // reflection that the static field is populated when the type loads.
        var source = @"package InitTable
import System

class Squares {
    shared {
        let Table []int32 = [8]int32
        init {
            for i in 0 ... 8 {
                Table[i] = i * i
            }
        }

        func At(i int32) int32 {
            return Table[i]
        }
    }
}

Console.WriteLine(Squares.At(5))
";
        var output = CompileLoadInvokeCaptureStdout(source, "Issue2131-InitTable");

        // 5 * 5 = 25 — proves the loop in the .cctor ran and wrote Table[5].
        Assert.Contains("25", output);
    }

    [Fact]
    public void InitBlock_Cctor_RunsAfterFieldInitializers_InSourceOrder()
    {
        // A static field initializer seeds a value; the init block then reads
        // and mutates it. The observed result proves ordering: field init first,
        // then the init block.
        var source = @"package InitOrder
import System

class Accum {
    shared {
        var Total int32 = 100
        init {
            Total = Total + 5
        }
        init {
            Total = Total * 2
        }
    }
}

Console.WriteLine(Accum.Total)
";
        var output = CompileLoadInvokeCaptureStdout(source, "Issue2131-InitOrder");

        // (100 + 5) * 2 = 210.
        Assert.Contains("210", output);
    }

    [Fact]
    public void TypeWithInitBlock_IsNotBeforeFieldInit()
    {
        // C# clears beforefieldinit when a static constructor is declared; a
        // G# `init` block declares an explicit .cctor body, so the emitted type
        // must not be beforefieldinit.
        var source = @"package NoBeforeFieldInit
import System

class Widget {
    shared {
        var Count int32 = 1
        init {
            Count = 2
        }
    }
}

Console.WriteLine(Widget.Count)
";
        using var peStream = new MemoryStream();
        var result = Compile(source, peStream);
        Assert.True(
            result.Success,
            "compilation should succeed: " + string.Join("; ", result.Diagnostics.Select(d => d.Message)));

        peStream.Position = 0;
        using var peReader = new PEReader(peStream, PEStreamOptions.LeaveOpen);
        var md = peReader.GetMetadataReader();

        var widget = md.TypeDefinitions
            .Select(md.GetTypeDefinition)
            .Single(t => md.GetString(t.Name) == "Widget");

        Assert.False(
            (widget.Attributes & TypeAttributes.BeforeFieldInit) != 0,
            "a type with an init block must not be beforefieldinit");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Helpers
    // ─────────────────────────────────────────────────────────────────────────

    private static IEnumerable<SyntaxNode> Descendants(SyntaxNode node)
    {
        foreach (var child in node.GetChildren())
        {
            yield return child;
            foreach (var grandChild in Descendants(child))
            {
                yield return grandChild;
            }
        }
    }

    private static EmitResult Compile(string source, Stream peStream)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.Emit(peStream);
    }

    private static string CompileLoadInvokeCaptureStdout(string source, string contextName)
    {
        using var peStream = new MemoryStream();
        var result = Compile(source, peStream);
        Assert.True(
            result.Success,
            "compilation should succeed: " + string.Join("; ", result.Diagnostics.Select(d => d.Message)));

        peStream.Position = 0;
        var loadContext = new AssemblyLoadContext(contextName, isCollectible: true);
        try
        {
            var asm = loadContext.LoadFromStream(peStream);
            var programType = asm.GetTypes().FirstOrDefault(t => t.Name == "<Program>");
            Assert.NotNull(programType);
            var entry = programType!.GetMethod(
                "<Main>$",
                BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic);
            Assert.NotNull(entry);

            var stdout = Console.Out;
            var captured = new StringWriter();
            Console.SetOut(captured);
            try
            {
                entry!.Invoke(null, entry.GetParameters().Length == 0 ? null : new object[] { System.Array.Empty<string>() });
            }
            finally
            {
                Console.SetOut(stdout);
            }

            return captured.ToString();
        }
        finally
        {
            loadContext.Unload();
        }
    }
}
