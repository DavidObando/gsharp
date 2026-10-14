// <copyright file="Issue1206QualifiedAttributeTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import Xunit

/// Regression coverage for issue #1206: namespace-qualified attribute names
/// (e.g. `@System.Obsolete`, `@System.ObsoleteAttribute`,
/// `@System.Runtime.InteropServices.DllImport`) must resolve without an
/// `import`, mirroring how qualified type references resolve. The resolver
/// must split `Ns.Name` and resolve the type by full name, append the
/// `Attribute` suffix to the final simple-name segment only (never produce
/// a doubled `...AttributeAttribute`), and the type-identity-based
/// P/Invoke detection must recognise the qualified `@DllImport`.
open class Issue1206QualifiedAttributeTests {
    @Fact
    func Qualified_Obsolete_Resolves_Without_Import() {
        let globalScope = BindSource(`@System.Obsolete("x")
func Helper() {
}
`)
        let helper = globalScope.Functions.Single((f FunctionSymbol) -> f.Name == "Helper")
        let attr = Assert.Single(helper.Attributes)
        Assert.Equal("System.ObsoleteAttribute", attr.AttributeType.Name)
        Assert.DoesNotContain(GetBinderDiagnostics(globalScope), (d Diagnostic) -> d.Id == "GS0198")
    }

    @Fact
    func Qualified_ObsoleteAttribute_Resolves_Without_Double_Suffix() {
        // The explicit `Attribute` suffix must NOT produce
        // `System.ObsoleteAttributeAttribute`.
        let globalScope = BindSource(`@System.ObsoleteAttribute("x")
func Helper() {
}
`)
        let helper = globalScope.Functions.Single((f FunctionSymbol) -> f.Name == "Helper")
        let attr = Assert.Single(helper.Attributes)
        Assert.Equal("System.ObsoleteAttribute", attr.AttributeType.Name)
        Assert.DoesNotContain(GetBinderDiagnostics(globalScope), (d Diagnostic) -> d.Id == "GS0198")
    }

    @Fact
    func Unqualified_Obsolete_Still_Resolves_With_Import() {
        let globalScope = BindSource(`import System
@Obsolete("x")
func Helper() {
}
`)
        let helper = globalScope.Functions.Single((f FunctionSymbol) -> f.Name == "Helper")
        let attr = Assert.Single(helper.Attributes)
        Assert.Equal("System.ObsoleteAttribute", attr.AttributeType.Name)
        Assert.DoesNotContain(GetBinderDiagnostics(globalScope), (d Diagnostic) -> d.Id == "GS0198")
    }

    @Fact
    func Nested_UserAttribute_UsesContainerAndSuffix() {
        let globalScope = BindSource(`class NestedAttribute : Attribute {
}

class GenericAttribute[T] : Attribute {
}

class Holder {
    class Nested {
    }

    class NestedAttribute : Attribute {
    }

    class Generic[T] {
    }

    class GenericAttribute[T] : Attribute {
    }
}

@Holder.Nested
class Consumer {
}

@Holder.Generic[int32]
class GenericConsumer {
}`)
        let consumer = globalScope.Structs.Single((type StructSymbol) -> type.Name == "Consumer")
        let genericConsumer = globalScope.Structs.Single((type StructSymbol) -> type.Name == "GenericConsumer")
        let attribute = Assert.Single(consumer.Attributes)
        let attributeType = Assert.IsType[StructSymbol](attribute.AttributeType)
        Assert.Equal("NestedAttribute", attributeType.Name)
        Assert.Equal("Holder", attributeType.ContainingType?.Name)
        let genericAttribute = Assert.Single(genericConsumer.Attributes)
        let genericAttributeType = Assert.IsType[StructSymbol](genericAttribute.AttributeType)
        Assert.Equal("GenericAttribute", genericAttributeType.Name)
        Assert.Equal("Holder", (genericAttributeType.Definition ?? genericAttributeType).ContainingType?.Name)
        Assert.Equal(TypeSymbol.Int32, Assert.Single(genericAttributeType.TypeArguments))
        Assert.Empty(GetBinderDiagnostics(globalScope))
    }

    @Fact
    func Qualified_Unknown_Attribute_Still_Reports_GS0198() {
        let globalScope = BindSource(`@System.DoesNotExistAnywhere
func Helper() {
}
`)
        Assert.Contains(GetBinderDiagnostics(globalScope), (d Diagnostic) -> d.Id == "GS0198")
    }

    @Fact
    func Qualified_DllImport_Is_Recognised_As_PInvoke() {
        const source = `
package P

unsafe class C {
    shared {
        @System.Runtime.InteropServices.DllImport("kernel32", SetLastError: true)
        func ReadFile(handle System.IntPtr, pBuffer *void, n int32, pRead *int32, ov int32) bool;
    }
}
`
        let globalScope = BindSource(source)
        let fn = GetAllFunctions(globalScope).Single((f FunctionSymbol) -> f.Name == "ReadFile")
        Assert.True(fn.IsPInvoke)
        Assert.NotNull(fn.PInvokeMetadata)
        Assert.Equal("kernel32", fn.PInvokeMetadata!!.LibraryName)
        Assert.True(fn.PInvokeMetadata!!.SetLastError)
        // Neither the unresolved-attribute (GS0198) nor the bodyless-without-
        // DllImport (GS0325) diagnostic may appear.
        Assert.DoesNotContain(GetBinderDiagnostics(globalScope), (d Diagnostic) -> (d.Id is "GS0198" or "GS0325"))
    }

    shared {
        private func GetAllFunctions($scope BoundGlobalScope) sequence[FunctionSymbol] {
            for fn in $scope.Functions {
                yield fn
            }
            for type in $scope.Structs {
                for fn in type.Methods {
                    yield fn
                }
                for fn in type.StaticMethods {
                    yield fn
                }
            }
        }

        private func BindSource(source string) BoundGlobalScope {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            return Binder.BindGlobalScope(previous: nil, ImmutableArray.Create(tree))
        }

        private func GetBinderDiagnostics($scope BoundGlobalScope) IEnumerable[Diagnostic] {
            return $scope.Diagnostics
        }
    }
}
