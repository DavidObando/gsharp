// <copyright file="Issue1507SliceArrayUntypedLambdaInferenceTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections
import System.Collections.Generic
import System.Collections.Immutable
import System.IO
import System.Linq
import System.Reflection
import Xunit

/// Issue #1507 — target-typed inference of an UNTYPED arrow-lambda parameter
/// (`(i) -> …`) passed to a LINQ / imported extension method must be
/// driven by the matching delegate parameter when the receiver is a G# slice
/// (`[]T`) or array (`[N]T`), exactly as it already is for a
/// `List[T]` receiver. On the base compiler the lambda parameter was never
/// target-typed for a slice/array receiver — the extension probe in
/// `ResolveDeferredArrowLambdaArguments` is gated on a non-null receiver
/// `ClrType`, which a slice/array receiver lacks — so the call reported
/// `GS0159` (cannot find function), `GS0304` (cannot infer the type of
/// lambda parameter) and, for a user element, `GS0158` (cannot find
/// member). The fix normalizes a slice/array receiver to a symbolic
/// `IEnumerable[elementType]` purely for the deferred-lambda inference,
/// recovering the element type for the untyped lambda parameter.
///
/// Element / package names are unique per test method on purpose: a delegate
/// function-type such as `(Item) -> bool` is interned process-wide by
/// its display name, so reusing a single name across in-process compilations
/// would alias a stale element symbol from a previous test.
open class Issue1507SliceArrayUntypedLambdaInferenceTests {
    @Fact
    func Slice_UserStruct_UntypedWhere_InfersElementType() {
        let source = `
package Probe1507WhereS
import System
import System.Linq

data struct Item1507WhereS { var V int32 }

func f(xs []Item1507WhereS) int32 { return xs.Where((i) -> i.V > 0).Count() }
`
        let program = BindProgram(source)
        AssertNoErrors(program)
        AssertOnlyLambdaParameterType(program, "Item1507WhereS")
    }

    @Fact
    func Slice_UserStruct_UntypedSelect_InfersElementType() {
        let source = `
package Probe1507SelectS
import System
import System.Linq

data struct Item1507SelectS { var V int32 }

func f(xs []Item1507SelectS) int32 { return xs.Select((i) -> i.V).Sum() }
`
        let program = BindProgram(source)
        AssertNoErrors(program)
        AssertOnlyLambdaParameterType(program, "Item1507SelectS")
    }

    @Fact
    func Slice_UserStruct_UntypedOrderBy_InfersElementType() {
        let source = `
package Probe1507OrderByS
import System
import System.Linq

data struct Item1507OrderByS { var V int32 }

func f(xs []Item1507OrderByS) int32 { return xs.OrderBy((i) -> i.V).First().V }
`
        let program = BindProgram(source)
        AssertNoErrors(program)
        AssertOnlyLambdaParameterType(program, "Item1507OrderByS")
    }

    @Fact
    func Slice_PrimitiveInt32_UntypedWhere_InfersInt32() {
        let source = `
package Probe1507WhereInt
import System
import System.Linq

func f(xs []int32) int32 { return xs.Where((i) -> i > 0).Count() }
`
        let program = BindProgram(source)
        AssertNoErrors(program)
        AssertOnlyLambdaParameterType(program, "int32")
    }

    @Fact
    func Slice_PrimitiveString_UntypedWhere_InfersString() {
        let source = `
package Probe1507WhereStr
import System
import System.Linq

func f(xs []string) int32 { return xs.Where((s) -> s.Length > 3).Count() }
`
        let program = BindProgram(source)
        AssertNoErrors(program)
        AssertOnlyLambdaParameterType(program, "string")
    }

    @Fact
    func Array_UserStruct_UntypedWhere_InfersElementType() {
        let source = `
package Probe1507ArrWhereS
import System
import System.Linq

data struct Item1507ArrWhereS { var V int32 }

func f(xs [3]Item1507ArrWhereS) int32 { return xs.Where((i) -> i.V > 0).Count() }
`
        let program = BindProgram(source)
        AssertNoErrors(program)
        AssertOnlyLambdaParameterType(program, "Item1507ArrWhereS")
    }

    @Fact
    func Slice_UserStruct_ChainedWhereWhereCount_Binds() {
        let source = `
package Probe1507Chain
import System
import System.Linq

data struct Item1507Chain { var V int32 }

func f(xs []Item1507Chain) int32 { return xs.Where((i) -> i.V > 0).Where((i) -> i.V < 10).Count() }
`
        let program = BindProgram(source)
        AssertNoErrors(program)
        // Both chained untyped lambdas must infer the element type.
        AssertOnlyLambdaParameterType(program, "Item1507Chain")
    }

    @Fact
    func Slice_UserStruct_ChainedSelectWhereSum_Binds() {
        let source = `
package Probe1507SelectWhere
import System
import System.Linq

data struct Item1507SelectWhere { var V int32 }

func f(xs []Item1507SelectWhere) int32 { return xs.Select((i) -> i.V).Where((v) -> v > 0).Sum() }
`
        let program = BindProgram(source)
        AssertNoErrors(program)
        let paramTypes = CollectLambdaParameterTypeNames(program)
        // Select's lambda parameter is the element type; Where's lambda parameter
        // is the projected int32 — both must be recovered (never `object`).
        Assert.Contains("Item1507SelectWhere", paramTypes)
        Assert.Contains("int32", paramTypes)
        Assert.DoesNotContain("object", paramTypes)
    }

    @Fact
    func Regression_Slice_ExplicitlyTypedLambda_StillBinds() {
        let source = `
package Probe1507Explicit
import System
import System.Linq

data struct Item1507Explicit { var V int32 }

func f(xs []Item1507Explicit) int32 { return xs.Where((i Item1507Explicit) -> i.V > 0).Count() }
`
        let program = BindProgram(source)
        AssertNoErrors(program)
        AssertOnlyLambdaParameterType(program, "Item1507Explicit")
    }

    @Fact
    func Regression_Slice_NonLambdaExtensionCall_StillBinds() {
        let source = `
package Probe1507NoLambda
import System
import System.Linq

data struct Item1507NoLambda { var V int32 }

func f(xs []Item1507NoLambda) int32 { return xs.Count() }
`
        let program = BindProgram(source)
        AssertNoErrors(program)
    }

    @Fact
    func Regression_List_UntypedWhere_StillInfersElementType() {
        let source = `
package Probe1507List
import System
import System.Linq
import System.Collections.Generic

data struct Item1507List { var V int32 }

func f(xs List[Item1507List]) int32 { return xs.Where((i) -> i.V > 0).Count() }
`
        let program = BindProgram(source)
        AssertNoErrors(program)
        AssertOnlyLambdaParameterType(program, "Item1507List")
    }

    shared {
        private func AssertNoErrors(program BoundProgram) {
            Assert.DoesNotContain(program.Diagnostics, (d Diagnostic) -> d.IsError)
        }

        private func AssertOnlyLambdaParameterType(program BoundProgram, expectedElementTypeName string) {
            let names = CollectLambdaParameterTypeNames(program)
            Assert.NotEmpty(names)
            Assert.All(names, (n string) -> Assert.Equal(expectedElementTypeName, n))
        }

        private func CollectLambdaParameterTypeNames(program BoundProgram) List[string] {
            let literals = List[BoundFunctionLiteralExpression]()
            let visited = HashSet[object](ReferenceEqualityComparer.Instance)
            for body in program.Functions.Values {
                Collect(body, literals, visited)
            }
            if program.Statement != nil {
                Collect(program.Statement, literals, visited)
            }
            let names = List[string]()
            for literal in literals {
                Assert.NotNull(literal.FunctionType)
                Assert.NotEmpty(literal.FunctionType.ParameterTypes)
                names.Add((literal.FunctionType.ParameterTypes[0]?.Name)!!)
            }
            return names
        }

        // Reflection walk over the bound tree: descend through every public
        // BoundNode-typed property and every enumerable of BoundNodes, collecting
        // the bound arrow-lambda literals. Symbols are never BoundNodes, so the walk
        // terminates without cycles.
        private func Collect(node BoundNode?, literals List[BoundFunctionLiteralExpression], visited HashSet[object]) {
            if node == nil || !visited.Add(node) {
                return
            }
            if node is BoundFunctionLiteralExpression literal {
                literals.Add(literal)
            }
            for property in node.GetType().GetProperties(BindingFlags.Public | BindingFlags.Instance) {
                if property.GetIndexParameters().Length > 0 {
                    continue
                }
                var value object?
                try {
                    value = property.GetValue(node)
                } catch (TargetInvocationException) {
                    continue
                }
                if value is BoundNode child {
                    Collect(child, literals, visited)
                } else if value is IEnumerable enumerable && !(value is string) {
                    // A default (uninitialized) ImmutableArray boxes to IEnumerable
                    // but throws on enumeration; skip such properties defensively.
                    var enumerator IEnumerator
                    try {
                        enumerator = enumerable.GetEnumerator()
                    } catch (InvalidOperationException) {
                        continue
                    }
                    while true {
                        try {
                            if !enumerator.MoveNext() {
                                break
                            }
                        } catch (InvalidOperationException) {
                            break
                        }
                        if enumerator.Current is BoundNode boundItem {
                            Collect(boundItem, literals, visited)
                        }
                    }
                }
            }
        }

        private func BindProgram(source string) BoundProgram {
            // Reference the full BCL through a MetadataLoadContext so
            // System.Linq.Enumerable's generic extension methods are discoverable,
            // mirroring the issue #666 / #903 harness.
            let paths = List[string]()
            let tpa string? = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string
            if !string.IsNullOrEmpty(tpa) {
                for p in tpa.Split(Path.PathSeparator) {
                    if !string.IsNullOrWhiteSpace(p) && File.Exists(p) {
                        paths.Add(p)
                    }
                }
            }
            using let resolver = ReferenceResolver.WithReferences(paths)
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let globalScope = GSharp
                .Core
                .CodeAnalysis
                .Binding
                .Binder
                .BindGlobalScope(previous: nil, ImmutableArray.Create(tree), resolver)
            let program = GSharp.Core.CodeAnalysis.Binding.Binder.BindProgram(globalScope, resolver)
            return program
        }
    }
}
