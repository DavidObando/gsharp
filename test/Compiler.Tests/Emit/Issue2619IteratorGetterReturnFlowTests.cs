// <copyright file="Issue2619IteratorGetterReturnFlowTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

public class Issue2619IteratorGetterReturnFlowTests
{
    [Fact]
    public void ExhaustiveIteratorGetters_EmitAndRun()
    {
        const string Source = """
            package Oahu.Cli.Tui.Screens

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
            }
            """;

        var assembly = CompileAndRun(Source);

        Assert.Equal(8, GetField(assembly, "hintCount"));
        Assert.Equal(30, GetField(assembly, "switchSum"));
    }

    [Fact]
    public void IncompleteOrdinaryGetter_StillReportsGs0100()
    {
        const string Source = """
            package Issue2619.Incomplete

            class C {
                private var condition bool

                prop Value int32 {
                    get {
                        if condition {
                            return 1
                        }
                    }
                }
            }
            """;

        var tree = SyntaxTree.Parse(SourceText.From(Source));
        var compilation = new Compilation(tree);
        using var peStream = new MemoryStream();
        var result = compilation.Emit(peStream);

        Assert.Contains(result.Diagnostics, diagnostic => diagnostic.Id == "GS0100");
    }

    private static Assembly CompileAndRun(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        using var peStream = new MemoryStream();
        var result = compilation.Emit(peStream);

        Assert.True(
            result.Success,
            string.Join(Environment.NewLine, result.Diagnostics.Select(diagnostic => diagnostic.ToString())));

        var assembly = Assembly.Load(peStream.ToArray());
        var program = assembly.GetTypes().Single(type => type.Name == "<Program>");
        var entry = program.GetMethod("<Main>$", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);
        entry!.Invoke(null, entry.GetParameters().Length == 0 ? null : new object[] { Array.Empty<string>() });
        return assembly;
    }

    private static int GetField(Assembly assembly, string name)
    {
        var program = assembly.GetTypes().Single(type => type.Name == "<Program>");
        return (int)program.GetField(name, BindingFlags.Public | BindingFlags.Static)!.GetValue(null)!;
    }
}
