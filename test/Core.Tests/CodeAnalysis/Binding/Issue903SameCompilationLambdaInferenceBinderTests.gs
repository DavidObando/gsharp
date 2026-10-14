// <copyright file="Issue903SameCompilationLambdaInferenceBinderTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.IO
import System.Linq
import Xunit

/// Issue #903 — an un-typed arrow lambda (`(c) -> …`) passed to a
/// generic LINQ extension method whose receiver's generic element type is a
/// <em>same-compilation</em> user type (a `struct` or `class` being
/// compiled in the same source, e.g. `List[Check]`) must infer its
/// parameter type from that element symbol so the call resolves and the
/// predicate/projection body type-checks.
///
/// On the base compiler this reported `GS0159` (cannot find function),
/// `GS0304` (cannot infer the type of lambda parameter), and `GS0158`
/// (cannot find member) because the element type has no CLR (cref:Type)
/// yet (it is still being compiled), so the reflection-driven inference path
/// lost the element identity. The fix recovers it symbolically from the
/// receiver's generic type arguments. Sibling assemblies (CLR reference element
/// types) were already covered by issue #666; these tests pin the
/// same-compilation case for both `struct` and `class` elements.
///
/// Element types are uniquely named per test method on purpose: a delegate
/// function-type such as `(Check) -> bool` is interned process-wide by
/// its display name, so reusing a single name across in-process compilations
/// would alias a stale element symbol from a previous test.
open class Issue903SameCompilationLambdaInferenceBinderTests {
    @Fact
    func Struct_UntypedLambda_Single_Binds() {
        let source = `
package Probe
import System.Collections.Generic
import System.Linq

struct Check903SingleS { let Id string }

var checks = List[Check903SingleS]()
checks.Add(Check903SingleS { Id: "network" })
var net = checks.Single((c) -> c.Id == "network")
`
        AssertBindsWithoutErrors(source)
    }

    @Fact
    func Struct_UntypedLambda_Where_Binds() {
        let source = `
package Probe
import System.Collections.Generic
import System.Linq

struct Check903WhereS { let Id string }

var checks = List[Check903WhereS]()
checks.Add(Check903WhereS { Id: "network" })
var filtered = checks.Where((c) -> c.Id == "network").ToList()
`
        AssertBindsWithoutErrors(source)
    }

    @Fact
    func Struct_UntypedLambda_SelectProjectingToString_Binds() {
        let source = `
package Probe
import System.Collections.Generic
import System.Linq

struct Check903SelectS { let Id string }

var checks = List[Check903SelectS]()
checks.Add(Check903SelectS { Id: "network" })
var ids = checks.Select((c) -> c.Id).ToHashSet()
`
        AssertBindsWithoutErrors(source)
    }

    @Fact
    func Class_UntypedLambda_Single_Binds() {
        let source = `
package Probe
import System.Collections.Generic
import System.Linq

class Check903SingleC { let Id string }

var checks = List[Check903SingleC]()
checks.Add(Check903SingleC { Id: "network" })
var net = checks.Single((c) -> c.Id == "network")
`
        AssertBindsWithoutErrors(source)
    }

    @Fact
    func Class_UntypedLambda_SelectProjectingToString_Binds() {
        let source = `
package Probe
import System.Collections.Generic
import System.Linq

class Check903SelectC { let Id string }

var checks = List[Check903SelectC]()
checks.Add(Check903SelectC { Id: "network" })
var ids = checks.Select((c) -> c.Id).ToHashSet()
`
        AssertBindsWithoutErrors(source)
    }

    @Fact
    func Struct_ExplicitlyTypedLambda_Single_Binds() {
        // The explicitly-typed parameter form must keep binding cleanly; on the
        // base compiler it regressed alongside the untyped form because the
        // same-compilation Func<Check,bool> argument had no CLR backing.
        let source = `
package Probe
import System.Collections.Generic
import System.Linq

struct Check903TypedS { let Id string }

var checks = List[Check903TypedS]()
checks.Add(Check903TypedS { Id: "network" })
var net = checks.Single((c Check903TypedS) -> c.Id == "network")
`
        AssertBindsWithoutErrors(source)
    }

    shared {
        private func AssertBindsWithoutErrors(source string) {
            // Reference the full BCL through a MetadataLoadContext so
            // System.Linq.Enumerable's generic extension methods are discoverable,
            // mirroring the issue #666 harness. The element types under test are
            // declared in-source (same compilation), which is the #903 scenario.
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
            let globalScope = Binder.BindGlobalScope(previous: nil, ImmutableArray.Create(tree), resolver)
            let program = Binder.BindProgram(globalScope, resolver)
            let diagnostics = globalScope.Diagnostics.AddRange(program.Diagnostics)
            Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.IsError)
        }
    }
}
