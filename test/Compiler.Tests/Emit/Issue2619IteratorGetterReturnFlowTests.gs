// <copyright file="Issue2619IteratorGetterReturnFlowTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import System
import System.IO
import System.Linq
import System.Reflection
import Xunit

open class Issue2619IteratorGetterReturnFlowTests {
    @Fact
    func ExhaustiveIteratorGetters_EmitAndRun() {
        const Source = `package Oahu.Cli.Tui.Screens

import System.Collections.Generic

class LibraryScreen {
    private var searchMode bool
    private var queueServiceFactory object?

    init(searchMode bool, queueServiceFactory object?) {
        this.searchMode = searchMode
        this.queueServiceFactory = queueServiceFactory
    }

    prop Hints IEnumerable[KeyValuePair[string, string?]] {
        get {
            if searchMode {
                yield KeyValuePair[string, string?]("Enter", "search")
                yield KeyValuePair[string, string?]("Esc", "cancel")
            } else {
                yield KeyValuePair[string, string?]("/", "search")
                yield KeyValuePair[string, string?]("↑↓", "navigate")
                yield KeyValuePair[string, string?]("PgUp/Dn", "page")
                yield KeyValuePair[string, string?]("Space", "select")
                yield KeyValuePair[string, string?]("a", "select all")
                if queueServiceFactory != nil {
                    yield KeyValuePair[string, string?]("q", "enqueue")
                }
            }
        }
    }
}

class SwitchValues {
    private var value int32

    init(value int32) {
        this.value = value
    }

    prop Values sequence[int32] {
        get {
            switch value {
                case 0 {
                    yield 10
                }
                default {
                    yield 20
                }
            }
        }
    }
}

public var hintCount = 0
for hint in LibraryScreen(true, nil).Hints {
    hintCount = hintCount + 1
}
for hint in LibraryScreen(false, "queue").Hints {
    hintCount = hintCount + 1
}

public var switchSum = 0
for value in SwitchValues(0).Values {
    switchSum = switchSum + value
}
for value in SwitchValues(1).Values {
    switchSum = switchSum + value
}`
        let assembly = CompileAndRun(Source)
        Assert.Equal(8, GetField(assembly, "hintCount"))
        Assert.Equal(30, GetField(assembly, "switchSum"))
    }

    @Fact
    func IncompleteOrdinaryGetter_StillReportsGs0100() {
        const Source = `package Issue2619.Incomplete

class C {
    private var condition bool

    prop Value int32 {
        get {
            if condition {
                return 1
            }
        }
    }
}`
        let tree = SyntaxTree.Parse(SourceText.From(Source))
        let compilation = Compilation(tree)
        using let peStream = MemoryStream()
        let result = compilation.Emit(peStream)
        Assert.Contains(result.Diagnostics, (diagnostic Diagnostic) -> diagnostic.Id == "GS0100")
    }

    shared {
        private func CompileAndRun(source string) Assembly {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let compilation = Compilation(tree)
            using let peStream = MemoryStream()
            let result = compilation.Emit(peStream)
            Assert.True(
                result.Success,
                string.Join(
                    Environment.NewLine,
                    result.Diagnostics.Select((diagnostic Diagnostic) -> diagnostic.ToString())
                )
            )
            let assembly = EmittedFixture.Load(peStream.ToArray())
            let program = assembly.GetTypes().Single((type Type) -> type.Name == "<Program>")
            let entry MethodInfo? = program.GetMethod(
                "<Main>$$",
                BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static
            )
            entry!!.Invoke(
                nil,
                if entry!!.GetParameters().Length == 0 {
                    default([]?object)
                } else {
                    []object{Array.Empty[string]()}
                }
            )
            return assembly
        }

        private func GetField(assembly Assembly, name string) int32 {
            let program = assembly.GetTypes().Single((type Type) -> type.Name == "<Program>")
            return int32(program.GetField(name, BindingFlags.Public | BindingFlags.Static)!!.GetValue(nil)!!)
        }
    }
}
