package GSharp.Core.Tests.CodeAnalysis.Symbols

import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.IO
import System.Linq
import System.Reflection
import System.Runtime.CompilerServices
import System.Threading
import System.Threading.Tasks
import Xunit

/// Issue #5158: equal imported constructions share one instance.
class Issue5158InternedConstructionTests {
    private const FixtureSource string = `
namespace Intern5158 {
    public class Holder { }
}`

    private func LoadHolder(resolver ReferenceResolver, fixture CSharpFixture) Type {
        let name = Path.GetFileNameWithoutExtension(fixture.AssemblyPath)
        let assembly = resolver.Assemblies.First((candidate Assembly) -> candidate.GetName().Name == name)
        return assembly.GetType("Intern5158.Holder")!!
    }

    private func ListOf(argument TypeSymbol) ImportedTypeSymbol -> ImportedTypeSymbol.GetConstructed(
        typeof(List[object]),
        typeof(List[_]),
        ImmutableArray.Create[TypeSymbol](argument)
    )

    private func Parameter(name string) TypeParameterSymbol -> TypeParameterSymbol(
        name,
        0,
        TypeParameterConstraint.Any,
        TypeParameterVariance.None
    )

    @Fact
    func EqualConstruction_ReturnsTheSameInstance_AndCountsTheHit() {
        let argument = Parameter("T")
        using let measurements = CompilationMeasurements.Start("test")

        let first = ListOf(argument)
        Assert.Equal(1L, measurements.GetCounter("metadata.constructions"))
        Assert.Equal(0L, measurements.GetCounter("metadata.construction-hits"))
        let second = ListOf(argument)

        Assert.Same(first, second)
        Assert.Equal(1L, measurements.GetCounter("metadata.constructions"))
        Assert.Equal(1L, measurements.GetCounter("metadata.construction-hits"))
        Assert.Equal("System.Collections.Generic.List`1[T]", first.Name)
        Assert.Same(argument, Assert.Single(first.TypeArguments))
    }

    @Fact
    func ADifferentArgumentObject_NeverAnswersForAnotherOne() {
        // Two parameters with the same name and shape are still different symbols.
        let first = ListOf(Parameter("T"))
        let second = ListOf(Parameter("T"))
        Assert.NotSame(first, second)
        Assert.Equal(first.Name, second.Name)
    }

    @Fact
    func EachAnnotationOfAnArgument_KeepsItsOwnConstruction() {
        // ADR-0186 / ADR-0193: `T`, `T?` and the platform form of `T` are three different
        // argument objects, so they are three different constructions.
        let parameter = Parameter("T")
        let bare = ListOf(parameter)
        let nullable = ListOf(NullableTypeSymbol.Get(parameter))
        let platform = ListOf(PlatformTypeSymbol.Get(parameter))
        Assert.NotSame(bare, nullable)
        Assert.NotSame(bare, platform)
        Assert.NotSame(nullable, platform)
        Assert.Same(nullable, ListOf(NullableTypeSymbol.Get(parameter)))
        Assert.Same(platform, ListOf(PlatformTypeSymbol.Get(parameter)))
        Assert.Same(bare, ListOf(parameter))
    }

    @Fact
    func ArgumentOrderAndCount_ArePartOfTheKey() {
        let first = Parameter("A")
        let second = Parameter("B")
        let forward = ImportedTypeSymbol.GetConstructed(
            typeof(Dictionary[object, object]),
            typeof(Dictionary[_, _]),
            ImmutableArray.Create[TypeSymbol](first, second)
        )
        let backward = ImportedTypeSymbol.GetConstructed(
            typeof(Dictionary[object, object]),
            typeof(Dictionary[_, _]),
            ImmutableArray.Create[TypeSymbol](second, first)
        )
        Assert.NotSame(forward, backward)
        Assert.Equal("System.Collections.Generic.Dictionary`2[A, B]", forward.Name)
        Assert.Equal("System.Collections.Generic.Dictionary`2[B, A]", backward.Name)
        // A prefix of the arguments is a different construction, not the same entry.
        let single = ListOf(first)
        let pair = ImportedTypeSymbol.GetConstructed(
            typeof(List[object]),
            typeof(List[_]),
            ImmutableArray.Create[TypeSymbol](first, first)
        )
        Assert.NotSame(single, pair)
    }

    @Fact
    func ErasedTypeAndOpenDefinition_AreEachPartOfTheKey() {
        let argument = Parameter("T")
        let arguments = ImmutableArray.Create[TypeSymbol](argument)
        let list = ImportedTypeSymbol.GetConstructed(typeof(List[object]), typeof(List[_]), arguments)
        let otherErased = ImportedTypeSymbol.GetConstructed(typeof(HashSet[object]), typeof(List[_]), arguments)
        let otherOpen = ImportedTypeSymbol.GetConstructed(typeof(List[object]), typeof(HashSet[_]), arguments)
        let noOpen = ImportedTypeSymbol.GetConstructed(typeof(List[object]), nil, arguments)
        Assert.NotSame(list, otherErased)
        Assert.NotSame(list, otherOpen)
        Assert.NotSame(list, noOpen)
        Assert.Same(noOpen, ImportedTypeSymbol.GetConstructed(typeof(List[object]), nil, arguments))
        Assert.Null(noOpen.OpenDefinition)
        Assert.Same(typeof(HashSet[_]), otherOpen.OpenDefinition)
    }

    @Fact
    func SeparateReferenceSets_NeverShareAConstruction() {
        using let fixture = CSharpFixture(FixtureSource)
        using let first = ReferenceResolver.WithReferences([]string{fixture.AssemblyPath})
        using let second = ReferenceResolver.WithReferences([]string{fixture.AssemblyPath})
        let firstHolder = LoadHolder(first, fixture)
        let secondHolder = LoadHolder(second, fixture)
        Assert.NotSame(firstHolder, secondHolder)
        Assert.Equal(firstHolder.FullName, secondHolder.FullName)
        let argument = Parameter("T")
        let arguments = ImmutableArray.Create[TypeSymbol](argument)
        let inFirst = ImportedTypeSymbol.GetConstructed(firstHolder, firstHolder, arguments)
        let inSecond = ImportedTypeSymbol.GetConstructed(secondHolder, secondHolder, arguments)
        Assert.NotSame(inFirst, inSecond)
        Assert.Same(firstHolder, inFirst.ClrType)
        Assert.Same(secondHolder, inSecond.ClrType)
        Assert.Same(inFirst, ImportedTypeSymbol.GetConstructed(firstHolder, firstHolder, arguments))
        Assert.Same(inSecond, ImportedTypeSymbol.GetConstructed(secondHolder, secondHolder, arguments))
    }

    @Fact
    func ConcurrentFirstCalls_BuildOnce_AndShareTheSymbol() {
        const workers = 8
        const rounds = 200
        using let measurements = CompilationMeasurements.Start("test")
        using let barrier = Barrier(workers)
        for var round = 0; round < rounds; round++ {
            // A fresh argument per round, so every round is a first call.
            let argument = Parameter("T")
            let tasks = List[Task[ImportedTypeSymbol]]()
            for var i = 0; i < workers; i++ {
                tasks.Add(
                    Task.Run(
                        () -> {
                            barrier.SignalAndWait()
                            return ListOf(argument)
                        }
                    )
                )
            }
            let symbols = Task.WhenAll(tasks).GetAwaiter().GetResult()
            for symbol in symbols {
                Assert.Same(symbols[0], symbol)
            }
        }
        Assert.Equal(int64(rounds), measurements.GetCounter("metadata.constructions"))
        Assert.Equal(int64(rounds * (workers - 1)), measurements.GetCounter("metadata.construction-hits"))
    }

    @Fact
    func UnkeyableArguments_AreNeverStored() {
        using let measurements = CompilationMeasurements.Start("test")
        let builder = ImmutableArray.CreateBuilder[TypeSymbol]()
        builder.Add(default(TypeSymbol))
        let withNull = builder.ToImmutable()
        Assert.Null(Assert.Single(withNull))
        let first = ImportedTypeSymbol.GetConstructed(typeof(List[object]), typeof(List[_]), withNull)
        let second = ImportedTypeSymbol.GetConstructed(typeof(List[object]), typeof(List[_]), withNull)
        Assert.NotSame(first, second)
        Assert.Equal("System.Collections.Generic.List`1[?]", first.Name)
        // The unset array fails exactly as before, on every call, and nothing is stored.
        Assert.Throws[NullReferenceException](
            () -> ImportedTypeSymbol.GetConstructed(
                typeof(List[object]),
                typeof(List[_]),
                default(ImmutableArray[TypeSymbol])
            )
        )
        Assert.Throws[NullReferenceException](
            () -> ImportedTypeSymbol.GetConstructed(
                typeof(List[object]),
                typeof(List[_]),
                default(ImmutableArray[TypeSymbol])
            )
        )
        Assert.Equal(0L, measurements.GetCounter("metadata.constructions"))
        Assert.Equal(0L, measurements.GetCounter("metadata.construction-hits"))
    }

    @Fact
    func ANullErasedType_StillThrows() {
        Assert.Throws[ArgumentNullException](
            () -> ImportedTypeSymbol.GetConstructed(nil, typeof(List[_]), ImmutableArray[TypeSymbol].Empty)
        )
    }

    @MethodImpl(MethodImplOptions.NoInlining)
    private func BuildDroppedConstruction()[]WeakReference {
        let parameter = Parameter("Dropped")
        let construction = ListOf(parameter)
        Assert.Same(construction, ListOf(parameter))
        return []WeakReference{WeakReference(parameter), WeakReference(construction)}
    }

    @Fact
    func AnEntry_DoesNotKeepItsArgumentOrItselfAlive() {
        let references = BuildDroppedConstruction()
        for var i = 0; i < 4; i++ {
            GC.Collect()
            GC.WaitForPendingFinalizers()
        }
        Assert.False(references[0].IsAlive)
        Assert.False(references[1].IsAlive)
    }

    @MethodImpl(MethodImplOptions.NoInlining)
    private func BuildReferenceSetConstruction() WeakReference {
        using let fixture = CSharpFixture(FixtureSource)
        let resolver = ReferenceResolver.WithReferences([]string{fixture.AssemblyPath})
        let holder = LoadHolder(resolver, fixture)
        // Every argument is long lived, so only the erased type key can pin the context.
        let construction = ImportedTypeSymbol.GetConstructed(
            holder,
            holder,
            ImmutableArray.Create[TypeSymbol](TypeSymbol.Int32)
        )
        Assert.Same(
            construction,
            ImportedTypeSymbol.GetConstructed(holder, holder, ImmutableArray.Create[TypeSymbol](TypeSymbol.Int32))
        )
        resolver.Dispose()
        return WeakReference(holder)
    }

    @Fact
    func AnEntry_DoesNotKeepItsReferenceSetAlive() {
        let holder = BuildReferenceSetConstruction()
        for var i = 0; i < 4; i++ {
            GC.Collect()
            GC.WaitForPendingFinalizers()
        }
        Assert.False(holder.IsAlive)
    }
}
