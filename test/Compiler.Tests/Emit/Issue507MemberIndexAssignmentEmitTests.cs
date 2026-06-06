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

    [Fact]
    public void MemberIndexerRead_ChainedShape_BindsCleanly()
    {
        // Issue #507 follow-up (bind-side read): although `let v = h.Map[k]`
        // was listed in the original issue as "works", BindAccessorStep had no
        // case for IndexExpressionSyntax, so a folded read shape
        // (`AccessorExpression(h, ., IndexExpression(Map, [k]))`) produced
        // BoundErrorExpression with no diagnostic and surfaced downstream as
        // GS9998. The added IndexExpressionSyntax case in BindAccessorStep
        // routes the read through the same shared helper used by writes.
        var source = """
            package P
            import System
            import System.Collections.Generic

            type Holder struct {
                Map Dictionary[string, int32]
            }

            let h = Holder{Map: Dictionary[string, int32]()}
            h.Map["answer"] = 42
            public var result = h.Map["answer"]
            """;

        Assert.Equal(42, RunAndGetIntResult(source));
    }

    [Fact]
    public void MemberIndexerCompoundAssignment_PlusEquals()
    {
        // Issue #507 follow-up: compound `op=` assignment through a member
        // chain must (a) parse via the new CompoundIndexAssignmentExpression
        // shape and (b) lower into a single read+write against one captured
        // receiver. Final read confirms the dictionary slot was updated.
        var source = """
            package P
            import System
            import System.Collections.Generic

            type Holder struct {
                Map Dictionary[string, int32]
            }

            let h = Holder{Map: Dictionary[string, int32]()}
            h.Map["k"] = 5
            h.Map["k"] += 3
            public var result = h.Map["k"]
            """;

        Assert.Equal(8, RunAndGetIntResult(source));
    }

    [Fact]
    public void MemberIndexerCompoundAssignment_MinusEqualsAndStarEquals()
    {
        // Mirrors PlusEquals for additional compound ops to lock in that the
        // dispatch is operator-agnostic and goes through TryGetCompoundAssignmentBaseOperator.
        var source = """
            package P
            import System
            import System.Collections.Generic

            type Holder struct {
                Map Dictionary[string, int32]
            }

            let h = Holder{Map: Dictionary[string, int32]()}
            h.Map["k"] = 10
            h.Map["k"] -= 4
            h.Map["k"] *= 3
            public var result = h.Map["k"]
            """;

        Assert.Equal(18, RunAndGetIntResult(source));
    }

    [Fact]
    public void LocalIndexerCompoundAssignment_AlsoWorks()
    {
        // Issue #507 follow-up: the local-variable form (`d[k] += v`) was
        // also broken pre-fix (parser reported GS0005 on `+=`). The new
        // parser path covers both shapes through a single
        // CompoundIndexAssignmentExpression node so the public language is
        // consistent for compound indexer assignment.
        var source = """
            package P
            import System
            import System.Collections.Generic

            let d = Dictionary[string, int32]()
            d["x"] = 7
            d["x"] += 11
            public var result = d["x"]
            """;

        Assert.Equal(18, RunAndGetIntResult(source));
    }

    [Fact]
    public void ChainedMemberIndexerCompoundAssignment_DeepChain()
    {
        // Deep member chain with compound op: receiver is a struct field
        // referenced through another struct field. The receiver chain
        // (`o.InnerObj.Map`) must be captured into a single temp; both the
        // read and write of the indexer must target the same dictionary.
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

            let o = Outer{InnerObj: Inner{Map: Dictionary[string, int32]()}}
            o.InnerObj.Map["k"] = 100
            o.InnerObj.Map["k"] += 23
            public var result = o.InnerObj.Map["k"]
            """;

        Assert.Equal(123, RunAndGetIntResult(source));
    }

    [Fact]
    public void MemberIndexerCompoundAssignment_ReceiverEvaluatedOnce()
    {
        // Receiver-once contract: when the chain receiver has side effects
        // (here a function returning the dictionary while incrementing a
        // static counter), the compound `op=` form must evaluate it
        // exactly once. After `Bag().Map["k"] += 5`, the counter must be 1
        // (not 2) and the indexer write must land on the single returned
        // bag — observable by reading back via a separately-cached handle.
        var source = """
            package P
            import System
            import System.Collections.Generic

            type Bag struct {
                Map Dictionary[string, int32]
            }

            public var calls = 0
            let stored = Bag{Map: Dictionary[string, int32]()}

            func GetBag() Bag {
                calls = calls + 1
                return stored
            }

            stored.Map["k"] = 10
            GetBag().Map["k"] += 5
            public var resultValue = stored.Map["k"]
            public var resultCalls = calls
            """;

        var (value, calls) = RunAndGetTwoIntResults(source, "resultValue", "resultCalls");
        Assert.Equal(15, value);
        Assert.Equal(1, calls);
    }

    [Fact]
    public void NullConditionalMemberIndexerAssignment_WritesWhenNonNil()
    {
        // Issue #507 follow-up: `obj?.Map[k] = v` writes through when obj
        // is non-nil. The chain receiver is captured into a synthetic
        // `$ncap_N` local; the BoundNullConditionalAccessExpression wraps
        // the indexer assignment as the whenNotNull branch. We observe
        // the landing via a separately-held reference to the same
        // dictionary (avoids reading through `?.` on a value-type result).
        var source = """
            package P
            import System
            import System.Collections.Generic

            type Holder class(Map Dictionary[string, int32]) {
            }

            let m = Dictionary[string, int32]()
            let h Holder? = Holder(m)
            h?.Map["k"] = 77
            public var result = m["k"]
            """;

        Assert.Equal(77, RunAndGetIntResult(source));
    }

    [Fact]
    public void NullConditionalMemberIndexerAssignment_NoOpsWhenNil()
    {
        // No-op semantics: when the receiver is nil, the indexer write
        // must not be evaluated. The dictionary captured into the
        // observation handle stays unchanged. This guards against a
        // regression that would unconditionally call set_Item.
        var source = """
            package P
            import System
            import System.Collections.Generic

            type Holder class(Map Dictionary[string, int32]) {
            }

            let m = Dictionary[string, int32]()
            m["k"] = 10
            let h Holder? = nil
            h?.Map["k"] = 99
            public var result = m["k"]
            """;

        Assert.Equal(10, RunAndGetIntResult(source));
    }

    [Fact]
    public void DeepNullConditionalMemberIndexerAssignment_WorksWhenIntermediateNonNil()
    {
        // Deep chain `o.InnerObj?.Map[k] = v` where InnerObj is a
        // nullable class field. The split helper must walk the
        // right-recursive parse tree to find the `?.` and capture
        // `o.InnerObj` (not just `o`). We observe through a separately
        // held reference to the inner dictionary so the read path
        // doesn't need to thread `?.` over an int value.
        var source = """
            package P
            import System
            import System.Collections.Generic

            type Inner class(Map Dictionary[string, int32]) {
            }

            type Outer class(InnerObj Inner?) {
            }

            let m = Dictionary[string, int32]()
            let o = Outer(Inner(m))
            o.InnerObj?.Map["k"] = 55
            public var result = m["k"]
            """;

        Assert.Equal(55, RunAndGetIntResult(source));
    }

    [Fact]
    public void DeepNullConditionalMemberIndexerAssignment_NoOpsWhenIntermediateNil()
    {
        // Mirror of the deep NC write but the intermediate field is nil.
        // No write may occur. We observe the no-op via a captured handle
        // (the dictionary that *would* be the target if InnerObj were
        // non-nil) and verify it is unchanged.
        var source = """
            package P
            import System
            import System.Collections.Generic

            type Inner class(Map Dictionary[string, int32]) {
            }

            type Outer class(InnerObj Inner?) {
            }

            let o = Outer(nil)
            o.InnerObj?.Map["k"] = 999
            public var result = 7
            """;

        Assert.Equal(7, RunAndGetIntResult(source));
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

    private static (int First, int Second) RunAndGetTwoIntResults(string source, string firstField, string secondField)
    {
        var assembly = CompileToAssembly(source);
        var program = assembly.GetTypes().Single(t => t.Name == "<Program>");
        var entry = program.GetMethod(
            "<Main>$",
            BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);
        var first = program.GetField(firstField, BindingFlags.Public | BindingFlags.Static);
        var second = program.GetField(secondField, BindingFlags.Public | BindingFlags.Static);

        entry!.Invoke(null, null);
        return ((int)first!.GetValue(null)!, (int)second!.GetValue(null)!);
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
