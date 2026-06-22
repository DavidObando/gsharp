// <copyright file="Issue942IndexerIdentifierParseEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #942: member access on an element-access whose index is an
/// <em>identifier</em> — <c>expr[i].Member</c> — previously mis-parsed. The
/// parser's <c>LooksLikeGenericCallSite</c> disambiguator treated
/// <c>name[identifier]</c> followed by <c>.</c> as a generic type-argument
/// list (<c>Foo[Bar].Member</c>) rather than an indexer-then-member access,
/// because a lone identifier scans as a type clause and <c>.</c> was in the
/// generic follow-set. The literal-index form <c>expr[0].Member</c> parsed
/// correctly because a literal is not a type clause.
///
/// The fix restricts the <c>.</c> follow-set marker to the unambiguous
/// multi-type-argument shape (<c>Pair[int, string].zero</c>): an indexer can
/// only ever hold a single index expression, so a single bracketed argument
/// followed by <c>.</c> is parsed as an indexer-then-member access, matching
/// the literal-index behaviour. The <c>(</c> / <c>{</c> markers stay
/// arity-agnostic, so generic instantiations / calls / composite literals are
/// unaffected. The guard tests below lock in that genuine generics still work.
/// </summary>
public class Issue942IndexerIdentifierParseEmitTests
{
    [Fact]
    public void IdentifierIndex_MemberCall_ParsesAndCompiles()
    {
        // The headline scenario from the issue: `xs[i].ToString()` with an
        // identifier index used as the receiver of a member call.
        var source = """
            package P
            import System

            let xs = []int32{3, 1, 2}
            let i = 0
            Console.WriteLine(xs[0].ToString())
            Console.WriteLine(xs[i].ToString())
            public var result = xs[i]
            """;

        Assert.Equal(3, RunAndGetIntResult(source));
    }

    [Fact]
    public void IdentifierIndex_MemberAccess_ProducesElementMember()
    {
        // `names[i].Length` — member access (not a call) on the element
        // selected by an identifier index. Result is the int length.
        var source = """
            package P
            import System

            let names = []string{"ab", "cdef", "x"}
            let i = 1
            public var result = names[i].Length
            """;

        Assert.Equal(4, RunAndGetIntResult(source));
    }

    [Fact]
    public void IdentifierIndex_AsStandaloneValue()
    {
        // `xs[i]` used purely as a value (no postfix `.` or `(`).
        var source = """
            package P
            import System

            let xs = []int32{10, 20, 30}
            let i = 2
            public var result = xs[i]
            """;

        Assert.Equal(30, RunAndGetIntResult(source));
    }

    [Fact]
    public void NestedIdentifierIndexers_Parse()
    {
        // `m[i][j]` — nested indexers, both with identifier indices.
        var source = """
            package P
            import System
            import System.Collections.Generic

            let inner = List[int32]()
            inner.Add(30)
            inner.Add(40)
            let m = List[List[int32]]()
            m.Add(inner)
            m.Add(inner)
            let i = 1
            let j = 0
            public var result = m[i][j]
            """;

        Assert.Equal(30, RunAndGetIntResult(source));
    }

    [Fact]
    public void IdentifierIndex_AssignmentTarget()
    {
        // `xs[i] = v` — identifier index as the LHS of an assignment.
        var source = """
            package P
            import System

            let xs = []int32{3, 1, 2}
            let i = 1
            xs[i] = 99
            public var result = xs[i]
            """;

        Assert.Equal(99, RunAndGetIntResult(source));
    }

    [Fact]
    public void InterfaceTypedReceiver_IdentifierIndex_MemberCall()
    {
        // The IReadOnlyList[T] variant from the issue (a different GS0005 at
        // the DotToken): `ro[i].ToString()` on an interface-typed receiver.
        var source = """
            package P
            import System
            import System.Collections.Generic

            let xs = []int32{5, 6, 7}
            let ro IReadOnlyList[int32] = xs
            let i = 1
            Console.WriteLine(ro[i].ToString())
            public var result = ro[i]
            """;

        Assert.Equal(6, RunAndGetIntResult(source));
    }

    [Fact]
    public void ChainedMemberThenIdentifierIndexThenMember()
    {
        // `holder[0][i]` chained indexer access mixed with a literal and an
        // identifier index, used as the receiver of a member access.
        var source = """
            package P
            import System
            import System.Collections.Generic

            let row = List[int32]()
            row.Add(100)
            row.Add(200)
            let holder = List[List[int32]]()
            holder.Add(row)
            let i = 1
            public var result = holder[0][i].CompareTo(0)
            """;

        Assert.Equal(1, RunAndGetIntResult(source));
    }

    [Fact]
    public void GenericInstantiation_StillWorks()
    {
        // Guard: a genuine generic instantiation + call (`Dictionary[K, V]()`)
        // and indexing the result must still bind correctly. The `(` follow-set
        // marker is unchanged by the fix.
        var source = """
            package P
            import System
            import System.Collections.Generic

            let d = Dictionary[string, int32]()
            d.Add("k", 7)
            public var result = d["k"]
            """;

        Assert.Equal(7, RunAndGetIntResult(source));
    }

    [Fact]
    public void GenericMethodCall_StillWorks()
    {
        // Guard: an explicit generic method call `xs.ToList[int32]()` must
        // still parse as a generic call (the `(` follow-set marker), not an
        // indexer.
        var source = """
            package P
            import System
            import System.Collections.Generic
            import System.Linq

            let xs = []int32{5, 6, 7}
            let lst = xs.ToList[int32]()
            let i = 1
            public var result = lst[i]
            """;

        Assert.Equal(6, RunAndGetIntResult(source));
    }

    [Fact]
    public void MultiTypeArgGenericMember_StillTreatedAsGeneric()
    {
        // Guard: a multi-type-argument list followed by `.` is unambiguously a
        // generic type (an indexer cannot hold a comma-separated list), so the
        // `.` follow-set still commits to a generic call site for that shape.
        // `Dictionary[string, int32]().Count` exercises the multi-arg `.`
        // follow against the constructed generic.
        var source = """
            package P
            import System
            import System.Collections.Generic

            let d = Dictionary[string, int32]()
            d.Add("a", 1)
            d.Add("b", 2)
            public var result = d.Count
            """;

        Assert.Equal(2, RunAndGetIntResult(source));
    }

    private static int RunAndGetIntResult(string source)
    {
        var assembly = CompileToAssembly(source);
        var program = assembly.GetTypes().Single(t => t.Name == "<Program>");
        var entry = program.GetMethod(
            "<Main>$",
            BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);
        var resultField = program.GetField(
            "result",
            BindingFlags.Public | BindingFlags.Static);

        entry!.Invoke(null, entry.GetParameters().Length == 0 ? null : new object[] { System.Array.Empty<string>() });
        return (int)resultField!.GetValue(null)!;
    }

    private static Assembly CompileToAssembly(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue942_emit_").FullName;
        var srcPath = Path.Combine(tempDir, "test.gs");
        var outPath = Path.Combine(tempDir, "test.dll");
        File.WriteAllText(srcPath, source);

        using var compileOut = new StringWriter();
        using var compileErr = new StringWriter();
        var prevOut = Console.Out;
        var prevErr = Console.Error;
        Console.SetOut(compileOut);
        Console.SetError(compileErr);
        int compileExit;
        try
        {
            compileExit = Program.Main(new[]
            {
                "/out:" + outPath,
                "/target:exe",
                "/targetframework:net10.0",
                srcPath,
            });
        }
        finally
        {
            Console.SetOut(prevOut);
            Console.SetError(prevErr);
        }

        Assert.True(
            compileExit == 0,
            $"gsc failed:\nstdout:\n{compileOut}\nstderr:\n{compileErr}");

        var bytes = File.ReadAllBytes(outPath);
        return Assembly.Load(bytes);
    }
}
