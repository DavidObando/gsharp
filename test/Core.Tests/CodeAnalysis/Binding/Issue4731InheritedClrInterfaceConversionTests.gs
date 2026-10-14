// <copyright file="Issue4731InheritedClrInterfaceConversionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import System
import System.Collections.Immutable
import System.Linq
import System.Reflection.Metadata
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import Xunit
import GSharp.Core.CodeAnalysis
import Microsoft.CodeAnalysis
import System.Reflection

class Issue4731InheritedClrInterfaceConversionTests {
    @Theory
    @InlineData(typeof(object), "absent")
    @InlineData(typeof(object), "present")
    @InlineData(typeof(object), "null-slot")
    @InlineData(typeof(object), "error-slot")
    @InlineData(typeof(object), "short-vector")
    @InlineData(typeof(object), "missing-unrelated-slot")
    @InlineData(typeof(object), "present-nullable")
    @InlineData(typeof(object), "missing-unrelated-slot-nullable")
    @InlineData(typeof(string), "absent")
    @InlineData(typeof(string), "present")
    @InlineData(typeof(string), "null-slot")
    @InlineData(typeof(string), "error-slot")
    @InlineData(typeof(string), "short-vector")
    @InlineData(typeof(string), "missing-unrelated-slot")
    @InlineData(typeof(string), "present-nullable")
    @InlineData(typeof(string), "missing-unrelated-slot-nullable")
    @InlineData(typeof(int32), "absent")
    @InlineData(typeof(int32), "present")
    @InlineData(typeof(int32), "null-slot")
    @InlineData(typeof(int32), "error-slot")
    @InlineData(typeof(int32), "short-vector")
    @InlineData(typeof(int32), "missing-unrelated-slot")
    func ClosedClrInference_DoesNotInventSymbolicMethodSlotAnnotations(contextType Type, symbolicArguments string) {
        let definition = typeof(MethodDefinition).GetMethods().Single(
            (method MethodInfo) -> method.Name == "DecodeSignature"
        )
        let closed = definition.MakeGenericMethod(typeof(string), contextType)
        Assert.Equal(contextType, closed.GetParameters()[1].ParameterType)
        Assert.Equal(
            ClrNullabilityState.NotAnnotated,
            ClrNullability.GetParameterDeclaredState(definition.GetParameters()[1])
        )
        let nullableContext = symbolicArguments == "present-nullable" ||
            symbolicArguments == "missing-unrelated-slot-nullable"
        var contextSymbol = TypeSymbol.FromClrType(contextType)
        if nullableContext {
            contextSymbol = NullableTypeSymbol.Get(contextSymbol)
        }
        let arguments = switch symbolicArguments {
            case "absent": default(ImmutableArray[TypeSymbol])
            case "present" or "present-nullable": ImmutableArray.Create[TypeSymbol](TypeSymbol.String, contextSymbol)
            case "null-slot": ImmutableArray.Create[TypeSymbol](TypeSymbol.String, default(TypeSymbol))
            case "error-slot": ImmutableArray.Create[TypeSymbol](TypeSymbol.String, TypeSymbol.Error)
            case "short-vector": ImmutableArray.Create[TypeSymbol](TypeSymbol.String)
            case "missing-unrelated-slot" or "missing-unrelated-slot-nullable": ImmutableArray.Create[TypeSymbol](
                default(TypeSymbol),
                contextSymbol
            )
            default: throw ArgumentOutOfRangeException("symbolicArguments")
        }
        let target TypeSymbol? = MemberLookup.GetClrMethodParameterConversionTargetTypeSymbol(
            TypeSymbol.FromClrType(typeof(MethodDefinition)),
            closed,
            1,
            arguments
        )
        if symbolicArguments == "present" || symbolicArguments == "missing-unrelated-slot" || nullableContext {
            Assert.Equal(contextSymbol, target)
        } else {
            Assert.Null(target)
        }
    }

    @Theory
    @InlineData("ImmutableArray[int32]", "IEnumerable[object]")
    @InlineData("ImmutableArray[List[Item]]", "IEnumerable[List[object]]")
    func ImportedValueWrapper_UnsafeVarianceCannotUseErasedBoxing(sourceType string, targetType string) {
        let compilation = Bind("import System.Collections.Immutable\nclass Item {}", sourceType, targetType, "value")
        let error = Assert.Single(
            compilation.GlobalScope.Diagnostics.Concat(compilation.BoundProgram.Diagnostics),
            (diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> diagnostic.IsError
        )
        Assert.Equal("GS0155", error.Id)
    }

    @Theory
    @InlineData("ImmutableArray[IMethodSymbol]", "value")
    @InlineData("INamedTypeSymbol", "value.InstanceConstructors")
    @InlineData("IMethodSymbol", "value.ExplicitInterfaceImplementations")
    func ImportedValueWrapper_InterfaceProjectionPreservesCovariance(sourceType string, expression string) {
        let tree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree.Parse(SourceText.From((`package Issue4731.ImportedValueProjection
import System.Collections.Generic
import System.Collections.Immutable
import Microsoft.CodeAnalysis
func Convert(value ` + "$sourceType" + `) IEnumerable[ISymbol] -> ` + "$expression")))
        let references = ReferenceResolver.WithReferences([]string{typeof(IMethodSymbol).Assembly.Location})
        let compilation = GSharp
            .Core
            .CodeAnalysis
            .Compilation
            .Compilation(references, tree){Nullability = NullabilityMode.PlatformTypes}
        Assert.DoesNotContain(
            compilation.GlobalScope.Diagnostics.Concat(compilation.BoundProgram.Diagnostics),
            (value GSharp.Core.CodeAnalysis.Diagnostic) -> value.IsError
        )
    }

    @Theory
    @InlineData("sequence[List[Item]]", "sequence[List[object]]", "GS0155")
    @InlineData("sequence[List[Item]]", "IEnumerable[List[object]]", "GS0155")
    @InlineData("async sequence[List[Item]]", "async sequence[List[object]]", "GS0155")
    @InlineData("async sequence[List[Item]]", "IAsyncEnumerable[List[object]]", "GS0155")
    @InlineData("sequence[sequence[List[Item]]]", "sequence[sequence[List[object]]]", "GS0155")
    @InlineData("sequence[List[Item]?]", "sequence[List[object]?]", "GS0155")
    @InlineData("sequence[(Item, int32)]", "sequence[(object, int32)]", "GS0156")
    @InlineData("sequence[List[(Item, int32)]]", "sequence[List[(object, int32)]]", "GS0155")
    @InlineData("async sequence[(Item, int32)]", "async sequence[(object, int32)]", "GS0156")
    @InlineData("sequence[[3]int32]", "sequence[[4]int32]", "GS0155")
    @InlineData("async sequence[[3]int32]", "IAsyncEnumerable[[4]int32]", "GS0155")
    @InlineData("sequence[[]int32]", "sequence[[3]int32]", "GS0155")
    @InlineData("sequence[List[[]Item]]", "sequence[List[[]object]]", "GS0155")
    func NestedInvariantSequenceElements_CannotUseErasedClrIdentity(
        sourceType string,
        targetType string,
        diagnostic string
    ) {
        let compilation = Bind("class Item {}", sourceType, targetType, "value")
        let error = Assert.Single(
            compilation.GlobalScope.Diagnostics.Concat(compilation.BoundProgram.Diagnostics),
            (diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> diagnostic.IsError
        )
        Assert.Equal(diagnostic, error.Id)
    }

    @Theory
    @InlineData("sequence[Item]", "IEnumerable[object]")
    @InlineData("sequence[Item]", "sequence[object]")
    @InlineData("IEnumerable[Item]", "sequence[object]")
    @InlineData("async sequence[Item]", "IAsyncEnumerable[object]")
    @InlineData("async sequence[Item]", "async sequence[object]")
    @InlineData("sequence[List[Item]]", "IEnumerable[List[Item]]")
    @InlineData("sequence[IEnumerable[Item]]", "IEnumerable[IEnumerable[object]]")
    @InlineData("sequence[(Item, int32)]", "IEnumerable[(Item, int32)]")
    @InlineData("sequence[[3]int32]", "IEnumerable[[3]int32]")
    @InlineData("sequence[List[(Item, int32)]]", "IEnumerable[List[(Item, int32)]]")
    func ReifiedSequenceSource_SharedImportedVarianceAcceptsReferenceElements(sourceType string, targetType string) {
        let compilation = Bind("class Item {}", sourceType, targetType, "value")
        Assert.Empty(compilation.GlobalScope.Diagnostics.Concat(compilation.BoundProgram.Diagnostics))
    }

    @Theory
    @InlineData("sequence[T]", "IEnumerable[object]", "[T]")
    @InlineData("sequence[T]", "sequence[object]", "[T]")
    @InlineData("async sequence[T]", "IAsyncEnumerable[object]", "[T]")
    @InlineData("sequence[int32]", "IEnumerable[object]", "")
    @InlineData("async sequence[int32]", "IAsyncEnumerable[object]", "")
    func ReifiedSequenceSource_SharedVarianceRejectsValueOrUnconstrainedElements(
        sourceType string,
        targetType string,
        typeParameters string
    ) {
        let compilation = Bind("", sourceType, targetType, "value", typeParameters)
        let error = Assert.Single(
            compilation.GlobalScope.Diagnostics.Concat(compilation.BoundProgram.Diagnostics),
            (diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> diagnostic.IsError
        )
        Assert.Equal("GS0156", error.Id)
    }

    @Theory
    @InlineData("class Leaf : ArrayList {}", "Leaf", "IEnumerable", "value")
    @InlineData("class Leaf : ArrayList {}", "Leaf", "IEnumerable", "cast[IEnumerable](value)")
    @InlineData("open class Mid : ArrayList {}\nclass Leaf : Mid {}", "Leaf", "IEnumerable", "value")
    @InlineData("open class Mid : ArrayList {}\nclass Leaf : Mid {}", "Leaf", "IEnumerable", "cast[IEnumerable](value)")
    @InlineData("class Leaf : List[string] {}", "Leaf", "IEnumerable[object]", "value")
    @InlineData("class Leaf : List[string] {}", "Leaf", "IEnumerable[object]", "cast[IEnumerable[object]](value)")
    @InlineData("class Leaf : List[string] {}", "Leaf", "sequence[object]", "value")
    @InlineData("class Leaf : List[string] {}", "Leaf", "sequence[object]", "cast[sequence[object]](value)")
    @InlineData("class Leaf : List[int32?] {}", "Leaf", "IEnumerable[int32?]", "value")
    @InlineData("class Leaf : List[int32?] {}", "Leaf", "sequence[int32?]", "value")
    @InlineData("class Leaf : ArrayList {}", "Leaf?", "IEnumerable?", "value")
    @InlineData("class Leaf : ArrayList {}", "Leaf?", "IEnumerable", "cast[IEnumerable](value)")
    @InlineData("class Leaf : ArrayList {}", "Leaf", "ArrayList", "value")
    @InlineData("class Leaf : ArrayList, IEnumerable {}", "Leaf", "IEnumerable", "value")
    func InheritedInterface_ImplicitAndCheckedConversionsBind(
        declarations string,
        sourceType string,
        targetType string,
        expression string
    ) {
        let compilation = Bind(declarations, sourceType, targetType, expression)
        Assert.Empty(compilation.GlobalScope.Diagnostics.Concat(compilation.BoundProgram.Diagnostics))
    }

    @Theory
    @InlineData("value")
    @InlineData("cast[IEnumerable[T]](value)")
    func GenericImportedOwner_SubstitutesTheInScopeTypeParameter(expression string) {
        let compilation = Bind(
            "open class Mid[T] : List[T] {}\nclass Leaf[T] : Mid[T] {}",
            "Leaf[T]",
            "IEnumerable[T]",
            expression,
            "[T]"
        )
        Assert.Empty(compilation.GlobalScope.Diagnostics.Concat(compilation.BoundProgram.Diagnostics))
    }

    @Theory
    @InlineData("value")
    @InlineData("cast[IEnumerable[Item]](value)")
    func GenericImportedOwner_PreservesSameCompilationElementIdentity(expression string) {
        let compilation = Bind(`class Item {}
open class Mid[T] : List[T] {}
class Leaf : Mid[Item] {}`, "Leaf", "IEnumerable[Item]", expression)
        Assert.Empty(compilation.GlobalScope.Diagnostics.Concat(compilation.BoundProgram.Diagnostics))
    }

    @Theory
    @InlineData("value")
    @InlineData("cast[sequence[T]](value)")
    func GenericSequenceAlias_PreservesTheInScopeElement(expression string) {
        let compilation = Bind(
            "open class Mid[T] : List[T] {}\nclass Leaf[T] : Mid[T] {}",
            "Leaf[T]",
            "sequence[T]",
            expression,
            "[T]"
        )
        Assert.Empty(compilation.GlobalScope.Diagnostics.Concat(compilation.BoundProgram.Diagnostics))
    }

    @Theory
    @InlineData("IEnumerable[object]", "value")
    @InlineData("sequence[object]", "value")
    @InlineData("sequence[object]", "cast[sequence[object]](value)")
    func UnconstrainedSequenceElement_CannotUseReferenceVariance(targetType string, expression string) {
        let compilation = Bind("class Leaf[T] : List[T] {}", "Leaf[T]", targetType, expression, "[T]")
        let error = Assert.Single(
            compilation.GlobalScope.Diagnostics.Concat(compilation.BoundProgram.Diagnostics),
            (diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> diagnostic.IsError
        )
        Assert.Equal("GS0155", error.Id)
    }

    @Theory
    @InlineData("class Leaf {}", "Leaf", "IEnumerable", "value")
    @InlineData("class Leaf {}", "Leaf", "IEnumerable", "cast[IEnumerable](value)")
    @InlineData("class Leaf : ArrayList {}", "Leaf?", "IEnumerable", "value")
    @InlineData("class Leaf : List[int32] {}", "Leaf", "IEnumerable[object]", "value")
    @InlineData("class Leaf : List[object] {}", "Leaf", "IList[string]", "value")
    @InlineData(`class Item {}
class Other {}
class Leaf : List[Item] {}`, "Leaf", "IEnumerable[Other]", "value")
    @InlineData(`class Item {}
class Other {}
class Leaf : List[Item] {}`, "Leaf", "sequence[Other]", "value")
    @InlineData("class Leaf : List[int32] {}", "Leaf", "sequence[object]", "value")
    func InvalidImplicitConversions_RemainRejected(
        declarations string,
        sourceType string,
        targetType string,
        expression string
    ) {
        let compilation = Bind(declarations, sourceType, targetType, expression)
        let error = Assert.Single(
            compilation.GlobalScope.Diagnostics.Concat(compilation.BoundProgram.Diagnostics),
            (diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> diagnostic.IsError
        )
        Assert.Equal(
            if sourceType == "Leaf?" {
                "GS0156"
            } else {
                "GS0155"
            },
            error.Id
        )
        Assert.True(error.Location.Span.Length > 0)
    }

    @Theory
    @InlineData("IEnumerable[string]", false)
    @InlineData("IEnumerable[string?]", true)
    @InlineData("sequence[string]", false)
    @InlineData("sequence[string?]", true)
    func SubstitutedPlatformElement_ReusesContainerNullabilityRules(targetType string, isImplicit bool) {
        let compilation = Bind("class Leaf[T] : List[T] {}", "Leaf[string]", targetType, "value")
        Assert.Empty(compilation.GlobalScope.Diagnostics.Concat(compilation.BoundProgram.Diagnostics))
        let definition = Assert.Single(compilation.GlobalScope.Structs, (type StructSymbol) -> type.Name == "Leaf")
        let source = StructSymbol.Construct(
            definition,
            ImmutableArray.Create[TypeSymbol](PlatformTypeSymbol.Get(TypeSymbol.String))
        )
        let target = Assert.Single(
            compilation.GlobalScope.Functions,
            (function FunctionSymbol) -> function.Name == "Convert"
        )
            .Type
        Assert.Equal(isImplicit, Conversion.Classify(source, target).IsImplicit)
        if !isImplicit {
            Assert.False(Conversion.Classify(source, target).Exists)
        }
    }

    shared {
        private func Bind(
            declarations string,
            sourceType string,
            targetType string,
            expression string,
            typeParameters string = ""
        ) GSharp
            .Core
            .CodeAnalysis
            .Compilation
            .Compilation {
            let source = (`package Issue4731
import System.Collections
import System.Collections.Generic

` + "$declarations" + `
func Convert` + "$typeParameters" + `(value ` + "$sourceType" + `) ` + "$targetType" + ` -> ` + "$expression")
            let tree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree.Parse(SourceText.From(source))
            Assert.Empty(tree.Diagnostics)
            return GSharp.Core.CodeAnalysis.Compilation.Compilation(tree){Nullability = NullabilityMode.PlatformTypes}
        }
    }
}
