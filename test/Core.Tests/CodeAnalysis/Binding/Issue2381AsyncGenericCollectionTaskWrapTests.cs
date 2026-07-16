// <copyright file="Issue2381AsyncGenericCollectionTaskWrapTests.cs" company="GSharp">
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
/// Issue #2381: <see cref="LambdaBinder.WrapAsTask"/> previously only routed
/// a NULL-<see cref="TypeSymbol.ClrType"/> element (bare same-compilation
/// struct/interface/enum/tuple, or a type-parameter-containing type — issues
/// #1785/#2026/#2232) through the symbolic <c>Task&lt;T&gt;</c> construction
/// that preserves the real element identity for downstream (emit-time and
/// call-site delegate-target-typing) consumers. An imported generic
/// collection closed over a same-compilation argument (e.g.
/// <c>List[UserClass]</c>) reports a NON-null but object-erased ClrType
/// (<c>List&lt;object&gt;</c>) and a same-compilation array/slice element
/// (e.g. <c>[]UserClass</c>) reports a genuinely null ClrType that matched
/// none of the old hand-listed wrapper kinds — both silently fell through to
/// either the ordinary erased-reflection <c>Task&lt;T&gt;</c> construction or
/// (for the array/slice case) no Task-wrapping at all.
/// <para>
/// Mirroring <c>Issue2026GenericAsyncTaskWrapTests</c>'s pattern: a same-
/// compilation <see cref="FunctionSymbol.Type"/> holds the DECLARED
/// (unwrapped) inner result type — <c>WrapAsTask</c>'s widened, Task-wrapped
/// "observable" type is instead computed at each call site (a
/// <see cref="BoundCallExpression"/> invoking the async function). These
/// tests therefore bind a small caller around each async repro and assert on
/// the CALL EXPRESSION's <c>.Type</c>, exactly like the #2026 suite.
/// </para>
/// </summary>
public class Issue2381AsyncGenericCollectionTaskWrapTests
{
    [Fact]
    public void AsyncFunctionReturningListOfUserClass_CallSiteObservedAsSymbolicTaskOfListOfUserClass()
    {
        const string source = @"
package p
import System.Collections.Generic
class DiagnosticCheck2381Wrap {}
async func RunAsync() List[DiagnosticCheck2381Wrap] {
    let results = List[DiagnosticCheck2381Wrap]()
    return results
}
func Outer() {
    var r = RunAsync()
}
";
        var compilation = Compile(source);
        Assert.Empty(compilation.GlobalScope.Diagnostics);

        var call = FindCall(compilation, "Outer", "RunAsync");
        AssertIsTaskOfCollectionOfUserType(call.Type, "List", "DiagnosticCheck2381Wrap");
    }

    [Fact]
    public void AsyncFunctionReturningDictionaryOfStringToUserClass_CallSiteObservedAsSymbolicTaskOfDictionary()
    {
        const string source = @"
package p
import System.Collections.Generic
class DiagnosticCheck2381Dict {}
async func RunAsync() Dictionary[string, DiagnosticCheck2381Dict] {
    let results = Dictionary[string, DiagnosticCheck2381Dict]()
    return results
}
func Outer() {
    var r = RunAsync()
}
";
        var compilation = Compile(source);
        Assert.Empty(compilation.GlobalScope.Diagnostics);

        var call = FindCall(compilation, "Outer", "RunAsync");
        var task = Assert.IsType<ImportedTypeSymbol>(call.Type);
        Assert.True(task.ClrType.IsGenericType && task.ClrType.GetGenericTypeDefinition() == typeof(System.Threading.Tasks.Task<>));
        Assert.Single(task.TypeArguments);

        var dict = Assert.IsType<ImportedTypeSymbol>(task.TypeArguments[0]);
        Assert.Equal(2, dict.TypeArguments.Length);
        Assert.Equal("string", dict.TypeArguments[0].Name);
        Assert.Equal("DiagnosticCheck2381Dict", dict.TypeArguments[1].Name);
        Assert.NotEqual(typeof(object), dict.TypeArguments[1].ClrType);
    }

    [Fact]
    public void AsyncFunctionReturningNestedListOfListOfUserClass_CallSiteObservedAsSymbolicTaskThroughBothLayers()
    {
        const string source = @"
package p
import System.Collections.Generic
class DiagnosticCheck2381Nested {}
async func RunAsync() List[List[DiagnosticCheck2381Nested]] {
    let results = List[List[DiagnosticCheck2381Nested]]()
    return results
}
func Outer() {
    var r = RunAsync()
}
";
        var compilation = Compile(source);
        Assert.Empty(compilation.GlobalScope.Diagnostics);

        var call = FindCall(compilation, "Outer", "RunAsync");
        var task = Assert.IsType<ImportedTypeSymbol>(call.Type);
        var outerList = Assert.IsType<ImportedTypeSymbol>(task.TypeArguments[0]);
        var innerList = Assert.IsType<ImportedTypeSymbol>(outerList.TypeArguments[0]);
        Assert.Equal("DiagnosticCheck2381Nested", innerList.TypeArguments[0].Name);
    }

    [Fact]
    public void AsyncFunctionReturningArrayOfUserClass_CallSiteObservedAsSymbolicTaskOfArray()
    {
        // Coverage: array/slice element — a distinct null-ClrType shape from
        // the imported-generic (List/Dictionary) case above, since
        // SliceTypeSymbol/ArrayTypeSymbol compute their ClrType once, at
        // construction, as `elementType.ClrType?.MakeArrayType()`.
        const string source = @"
package p
class DiagnosticCheck2381Arr {}
async func RunAsync() []DiagnosticCheck2381Arr {
    let results = []DiagnosticCheck2381Arr{}
    return results
}
func Outer() {
    var r = RunAsync()
}
";
        var compilation = Compile(source);
        Assert.Empty(compilation.GlobalScope.Diagnostics);

        var call = FindCall(compilation, "Outer", "RunAsync");
        var task = Assert.IsType<ImportedTypeSymbol>(call.Type);
        Assert.True(task.ClrType.IsGenericType && task.ClrType.GetGenericTypeDefinition() == typeof(System.Threading.Tasks.Task<>));
        Assert.Single(task.TypeArguments);

        var arr = Assert.IsType<SliceTypeSymbol>(task.TypeArguments[0]);
        Assert.Equal("DiagnosticCheck2381Arr", arr.ElementType.Name);
    }

    [Fact]
    public void AsyncFunctionReturningListOfValueTypeStruct_CallSiteObservedAsSymbolicTaskOfListOfStruct()
    {
        // Coverage: same-compilation VALUE type (struct) element, not class.
        const string source = @"
package p
import System.Collections.Generic
struct Point2381Wrap(X int32) { }
async func RunAsync() List[Point2381Wrap] {
    let results = List[Point2381Wrap]()
    return results
}
func Outer() {
    var r = RunAsync()
}
";
        var compilation = Compile(source);
        Assert.Empty(compilation.GlobalScope.Diagnostics);

        var call = FindCall(compilation, "Outer", "RunAsync");
        AssertIsTaskOfCollectionOfUserType(call.Type, "List", "Point2381Wrap");
    }

    [Fact]
    public void AsyncFunctionReturningListOfPrimitive_CallSiteRegressionUsesOrdinaryReflectionTask()
    {
        // Negative control: a collection over a BUILT-IN element type must
        // keep the ordinary (non-symbolic) reflection-based Task<T>
        // construction — the real, already-closed CLR Task<List<int32>>,
        // not a GetConstructed symbolic wrapper — matching pre-#2381
        // behavior exactly.
        const string source = @"
package p
import System.Collections.Generic
async func RunAsync() List[int32] {
    let results = List[int32]()
    return results
}
func Outer() {
    var r = RunAsync()
}
";
        var compilation = Compile(source);
        Assert.Empty(compilation.GlobalScope.Diagnostics);

        var call = FindCall(compilation, "Outer", "RunAsync");
        var task = Assert.IsType<ImportedTypeSymbol>(call.Type);
        Assert.True(task.ClrType.IsGenericType && task.ClrType.GetGenericTypeDefinition() == typeof(System.Threading.Tasks.Task<>));

        var listClrType = task.ClrType.GetGenericArguments()[0];
        Assert.True(listClrType.IsGenericType && listClrType.GetGenericTypeDefinition() == typeof(System.Collections.Generic.List<>));
        Assert.Equal(typeof(int), listClrType.GetGenericArguments()[0]);
    }

    [Fact]
    public void AsyncFunctionReturningNonGenericUserClass_CallSiteRegressionStillWrapsSymbolically()
    {
        // Regression: the pre-existing #1785/#2026 bare same-compilation
        // class/struct shape (no surrounding collection) must still route
        // through the symbolic Task<T> construction exactly as before.
        const string source = @"
package p
class DiagnosticCheck2381Bare {}
async func RunAsync() DiagnosticCheck2381Bare {
    return DiagnosticCheck2381Bare()
}
func Outer() {
    var r = RunAsync()
}
";
        var compilation = Compile(source);
        Assert.Empty(compilation.GlobalScope.Diagnostics);

        var call = FindCall(compilation, "Outer", "RunAsync");
        var task = Assert.IsType<ImportedTypeSymbol>(call.Type);
        Assert.Single(task.TypeArguments);
        Assert.Equal("DiagnosticCheck2381Bare", task.TypeArguments[0].Name);
    }

    private static void AssertIsTaskOfCollectionOfUserType(TypeSymbol type, string collectionOpenName, string expectedElementName)
    {
        var task = Assert.IsType<ImportedTypeSymbol>(type);
        Assert.True(task.ClrType.IsGenericType && task.ClrType.GetGenericTypeDefinition() == typeof(System.Threading.Tasks.Task<>));
        Assert.Single(task.TypeArguments);

        var collection = Assert.IsType<ImportedTypeSymbol>(task.TypeArguments[0]);
        Assert.Equal(collectionOpenName, collection.OpenDefinition.Name.Split('`')[0]);
        Assert.Single(collection.TypeArguments);
        Assert.Equal(expectedElementName, collection.TypeArguments[0].Name);
        Assert.NotEqual(typeof(object), collection.TypeArguments[0].ClrType);
    }

    private static Compilation Compile(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        return new Compilation(tree) { IsLibrary = true };
    }

    private static BoundCallExpression FindCall(Compilation compilation, string functionName, string callName)
    {
        var fn = compilation.BoundProgram.Functions.Keys.Single(f => f.Name == functionName);
        var body = compilation.BoundProgram.Functions[fn];
        var collector = new CallCollector(callName);
        collector.Visit(body);
        return collector.Collected.FirstOrDefault();
    }

    private sealed class CallCollector : BoundTreeWalker
    {
        private readonly string callName;

        public CallCollector(string callName)
        {
            this.callName = callName;
        }

        public List<BoundCallExpression> Collected { get; } = new();

        public override void VisitExpression(BoundExpression node)
        {
            if (node is BoundCallExpression call && call.Function.Name == callName)
            {
                Collected.Add(call);
            }

            base.VisitExpression(node);
        }
    }
}
