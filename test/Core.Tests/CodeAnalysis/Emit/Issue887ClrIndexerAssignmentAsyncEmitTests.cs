// <copyright file="Issue887ClrIndexerAssignmentAsyncEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.Loader;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;
using Xunit.Abstractions;

namespace GSharp.Core.Tests.CodeAnalysis.Emit;

/// <summary>
/// Issue #887: an index assignment through a member (e.g. <c>obj.Map["k"] = v</c>
/// on a <c>Dictionary</c>, or <c>psi.Environment["k"] = v</c>) inside a
/// state-machine method (<c>async func</c>, iterator, or async iterator)
/// previously failed at emit with GS9998
/// "Variable '&lt;idxAsn#&gt;' has no local slot or parameter index". The
/// synthesized index-assignment receiver temp was hoisted into a state-machine
/// field, but the index-assignment bound nodes keep their receiver as a raw
/// <see cref="GSharp.Core.CodeAnalysis.Symbols.VariableSymbol"/> that the
/// MoveNext rewriters never redirected to the hoisted field. These tests verify
/// emit succeeds and the writes persist.
/// </summary>
public class Issue887ClrIndexerAssignmentAsyncEmitTests
{
    private readonly ITestOutputHelper output;

    public Issue887ClrIndexerAssignmentAsyncEmitTests(ITestOutputHelper output)
    {
        this.output = output;
    }

    [Fact]
    public void MemberClrIndexerAssignment_InAsync_PersistsWrites()
    {
        var result = this.CompileAndRun(
            @"package R
import System
import System.Collections.Generic
import System.Threading.Tasks

class Wrap { prop Map Dictionary[string,string]
    init(m Dictionary[string,string]) { Map = m }
}

async func run() string {
    let h = Dictionary[string,string]()
    let w = Wrap(h)
    w.Map[""FOO""] = ""1""
    w.Map[""BAR""] = ""2""
    await Task.Yield()
    return w.Map[""FOO""] + w.Map[""BAR""]
}

var t = run()
t.Wait()
Console.WriteLine(t.Result)
",
            "Issue887Async");

        Assert.Contains("12", result);
    }

    [Fact]
    public void ProcessStartInfo_ObjectInitializer_AndEnvironmentIndexer_InAsync()
    {
        // The original repro shape from the issue: an object initializer block
        // followed by `psi.Environment[...] = ...` CLR-indexer writes, all inside
        // an async func.
        var result = this.CompileAndRun(
            @"package R
import System
import System.Diagnostics
import System.Threading.Tasks

async func run() int32 {
    let psi = ProcessStartInfo(""dotnet"")
    {
        RedirectStandardOutput = true,
        UseShellExecute = false
    }
    psi.Environment[""OAHU_NO_TUI""] = ""1""
    psi.Environment[""NO_COLOR""] = ""1""
    await Task.Yield()
    Console.WriteLine(psi.Environment[""OAHU_NO_TUI""] + psi.Environment[""NO_COLOR""])
    return 0
}

var t = run()
t.Wait()
",
            "Issue887Psi");

        Assert.Contains("11", result);
    }

    [Fact]
    public void MemberClrIndexerAssignment_InIterator_PersistsWrites()
    {
        var result = this.CompileAndRun(
            @"package R
import System
import System.Collections.Generic

class Wrap { prop Map Dictionary[string,string]
    init(m Dictionary[string,string]) { Map = m }
}

func gen() sequence[int32] {
    let w = Wrap(Dictionary[string,string]())
    w.Map[""FOO""] = ""1""
    yield 1
    Console.WriteLine(w.Map[""FOO""])
    yield 2
}

for x in gen() {
    Console.WriteLine(x)
}
",
            "Issue887Iter");

        Assert.Contains("1", result);
    }

    [Fact]
    public void MemberClrIndexerAssignment_InAsyncIterator_Emits()
    {
        // Async iterator (IAsyncEnumerable) state machine: emit must succeed
        // when a hoisted receiver temp feeds a CLR-indexer write.
        using var peStream = new MemoryStream();
        var tree = SyntaxTree.Parse(SourceText.From(
            @"package R
import System
import System.Collections.Generic
import System.Threading.Tasks

class Wrap { prop Map Dictionary[string,string]
    init(m Dictionary[string,string]) { Map = m }
}

func gen() IAsyncEnumerable[int32] {
    let w = Wrap(Dictionary[string,string]())
    w.Map[""FOO""] = ""1""
    yield 1
    await Task.Yield()
    w.Map[""BAR""] = ""2""
    yield 2
}
"));
        var compilation = new Compilation(tree);
        var result = compilation.Emit(peStream);
        foreach (var diagnostic in result.Diagnostics)
        {
            this.output.WriteLine(diagnostic.ToString());
        }

        Assert.True(
            result.Success,
            "compilation should succeed: " + string.Join("; ", result.Diagnostics.Select(d => d.Message)));
    }

    private string CompileAndRun(string source, string contextName)
    {
        using var peStream = new MemoryStream();
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        var result = compilation.Emit(peStream);
        foreach (var diagnostic in result.Diagnostics)
        {
            this.output.WriteLine(diagnostic.ToString());
        }

        Assert.True(
            result.Success,
            "compilation should succeed: " + string.Join("; ", result.Diagnostics.Select(d => d.Message)));

        peStream.Position = 0;
        var loadContext = new AssemblyLoadContext(contextName, isCollectible: true);
        try
        {
            var asm = loadContext.LoadFromStream(peStream);
            var programType = asm.GetTypes().First(t => t.Name == "<Program>");
            var entry = programType.GetMethod(
                "<Main>$",
                BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic);
            Assert.NotNull(entry);

            var stdout = Console.Out;
            var captured = new StringWriter();
            Console.SetOut(captured);
            try
            {
                entry!.Invoke(null, entry.GetParameters().Length == 0 ? null : new object[] { Array.Empty<string>() });
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
