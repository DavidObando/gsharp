// <copyright file="Issue666LinqExtensionOnClrRefTypeTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Core.Tests.Fixtures
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.IO
import System.Linq
import Xunit

/// Issue #666: LINQ extension methods (Where, Select, FirstOrDefault, ToArray,
/// AsEnumerable) called via instance syntax on IEnumerable<T>/List<T>
/// must work when T is a CLR reference type from a project-referenced (non-BCL)
/// assembly loaded through (cref:System.Reflection.MetadataLoadContext).
open class Issue666LinqExtensionOnClrRefTypeTests {
    @Fact
    func Where_OnList_ClrRefElement_InstanceSyntax_Binds() {
        let source = `
package Probe
import GSharp.Core.Tests.Fixtures
import System.Collections.Generic
import System.Linq

var xs = List[Issue666ItemCls]()
xs.Add(Issue666ItemCls())
var q = xs.Where(func(i Issue666ItemCls) bool { return true })
`
        AssertBindsWithoutErrors(source)
    }

    @Fact
    func Select_OnList_ClrRefElement_InstanceSyntax_Binds() {
        let source = `
package Probe
import GSharp.Core.Tests.Fixtures
import System.Collections.Generic
import System.Linq

var xs = List[Issue666ItemCls]()
xs.Add(Issue666ItemCls())
var q = xs.Select(func(i Issue666ItemCls) string { return i.Name })
`
        AssertBindsWithoutErrors(source)
    }

    @Fact
    func FirstOrDefault_OnList_ClrRefElement_InstanceSyntax_Binds() {
        let source = `
package Probe
import GSharp.Core.Tests.Fixtures
import System.Collections.Generic
import System.Linq

var xs = List[Issue666ItemCls]()
xs.Add(Issue666ItemCls())
var q = xs.FirstOrDefault()
`
        AssertBindsWithoutErrors(source)
    }

    @Fact
    func ToArray_OnList_ClrRefElement_InstanceSyntax_Binds() {
        let source = `
package Probe
import GSharp.Core.Tests.Fixtures
import System.Collections.Generic
import System.Linq

var xs = List[Issue666ItemCls]()
xs.Add(Issue666ItemCls())
var arr = xs.ToArray()
`
        AssertBindsWithoutErrors(source)
    }

    @Fact
    func AsEnumerable_OnList_ClrRefElement_InstanceSyntax_Binds() {
        let source = `
package Probe
import GSharp.Core.Tests.Fixtures
import System.Collections.Generic
import System.Linq

var xs = List[Issue666ItemCls]()
xs.Add(Issue666ItemCls())
var q = xs.AsEnumerable()
`
        AssertBindsWithoutErrors(source)
    }

    @Fact
    func WhereSelectChain_ClrRefElement_InstanceSyntax_Binds() {
        let source = `
package Probe
import GSharp.Core.Tests.Fixtures
import System.Collections.Generic
import System.Linq

var xs = List[Issue666ItemCls]()
xs.Add(Issue666ItemCls())
var q = xs.Where(func(i Issue666ItemCls) bool { return true }).Select(func(i Issue666ItemCls) string { return i.Name })
`
        AssertBindsWithoutErrors(source)
    }

    @Fact
    func AsEnumerableWhere_ClrRefElement_InstanceSyntax_Binds() {
        let source = `
package Probe
import GSharp.Core.Tests.Fixtures
import System.Collections.Generic
import System.Linq

var xs = List[Issue666ItemCls]()
xs.Add(Issue666ItemCls())
var q = xs.AsEnumerable().Where(func(i Issue666ItemCls) bool { return true })
`
        AssertBindsWithoutErrors(source)
    }

    @Fact
    func Linq_OnObservableCollection_UserRefElement_InstanceSyntax_Binds() {
        let source = `
package Probe
import System.Collections.ObjectModel
import System.Linq

class Item { }
var xs = ObservableCollection[Item]()
xs.Add(Item())
var filtered = xs.Where(func(i Item) bool { return true })
var any = xs.Any(func(i Item) bool { return true })
var count = xs.Count(func(i Item) bool { return true })
var first = xs.FirstOrDefault()
`
        AssertBindsWithoutErrors(source)
    }

    // --- Regression guards: BCL types (should already pass) ---
    @Fact
    func Where_OnList_String_InstanceSyntax_Binds() {
        let source = `
package Probe
import System.Collections.Generic
import System.Linq

var xs = List[string]()
xs.Add("hello")
var q = xs.Where(func(s string) bool { return true })
`
        AssertBindsWithoutErrors(source)
    }

    @Fact
    func Where_OnList_Int32_InstanceSyntax_Binds() {
        let source = `
package Probe
import System.Collections.Generic
import System.Linq

var xs = List[int32]()
xs.Add(1)
var q = xs.Where(func(x int32) bool { return x > 0 })
`
        AssertBindsWithoutErrors(source)
    }

    // --- Regression guard: explicit static form (the #320 workaround) ---
    @Fact
    func Where_ExplicitStatic_ClrRefElement_Binds() {
        let source = `
package Probe
import GSharp.Core.Tests.Fixtures
import System.Collections.Generic
import System.Linq

var xs = List[Issue666ItemCls]()
xs.Add(Issue666ItemCls())
var q = Enumerable.Where[Issue666ItemCls](xs, func(i Issue666ItemCls) bool { return true })
`
        AssertBindsWithoutErrors(source)
    }

    shared {
        private func AssertBindsWithoutErrors(source string) {
            // Load the test assembly (which contains the Issue666ItemCls fixture)
            // plus all BCL assemblies through a MetadataLoadContext, reproducing
            // the cross-context configuration that triggers issue #666.
            let fixturePath = typeof(Issue666ItemCls).Assembly.Location
            let paths List[string] = List[string]{fixturePath}
            // Include BCL assemblies so System.Linq.Enumerable is discoverable.
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
