// <copyright file="Issue2891SiblingAnalyzerNoDriftTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Linq;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Guards the two analyzers that share <see cref="ControlFlowGraph.Create"/>:
/// definite-return-only try and exhaustiveness projection must not change
/// GS0238/GS0239 assignment or GS0219 async ref-struct diagnostics.
/// </summary>
public class Issue2891SiblingAnalyzerNoDriftTests
{
    /// <summary>Gets sibling-analyzer shapes and expected relevant diagnostic IDs.</summary>
    public static IEnumerable<object[]> Cases()
    {
        yield return Case("OutFinallyAssigned", "", """
            func F(out value int32) {
                try {
                } finally {
                    value = 1
                }
            }
            """);
        yield return Case("OutTryOnlyCatchCompletes", "GS0238", """
            import System
            func F(out value int32) {
                try {
                    value = 1
                } catch (ex Exception) {
                }
            }
            """);
        yield return Case("OutTryAndCatchAssigned", "", """
            import System
            func F(out value int32) {
                try {
                    value = 1
                } catch (ex Exception) {
                    value = 2
                }
            }
            """);
        yield return Case("OutTryCatchFinallyAssigned", "", """
            import System
            func F(out value int32) {
                try {
                } catch (ex Exception) {
                } finally {
                    value = 3
                }
            }
            """);
        yield return Case("RefTryOnlyCatchCompletes", "GS0239", """
            import System
            func Bump(ref value int32) {
                value += 1
            }
            func F() {
                var value int32
                try {
                    value = 1
                } catch (ex Exception) {
                }
                Bump(&value)
            }
            """);
        yield return Case("RefFinallyAssigned", "", """
            func Bump(ref value int32) {
                value += 1
            }
            func F() {
                var value int32
                try {
                } finally {
                    value = 1
                }
                Bump(&value)
            }
            """);
        yield return Case("OutExhaustiveEnumNoDefault", "GS0238", """
            enum E { A, B }
            func F(out value int32, x E) {
                switch x {
                    case E.A { value = 1 }
                    case E.B { value = 2 }
                }
            }
            """);
        yield return Case("OutEnumWithDefault", "", """
            enum E { A, B }
            func F(out value int32, x E) {
                switch x {
                    case E.A { value = 1 }
                    default { value = 2 }
                }
            }
            """);
        yield return Case("RefExhaustiveEnumNoDefault", "GS0239", """
            enum E { A, B }
            func Bump(ref value int32) {
                value += 1
            }
            func F(x E) {
                var value int32
                switch x {
                    case E.A { value = 1 }
                    case E.B { value = 2 }
                }
                Bump(&value)
            }
            """);
        yield return Case("SpanTryDeadBeforeAwait", "", """
            import System
            import System.Threading.Tasks
            async func F(values []int32) Task[int32] {
                var span ReadOnlySpan[int32] = values
                var length = 0
                try {
                    length = span.Length
                } finally {
                }
                await Task.Yield()
                return length
            }
            """);
        yield return Case("SpanTryLiveAcrossAwait", "GS0219", """
            import System
            import System.Threading.Tasks
            async func F(values []int32) Task[int32] {
                var span ReadOnlySpan[int32] = values
                try {
                    await Task.Yield()
                } finally {
                    var length = span.Length
                }
                return 0
            }
            """);
        yield return Case("SpanExhaustiveSwitchLiveAcrossAwait", "GS0219", """
            import System
            import System.Threading.Tasks
            enum E { A, B }
            async func F(values []int32, x E) Task[int32] {
                var span ReadOnlySpan[int32] = values
                await Task.Yield()
                switch x {
                    case E.A { return span.Length }
                    case E.B { return span.Length + 1 }
                }
            }
            """);
    }

    [Theory]
    [MemberData(nameof(Cases))]
    public void SharedCfgDiagnosticsRemainUnchanged(string name, string expectedIds, string source)
    {
        _ = name;
        var compilation = new Compilation(SyntaxTree.Parse(SourceText.From(source)));
        var actual = compilation.GlobalScope.Diagnostics
            .Concat(compilation.BoundProgram.Diagnostics)
            .Where(diagnostic => diagnostic.Id is "GS0219" or "GS0238" or "GS0239")
            .Select(diagnostic => diagnostic.Id)
            .Distinct()
            .OrderBy(id => id);
        var expected = expectedIds
            .Split(',', System.StringSplitOptions.RemoveEmptyEntries)
            .OrderBy(id => id);
        Assert.Equal(expected, actual);
    }

    private static object[] Case(string name, string expectedIds, string body)
        => new object[] { name, expectedIds, $"package Issue2891.NoDrift{name}{System.Environment.NewLine}{body}" };
}
