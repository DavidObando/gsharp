// <copyright file="Issue2385NullableSameCompilationStructGenericArgTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #2385: <see cref="ConversionClassifier.TrySubstituteParameterTypeFromReceiver"/>
/// recovers the substituted parameter type for a call on an imported generic
/// receiver (e.g. <c>List[T].Add(value)</c>) whose type argument is a
/// same-compilation user type, so the binder does not misclassify the
/// argument as a boxing conversion to the erased CLR shape. Its gate,
/// however, only matched a receiver type argument that was DIRECTLY a
/// <see cref="StructSymbol"/>/<see cref="InterfaceSymbol"/>/<see cref="EnumSymbol"/>/
/// <see cref="DelegateTypeSymbol"/> (or a nested <see cref="ImportedTypeSymbol"/>) —
/// a same-compilation struct/enum WRAPPED in <see cref="NullableTypeSymbol"/>
/// (e.g. the receiver type argument of <c>List[Point?]</c>) matched none of
/// those cases, so the gate bailed out (returned <see langword="null"/>)
/// before ever attempting the substitution. The call then fell back to the
/// erased CLR parameter type (effectively <c>object</c>), and the argument
/// was bound as a boxing conversion — emitting an invalid <c>box</c>/<c>ldnull</c>
/// sequence against what is actually a value-type <c>Nullable&lt;T&gt;</c>
/// generic parameter slot (<c>InvalidProgramException</c> at runtime).
/// <para>
/// The fix replaces the narrow ad hoc list with
/// <see cref="TypeSymbol.ContainsSameCompilationUserType"/> — the general,
/// already-established predicate for exactly this shape (it recurses through
/// <c>NullableTypeSymbol</c>/<c>SliceTypeSymbol</c>/<c>ArrayTypeSymbol</c>/
/// <c>TupleTypeSymbol</c>/nested <c>ImportedTypeSymbol</c> uniformly), which
/// is a structural superset of the old list and additionally generalizes to
/// same-compilation enums wrapped in <c>Nullable&lt;T&gt;</c>.
/// </para>
/// <para>
/// These tests assert directly on the bound
/// <see cref="BoundImportedInstanceCallExpression.Arguments"/> types (after
/// argument-conversion rebinding) rather than only on the absence of
/// diagnostics, since the pre-fix defect compiled without any diagnostic and
/// only manifested as an <c>InvalidProgramException</c> at runtime.
/// </para>
/// </summary>
public class Issue2385NullableSameCompilationStructGenericArgTests
{
    [Fact]
    public void ListOfNullableUserStruct_AddConcreteValue_ArgumentSubstitutedToNullableOfStruct()
    {
        const string source = @"
package p
import System.Collections.Generic
struct Point2385(X int32, Y int32) { }
func Outer() {
    let list = List[Point2385?]()
    list.Add(Point2385(1, 2))
}
";
        var compilation = Compile(source);
        Assert.Empty(compilation.GlobalScope.Diagnostics);

        var call = FindImportedInstanceCall(compilation, "Outer", "Add");
        Assert.NotNull(call);
        var argType = Assert.IsType<NullableTypeSymbol>(call.Arguments[0].Type);
        Assert.Equal("Point2385", argType.UnderlyingType.Name);
        Assert.NotEqual(typeof(object), argType.UnderlyingType.ClrType);
    }

    [Fact]
    public void ListOfNullableUserStruct_AddNil_ArgumentSubstitutedToNullableOfStruct_NotErasedToObject()
    {
        const string source = @"
package p
import System.Collections.Generic
struct Point2385Nil(X int32, Y int32) { }
func Outer() {
    let list = List[Point2385Nil?]()
    list.Add(nil)
}
";
        var compilation = Compile(source);
        Assert.Empty(compilation.GlobalScope.Diagnostics);

        var call = FindImportedInstanceCall(compilation, "Outer", "Add");
        Assert.NotNull(call);

        // The nil argument must be lowered (by the binder) at the recovered
        // Nullable[Point2385Nil] target, not left/erased at `object` — a
        // `BoundDefaultExpression` typed `object` is exactly the pre-fix
        // shape that emitted the invalid `ldnull` against a value-type slot.
        var argType = Assert.IsType<NullableTypeSymbol>(call.Arguments[0].Type);
        Assert.Equal("Point2385Nil", argType.UnderlyingType.Name);
        Assert.IsType<BoundDefaultExpression>(call.Arguments[0]);
    }

    [Fact]
    public void ListOfNullableUserEnum_AddConcreteValueAndNil_ArgumentsSubstitutedToNullableOfEnum()
    {
        const string source = @"
package p
import System.Collections.Generic
enum Color2385 { Red, Green, Blue }
func Outer() {
    let list = List[Color2385?]()
    list.Add(Color2385.Green)
    list.Add(nil)
}
";
        var compilation = Compile(source);
        Assert.Empty(compilation.GlobalScope.Diagnostics);

        var calls = FindImportedInstanceCalls(compilation, "Outer", "Add");
        Assert.Equal(2, calls.Count);
        foreach (var call in calls)
        {
            var argType = Assert.IsType<NullableTypeSymbol>(call.Arguments[0].Type);
            Assert.Equal("Color2385", argType.UnderlyingType.Name);
        }
    }

    [Fact]
    public void DictionaryValueNullableUserStruct_IndexerSet_ArgumentSubstitutedToNullableOfStruct()
    {
        // Coverage: the same-compilation nullable struct occupies the SECOND
        // (value) type-argument position of a two-argument imported generic
        // (Dictionary[TKey,TValue]), via a plain indexer assignment
        // (`d[k] = v`, bound as BoundClrIndexAssignmentExpression). This
        // path uses the separate `MapErasedIndexerElementType` substitution
        // helper (issue #968), whose gate (`arg.ClrType == null`) already
        // covers a NullableTypeSymbol wrapping a same-compilation struct
        // (NullableTypeSymbol.ClrType delegates to the underlying type,
        // which is null pre-emit) — so this scenario was NOT part of the
        // #2385 defect. Kept as a sibling-path regression control alongside
        // the (buggy, now-fixed) Add(...) call-argument path.
        const string source = @"
package p
import System.Collections.Generic
struct Point2385Dict(X int32, Y int32) { }
func Outer() {
    let dict = Dictionary[string, Point2385Dict?]()
    dict[""a""] = Point2385Dict(1, 2)
    dict[""b""] = nil
}
";
        var compilation = Compile(source);
        Assert.Empty(compilation.GlobalScope.Diagnostics);

        // A plain (non-compound) indexer assignment `d[k] = v` binds to
        // BoundClrIndexAssignmentExpression, not a named `set_Item` call
        // node — the emitter later resolves the setter from `Indexer`.
        var writes = FindIndexAssignments(compilation, "Outer");
        Assert.Equal(2, writes.Count);
        foreach (var write in writes)
        {
            var argType = Assert.IsType<NullableTypeSymbol>(write.Value.Type);
            Assert.Equal("Point2385Dict", argType.UnderlyingType.Name);
        }
    }

    [Fact]
    public void ListOfNonNullableUserStruct_AddConcreteValue_RegressionStillSubstitutesDirectly()
    {
        // Regression control: the pre-existing (#765) DIRECT (non-nullable)
        // same-compilation struct type argument must still substitute
        // correctly — the fix only widens the gate, it must not narrow it.
        const string source = @"
package p
import System.Collections.Generic
struct Point2385Direct(X int32, Y int32) { }
func Outer() {
    let list = List[Point2385Direct]()
    list.Add(Point2385Direct(1, 2))
}
";
        var compilation = Compile(source);
        Assert.Empty(compilation.GlobalScope.Diagnostics);

        var call = FindImportedInstanceCall(compilation, "Outer", "Add");
        Assert.NotNull(call);

        // Identity conversion (no Nullable wrapper) — argument type is the
        // struct itself, not erased to object.
        var argType = Assert.IsType<StructSymbol>(call.Arguments[0].Type);
        Assert.Equal("Point2385Direct", argType.Name);
    }

    [Fact]
    public void ListOfNullablePrimitive_AddConcreteValueAndNil_RegressionUnaffected()
    {
        // Negative control: a BUILT-IN nullable value type (Nullable<int32>)
        // must keep binding and running exactly as before — this scenario
        // never reaches TrySubstituteParameterTypeFromReceiver's
        // same-compilation gate at all (overload resolution here actually
        // prefers the explicit `IList.Add(object)` interface implementation
        // over the generic `List<T>.Add(T)` for a bare int32 literal, and
        // that boxing conversion is unrelated to, and unaffected by, the
        // #2385 fix). The full compile+run+ILVerify coverage for this
        // control lives in the Compiler.Tests emit-level counterpart.
        const string source = @"
package p
import System.Collections.Generic
func Outer() {
    let list = List[int32?]()
    list.Add(42)
    list.Add(nil)
}
";
        var compilation = Compile(source);
        Assert.Empty(compilation.GlobalScope.Diagnostics);

        var calls = FindImportedInstanceCalls(compilation, "Outer", "Add");
        Assert.Equal(2, calls.Count);
    }

    private static Compilation Compile(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        return new Compilation(tree) { IsLibrary = true };
    }

    private static BoundImportedInstanceCallExpression FindImportedInstanceCall(Compilation compilation, string functionName, string methodName)
        => FindImportedInstanceCalls(compilation, functionName, methodName).FirstOrDefault();

    private static List<BoundImportedInstanceCallExpression> FindImportedInstanceCalls(Compilation compilation, string functionName, string methodName)
    {
        var fn = compilation.BoundProgram.Functions.Keys.Single(f => f.Name == functionName);
        var body = compilation.BoundProgram.Functions[fn];
        var collector = new ImportedInstanceCallCollector(methodName);
        collector.Visit(body);
        return collector.Collected;
    }

    private static List<BoundClrIndexAssignmentExpression> FindIndexAssignments(Compilation compilation, string functionName)
    {
        var fn = compilation.BoundProgram.Functions.Keys.Single(f => f.Name == functionName);
        var body = compilation.BoundProgram.Functions[fn];
        var collector = new ClrIndexAssignmentCollector();
        collector.Visit(body);
        return collector.Collected;
    }

    private sealed class ImportedInstanceCallCollector : BoundTreeWalker
    {
        private readonly string methodName;

        public ImportedInstanceCallCollector(string methodName)
        {
            this.methodName = methodName;
        }

        public List<BoundImportedInstanceCallExpression> Collected { get; } = new();

        public override void VisitExpression(BoundExpression node)
        {
            if (node is BoundImportedInstanceCallExpression call && call.Method.Name == methodName)
            {
                Collected.Add(call);
            }

            base.VisitExpression(node);
        }
    }

    private sealed class ClrIndexAssignmentCollector : BoundTreeWalker
    {
        public List<BoundClrIndexAssignmentExpression> Collected { get; } = new();

        public override void VisitExpression(BoundExpression node)
        {
            if (node is BoundClrIndexAssignmentExpression write)
            {
                Collected.Add(write);
            }

            base.VisitExpression(node);
        }
    }
}
