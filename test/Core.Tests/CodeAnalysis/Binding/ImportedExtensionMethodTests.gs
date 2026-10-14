// <copyright file="ImportedExtensionMethodTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Core.Tests.Fixtures
import GSharp.Tests
import System
import System.Collections.Concurrent
import System.Collections.Generic
import System.Collections.Immutable
import System.IO
import System.Linq
import System.Threading.Channels
import Xunit

/// Issue #294 — imported BCL/library `[Extension]` methods dispatched with
/// instance ("receiver") syntax (`receiver.Method(args)`) rather than only
/// statically (`DeclaringClass.Method(receiver, args)`). Exercised via
/// `System.Linq.Enumerable`, a dependency-free source of generic extension
/// methods over `IEnumerable<T>`.
/// @remarks These assert through full compilation (bind + lower + emit). The retired
/// tree-walking evaluator did not marshal GSharp closures into CLR delegates
/// for reflection-invoked imported methods. The
/// end-to-end execution path is covered by the `LinqExtensions`
/// conformance sample.
open class ImportedExtensionMethodTests {
    @Fact
    func KeyValuePair_ForTupleIn_UsesImportedDeconstructPattern() {
        let source = `
import System.Collections.Generic

var values = Dictionary[string, int32]()
values.Add("one", 1)
values.Add("two", 2)

var total = 0
for (key, value) in values {
    total = total + value
}
total
`
        AssertCompilesWithoutErrors(source)
        let result = EmittedOracle.Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(3, result.Value)
    }

    @Fact
    func ConcurrentDictionaryOfNestedUserGeneric_ForTupleIn_UsesImportedKeyValuePairDeconstructPattern() {
        let source = `
import System
import System.Collections.Concurrent
import System.Threading.Channels

class JobUpdate {
    prop Number int32 {
        get -> 42;
    }
}

var subscribers = ConcurrentDictionary[Guid, Channel[JobUpdate]]()
subscribers.TryAdd(Guid.Empty, Channel.CreateUnbounded[JobUpdate]())

var total = 0
for (key, ch) in subscribers {
    total = total + ch.Reader.Count
}
total
`
        AssertCompilesWithoutErrors(
            source,
            ReferenceResolver.WithReferences(
                []string{
                    typeof(object).Assembly.Location,
                    typeof(Console).Assembly.Location,
                    typeof(ConcurrentDictionary[_, _]).Assembly.Location,
                    typeof(Channel).Assembly.Location,
                    typeof(List[_]).Assembly.Location
                }.Distinct(StringComparer.OrdinalIgnoreCase)
            )
        )
    }

    @Fact
    func GenericDeconstructExtension_FromReferencedAssembly_Binds() {
        let source = `
package Demo
import GSharp.Core.Tests.Fixtures

func Run() int32 {
    var pair = ImportedPair2537[int32](4, 5)
    var (left, right) = pair
    left = 6
    return left + right
}
`
        AssertBindsWithoutErrors(source)
        AssertCompilesWithoutErrors(source, FixtureResolver())
    }

    @Fact
    func GenericLambdaExtensionOverload_FromReferencedAssembly_Binds() {
        let source = `
package Demo
import GSharp.Core.Tests.Fixtures

func Run() string? {
    var pair = ImportedPair2537[int32](4, 5)
    return pair.Transform(func(value int32) string { return value.ToString() })
}
`
        AssertBindsWithoutErrors(source)
    }

    @Fact
    func Where_OnList_InstanceSyntax_Compiles() {
        let source = `
import System.Linq
import System.Collections.Generic

var list = List[int32]()
list.Add(1)
list.Add(2)
list.Add(3)
list.Add(4)

var evens = list.Where(func(x int32) bool { return x % 2 == 0 })
`
        AssertCompilesWithoutErrors(source)
    }

    @Fact
    func WhereSelect_Chained_InstanceSyntax_Compiles() {
        let source = `
import System.Linq
import System.Collections.Generic

var list = List[int32]()
list.Add(1)
list.Add(2)
list.Add(3)
list.Add(4)

var projected = list.Where(func(x int32) bool { return x % 2 == 0 }).Select(func(x int32) int32 { return x * 10 })
`
        AssertCompilesWithoutErrors(source)
    }

    @Fact
    func Count_Terminal_InstanceSyntax_Compiles() {
        let source = `
import System.Linq
import System.Collections.Generic

var list = List[int32]()
list.Add(1)
list.Add(2)
list.Add(3)

var n = list.Where(func(x int32) bool { return x > 2 }).Count()
`
        AssertCompilesWithoutErrors(source)
    }

    @Fact
    func Sum_NonGenericReceiverInference_InstanceSyntax_Compiles() {
        let source = `
import System.Linq
import System.Collections.Generic

var list = List[int32]()
list.Add(2)
list.Add(3)
list.Add(5)

var total = list.Sum()
`
        AssertCompilesWithoutErrors(source)
    }

    @Fact
    func WithoutImportingNamespace_ExtensionNotVisible_Diagnoses() {
        // System.Linq is NOT imported, so Where must remain unresolved (GS0159):
        // import scope is respected.
        let source = `
import System.Collections.Generic

var list = List[int32]()
list.Add(1)

var evens = list.Where(func(x int32) bool { return x % 2 == 0 })
`
        let diagnostics = EmitDiagnostics(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.IsError)
    }

    @Fact
    func InstanceMethodPreferredOverExtension() {
        // List<T>.Contains is a genuine instance method; resolving it must use
        // the instance method, not an Enumerable.Contains extension. This guards
        // the standard resolution order (instance members before extensions).
        let source = `
import System.Linq
import System.Collections.Generic

var list = List[int32]()
list.Add(1)
list.Add(2)

var found = list.Contains(2)
`
        AssertCompilesWithoutErrors(source)
    }

    @Fact
    func CountBy_OmitsTrailingOptionalComparer_InstanceSyntax_Compiles() {
        // Issue #327: Enumerable.CountBy<TSource,TKey>(this IEnumerable<TSource>,
        // Func<TSource,TKey>, IEqualityComparer<TKey> comparer = null) is an
        // imported extension method with a trailing optional parameter. Calling
        // it with only the key selector must resolve by omitting the optional
        // comparer — the same shape as HttpResponse.WriteAsync(text) in #327.
        let source = `
import System.Linq
import System.Collections.Generic

var list = List[int32]()
list.Add(1)
list.Add(2)
list.Add(3)
list.Add(4)

var counts = list.CountBy(func(x int32) int32 { return x % 2 })
`
        AssertCompilesWithoutErrors(source)
    }

    @Fact
    func ExtensionMethod_DelegateParameter_LambdaLiteralArgument_Binds() {
        // Issue #322: a function literal (lambda) passed directly as an argument
        // when resolving an extension-method overload whose parameter type is
        // System.Delegate must bind, just as the var-bound form already does.
        // The fixture assembly is supplied as an explicit reference, so the
        // binder loads `Handle`'s System.Delegate parameter through a
        // MetadataLoadContext while the lambda carries a *live runtime* Func<>
        // type. The delegate→Delegate conversion must therefore be classified by
        // name across reflection contexts. Mirrors the ASP.NET Core minimal-API
        // MapGet(this ..., string, Delegate) shape.
        let source = `
package Demo
import GSharp.Core.Tests.Fixtures

func Run() string {
    var prefix = "hi"
    return prefix.Handle(func() string { return "ok" })
}
`
        AssertBindsWithoutErrors(source)
    }

    @Fact
    func ExtensionMethod_DelegateParameter_NineArgumentLambda_Binds() {
        let source = `
package Demo
import GSharp.Core.Tests.Fixtures

func Run() string {
    return "x".Handle(func(a int32, b int32, c int32, d int32, e int32, f int32, g int32, h int32, i int32) string {
        return "ok"
    })
}
`
        AssertBindsWithoutErrors(source)
    }

    @Fact
    func ExtensionMethod_DelegateParameter_VarBoundArgument_Binds() {
        // Companion to the lambda-literal case: the documented workaround
        // (bind to a typed func var first) already bound before issue #322;
        // this guards that the fix does not regress it. A native `func()
        // string` annotation is used (rather than `Func[string]`) so the test
        // does not depend on importing System under the fixture-only resolver.
        let source = `
package Demo
import GSharp.Core.Tests.Fixtures

func Run() string {
    var handler func() string = func() string { return "ok" }
    var prefix = "hi"
    return prefix.Handle(handler)
}
`
        AssertBindsWithoutErrors(source)
    }

    shared {
        private func AssertBindsWithoutErrors(source string) {
            // Use an explicit reference to the test (fixture) assembly so its types
            // are loaded through a MetadataLoadContext — the cross-reflection-context
            // configuration that reproduces issue #322. The Default resolver loads
            // host runtime assemblies and would not exercise that path.
            let resolver = FixtureResolver()
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let globalScope = Binder.BindGlobalScope(previous: nil, ImmutableArray.Create(tree), resolver)
            let program = Binder.BindProgram(globalScope, resolver)
            let diagnostics = globalScope.Diagnostics.AddRange(program.Diagnostics)
            Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.IsError)
        }

        private func FixtureResolver() ReferenceResolver -> ReferenceResolver.WithReferences(
            []string{typeof(Handler322Extensions).Assembly.Location}
        )

        private func AssertCompilesWithoutErrors(source string) {
            let diagnostics = EmitDiagnostics(source, out var success)
            Assert.True(
                success,
                "Emit failed:\n" + string.Join("\n", diagnostics.Select((d Diagnostic) -> d.ToString()))
            )
            Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.IsError)
        }

        private func AssertCompilesWithoutErrors(source string, resolver ReferenceResolver) {
            let compilation = Compilation(resolver, SyntaxTree.Parse(SourceText.From(source)))
            using let peStream = MemoryStream()
            let result = compilation.Emit(peStream)
            Assert.True(
                result.Success,
                "Emit failed:\n" + string.Join("\n", result.Diagnostics.Select((d Diagnostic) -> d.ToString()))
            )
        }

        private func EmitDiagnostics(source string) IReadOnlyList[Diagnostic] -> EmitDiagnostics(source, out _)

        private func EmitDiagnostics(source string, out success bool) IReadOnlyList[Diagnostic] {
            let compilation = Compilation(SyntaxTree.Parse(SourceText.From(source)))
            using let peStream = MemoryStream()
            let result = compilation.Emit(peStream)
            success = result.Success
            return result.Diagnostics
        }
    }
}
