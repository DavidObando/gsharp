// <copyright file="Issue507MemberIndexAssignmentEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #507: <c>obj.Member[key] = value</c> previously failed to parse
/// with <c>GS0005: Unexpected token &lt;EqualsToken&gt;</c>. The parser
/// folded <c>[...]</c> into the right-hand side of the trailing <c>.</c>
/// (producing <c>AccessorExpression(obj, ., IndexExpression(Member, [k]))</c>)
/// and the assignment path only special-cased a bare identifier on the LHS,
/// so the trailing <c>=</c> had no production to match.
///
/// The fix lifts the trailing index access into a canonical
/// <c>IndexExpression(&lt;receiver-chain&gt;, [k])</c>, wraps it in a new
/// <c>MemberIndexAssignmentExpressionSyntax</c>, and the binder lowers it
/// through a synthesized temp local so the existing CLR-indexer / array /
/// map assignment paths are reused unchanged. The tests below lock in the
/// new shape and guard against regressions in the surrounding parser arms.
/// </summary>
public class Issue507MemberIndexAssignmentEmitTests
{
    [Fact]
    public void MemberIndexerAssignment_WritesThroughSetterAndReadsBack()
    {
        // The headline scenario: an indexer write whose LHS is `obj.Field`.
        // The synthesized temp must hold the bound field value so the
        // existing `set_Item` emission produces a callvirt against it.
        // Reading back via the workaround local form (`let m = h.Map; m[k]`)
        // confirms the write landed on the same backing dictionary.
        var source = """
            package P
            import System
            import System.Collections.Generic

            type Holder struct {
                Map Dictionary[string, int32]
            }

            func MakeHolder() Holder {
                return Holder{Map: Dictionary[string, int32]()}
            }

            let h = MakeHolder()
            h.Map["answer"] = 42
            let inner = h.Map
            public var result = inner["answer"]
            """;

        Assert.Equal(42, RunAndGetIntResult(source));
    }

    [Fact]
    public void ChainedMemberIndexerAssignment_LiftsTrailingIndexer()
    {
        // The reshape recurses through nested AccessorExpressions, so
        // `o.Inner.Map[k] = v` must canonicalize to
        // `IndexExpression(AccessorExpression(o, ., AccessorExpression(Inner, ., Map)), [k])`
        // before binding. A wrong reshape would leave the inner accessor
        // dangling and either fail to parse or bind the indexer against
        // the wrong receiver.
        var source = """
            package P
            import System
            import System.Collections.Generic

            type Inner struct {
                Map Dictionary[string, int32]
            }

            type Outer struct {
                InnerObj Inner
            }

            func MakeOuter() Outer {
                return Outer{InnerObj: Inner{Map: Dictionary[string, int32]()}}
            }

            let o = MakeOuter()
            o.InnerObj.Map["k"] = 99
            let m = o.InnerObj.Map
            public var result = m["k"]
            """;

        Assert.Equal(99, RunAndGetIntResult(source));
    }

    [Fact]
    public void CallResultIndexerAssignment_AlsoWorks()
    {
        // The fix is not limited to member access: any expression whose
        // trailing primary is an index access becomes a valid LHS. Here
        // the receiver chain is a call (`MakeMap()`), which exercises the
        // top-level IndexExpression branch of TryLiftTrailingIndexer.
        var source = """
            package P
            import System
            import System.Collections.Generic

            func MakeMap() Dictionary[string, int32] {
                return Dictionary[string, int32]()
            }

            let shared = MakeMap()
            shared["seed"] = 7
            MakeMap()["throwaway"] = 99
            public var result = shared["seed"]
            """;

        Assert.Equal(7, RunAndGetIntResult(source));
    }

    [Fact]
    public void GenericTypeArgsAfterMemberAccess_StillParsesAsCall()
    {
        // Regression guard: `foo.Bar[int32](...)` must keep being parsed
        // as a member-then-generic-call, not as the new indexer-assignment
        // shape. The ADR-0020 disambiguation (`LooksLikeGenericCallSite`)
        // runs inside `ParseNameOrCallExpression`, so the trailing `[T](`
        // continues to be folded into a `CallExpression` on the right
        // side of `.` and never reaches the assignment tail.
        var source = """
            package P
            import System

            type Holder struct {
                Value int32
            }

            func (h Holder) Pick[T](v T) int32 {
                return h.Value
            }

            let h = Holder{Value: 17}
            public var result = h.Pick[int32](0)
            """;

        Assert.Equal(17, RunAndGetIntResult(source));
    }

    [Fact]
    public void MemberIndexRead_ViaLocalBinding_StillWorks()
    {
        // Regression guard for the documented workaround (binding the
        // indexed property to a local first). This path predates the
        // fix and must not be perturbed by the new parser arm.
        var source = """
            package P
            import System
            import System.Collections.Generic

            type Holder struct {
                Map Dictionary[string, int32]
            }

            let h = Holder{Map: Dictionary[string, int32]()}
            let env = h.Map
            env["NO_COLOR"] = 1
            public var result = env["NO_COLOR"]
            """;

        Assert.Equal(1, RunAndGetIntResult(source));
    }

    [Fact]
    public void BareIdentifierIndexerAssignment_StillWorks()
    {
        // Regression guard: the pre-existing `id[k] = v` arm
        // (IndexAssignmentExpressionSyntax) must continue to win against
        // the new tail handler. The tail handler only fires when the
        // earlier identifier-specific arms have already declined.
        var source = """
            package P
            import System
            import System.Collections.Generic

            let d = Dictionary[string, int32]()
            d["x"] = 5
            public var result = d["x"]
            """;

        Assert.Equal(5, RunAndGetIntResult(source));
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

        entry!.Invoke(null, null);
        return (int)resultField!.GetValue(null)!;
    }

    private static Assembly CompileToAssembly(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue507_emit_").FullName;
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
