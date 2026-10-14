// <copyright file="Issue2131StaticInitializerBlockTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Reflection
import System.Reflection.Metadata
import System.Reflection.PortableExecutable
import System.Runtime.Loader
import Xunit

/// ADR-0140 / issue #2131: tests for the `shared { init { … } }`
/// static-initializer block covering the parser (round-trip), the binder (bare
/// static-field assignment inside `init` resolves), and emit/semantics
/// (the `.cctor` runs the block and populates a static field; the type is
/// not `beforefieldinit`).
open class Issue2131StaticInitializerBlockTests {
    // ─────────────────────────────────────────────────────────────────────────
    // 1. Parser
    // ─────────────────────────────────────────────────────────────────────────
    @Fact
    func InitBlock_Parses_InsideSharedBlock() {
        let source = `
class Widget {
    shared {
        var Count int32 = 0
        init {
            Count = 41
            Count = Count + 1
        }
    }
}
`
        let tree = SyntaxTree.Parse(SourceText.From(source))
        Assert.Empty(tree.Diagnostics)
        let initBlock = Assert.Single(Descendants(tree.Root).OfType[StaticInitializerBlockSyntax]())
        Assert.Equal(SyntaxKind.StaticInitializerBlock, initBlock.Kind)
        Assert.Equal("init", initBlock.InitKeyword.Text)
        Assert.NotNull(initBlock.Body)
        Assert.Equal(SyntaxKind.BlockStatement, initBlock.Body.Kind)
        Assert.Equal(2, initBlock.Body.Statements.Length)
    }

    @Fact
    func MultipleInitBlocks_Parse_InSourceOrder() {
        let source = `
class Widget {
    shared {
        var Count int32 = 0
        init { Count = 1 }
        init { Count = 2 }
    }
}
`
        let tree = SyntaxTree.Parse(SourceText.From(source))
        Assert.Empty(tree.Diagnostics)
        let initBlocks = Descendants(tree.Root).OfType[StaticInitializerBlockSyntax]().ToArray()
        Assert.Equal(2, initBlocks.Length)
    }

    @Fact
    func Init_RemainsUsableAsAnOrdinaryIdentifier() {
        // `init` is contextual: it is only special as the first token of a
        // shared-block member immediately followed by `{`. A local named `init`
        // must still parse cleanly.
        let source = `
package Sample
import System
var init = 3
Console.WriteLine(init)
`
        let tree = SyntaxTree.Parse(SourceText.From(source))
        Assert.Empty(tree.Diagnostics)
        Assert.Empty(Descendants(tree.Root).OfType[StaticInitializerBlockSyntax]())
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 2. Binder
    // ─────────────────────────────────────────────────────────────────────────
    @Fact
    func InitBlock_BareStaticFieldAssignment_BindsWithoutDiagnostics() {
        let source = `package BindInit
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
`
        using let peStream = MemoryStream()
        let result = Compile(source, peStream)
        Assert.True(
            result.Success,
            "binding/emit should succeed: " + string.Join("; ", result.Diagnostics.Select((d Diagnostic) -> d.Message))
        )
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 3. Emit / semantics
    // ─────────────────────────────────────────────────────────────────────────
    @Fact
    func InitBlock_Cctor_PopulatesStaticTable_AtLoad() {
        // The init block fills a lookup table with index-dependent values in a
        // loop — something a per-field initializer cannot express. Verify via
        // reflection that the static field is populated when the type loads.
        let source = `package InitTable
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
`
        let output = CompileLoadInvokeCaptureStdout(source, "Issue2131-InitTable")
        // 5 * 5 = 25 — proves the loop in the .cctor ran and wrote Table[5].
        Assert.Contains("25", output)
    }

    @Fact
    func InitBlock_Cctor_RunsAfterFieldInitializers_InSourceOrder() {
        // A static field initializer seeds a value; the init block then reads
        // and mutates it. The observed result proves ordering: field init first,
        // then the init block.
        let source = `package InitOrder
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
`
        let output = CompileLoadInvokeCaptureStdout(source, "Issue2131-InitOrder")
        // (100 + 5) * 2 = 210.
        Assert.Contains("210", output)
    }

    @Fact
    func TypeWithInitBlock_IsNotBeforeFieldInit() {
        // C# clears beforefieldinit when a static constructor is declared; a
        // G# `init` block declares an explicit .cctor body, so the emitted type
        // must not be beforefieldinit.
        let source = `package NoBeforeFieldInit
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
`
        using let peStream = MemoryStream()
        let result = Compile(source, peStream)
        Assert.True(
            result.Success,
            "compilation should succeed: " + string.Join("; ", result.Diagnostics.Select((d Diagnostic) -> d.Message))
        )
        peStream.Position = 0
        using let peReader = PEReader(peStream, PEStreamOptions.LeaveOpen)
        let md = peReader.GetMetadataReader()
        let widget = md
            .TypeDefinitions
            .Select(md.GetTypeDefinition)
            .Single((t TypeDefinition) -> md.GetString(t.Name) == "Widget")
        Assert.False(
            (widget.Attributes & TypeAttributes.BeforeFieldInit) != 0,
            "a type with an init block must not be beforefieldinit"
        )
    }

    shared {
        // ─────────────────────────────────────────────────────────────────────────
        // Helpers
        // ─────────────────────────────────────────────────────────────────────────
        private func Descendants(node SyntaxNode) sequence[SyntaxNode] {
            for child in node.GetChildren() {
                yield child
                for grandChild in Descendants(child) {
                    yield grandChild
                }
            }
        }

        private func Compile(source string, peStream Stream) EmitResult {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let compilation = Compilation(tree)
            return compilation.Emit(peStream)
        }

        private func CompileLoadInvokeCaptureStdout(source string, contextName string) string {
            using let peStream = MemoryStream()
            let result = Compile(source, peStream)
            Assert.True(
                result.Success,
                "compilation should succeed: " + string.Join(
                    "; ",
                    result.Diagnostics.Select((d Diagnostic) -> d.Message)
                )
            )
            peStream.Position = 0
            let loadContext = AssemblyLoadContext(contextName, isCollectible: true)
            try {
                let asm = loadContext.LoadFromStream(peStream)
                let programType Type? = asm.GetTypes().FirstOrDefault((t Type) -> t.Name == "<Program>")
                Assert.NotNull(programType)
                let entry MethodInfo? = programType!!.GetMethod(
                    "<Main>$$",
                    BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic
                )
                Assert.NotNull(entry)
                let stdout = Console.Out
                let captured = StringWriter()
                Console.SetOut(captured)
                try {
                    entry!!.Invoke(
                        nil,
                        if entry!!.GetParameters().Length == 0 {
                            default([]?object)
                        } else {
                            []object{Array.Empty[string]()}
                        }
                    )
                } finally {
                    Console.SetOut(stdout)
                }
                return captured.ToString()
            } finally {
                loadContext.Unload()
            }
        }
    }
}
