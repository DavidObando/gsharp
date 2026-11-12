package GSharp.Core.Tests.CodeAnalysis.Symbols

import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Symbols
import System
import System.Collections.Generic
import System.Collections.Immutable
import Xunit

class Issue5956ImportedNullableTupleContractTests {
    @Fact
    func NamedTupleInGenericReturn_RetainsContractsDuringConversion() {
        let method = typeof(Surface).GetMethod("Prepare")!!
        let imported = ClrNullability.GetReturnTypeSymbol(method)
        let tuple = Assert.IsType[TupleTypeSymbol](Assert.Single(imported.GetElementPositions()))
        Assert.Equal("Original", tuple.ElementNames[1])
        Assert.Equal(ReferenceNullabilityKind.Nullable, tuple.ElementTypes[1].ReferenceNullability)
        let nested = ClrNullability.GetReturnTypeSymbol(typeof(Surface).GetMethod("Nested")!!)
        let nestedTuple = Assert.IsType[TupleTypeSymbol](Assert.Single(nested.GetElementPositions()))
        Assert.Equal(ReferenceNullabilityKind.NotNull, nestedTuple.ElementTypes[0].ReferenceNullability)
        Assert.Equal(
            ReferenceNullabilityKind.Nullable,
            Assert.Single(nestedTuple.ElementTypes[0].GetElementPositions()).ReferenceNullability
        )
        Assert.Equal(ReferenceNullabilityKind.NotNull, nestedTuple.ElementTypes[1].ReferenceNullability)
        let target = ImportedTypeSymbol.GetConstructed(
            method.ReturnType,
            typeof(IReadOnlyList[_]),
            ImmutableArray.Create[TypeSymbol](
                TupleTypeSymbol.Get(
                    ImmutableArray.Create[TypeSymbol](
                        TypeSymbol.String,
                        NullableTypeSymbol.Get(SliceTypeSymbol.Get(TypeSymbol.UInt8))
                    ),
                    ImmutableArray.Create[string?]("Path", "Original")
                )
            )
        )
        Assert.True(Conversion.Classify(imported, target).IsImplicit)
    }

    private shared class Surface {
        func Prepare() IReadOnlyList[(Path string, Original[]?uint8)] -> throw NotImplementedException()

        func Nested() IReadOnlyList[(Values[]string?, Required[]uint8)] -> throw NotImplementedException()
    }
}
